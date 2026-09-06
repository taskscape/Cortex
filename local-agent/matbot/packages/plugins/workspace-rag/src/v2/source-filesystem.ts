import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
/**
 * Extracts a Node.js-style error code from an unknown thrown value.
 * @param error - Caught value to inspect.
 * @returns The `code` property as a string when present, otherwise undefined.
 * @throws Never.
 */
export function errorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error
        ? String((error as {
            code?: unknown;
        }).code)
        : undefined;
}
/**
 * Wraps an underlying failure into a discovery error with target context.
 * @param target - Path or root that could not be fully discovered.
 * @param error - Original failure; its message is embedded in the new error.
 * @returns A new Error describing the incomplete discovery.
 * @throws Never.
 */
export function discoveryError(target: string, error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    return new Error(`Workspace RAG V2 could not completely discover ${target}: ${detail}`);
}
/**
 * Resolves a path and normalizes its separators.
 * @param value - Path to normalize.
 * @returns The absolute path with backslashes replaced by forward slashes.
 * @throws Never.
 */
export function normalizedPath(value: string): string {
    return path.resolve(value).replace(/\\/gu, '/');
}
export const SKIPPABLE_ROOT_ERROR_CODES = new Set([
    'EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOTDIR', 'EPERM',
]);
/**
 * Checks whether a path lies at or inside a root.
 * @param filePath - Path to test.
 * @param root - Root directory.
 * @returns True when the path equals the root or is contained by it.
 * @throws Never.
 */
export function isWithinRoot(filePath: string, root: string): boolean {
    const relative = path.relative(root, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
/**
 * Filters configured roots down to those currently indexable.
 *
 * Directories and `.md` files are kept; anything else is skipped, as are
 * roots whose stat fails with a skippable error code. Other stat failures
 * are reported as discovery errors.
 * @param paths - Configured root paths.
 * @returns Available roots in `paths` and the skipped ones (`skippedPaths`), both absolute.
 * @throws Error - When a root cannot be stat-ed for a reason outside the skippable set (wrapped by {@link discoveryError}).
 */
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
/**
 * Yields markdown files found under the given roots.
 *
 * Traversal is depth-first over sorted directory listings, skipping
 * `node_modules`, `.git`, and `.data` directories. Only files ending in
 * `.md` (case-insensitive) are yielded; when `priority` is given, only files
 * whose {@link discoveryPriority} matches are yielded. Missing files and
 * missing root `.md` paths are silently skipped; other failures are raised
 * as discovery errors.
 * @param paths - Root paths to scan.
 * @param signal - Abort signal; once aborted, iteration simply completes.
 * @param priority - Optional priority class to filter yielded files by.
 * @returns Objects with the normalized absolute `path`, `size` in bytes, and `modifiedAt` ISO timestamp, in deterministic traversal order.
 * @throws Error - When a required stat or directory listing fails for a non-skippable reason (wrapped by {@link discoveryError}).
 */
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
/**
 * Counts markdown files under the given roots without full discovery.
 *
 * Missing roots and unreadable directories are silently ignored;
 * `node_modules`, `.git`, and `.data` directories are skipped.
 * @param paths - Root paths to scan.
 * @param signal - Abort signal; once aborted, the count so far is returned.
 * @returns The number of `.md` files (case-insensitive) found.
 * @throws Never.
 */
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
/**
 * Classifies a file path into a discovery priority by directory name.
 * @param filePath - Path to classify (compared case-insensitively).
 * @returns 'authority' when any path segment is one of authority, official, signed, approved, or executed; 'archive' for archive, archived, history, old, or obsolete; otherwise 'current'.
 * @throws Never.
 */
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
/**
 * The filesystem source-acquisition bundle: root validation, discovery, and counting.
 */
export type RagSourceAcquisition = typeof filesystemSource;
