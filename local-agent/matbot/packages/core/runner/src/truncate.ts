import type { FileStore } from './types.js';

/** Caps applied to every tool result before it enters model context. */
export interface ToolOutputLimits {
  /** Byte cap on the serialized result. Default 51200. */
  maxBytes?: number;
  /** Line cap for string results. Default 2000. */
  maxLines?: number;
}

export const DEFAULT_OUTPUT_LIMITS: Required<ToolOutputLimits> = {
  maxBytes: 51200,
  maxLines: 2000,
};

export interface TruncationOutcome {
  result: unknown;
  truncated: boolean;
  totalBytes?: number;
  savedTo?: string;
}

function serialize(result: unknown): string {
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result, null, 2) ?? String(result); }
  catch { return String(result); }
}

async function saveFullOutput(
  files: FileStore,
  name: string,
  text: string,
): Promise<string | undefined> {
  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    async function* chunks(): AsyncIterable<Uint8Array> {
      const size = 64 * 1024;
      for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, Math.min(i + size, bytes.length));
      }
    }
    const handle = await files.putTemp(name, 'text/plain', chunks());
    return handle.name ?? handle.id;
  } catch {
    return undefined;
  }
}

/**
 * Enforce the universal output policy on one tool result (spec R16). Strings are capped by line
 * and byte count with a head/tail preview plus an explicit re-read hint; structured results whose
 * serialization overflows the byte cap are replaced with a truncated envelope that preserves a
 * preview and, when a FileStore is available, points at the full persisted output.
 */
export async function truncateToolResult(
  result: unknown,
  limits: ToolOutputLimits | undefined,
  files?: FileStore,
  saveName?: string,
): Promise<TruncationOutcome> {
  const maxBytes = limits?.maxBytes ?? DEFAULT_OUTPUT_LIMITS.maxBytes;
  const maxLines = limits?.maxLines ?? DEFAULT_OUTPUT_LIMITS.maxLines;

  if (typeof result === 'string') {
    const lines = result.split('\n');
    let text = lines.length > maxLines
      ? [...lines.slice(0, maxLines), `…${lines.length - maxLines} more lines (use offset/limit reads to page through)`].join('\n')
      : result;
    const encoded = new TextEncoder().encode(text);
    if (encoded.length > maxBytes) {
      const head = Math.floor(maxBytes * 0.7);
      const tail = Math.max(0, maxBytes - head - 120);
      const full = text;
      text = `${text.slice(0, head)}\n…[${encoded.length - head - tail} bytes truncated]…\n${tail > 0 ? text.slice(-tail) : ''}`;
      const savedTo = files !== undefined && saveName !== undefined ? await saveFullOutput(files, saveName, full) : undefined;
      return {
        result: `${text}\n[output truncated at ${maxBytes} bytes${savedTo !== undefined ? ` — full output saved as file "${savedTo}"` : ''}]`,
        truncated: true,
        totalBytes: encoded.length,
        ...(savedTo !== undefined ? { savedTo } : {}),
      };
    }
    return lines.length > maxLines ? { result: text, truncated: true, totalBytes: encoded.length } : { result, truncated: false };
  }

  if (result === null || result === undefined || typeof result !== 'object') {
    return { result, truncated: false };
  }

  const serialized = serialize(result);
  const totalBytes = new TextEncoder().encode(serialized).length;
  if (totalBytes <= maxBytes) return { result, truncated: false };

  const preview = serialized.slice(0, Math.min(maxBytes, 4000));
  const savedTo = files !== undefined && saveName !== undefined ? await saveFullOutput(files, saveName, serialized) : undefined;
  return {
    result: {
      truncated: true,
      totalBytes,
      preview,
      hint: 'The tool result exceeded the output limit and was replaced with this preview.'
        + (savedTo !== undefined ? ` Full output saved as file "${savedTo}".` : '')
        + ' Re-run with narrower parameters (pagination, filters, ranges) instead of re-reading everything.',
    },
    truncated: true,
    totalBytes,
    ...(savedTo !== undefined ? { savedTo } : {}),
  };
}
