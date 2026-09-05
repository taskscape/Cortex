import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const queues = new Map<string, Promise<unknown>>();
export const configurationVersion = (text: string) => createHash('sha256').update(text).digest('hex');
/** Atomic replacement shared by configuration administration and legacy provider/plugin tools. */
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
export async function replaceConfigurationFile(file: string, expectedText: string, nextText: string) { return mutateConfigurationFile(file, () => ({ text: nextText, value: undefined }), configurationVersion(expectedText)); }
