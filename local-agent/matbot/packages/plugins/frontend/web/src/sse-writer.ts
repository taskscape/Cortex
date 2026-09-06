/**
 * Serializes a value as a Server-Sent Events `data:` line.
 *
 * Returned string ends with the double-newline required by the SSE spec.
 * Safe to write directly to any writable stream.
 *
 * @param event - SSE event name the client demultiplexes on.
 * @param data - Value serialised as JSON into the `data:` field.
 * @returns The complete SSE frame, terminated by a blank line.
 * @throws TypeError - If `data` cannot be serialised to JSON (e.g. a circular structure).
 */
export function sseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

/**
 * Serializes an SSE comment (keep-alive) line.
 * @param text Comment text.
 * @returns The comment terminated by the double-newline the SSE spec requires.
 * @throws Never.
 */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
