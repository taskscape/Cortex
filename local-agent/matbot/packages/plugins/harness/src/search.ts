import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { defineTool } from './define.js';
import { confine, HarnessError, requireRoot } from './paths.js';
import { globToRegExp, isBinary, walkFiles, IGNORED_DIRS } from './fsutil.js';

const RESULT_CAP = 100;
const LINE_CAP = 2000;

interface GlobInput { pattern: string; path?: string; limit?: number }

export const globTool: Tool = defineTool({
  name: 'glob',
  description:
    'Find files by glob pattern (`**` matches any depth, `*` within one segment, `?` one character, ' +
    '[a-z] classes). Searches the workspace from the optional `path` (absolute or ' +
    'workspace-relative). Common generated directories (.git, node_modules) are skipped. Returns at ' +
    `most \`limit\` (default ${RESULT_CAP}) paths, sorted. Prefer narrow patterns over broad ones.`,
  inputSchema: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', description: 'Glob such as "src/**/*.ts" or "**/*.md".' },
      path:    { type: 'string', description: 'Directory to search from. Defaults to the workspace root.' },
      limit:   { type: 'integer', minimum: 1, description: `Maximum results. Default ${RESULT_CAP}.` },
    },
  },
  permission: { action: 'read', patterns: () => ['*'] },

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as GlobInput;
    const root = requireRoot(ctx);
    const base = confine(root, req.path);
    const baseInfo = await stat(base).catch(() => null);
    if (baseInfo === null || !baseInfo.isDirectory()) {
      throw new HarnessError(`path "${req.path ?? '.'}" is not a directory inside the workspace.`, 'not_found');
    }
    const rx = globToRegExp(req.pattern);
    const limit = Math.max(1, Math.trunc(req.limit ?? RESULT_CAP));
    const files = await walkFiles(base);
    const matches = files.filter(f => rx.test(f));
    matches.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    yield {
      type: 'result',
      value: {
        matches: matches.slice(0, limit),
        truncated: matches.length > limit,
        totalMatches: matches.length,
      },
    };
  },
});

interface GrepInput { pattern: string; path?: string; include?: string; maxResults?: number }

export const grepTool: Tool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression across the workspace (or a subdirectory `path`). ' +
    '`include` narrows files by glob (e.g. "*.ts"). Ignores .git/node_modules and binary files. Returns ' +
    'up to `maxResults` (default 100) matches of {file, line, text} with 1-indexed line numbers; matched ' +
    'lines are truncated at 2000 characters. Prefer several targeted searches over one broad pattern.',
  inputSchema: {
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern:    { type: 'string', description: 'JavaScript regular expression (e.g. "function\\s+\\w+").' },
      path:       { type: 'string', description: 'Directory to search from. Defaults to the workspace root.' },
      include:    { type: 'string', description: 'Glob filter for files, e.g. "*.{ts,tsx}".' },
      maxResults: { type: 'integer', minimum: 1, description: `Maximum matches returned. Default ${RESULT_CAP}.` },
    },
  },
  permission: { action: 'read', patterns: () => ['*'] },

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as GrepInput;
    let rx: RegExp;
    try { rx = new RegExp(req.pattern); }
    catch (e) {
      throw new HarnessError(
        `Invalid regular expression "${req.pattern}": ${e instanceof Error ? e.message : String(e)}. Escape special characters and retry.`,
        'invalid_pattern',
      );
    }
    const root = requireRoot(ctx);
    const base = confine(root, req.path);
    const maxResults = Math.max(1, Math.trunc(req.maxResults ?? RESULT_CAP));

    const files = await walkFiles(base, req.include !== undefined ? { include: globToRegExp(req.include) } : {});
    // A glob like "*.py" matches basenames anywhere (ripgrep --glob semantics), while
    // path-bearing globs ("src/**") match the relative path.
    const includeRx = req.include !== undefined ? globToRegExp(req.include) : undefined;
    const included = (rel: string): boolean =>
      includeRx === undefined || includeRx.test(rel) || includeRx.test(rel.split('/').pop() ?? '');
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let truncated = false;
    for (const rel of files) {
      if (!included(rel)) continue;
      if (matches.length >= maxResults) { truncated = true; break; }
      const full = `${base}${sep}${rel.split('/').join(sep)}`;
      const bytes = await readFile(full).catch(() => null);
      if (bytes === null || bytes.length > 2_000_000 || isBinary(full, bytes)) continue;
      const lines = bytes.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!rx.test(line)) continue;
        matches.push({ file: rel, line: i + 1, text: line.slice(0, LINE_CAP) });
        if (matches.length >= maxResults) { truncated = true; break; }
      }
    }
    yield { type: 'result', value: { matches, truncated, searchedFiles: files.length } };
  },
});

interface ListInput { path?: string; depth?: number; maxEntries?: number }

export const listTool: Tool = defineTool({
  name: 'list',
  description:
    'List a workspace directory tree. Returns an indented rendering of directories (with trailing "/") ' +
    'and files up to `depth` levels (default 3), capped at `maxEntries` entries. Generated directories ' +
    '(.git, node_modules, …) are pruned. For content searches use grep; for name patterns use glob.',
  inputSchema: {
    type: 'object',
    properties: {
      path:       { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
      depth:      { type: 'integer', minimum: 1, description: 'Maximum recursion depth. Default 3.' },
      maxEntries: { type: 'integer', minimum: 1, description: 'Maximum entries rendered. Default 1000.' },
    },
  },
  permission: { action: 'read', patterns: () => ['*'] },

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as ListInput;
    const root = requireRoot(ctx);
    const base = confine(root, req.path);
    const depth = Math.max(1, Math.trunc(req.depth ?? 3));
    const maxEntries = Math.max(1, Math.trunc(req.maxEntries ?? 1000));

    const lines: string[] = [];
    let truncated = false;
    async function visit(dir: string, level: number, prefix: string): Promise<void> {
      if (level > depth || truncated || lines.length >= maxEntries) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (entries === null) return;
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const entry of entries) {
        if (truncated || lines.length >= maxEntries) { truncated = true; return; }
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) await visit(`${dir}${sep}${entry.name}`, level + 1, `${prefix}  `);
      }
    }
    await visit(base, 1, '');
    yield {
      type: 'result',
      value: {
        path: relative(root, base).split(sep).join('/') || '.',
        entries: lines,
        truncated,
      },
    };
  },
});
