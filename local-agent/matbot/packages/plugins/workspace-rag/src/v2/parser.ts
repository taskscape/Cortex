import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { detectPassageLanguage } from './language.js';
import type {
  RagV2HeadingRef,
  RagV2IngestionPolicy,
  RagV2PassageRecord,
  RagV2SectionRecord,
} from './types.js';

/**
 * One physical line emitted by the streaming line reader, with its byte and
 * line positions in the source file. Overlong lines arrive in consecutive
 * segments flagged with `completesLine: false`.
 */
interface RawLine {
  raw: Buffer;
  text: string;
  startByte: number;
  endByte: number;
  lineNumber: number;
  completesLine: boolean;
}

/**
 * A raw structural block (heading, paragraph, code fence, table, front
 * matter) assembled from consecutive lines, with byte and line extents.
 */
interface RawUnit {
  raw: Buffer;
  text: string;
  type: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  lexicalPrefix?: string;
}

/**
 * Front-matter metadata extracted from a parsed document.
 */
export interface RagV2ParsedMetadata {
  documentType?: string;
  collectionId?: string;
  collectionTitle?: string;
  jurisdiction?: string;
  governingLaw?: string;
  parties: string[];
  publicationDate?: string;
  validFrom?: string;
  validTo?: string;
}

/**
 * Identity inputs the parser stamps onto generated records.
 */
export interface RagV2ParserIdentity {
  workspaceId: string;
  contextId: string;
  documentId: string;
  documentVersionId: string;
  sourcePath?: string;
}

/**
 * Streaming sink receiving sections and passages as they are produced.
 */
export interface RagV2ParserSink {
  /**
   * Called once per completed section.
   * @param section - The section record.
   */
  onSection(section: RagV2SectionRecord): Promise<void>;
  /**
   * Called once per completed passage.
   * @param passage - The passage record.
   */
  onPassage(passage: RagV2PassageRecord): Promise<void>;
  /**
   * Called periodically with the parse's current line/byte progress, awaited
   * before the line is processed.
   * @param line - 1-based line number just reached.
   * @param byteOffset - Byte offset of that line's start in the source file.
   */
  onLineCheckpoint?(line: number, byteOffset: number): Promise<void>;
}

/**
 * Aggregate statistics returned after a full parse.
 */
export interface RagV2ParserResult {
  title: string;
  lineCount: number;
  tableOfContents: RagV2HeadingRef[];
  tableOfContentsTruncated: boolean;
  routingSummary: string;
  languageDistribution: Record<string, number>;
  sectionCount: number;
  passageCount: number;
  peakBufferedBytes: number;
  metadata: RagV2ParsedMetadata;
}

const TABLE_OF_CONTENTS_LIMIT = 10_000;
const ROUTING_SUMMARY_CHARS = 4_000;
const SECTION_SUMMARY_CHARS = 2_000;

/**
 * Computes the SHA-256 hex digest of a string or buffer.
 * @param value - Content to hash.
 * @returns Lowercase hex digest (64 characters).
 * @throws Never.
 */
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Derives a deterministic, collision-resistant identifier by hashing the
 * namespace and value; the fixed version/variant nibbles give the result the
 * shape of a UUID without any randomness.
 * @param namespace - Domain prefix mixed into the hash (e.g. a document
 *   version id), separating id spaces.
 * @param value - Value to identify (e.g. a structural key plus ordinal).
 * @returns UUID-formatted id derived from the SHA-256 digest.
 * @throws Never.
 */
function stableId(namespace: string, value: string): string {
  const hex = digest(`${namespace}\0${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Estimates the token count of a text at roughly four characters per token.
 * @param text - Text to measure, in characters.
 * @returns Estimated token count; never below 1.
 * @throws Never.
 */
function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Detects whether a block of text is a heading and classifies its level.
 * Recognizes ATX (`#`) and Setext (`=`/`-`) Markdown headings, legal clause
 * headings (article/section/§/rozdział/…), and numbered headings like
 * `1.2.3`.
 * @param text - Candidate text; may span two lines for Setext headings.
 * @returns Heading level (1-6) and cleaned heading text, or undefined when
 *   the text is not a heading.
 * @throws Never.
 */
function headingMatch(text: string): { level: number; text: string } | undefined {
  const setext = /^([^\r\n]+)\r?\n(=+|-+)[ \t]*(?:\r?\n)?$/u.exec(text);
  if (setext) return { level: setext[2]![0] === '=' ? 1 : 2, text: setext[1]!.trim() };
  const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(text);
  if (atx) return { level: atx[1]!.length, text: atx[2]!.trim() };
  const clause = /^((?:article|art\.?|chapter|section|clause|annex|appendix|rozdział|artykuł|art\.?|§)\s+[\w.-]+(?:[ \t]+[-–—:]?[ \t]*.*)?)$/iu.exec(text.trim());
  if (clause) return { level: 2, text: clause[1]!.trim() };
  const numbered = /^(\d+(?:\.\d+){1,8}[.)]?[ \t]+\S.*)$/u.exec(text.trim());
  if (numbered) return { level: Math.min(6, numbered[1]!.split('.').length + 1), text: numbered[1]!.trim() };
  return undefined;
}

/**
 * Classifies a unit by its first line.
 * @param lines - The lines composing the unit.
 * @returns One of `code`, `quote`, `list`, `table`, `front_matter`,
 *   `horizontal_rule`, or `paragraph`.
 * @throws Never.
 */
function unitType(lines: readonly RawLine[]): string {
  const first = lines[0]?.text.trim() ?? '';
  if (/^```|^~~~/u.test(first)) return 'code';
  if (/^>/u.test(first)) return 'quote';
  if (/^(?:[-*+]|\d+[.)])[ \t]+/u.test(first)) return 'list';
  if (/^\|.*\|[ \t]*$/u.test(first)) return 'table';
  if (/^---[ \t]*$/u.test(first) && lines.length > 1) return 'front_matter';
  if (/^---[ \t]*$/u.test(first)) return 'horizontal_rule';
  return 'paragraph';
}

/**
 * Trims surrounding whitespace and removes one layer of matching single or
 * double quotes.
 * @param value - Raw front-matter value.
 * @returns The unquoted, trimmed value.
 * @throws Never.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1).trim();
  return trimmed;
}

/**
 * Validates and normalizes a front-matter date value.
 * @param value - Raw value; may be undefined or quoted.
 * @returns The unquoted value when it matches an ISO `YYYY-MM-DD` (optionally
 *   with time/offset) and parses as a date; otherwise undefined.
 * @throws Never.
 */
function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = unquote(value);
  const match = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?$/u.exec(candidate);
  if (!match || Number.isNaN(Date.parse(candidate))) return undefined;
  return candidate;
}

/**
 * Parses a YAML-like front-matter block into document metadata. Recognizes
 * scalar keys and inline or block lists, with several alias spellings per
 * field (e.g. `book_id`/`series_id` for `collectionId`); unknown keys are
 * ignored.
 * @param text - The full front-matter block including both `---` fences; the
 *   first and last lines are skipped.
 * @returns Extracted metadata; absent optional fields are omitted and
 *   `parties` defaults to an empty array.
 * @throws Never.
 */
function parseFrontMatter(text: string): RagV2ParsedMetadata {
  const scalar = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let activeList: string | undefined;
  for (const rawLine of text.split(/\r?\n/u).slice(1, -1)) {
    const item = /^[ \t]*-[ \t]+(.+)$/u.exec(rawLine);
    if (item && activeList) {
      lists.set(activeList, [...(lists.get(activeList) ?? []), unquote(item[1]!)]);
      continue;
    }
    const property = /^[ \t]*([A-Za-z][\w -]{0,63})[ \t]*:[ \t]*(.*)$/u.exec(rawLine);
    if (!property) continue;
    const key = property[1]!.trim().toLocaleLowerCase().replace(/[ _-]+/gu, '_');
    const value = property[2]!.trim();
    activeList = value ? undefined : key;
    if (!value) continue;
    if (value.startsWith('[') && value.endsWith(']')) {
      lists.set(key, value.slice(1, -1).split(',').map(unquote).filter(Boolean));
    } else {
      scalar.set(key, unquote(value));
    }
  }
  const parties = lists.get('parties')
    ?? lists.get('party')
    ?? scalar.get('parties')?.split(/[;,]/u).map(value => value.trim()).filter(Boolean)
    ?? [];
  const documentType = scalar.get('document_type') ?? scalar.get('type');
  const collectionId = scalar.get('collection_id')
    ?? scalar.get('book_id')
    ?? scalar.get('series_id')
    ?? scalar.get('collection')
    ?? scalar.get('book')
    ?? scalar.get('series');
  const collectionTitle = scalar.get('collection_title')
    ?? scalar.get('book_title')
    ?? scalar.get('series_title')
    ?? scalar.get('collection')
    ?? scalar.get('book')
    ?? scalar.get('series');
  const jurisdiction = scalar.get('jurisdiction');
  const governingLaw = scalar.get('governing_law') ?? scalar.get('governinglaw');
  const publicationDate = parseDate(
    scalar.get('publication_date') ?? scalar.get('published') ?? scalar.get('date'),
  );
  const validFrom = parseDate(scalar.get('valid_from') ?? scalar.get('effective_date'));
  const validTo = parseDate(scalar.get('valid_to') ?? scalar.get('expiry_date'));
  return {
    ...(documentType ? { documentType } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(collectionTitle ? { collectionTitle } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    ...(governingLaw ? { governingLaw } : {}),
    parties,
    ...(publicationDate ? { publicationDate } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

/**
 * Joins the raw bytes of a unit's lines, returning the single buffer directly
 * when there is only one line.
 * @param lines - Non-empty line list.
 * @returns Concatenated raw bytes of all lines.
 * @throws Never.
 */
function concatenateRaw(lines: readonly RawLine[]): Buffer {
  return lines.length === 1 ? lines[0]!.raw : Buffer.concat(lines.map(line => line.raw));
}

/**
 * Reads a file as newline-delimited lines without loading it fully into
 * memory. Lines longer than the buffering budget are split into consecutive
 * segments flagged with `completesLine: false`, cutting only on complete
 * UTF-8 sequences.
 * @param filePath - File to read.
 * @param maxBufferedBytes - Overall buffering budget in bytes; scales the
 *   read chunk size and the maximum line segment size.
 * @returns Yields {@link RawLine} records in file order with absolute byte
 *   offsets and 1-based line numbers, including a final unterminated line if
 *   present.
 * @throws Error - if the file cannot be opened or the stream fails.
 */
async function* streamLines(filePath: string, maxBufferedBytes: number): AsyncGenerator<RawLine> {
  const highWaterMark = Math.max(64 * 1024, Math.min(1024 * 1024, Math.floor(maxBufferedBytes / 4)));
  const maxLineSegment = Math.max(64 * 1024, Math.floor(maxBufferedBytes / 4));
  let carry = Buffer.alloc(0);
  let byteOffset = 0;
  let lineNumber = 1;

  for await (const value of createReadStream(filePath, { highWaterMark })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let cursor = 0;
    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0A, cursor);
      if (newline >= 0) {
        const raw = buffer.subarray(cursor, newline + 1);
        const bodyEnd = raw.length >= 2 && raw[raw.length - 2] === 0x0D ? raw.length - 2 : raw.length - 1;
        yield {
          raw,
          text: raw.subarray(0, bodyEnd).toString('utf8'),
          startByte: byteOffset,
          endByte: byteOffset + raw.length,
          lineNumber,
          completesLine: true,
        };
        byteOffset += raw.length;
        lineNumber++;
        cursor = newline + 1;
        continue;
      }
      const remaining = buffer.length - cursor;
      if (remaining > maxLineSegment) {
        let length = maxLineSegment;
        while (
          length > 1
          && cursor + length < buffer.length
          && (buffer[cursor + length]! & 0xC0) === 0x80
        ) {
          length--;
        }
        const raw = buffer.subarray(cursor, cursor + length);
        yield {
          raw,
          text: raw.toString('utf8'),
          startByte: byteOffset,
          endByte: byteOffset + raw.length,
          lineNumber,
          completesLine: false,
        };
        byteOffset += raw.length;
        cursor += length;
        continue;
      }
      carry = Buffer.from(buffer.subarray(cursor));
      cursor = buffer.length;
    }
    if (cursor === buffer.length && buffer.length > 0 && buffer[buffer.length - 1] === 0x0A) carry = Buffer.alloc(0);
  }

  if (carry.length > 0) {
    yield {
      raw: carry,
      text: carry.toString('utf8'),
      startByte: byteOffset,
      endByte: byteOffset + carry.length,
      lineNumber,
      completesLine: true,
    };
  }
}

/**
 * Groups streamed lines into structural units. Headings become standalone
 * units; fenced code and front matter stay together; other content is cut on
 * blank lines or when buffered bytes reach a quarter of the budget. Line
 * checkpoints are reported at the first line and every `lineIndexStride`
 * lines thereafter.
 * @param filePath - File to read.
 * @param maxBufferedBytes - Buffering budget in bytes passed through to
 *   {@link streamLines}; also sets the unit flush threshold.
 * @param lineIndexStride - Interval in lines between checkpoint callbacks.
 * @param onLineCheckpoint - Optional async callback invoked with the 1-based
 *   line number and byte offset at each checkpoint.
 * @returns Yields {@link RawUnit} records in file order.
 * @throws Error - if reading the file fails or a checkpoint callback rejects.
 */
async function* streamUnits(
  filePath: string,
  maxBufferedBytes: number,
  lineIndexStride: number,
  onLineCheckpoint?: (line: number, byteOffset: number) => Promise<void>,
): AsyncGenerator<RawUnit> {
  let lines: RawLine[] = [];
  let fenced = false;
  let fenceMarker = '';
  let frontMatter = false;
  let bufferedBytes = 0;

  /**
   * Joins the buffered lines into one unit and resets the buffer.
   * @returns The completed unit, or undefined when nothing is buffered.
   * @throws Never.
   */
  const flush = (): RawUnit | undefined => {
    if (lines.length === 0) return undefined;
    const raw = concatenateRaw(lines);
    const result: RawUnit = {
      raw,
      text: raw.toString('utf8'),
      type: unitType(lines),
      startByte: lines[0]!.startByte,
      endByte: lines.at(-1)!.endByte,
      startLine: lines[0]!.lineNumber,
      endLine: lines.at(-1)!.lineNumber,
    };
    lines = [];
    bufferedBytes = 0;
    return result;
  };

  for await (const line of streamLines(filePath, maxBufferedBytes)) {
    if (onLineCheckpoint && (line.lineNumber === 1 || line.lineNumber % lineIndexStride === 1)) {
      await onLineCheckpoint(line.lineNumber, line.startByte);
    }
    const trimmed = line.text.trim();
    const fence = /^(?:```|~~~)/u.test(trimmed);
    if (line.lineNumber === 1 && trimmed === '---') frontMatter = true;
    if (!fenced && !frontMatter && headingMatch(line.text)) {
      const pending = flush();
      if (pending) yield pending;
      yield {
        raw: line.raw,
        text: line.raw.toString('utf8'),
        type: 'heading',
        startByte: line.startByte,
        endByte: line.endByte,
        startLine: line.lineNumber,
        endLine: line.lineNumber,
      };
      continue;
    }
    lines.push(line);
    bufferedBytes += line.raw.length;
    if (fenced) {
      if (fence && trimmed.startsWith(fenceMarker)) {
        fenced = false;
        fenceMarker = '';
        const pending = flush();
        if (pending) yield { ...pending, type: 'code' };
      } else if (bufferedBytes >= Math.floor(maxBufferedBytes / 4)) {
        const pending = flush();
        if (pending) yield { ...pending, type: 'code' };
      }
      continue;
    }
    if (frontMatter) {
      if (line.lineNumber > 1 && trimmed === '---') {
        frontMatter = false;
        const pending = flush();
        if (pending) yield { ...pending, type: 'front_matter' };
      }
      continue;
    }
    if (fence) {
      fenced = true;
      fenceMarker = trimmed.slice(0, 3);
      continue;
    }
    if (!trimmed || bufferedBytes >= Math.floor(maxBufferedBytes / 4)) {
      const pending = flush();
      if (pending) yield pending;
    }
  }
  const pending = flush();
  if (pending) yield pending;
}

/**
 * Splits an oversized unit into byte-bounded parts no larger than
 * `hardMaxTokens * 4` bytes (minimum 1024), cutting only on complete UTF-8
 * sequences and tracking line offsets. Later parts of a split table carry the
 * table's first two lines as a `lexicalPrefix`.
 * @param unit - The unit to split; returned unchanged when within budget.
 * @param hardMaxTokens - Hard per-passage token limit, converted to bytes at
 *   four bytes per token.
 * @returns One or more parts covering the unit's full byte range in order.
 * @throws Never.
 */
function splitUnit(unit: RawUnit, hardMaxTokens: number): RawUnit[] {
  const maxBytes = Math.max(1024, hardMaxTokens * 4);
  if (unit.raw.length <= maxBytes) return [unit];
  const parts: RawUnit[] = [];
  const tableHeader = unit.type === 'table'
    ? unit.text.split(/\r?\n/u).slice(0, 2).join('\n').trim()
    : '';
  let cursor = 0;
  let lineOffset = 0;
  while (cursor < unit.raw.length) {
    let end = Math.min(unit.raw.length, cursor + maxBytes);
    while (end > cursor + 1 && end < unit.raw.length && (unit.raw[end]! & 0xC0) === 0x80) end--;
    const raw = unit.raw.subarray(cursor, end);
    const lineCount = raw.reduce((count, byte) => count + (byte === 0x0A ? 1 : 0), 0);
    parts.push({
      raw: Buffer.from(raw),
      text: raw.toString('utf8'),
      type: unit.type,
      startByte: unit.startByte + cursor,
      endByte: unit.startByte + end,
      startLine: unit.startLine + lineOffset,
      endLine: Math.max(unit.startLine + lineOffset, unit.startLine + lineOffset + lineCount),
      ...(unit.type === 'table' && cursor > 0 && tableHeader
        ? { lexicalPrefix: `${tableHeader}\n` }
        : {}),
    });
    lineOffset += lineCount;
    cursor = end;
  }
  return parts;
}

/**
 * Streams a Markdown file into sections and passages, emitting each through
 * `sink` without holding the whole file in memory.
 * @param filePath - File to parse.
 * @param identity - Identity stamped onto generated records.
 * @param policy - Passage sizing and buffering limits.
 * @param sink - Receiver for sections/passages (and optional checkpoints).
 * @param signal - Abort signal cancelling the parse; when omitted the parse
 *   runs to completion.
 * @returns Parse statistics and extracted metadata.
 * @throws Whatever `signal.reason` holds once the signal is aborted (an
 *   `Error` is used when no reason is set), or the first sink rejection.
 */
export async function parseMarkdownStream(
  filePath: string,
  identity: RagV2ParserIdentity,
  policy: RagV2IngestionPolicy,
  sink: RagV2ParserSink,
  signal?: AbortSignal,
): Promise<RagV2ParserResult> {
  const headingPath: string[] = [];
  const headingOrdinals = new Map<string, number>();
  const tableOfContents: RagV2HeadingRef[] = [];
  const documentSummary: string[] = [];
  const documentLanguages: Record<string, number> = {};
  const fallbackTitle = path.basename(identity.sourcePath ?? filePath);
  let title = fallbackTitle;
  let sectionCount = 0;
  let passageCount = 0;
  let lineCount = 0;
  let peakBufferedBytes = 0;
  let metadata: RagV2ParsedMetadata = { parties: [] };

  let section: {
    id: string;
    ordinal: number;
    type: string;
    headingPath: string[];
    headingText: string;
    startByte: number;
    endByte: number;
    startLine: number;
    endLine: number;
    hash: ReturnType<typeof createHash>;
    tokens: number;
    summary: string;
    languageTotals: Record<string, number>;
  } | undefined;

  let passageUnits: RawUnit[] = [];
  let passageTokens = 0;
  let previousPassage: RagV2PassageRecord | undefined;

  /**
   * Starts a new section keyed by the current heading path and type, with a
   * per-path ordinal keeping ids stable across re-parses.
   * @param unit - The unit opening the section; supplies its start position.
   * @param type - Structural type of the section.
   * @param text - Heading text used as the section's title.
   * @returns Nothing; `section`, `sectionCount`, and `headingOrdinals` are
   *   updated in place.
   * @throws Never.
   */
  const openSection = (unit: RawUnit, type: string, text: string): void => {
    const structuralKey = `${headingPath.join(' > ')}\0${type}`;
    const samePathOrdinal = (headingOrdinals.get(structuralKey) ?? 0) + 1;
    headingOrdinals.set(structuralKey, samePathOrdinal);
    section = {
      id: stableId(identity.documentVersionId, `${structuralKey}\0${samePathOrdinal}`),
      ordinal: sectionCount,
      type,
      headingPath: [...headingPath],
      headingText: text,
      startByte: unit.startByte,
      endByte: unit.endByte,
      startLine: unit.startLine,
      endLine: unit.endLine,
      hash: createHash('sha256'),
      tokens: 0,
      summary: '',
      languageTotals: {},
    };
    sectionCount++;
  };

  /**
   * Opens a document-root section when none is open, so content before the
   * first heading is still captured.
   * @param unit - The unit about to be consumed.
   * @returns Nothing.
   * @throws Never.
   */
  const ensureSection = (unit: RawUnit): void => {
    if (!section) openSection(unit, 'document_root', title);
  };

  /**
   * Delivers the held-back previous passage to the sink, linking it forward
   * to `nextPassageId` when supplied. Passages are held back one step so each
   * is emitted only once its successor's id is known.
   * @param nextPassageId - Passage id of the following passage, when known.
   * @returns A promise resolving once the sink has processed the passage.
   * @throws Error - if the sink's `onPassage` rejects.
   */
  const emitPreviousPassage = async (nextPassageId?: string): Promise<void> => {
    if (!previousPassage) return;
    await sink.onPassage(nextPassageId ? { ...previousPassage, nextPassageId } : previousPassage);
    previousPassage = undefined;
  };

  /**
   * Builds a {@link RagV2PassageRecord} from the buffered units (concatenating
   * lexical prefixes for split tables), detects its language, updates section
   * and document language/token totals and rolling summaries, and holds it as
   * `previousPassage` until the next passage is built.
   * @returns A promise resolving once the previous passage has been emitted.
   * @throws Error - if the sink's `onPassage` rejects.
   */
  const flushPassage = async (): Promise<void> => {
    if (passageUnits.length === 0 || !section) return;
    const raw = passageUnits.length === 1
      ? passageUnits[0]!.raw
      : Buffer.concat(passageUnits.map(unit => unit.raw));
    const text = raw.toString('utf8');
    const lexicalText = `${passageUnits.map(unit => unit.lexicalPrefix ?? '').join('')}${text}`;
    const language = detectPassageLanguage(text);
    const ordinal = passageCount;
    const passageId = stableId(section.id, `${ordinal}\0${digest(raw)}`);
    const passage: RagV2PassageRecord = {
      passageId,
      documentId: identity.documentId,
      documentVersionId: identity.documentVersionId,
      sectionId: section.id,
      workspaceId: identity.workspaceId,
      contextId: identity.contextId,
      ordinal,
      headingPath: [...section.headingPath],
      structuralType: passageUnits[0]!.type,
      startByte: passageUnits[0]!.startByte,
      endByte: passageUnits.at(-1)!.endByte,
      startLine: passageUnits[0]!.startLine,
      endLine: passageUnits.at(-1)!.endLine,
      ...(previousPassage ? { previousPassageId: previousPassage.passageId } : {}),
      language: language.primary,
      languageConfidence: language.confidence,
      languageDistribution: language.distribution,
      script: language.script,
      contentSha256: digest(raw),
      tokenCount: tokenEstimate(text),
      text,
      ...(lexicalText !== text ? { lexicalText } : {}),
      lexicalState: 'ready',
      embeddingState: 'not_planned',
    };
    await emitPreviousPassage(passageId);
    previousPassage = passage;
    passageCount++;
    for (const [code, weight] of Object.entries(language.distribution)) {
      documentLanguages[code] = (documentLanguages[code] ?? 0) + weight * passage.tokenCount;
      section.languageTotals[code] = (section.languageTotals[code] ?? 0) + weight * passage.tokenCount;
    }
    section.hash.update(raw);
    section.tokens += passage.tokenCount;
    section.endByte = passage.endByte;
    section.endLine = passage.endLine;
    if (section.summary.length < SECTION_SUMMARY_CHARS) {
      section.summary = `${section.summary} ${text.replace(/\s+/gu, ' ').trim()}`.trim().slice(0, SECTION_SUMMARY_CHARS);
    }
    if (documentSummary.join(' ').length < ROUTING_SUMMARY_CHARS) {
      documentSummary.push(text.replace(/\s+/gu, ' ').trim().slice(0, 1_000));
    }
    passageUnits = [];
    passageTokens = 0;
  };

  /**
   * Flushes the open passage and emits the open section with its content
   * hash, token total, dominant language, and routing summary.
   * @returns A promise resolving once the sink has processed the section.
   * @throws Error - if the sink's `onSection` or `onPassage` rejects.
   */
  const closeSection = async (): Promise<void> => {
    await flushPassage();
    if (!section) return;
    const total = Object.values(section.languageTotals).reduce((sum, value) => sum + value, 0);
    const rankedLanguages = Object.entries(section.languageTotals).sort((left, right) => right[1] - left[1]);
    const best = rankedLanguages[0];
    await sink.onSection({
      sectionId: section.id,
      documentId: identity.documentId,
      documentVersionId: identity.documentVersionId,
      workspaceId: identity.workspaceId,
      contextId: identity.contextId,
      ordinal: section.ordinal,
      structuralType: section.type,
      headingPath: section.headingPath,
      headingText: section.headingText,
      startByte: section.startByte,
      endByte: section.endByte,
      startLine: section.startLine,
      endLine: section.endLine,
      language: best && best[1] > 0 ? best[0] : 'und',
      languageConfidence: best && total > 0 ? best[1] / total : 0,
      contentSha256: section.hash.digest('hex'),
      tokenCount: section.tokens,
      routingSummary: section.summary || section.headingText,
      embeddingState: 'not_planned',
    });
    section = undefined;
  };

  for await (const sourceUnit of streamUnits(
    filePath,
    policy.parserMemoryBytes,
    policy.lineIndexStride,
    sink.onLineCheckpoint,
  )) {
    if (signal?.aborted) throw signal.reason ?? new Error('Workspace RAG V2 parsing cancelled.');
    lineCount = Math.max(lineCount, sourceUnit.endLine);
    peakBufferedBytes = Math.max(
      peakBufferedBytes,
      sourceUnit.raw.length + passageUnits.reduce((sum, unit) => sum + unit.raw.length, 0),
    );
    const heading = headingMatch(sourceUnit.text.trimEnd());
    if (sourceUnit.type === 'front_matter') {
      metadata = parseFrontMatter(sourceUnit.text);
      // Front matter controls routing and filtering. It is not source prose and
      // must not become a passage that can be returned as citation evidence.
      continue;
    }
    if (heading) {
      await closeSection();
      headingPath.length = Math.min(headingPath.length, Math.max(0, heading.level - 1));
      headingPath.push(heading.text);
      if (title === fallbackTitle) title = heading.text;
      if (tableOfContents.length < TABLE_OF_CONTENTS_LIMIT) {
        tableOfContents.push({
          level: heading.level,
          text: heading.text,
          line: sourceUnit.startLine,
          byte: sourceUnit.startByte,
        });
      }
      openSection(sourceUnit, 'heading', heading.text);
    }

    ensureSection(sourceUnit);
    const previousType = passageUnits.at(-1)?.type;
    if (
      passageUnits.length > 0
      && previousType !== sourceUnit.type
      && (
        ['code', 'table', 'front_matter'].includes(previousType ?? '')
        || ['code', 'table', 'front_matter'].includes(sourceUnit.type)
      )
    ) {
      await flushPassage();
    }
    for (const unit of splitUnit(sourceUnit, policy.hardMaxPassageTokens)) {
      const unitTokens = tokenEstimate(unit.text);
      if (passageUnits.length > 0 && passageTokens + unitTokens > policy.targetPassageTokens) {
        await flushPassage();
      }
      passageUnits.push(unit);
      passageTokens += unitTokens;
      if (passageTokens >= policy.hardMaxPassageTokens) await flushPassage();
    }
  }

  await closeSection();
  await emitPreviousPassage();
  const languageTotal = Object.values(documentLanguages).reduce((sum, value) => sum + value, 0);
  const languageDistribution = languageTotal > 0
    ? Object.fromEntries(Object.entries(documentLanguages).map(([code, weight]) => [code, weight / languageTotal]))
    : {};
  return {
    title,
    lineCount,
    tableOfContents,
    tableOfContentsTruncated: tableOfContents.length >= TABLE_OF_CONTENTS_LIMIT,
    routingSummary: documentSummary.join(' ').slice(0, ROUTING_SUMMARY_CHARS),
    languageDistribution,
    sectionCount,
    passageCount,
    peakBufferedBytes,
    metadata,
  };
}
