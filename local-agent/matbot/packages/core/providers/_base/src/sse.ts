// Parses a Server-Sent Events stream into data payloads.
// Uses only Web APIs (ReadableStream, TextDecoder) — works in Node 24+ and browsers.
const MAX_BUFFER_CHARS = 1_048_576;

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
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        // SSE spec: the field value starts after a single colon; the following optional
        // space is stripped — so both `data: x` and `data:x` carry payload "x".
        if (line.startsWith('data:')) {
          const data = line[5] === ' ' ? line.slice(6) : line.slice(5);
          if (data === '[DONE]') return;
          yield data;
        }
      }
      // A stream that never emits a newline would otherwise grow memory without bound.
      if (buffer.length > MAX_BUFFER_CHARS) {
        throw new Error(`SSE stream exceeded ${MAX_BUFFER_CHARS} buffered characters without a newline`);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
