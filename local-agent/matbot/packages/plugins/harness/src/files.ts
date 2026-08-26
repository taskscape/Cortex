import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, sep } from 'node:path';
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { defineTool } from './define.js';
import { confine, HarnessError, requireRoot } from './paths.js';
import { isBinary, recordRead, requireFreshRead, summarizeDiff } from './fsutil.js';

const READ_LINE_CAP   = 2000;
const READ_BYTE_CAP   = 50_000;

interface ReadInput { filePath: string; offset?: number; limit?: number }

function formatNumbered(lines: readonly string[], startLine: number): string {
  return lines.map((line, i) => {
    const text = line.length > READ_LINE_CAP ? `${line.slice(0, READ_LINE_CAP)}… [line truncated]` : line;
    return `${String(startLine + i).padStart(6)}\t${text}`;
  }).join('\n');
}

export const readTool: Tool = defineTool({
  name: 'read',
  description:
    'Read a file from the workspace with line numbers. Requires an absolute `filePath` inside the ' +
    `workspace. Returns up to \`limit\` (default ${READ_LINE_CAP}) lines starting at 1-indexed \`offset\`; ` +
    'lines longer than 2000 characters are truncated. Directories return a listing; binary files are ' +
    'refused. You must read a file before editing or overwriting it.',
  inputSchema: {
    type: 'object',
    required: ['filePath'],
    properties: {
      filePath: { type: 'string', description: 'Absolute path of the file to read (must be inside the workspace).' },
      offset:   { type: 'integer', minimum: 1, description: '1-indexed line to start reading from. Default 1.' },
      limit:    { type: 'integer', minimum: 1, description: `Maximum number of lines to return. Default ${READ_LINE_CAP}.` },
    },
  },
  permission: { action: 'read', patterns: input => [typeof (input as ReadInput)?.filePath === 'string' ? (input as ReadInput).filePath : '*'] },

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as ReadInput;
    const root = requireRoot(ctx);
    const resolved = confine(root, req.filePath, { absolute: true });

    const info = await stat(resolved).catch(() => null);
    if (info === null) {
      let suggestion = '';
      try {
        const dir = await readdir(dirname(resolved));
        const base = basename(resolved).toLowerCase();
        const near = dir.find(n => n.toLowerCase().includes(base.slice(0, Math.max(3, Math.min(base.length, 8)))) || base.includes(n.toLowerCase()));
        if (near !== undefined) suggestion = ` A similarly named entry exists: "${near}".`;
        else if (dir.length < 30) suggestion = ` Directory contents: ${dir.join(', ')}.`;
      } catch { /* parent missing too */ }
      throw new HarnessError(`File not found: ${resolved}.${suggestion}`, 'not_found');
    }
    if (info.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      yield {
        type: 'result',
        value: {
          path: resolved,
          type: 'directory',
          entries: entries.map(e => `${e.name}${e.isDirectory() ? '/' : ''}`),
          hint: 'This is a directory. Use glob/grep/list for navigation or read a specific file.',
        },
      };
      return;
    }

    const bytes = await readFile(resolved);
    if (isBinary(resolved, bytes)) {
      throw new HarnessError(
        `"${resolved}" appears to be a binary file (${bytes.length} bytes); the read tool only returns text.`,
        'invalid_input',
      );
    }
    await recordRead(ctx.session.id, resolved);

    let text = bytes.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const allLines = text.split('\n');
    const offset = Math.max(1, Math.trunc(req.offset ?? 1));
    const limit  = Math.max(1, Math.trunc(req.limit ?? READ_LINE_CAP));
    const slice  = allLines.slice(offset - 1, offset - 1 + limit);

    let out = formatNumbered(slice, offset);
    if (out.length > READ_BYTE_CAP) {
      const keptLines = out.slice(0, READ_BYTE_CAP).split('\n').length - 1;
      out = formatNumbered(slice.slice(0, Math.max(1, keptLines)), offset);
    }
    const nextLine = offset + slice.length;
    if (nextLine <= allLines.length) out += `\n(Use offset=${nextLine} to continue; ${allLines.length - nextLine + 1} lines remain.)`;

    yield {
      type: 'result',
      value: {
        path: relative(root, resolved).split(sep).join('/') || resolved,
        totalLines: allLines.length,
        offset,
        lines: slice.length,
        content: out,
      },
    };
  },
});

interface WriteInput { filePath: string; content: string }

export const writeTool: Tool = defineTool({
  name: 'write',
  description:
    'Create or completely overwrite a file in the workspace with `content`. Requires an absolute ' +
    '`filePath` inside the workspace; parent directories are created automatically. Overwriting an ' +
    'existing file requires that you read it earlier this session and that it has not changed on disk ' +
    'since — otherwise use edit for targeted changes. Prefer write for new files and whole-file rewrites.',
  inputSchema: {
    type: 'object',
    required: ['filePath', 'content'],
    properties: {
      filePath: { type: 'string', description: 'Absolute target path inside the workspace.' },
      content:  { type: 'string', description: 'Full new file contents.' },
    },
  },
  permission: { action: 'edit', patterns: input => [typeof (input as WriteInput)?.filePath === 'string' ? (input as WriteInput).filePath : '*'] },
  serial: true,

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as WriteInput;
    const root = requireRoot(ctx);
    const resolved = confine(root, req.filePath, { absolute: true });

    const existing = await stat(resolved).catch(() => null);
    let previous: string | undefined;
    if (existing !== null && existing.isFile()) {
      const bytes = await requireFreshRead(ctx.session.id, resolved);
      previous = bytes.toString('utf8');
    }

    await mkdir(dirname(resolved), { recursive: true });
    const hadBom = previous !== undefined && previous.charCodeAt(0) === 0xFEFF;
    const body = hadBom ? `\uFEFF${req.content}` : req.content;
    await writeFile(resolved, body, 'utf8');
    await recordRead(ctx.session.id, resolved);

    yield {
      type: 'result',
      value: {
        path: relative(root, resolved).split(sep).join('/') || resolved,
        created: existing === null,
        bytes: Buffer.byteLength(body, 'utf8'),
        ...(previous !== undefined ? summarizeDiff(previous.replace(/^\uFEFF/, ''), req.content) : {}),
      },
    };
  },
});

interface EditInput { filePath: string; oldString: string; newString: string; replaceAll?: boolean }

export function applyReplacement(content: string, oldString: string, newString: string, replaceAll: boolean): { text: string; replacements: number } {
  let count = 0;
  let idx = content.indexOf(oldString);
  while (idx >= 0) { count++; idx = content.indexOf(oldString, idx + oldString.length); }
  if (!replaceAll && count > 1) {
    throw new HarnessError(
      `Found ${count} occurrences of oldString. Make it unique by including more surrounding context, or pass replaceAll=true.`,
      'invalid_input',
    );
  }
  if (count === 0) throw new HarnessError('oldString was not found in the file. Re-read the file — it may have changed or the match may differ in whitespace.', 'not_found');
  return { text: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString), replacements: count };
}

export const editTool: Tool = defineTool({
  name: 'edit',
  description:
    'Replace exact text inside a file you have already read this session. `oldString` must match the ' +
    "file's current content exactly and be unique unless `replaceAll` is set — include enough " +
    'surrounding context to disambiguate. Line endings (CRLF/LF) are preserved automatically. The ' +
    'result includes a change summary with additions/deletions. For new files or full rewrites use write.',
  inputSchema: {
    type: 'object',
    required: ['filePath', 'oldString', 'newString'],
    properties: {
      filePath:   { type: 'string', description: 'Absolute path of the file to edit (inside the workspace).' },
      oldString:  { type: 'string', description: 'Exact existing text to replace. Must be unique in the file unless replaceAll.' },
      newString:  { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of failing on multiple matches. Default false.' },
    },
  },
  permission: { action: 'edit', patterns: input => [typeof (input as EditInput)?.filePath === 'string' ? (input as EditInput).filePath : '*'] },
  serial: true,

  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as EditInput;
    const root = requireRoot(ctx);
    const resolved = confine(root, req.filePath, { absolute: true });
    if ((await stat(resolved).catch(() => null)) === null) {
      throw new HarnessError(`File not found: ${resolved}. Use write to create it.`, 'not_found');
    }
    if (req.oldString === '') {
      throw new HarnessError('oldString must not be empty on an existing file — use the write tool for whole-file writes.', 'invalid_input');
    }

    const bytes = await requireFreshRead(ctx.session.id, resolved);
    let original = bytes.toString('utf8');
    const bom = original.charCodeAt(0) === 0xFEFF;
    if (bom) original = original.slice(1);

    const crlf = original.includes('\r\n');
    const normalize = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
    const denormalize = (s: string): string => (crlf ? s.replace(/\n/g, '\r\n') : s);

    const { text: replacedNormalized, replacements } =
      applyReplacement(normalize(original), normalize(req.oldString), normalize(req.newString), req.replaceAll === true);
    const updated = (bom ? '\uFEFF' : '') + denormalize(replacedNormalized);
    await writeFile(resolved, updated, 'utf8');
    await recordRead(ctx.session.id, resolved);

    yield {
      type: 'result',
      value: {
        path: relative(root, resolved).split(sep).join('/') || resolved,
        replacements,
        // Both sides normalized to the same line-ending style so only real changes appear.
        ...summarizeDiff(normalize(original), replacedNormalized),
      },
    };
  },
});
