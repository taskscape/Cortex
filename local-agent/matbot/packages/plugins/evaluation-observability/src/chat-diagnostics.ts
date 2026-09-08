import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObservabilityEvent } from '@matatbread/matbot-plugin-api';

/** Directory name, relative to a workspace's runtime `.data` directory, for chat audit logs. */
export const CHAT_DIAGNOSTIC_DIRECTORY = 'chat-diagnostics';
/** Keep locally persisted chat diagnostics for one week. */
export const CHAT_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** One JSONL record written for a session-correlated observability event. */
export interface ChatDiagnosticEntry {
  schemaVersion: 1;
  recordedAt: string;
  event: ObservabilityEvent;
}

/**
 * Returns a stable, path-safe per-session log filename without exposing a raw
 * session id in the directory listing. The id remains in each JSONL record so
 * operators can associate a log with the chat they are investigating.
 *
 * @param sessionId Session whose timeline is being recorded.
 * @returns A deterministic `.jsonl` filename.
 * @throws Never.
 */
export function chatDiagnosticFileName(sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return `session-${hash}.jsonl`;
}

/**
 * Deletes only regular JSONL chat diagnostics whose modification time is
 * strictly older than the configured retention window. It intentionally does
 * not traverse subdirectories or touch any other workspace runtime state.
 *
 * @param directory Exact chat-diagnostic directory to maintain.
 * @param nowMs Clock override for deterministic tests.
 * @param retentionMs Maximum log age; defaults to one week.
 * @returns Number of logs removed.
 * @throws Propagates directory creation or enumeration failures.
 */
export async function pruneChatDiagnosticLogs(
  directory: string,
  nowMs = Date.now(),
  retentionMs = CHAT_DIAGNOSTIC_RETENTION_MS,
): Promise<number> {
  await mkdir(directory, { recursive: true });
  const cutoff = nowMs - retentionMs;
  const entries = await readdir(directory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = join(directory, entry.name);
    const details = await stat(filePath);
    if (details.mtimeMs >= cutoff) continue;
    await unlink(filePath);
    removed++;
  }
  return removed;
}

/**
 * Serializes the already-sanitized observability timeline into one append-only
 * JSONL file per chat session. Events without a session id still live in the
 * normal observability stores, but are intentionally omitted here because
 * they cannot be assigned to a chat file.
 */
export class ChatDiagnosticJournal {
  private writeTail: Promise<void> = Promise.resolve();
  readonly directory: string;

  /**
   * @param directory Exact directory in which per-session logs reside.
   */
  constructor(directory: string) {
    this.directory = directory;
  }

  /**
   * Prepares the journal at Cortex startup and applies the one-week retention
   * policy before new chat events are accepted.
   *
   * @returns Number of old logs removed.
   * @throws Propagates filesystem failures so the caller can report them.
   */
  initialize(): Promise<number> {
    return pruneChatDiagnosticLogs(this.directory);
  }

  /**
   * Appends one event to the owning chat log. Writes are globally serialized,
   * preserving the event-observation order even when parallel tool calls end
   * at nearly the same time.
   *
   * @param event Sanitized event to append.
   * @returns Resolves when the line has been durably appended, or immediately
   *   when the event has no session correlation.
   * @throws Propagates a filesystem failure for the caller to log and contain.
   */
  record(event: ObservabilityEvent): Promise<void> {
    if (event.sessionId === undefined || event.sessionId.length === 0) return Promise.resolve();
    const line = `${JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), event } satisfies ChatDiagnosticEntry)}\n`;
    const filePath = join(this.directory, chatDiagnosticFileName(event.sessionId));
    const write = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(filePath, line, 'utf8');
    });
    this.writeTail = write;
    return write;
  }
}
