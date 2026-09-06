/** A Telegram Bot API `update` object (only the fields this frontend consumes). */
export interface TelegramUpdate {
  /** Monotonic update id used as the long-poll offset. */
  update_id: number;
  /** The message carried by the update, if any. */
  message?: TelegramMessage;
}

/** A Telegram Bot API `message` object (only the fields this frontend consumes). */
export interface TelegramMessage {
  /** Message id within the chat. */
  message_id: number;
  /** Chat the message belongs to. */
  chat: { id: number; type: string };
  /** Sender identity, absent for channel posts. */
  from?: { id: number; first_name?: string; username?: string };
  /** Message text, absent for non-text messages. */
  text?: string;
}

const API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS   = 15_000;
const SEND_MAX_ATTEMPTS = 3;
const ACTION_TIMEOUT_MS = 5_000;
const POLL_SLACK_MS     = 10_000;

/**
 * Waits for a fixed delay.
 *
 * @param ms - Milliseconds to wait.
 * @returns Resolves once the delay has elapsed; not abortable.
 * @throws Never.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POSTs a JSON payload to the Bot API, retrying on 429 rate-limit responses.
 *
 * Each attempt is bounded by a 15-second timeout in addition to any caller signal. On 429 the
 * server-advised `retry_after` (clamped to 1–30 seconds) is awaited before the next attempt, up to
 * three attempts in total; any other status is returned for the caller to judge.
 *
 * @param url - Absolute Bot API endpoint URL.
 * @param payload - Value serialised as the JSON request body.
 * @param signal - Optional caller cancellation signal, combined with the per-attempt timeout.
 * @returns The final `Response`, which may still be a non-2xx.
 * @throws Error - If the fetch itself fails (network error, timeout, or caller abort).
 */
async function postWithRetry(
  url: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 1;; attempt++) {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(payload),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(SEND_TIMEOUT_MS),
      ]),
    });
    if (res.status === 429 && attempt < SEND_MAX_ATTEMPTS) {
      const body = await res.json().catch(() => undefined) as { parameters?: { retry_after?: number } } | undefined;
      await sleep(Math.min(Math.max(body?.parameters?.retry_after ?? 1, 1), 30) * 1000);
      continue;
    }
    return res;
  }
}

/**
 * Sends a chat message, splitting it into 4096-unit chunks and retrying on
 * Telegram's 429 rate-limit responses.
 * @param botToken Bot API token.
 * @param chatId Target chat id.
 * @param text Text to send.
 * @param signal Optional cancellation signal.
 * @returns Resolves once every chunk has been accepted by the Bot API.
 * @throws If the API returns a non-OK response for any chunk.
 */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const chunk of splitText(text)) {
    const res = await postWithRetry(`${API}/bot${botToken}/sendMessage`, { chat_id: chatId, text: chunk }, signal);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`sendMessage failed: ${res.status} ${body}`);
    }
  }
}

/**
 * Sends a transient chat action indicator (e.g. "typing").
 * @param botToken Bot API token.
 * @param chatId Target chat id.
 * @param action Action name; defaults to "typing".
 * @returns Resolves once the request has been sent; the response status is not checked.
 * @throws TypeError - On network failure, or an abort error if the 5-second timeout elapses.
 */
export async function sendChatAction(
  botToken: string,
  chatId: number,
  action = 'typing',
): Promise<void> {
  await fetch(`${API}/bot${botToken}/sendChatAction`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action }),
    signal:  AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
}

/** Envelope of the Bot API `getUpdates` call: the usual `ok` flag plus the update list. */
interface GetUpdatesResponse { ok: boolean; result: TelegramUpdate[] }

/**
 * Long-polls Telegram for new updates.
 * @param botToken Bot API token.
 * @param offset First update_id to return (last seen + 1).
 * @param timeout Long-poll seconds the server should hold the connection.
 * @param signal Cancellation signal.
 * @returns The new updates, in id order.
 * @throws On non-OK HTTP status, non-JSON body, or `ok=false` responses.
 */
export async function getUpdates(
  botToken: string,
  offset: number,
  timeout: number,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const url =
    `${API}/bot${botToken}/getUpdates` +
    `?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  // A client-side deadline slightly past the long-poll timeout keeps a black-holed
  // TCP connection from stalling the poll loop forever.
  const res = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000 + POLL_SLACK_MS)]),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getUpdates failed: ${res.status} ${body}`);
  }
  let data: GetUpdatesResponse;
  try {
    data = await res.json() as GetUpdatesResponse;
  } catch {
    throw new Error('Telegram getUpdates returned a non-JSON response');
  }
  if (!data.ok) throw new Error('Telegram getUpdates returned ok=false');
  return data.result;
}

// Telegram limits messages to 4096 UTF-16 code units.
/**
 * Splits text into chunks of at most 4096 UTF-16 code units (Telegram's message limit).
 *
 * Chunks break at the last space, newline, or tab before the limit; when no such boundary exists
 * within the window (or it would produce an empty chunk), the chunk is cut hard at the limit so
 * progress is always made.
 *
 * @param text - Text to split; returned unchanged as a single chunk when within the limit.
 * @param max - Chunk size cap in UTF-16 code units; defaults to 4096.
 * @returns The chunks, in order, each within `max` and concatenating back to `text`.
 * @throws Never.
 */
function *splitText(text: string, max = 4096): Iterable<string> {
  if (text.length <= max) {
    yield text;
    return;
  }
  let i = 0;
  while(i < text.length) {
    const limit = i + max;
    const cut   = Math.max(
      text.lastIndexOf(' ', limit),
      text.lastIndexOf('\n', limit),
      text.lastIndexOf('\t', limit),
    );
    // A boundary at or before i would yield an empty chunk forever; advance by a
    // full window instead. cut < limit keeps each chunk within `max`.
    const end = cut > i && cut < limit ? cut + 1 : limit;
    yield text.slice(i, end);
    i = end;
  }
}
