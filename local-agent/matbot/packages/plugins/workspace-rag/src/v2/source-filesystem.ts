import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
export function errorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error
        ? String((error as {
            code?: unknown;
        }).code)
        : undefined;
}
export function discoveryError(target: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`Workspace RAG V2 could not completely discover ${target}: ${detail}`);
}
export function normalizedPath(value: string): string {
    return path.resolve(value).replace(/\\/gu, '/');
}
export const SKIPPABLE_ROOT_ERROR_CODES = new Set([
    'EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EPERM',
]);
export function isWithinRoot(filePath: string, root: string): boolean {
    const relative = path.relative(root, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
export async function availableMarkdownRoots(paths: readonly string[]): Promise<{
    paths: string[];
    skippedPaths: string[];
}> {
    const available: string[] = [];
    const skipped: string[] = [];
    for (const configuredPath of paths) {
        const root = path.resolve(configuredPath);
        try {
            const rootStat = await stat(root);
            if (rootStat.isDirectory() || (rootStat.isFile() && root.toLocaleLowerCase().endsWith('.md'))) {
                available.push(root);
            }
            else {
                skipped.push(root);
            }
        }
        catch (error) {
            if (!SKIPPABLE_ROOT_ERROR_CODES.has(errorCode(error) ?? ''))
                throw discoveryError(root, error);
            skipped.push(root);
        }
    }
    return { paths: available, skippedPaths: skipped };
}
export async function* discoverMarkdown(paths: readonly string[], signal: AbortSignal, priority?: 'authority' | 'current' | 'archive'): AsyncGenerator<{
    path: string;
    size: number;
    modifiedAt: string;
}> {
    const roots = [...paths].map(value => path.resolve(value));
    const stack: Array<{
        current: string;
        root: string;
        kind: 'root' | 'directory' | 'file';
    }> = roots
        .slice()
        .reverse()
        .map(current => ({ current, root: current, kind: 'root' }));
    while (stack.length > 0) {
        if (signal.aborted)
            return;
        const { current, root, kind } = stack.pop()!;
        let currentStat;
        try {
            currentStat = await stat(current);
        }
        catch (error) {
            const code = errorCode(error);
            if (kind === 'file' && code === 'ENOENT')
                continue;
            if (kind === 'root' && code === 'ENOENT' && current.toLocaleLowerCase().endsWith('.md'))
                continue;
            throw discoveryError(current, error);
        }
        if (currentStat.isFile()) {
            if (current.toLocaleLowerCase().endsWith('.md')) {
                const normalized = normalizedPath(current);
                if (!priority || discoveryPriority(normalized) === priority) {
                    yield { path: normalized, size: currentStat.size, modifiedAt: currentStat.mtime.toISOString() };
                }
            }
            continue;
        }
        if (!currentStat.isDirectory())
            continue;
        let entries;
        try {
            entries = (await readdir(current, { withFileTypes: true }))
                .sort((left, right) => left.name.localeCompare(right.name));
        }
        catch (error) {
            throw discoveryError(current, error);
        }
        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index]!;
            if (entry.isDirectory() && ['node_modules', '.git', '.data'].includes(entry.name))
                continue;
            if (entry.isDirectory() || (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md'))) {
                stack.push({
                    current: path.join(current, entry.name),
                    root,
                    kind: entry.isDirectory() ? 'directory' : 'file',
                });
            }
        }
    }
}
export async function countMarkdown(paths: readonly string[], signal: AbortSignal): Promise<number> {
    const directories: string[] = [];
    let files = 0;
    for (const value of paths) {
        const root = path.resolve(value);
        let rootStat;
        try {
            rootStat = await stat(root);
        }
        catch {
            continue;
        }
        if (rootStat.isDirectory())
            directories.push(root);
        else if (rootStat.isFile() && root.toLocaleLowerCase().endsWith('.md'))
            files++;
    }
    while (directories.length > 0) {
        if (signal.aborted)
            return files;
        const current = directories.pop()!;
        let entries;
        try {
            entries = await readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (['node_modules', '.git', '.data'].includes(entry.name))
                    continue;
                directories.push(path.join(current, entry.name));
            }
            else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md')) {
                files++;
            }
        }
    }
    return files;
}
export function discoveryPriority(filePath: string): 'authority' | 'current' | 'archive' {
    const lower = filePath.toLocaleLowerCase();
    if (/(?:^|\/)(?:authority|official|signed|approved|executed)(?:\/|$)/u.test(lower)) {
        return 'authority';
    }
    if (/(?:^|\/)(?:archive|archived|history|old|obsolete)(?:\/|$)/u.test(lower)) {
        return 'archive';
    }
    return 'current';
}
export const filesystemSource = { availableMarkdownRoots, discoverMarkdown, countMarkdown };
export type RagSourceAcquisition = typeof filesystemSource;
