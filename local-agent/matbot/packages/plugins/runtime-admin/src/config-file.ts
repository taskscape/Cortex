import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const queues = new Map<string, Promise<unknown>>();
/**
 * Computes the concurrency version token for a configuration file's current text.
 * @param text - Full file contents as read (UTF-8); any byte change yields a different token.
 * @returns Lowercase hex SHA-256 digest of the text; pass it back as `expectedVersion` to
 *   {@link mutateConfigurationFile} for compare-and-swap semantics.
 * @throws Never.
 */
export const configurationVersion = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * Atomic replacement shared by configuration administration and legacy provider/plugin tools.
 *
 * Serializes all mutations of one file through a per-file promise queue (keyed by resolved absolute
 * path), so concurrent callers never interleave read-modify-write cycles. Inside the queue it
 * re-reads the file twice: once to hand to `change` (optionally guarded by `expectedVersion`) and
 * once more just before committing, to detect writes made outside this runtime. The new text is
 * written to a sibling temporary file and renamed over the target, so readers never observe a
 * partial write.
 *
 * @typeParam T - The value the caller derives from the change; returned verbatim on success.
 * @param file - Path of the configuration file to mutate; resolved to an absolute path for queueing.
 * @param change - Pure-ish transform invoked with the current file text; returns the replacement
 *   text plus the value to propagate. May be async; it must not write to `file` itself.
 * @param expectedVersion - Optional {@link configurationVersion} token of the text the caller based
 *   its edit on; `undefined` skips the optimistic-concurrency check.
 * @returns The `value` produced by `change` for the committed write.
 * @throws Error - If `expectedVersion` is supplied and does not match the file's current version
 *   (caller must reload before editing).
 * @throws Error - If the file changed on disk between the two reads (modified outside this runtime).
 * @throws Error - If any underlying file operation (read, write, rename) fails; the temporary file
 *   is removed and prior contents remain intact.
 */
export async function mutateConfigurationFile<T>(file: string, change: (text: string) => {
    text: string;
    value: T;
} | Promise<{
    text: string;
    value: T;
}>, expectedVersion?: string): Promise<T> {
    const key = path.resolve(file);
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => { }).then(async () => {
        const current = await readFile(key, 'utf8');
        if (expectedVersion && configurationVersion(current) !== expectedVersion)
            throw new Error('Configuration conflict; reload before editing');
        const next = await change(current);
        if (await readFile(key, 'utf8') !== current)
            throw new Error('Configuration changed outside this runtime; reload before editing');
        const temporary = key + '.tmp-' + randomUUID();
        try {
            await writeFile(temporary, next.text, 'utf8');
            await rename(temporary, key);
        }
        finally {
            await rm(temporary, { force: true });
        }
        return next.value;
    });
    queues.set(key, run);
    try {
        return await run;
    }
    finally {
        if (queues.get(key) === run)
            queues.delete(key);
    }
}
/**
 * Replaces a configuration file's entire contents only if it still holds `expectedText`.
 * Optimistic-concurrency wrapper around {@link mutateConfigurationFile}: the caller supplies the
 * exact text it last observed, and the write is abandoned if the file has since changed.
 *
 * @param file - Path of the configuration file to replace.
 * @param expectedText - The full file contents the caller expects to find (UTF-8); hashed into the
 *   required version token.
 * @param nextText - The full replacement contents to write.
 * @returns Resolves (with `undefined`) once the replacement is committed.
 * @throws Error - On version conflict, external modification, or file I/O failure, exactly as
 *   {@link mutateConfigurationFile} reports them.
 */
export async function replaceConfigurationFile(file: string, expectedText: string, nextText: string) { return mutateConfigurationFile(file, () => ({ text: nextText, value: undefined }), configurationVersion(expectedText)); }
