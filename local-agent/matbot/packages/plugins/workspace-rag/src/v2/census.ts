import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { detectPassageLanguage } from './language.js';

/**
 * Per-file statistics gathered during a census scan.
 */
export interface RagV2CensusFileAnalysis {
  contentSha256: string;
  similarityFingerprint: string;
  headings: number;
  clauses: number;
  paragraphs: number;
  tables: number;
  estimatedPassages: number;
  language: ReturnType<typeof detectPassageLanguage>;
}

/**
 * Fixed-memory cardinality estimator used by the million-file census. It
 * avoids retaining a hash per source while still exposing the approximation
 * error in the census result.
 */
/**
 * A HyperLogLog cardinality estimator used to size corpora cheaply during census.
 */
export class RagV2HyperLogLog {
  private readonly precision = 14;
  private readonly registers = new Uint8Array(1 << this.precision);

  /**
   * Adds one value to the sketch.
   * @param value - Value to count toward the estimate.
   */
  add(value: string): void {
    const hash = createHash('sha256').update(value).digest();
    const first = hash.readUInt32BE(0);
    const index = first >>> (32 - this.precision);
    let remaining = (BigInt(first & ((1 << (32 - this.precision)) - 1)) << 32n)
      | BigInt(hash.readUInt32BE(4));
    let rank = 1;
    const bits = 64 - this.precision;
    while (rank <= bits && (remaining & (1n << BigInt(bits - rank))) === 0n) rank++;
    this.registers[index] = Math.max(this.registers[index]!, rank);
  }

  /**
   * Estimates the number of distinct values added so far.
   * @returns Approximate distinct count.
   */
  estimate(): number {
    const count = this.registers.length;
    const alpha = 0.7213 / (1 + 1.079 / count);
    let inverse = 0;
    let zeroes = 0;
    for (const register of this.registers) {
      inverse += 2 ** -register;
      if (register === 0) zeroes++;
    }
    const raw = alpha * count * count / inverse;
    if (raw <= 2.5 * count && zeroes > 0) return count * Math.log(count / zeroes);
    return raw;
  }

  /**
   * Reports the sketch's theoretical relative error bound.
   * @returns Relative error as a fraction (e.g. 0.016).
   */
  relativeError(): number {
    return 1.04 / Math.sqrt(this.registers.length);
  }
}

function similarityFingerprint(text: string): string {
  const weights = new Int32Array(64);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  for (const token of tokens.slice(0, 50_000)) {
    const hash = createHash('sha256').update(token).digest();
    const bits = hash.readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit++) {
      weights[bit] = weights[bit]! + ((bits & (1n << BigInt(bit))) === 0n ? -1 : 1);
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit]! >= 0) result |= 1n << BigInt(bit);
  }
  return result.toString(16).padStart(16, '0');
}

function inspectLine(
  line: string,
  state: {
    headings: number;
    clauses: number;
    paragraphs: number;
    tables: number;
    inParagraph: boolean;
    inTable: boolean;
  },
): void {
  const trimmed = line.trim();
  if (/^#{1,6}[ \t]+/u.test(trimmed)) state.headings++;
  if (/^(?:(?:article|art\.?|chapter|section|clause|annex|appendix|rozdział|artykuł|§)\s+[\w.-]+|\d+(?:\.\d+)+[.)]?\s+)/iu.test(trimmed)) {
    state.clauses++;
  }
  const tableLine = /^\|.*\|$/u.test(trimmed);
  if (tableLine && !state.inTable) state.tables++;
  state.inTable = tableLine;
  if (!trimmed) {
    state.inParagraph = false;
  } else if (!state.inParagraph && !tableLine) {
    state.paragraphs++;
    state.inParagraph = true;
  }
}

export async function analyzeCensusFile(
  filePath: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<RagV2CensusFileAnalysis> {
  const hash = createHash('sha256');
  const sampleChunks: Buffer[] = [];
  let sampleBytes = 0;
  const sampleLimit = 256 * 1024;
  let carry = '';
  const structural = {
    headings: 0,
    clauses: 0,
    paragraphs: 0,
    tables: 0,
    inParagraph: false,
    inTable: false,
  };
  for await (const value of createReadStream(filePath, { highWaterMark: 256 * 1024 })) {
    if (signal.aborted) throw signal.reason ?? new Error('Workspace RAG V2 census cancelled.');
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(chunk);
    if (sampleBytes < sampleLimit) {
      const selected = chunk.subarray(0, Math.min(chunk.length, sampleLimit - sampleBytes));
      sampleChunks.push(Buffer.from(selected));
      sampleBytes += selected.length;
    }
    const text = carry + chunk.toString('utf8');
    const lines = text.split(/\r?\n/u);
    carry = lines.pop() ?? '';
    for (const line of lines) inspectLine(line, structural);
    // A pathological line cannot make the census buffer unbounded.
    if (carry.length > 1024 * 1024) {
      inspectLine(carry.slice(0, 1024 * 1024), structural);
      carry = '';
    }
  }
  if (carry) inspectLine(carry, structural);
  const sample = Buffer.concat(sampleChunks).toString('utf8');
  const language = detectPassageLanguage(sample);
  const structuralFloor = structural.paragraphs + structural.tables + structural.clauses;
  return {
    contentSha256: hash.digest('hex'),
    similarityFingerprint: similarityFingerprint(sample),
    headings: structural.headings,
    clauses: structural.clauses,
    paragraphs: structural.paragraphs,
    tables: structural.tables,
    estimatedPassages: Math.max(structuralFloor, Math.ceil(byteLength / 3_200)),
    language,
  };
}
