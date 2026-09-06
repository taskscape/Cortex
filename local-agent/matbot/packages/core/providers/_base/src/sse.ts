// Parses a Server-Sent Events stream into data payloads.
// Uses only Web APIs (ReadableStream, TextDecoder) — works in Node 24+ and browsers.
const MAX_BUFFER_CHARS = 1_048_576;

/** One meaningful SSE frame, including the OpenAI-style `[DONE]` sentinel when present. */
export type SSEFrame = { type: 'data'; data: string } | { type: 'done' };

/**
 * Parse framed SSE data, joining multiple `data:` lines exactly as SSE specifies. Comments and
 * non-data fields are ignored. Unlike {@link parseSSE}, this lower-level form exposes the
 * terminal sentinel so gateways can require it before releasing buffered tool calls.
 */
export async function* parseSSEFrames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<SSEFrame> {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });

  const dispatch = async function* (): AsyncIterable<SSEFrame> {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') {
      yield { type: 'done' };
      return;
    }
    yield { type: 'data', data };
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          let terminated = false;
          for await (const frame of dispatch()) {
            yield frame;
            terminated ||= frame.type === 'done';
          }
          if (terminated) return;
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          dataLines.push(line[5] === ' ' ? line.slice(6) : line.slice(5));
        }
      }
      if (buffer.length > MAX_BUFFER_CHARS) {
        throw new Error(`SSE stream exceeded ${MAX_BUFFER_CHARS} buffered characters without a newline`);
      }
    }
    // Flush a final split UTF-8 code point before examining an unterminated final frame.
    buffer += decoder.decode();
    // Some otherwise-valid implementations omit the final blank line. Preserve their last
    // complete data frame, but do not manufacture a missing `[DONE]` sentinel.
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, '');
      if (line.startsWith('data:')) dataLines.push(line[5] === ' ' ? line.slice(6) : line.slice(5));
    }
    yield* dispatch();
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Parse a Server-Sent Events stream into its `data:` payloads. Uses only Web APIs
 * (ReadableStream, TextDecoder), so it works in Node 24+ and browsers. `[DONE]` sentinels
 * terminate consumption; each yielded string is the raw data-line content for the caller to
 * JSON-parse. Non-`data:` lines (comments, `event:`/`id:`/`retry:` fields) are skipped, and the
 * optional single space after the colon is stripped.
 *
 * @param body - The HTTP response body stream.
 * @param signal - Optional cancellation signal; when it fires (or has already fired) the
 *                 underlying reader is cancelled and iteration ends.
 * @returns An async iterable of SSE `data:` payload strings, in stream order.
 * @throws The abort `signal`'s reason when it fires during consumption.
 * @throws If the buffer exceeds the maximum size without a newline (a malformed/unbounded stream).
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  for await (const frame of parseSSEFrames(body, signal)) {
    if (frame.type === 'done') return;
    yield frame.data;
  }
}
