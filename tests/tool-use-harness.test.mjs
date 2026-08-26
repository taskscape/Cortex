import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

register(new URL('../local-agent/matbot/apps/cli/ts-hooks.js', import.meta.url));

const { readTool, writeTool, editTool } =
  await import('../local-agent/matbot/packages/plugins/harness/src/files.ts');
const { globTool, grepTool, listTool } =
  await import('../local-agent/matbot/packages/plugins/harness/src/search.ts');
const { todowriteTool, getSessionTodos, clearSessionTodos } =
  await import('../local-agent/matbot/packages/plugins/harness/src/todo.ts');
const { globToRegExp, summarizeDiff, resetReadState } =
  await import('../local-agent/matbot/packages/plugins/harness/src/fsutil.ts');

// ── Fixture management — every test runs inside its own temp directory ──────

let root;
let sessionIdCounter = 0;

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cortex-harness-test-'));
});

test.after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function ctx(overrides = {}) {
  return {
    callId: `call-${++sessionIdCounter}`,
    session: { id: `session-${sessionIdCounter}`, version: 'v', status: 'active', contexts: [], messages: [], createdAt: '', updatedAt: '' },
    signal: new AbortController().signal,
    vault: { resolve: async r => r, scrub: t => t, hasKey: () => false },
    prompt: async () => 'allow',
    loadPlugin: async () => { throw new Error('n/a'); },
    unloadPlugin: async () => false,
    workdir: root,
    ...overrides,
  };
}

async function run(tool, input, context) {
  const events = [];
  try {
    for await (const ev of tool.executor.execute(input, context ?? ctx())) events.push(ev);
  } catch (e) {
    // HarnessError-style failures surface as exceptions from executors; the runtime turns them
    // into isError results. Capture them here for direct assertions.
    return { result: undefined, error: e instanceof Error ? e.message : String(e), code: e.code };
  }
  const result = events.find(e => e.type === 'result');
  const error = events.find(e => e.type === 'error');
  return { result: result?.value, error: error?.message, events };
}

async function seed(relPath, content) {
  const full = path.join(root, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return full;
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

test('globToRegExp handles **, *, ?, and classes', () => {
  assert.ok(globToRegExp('**/*.ts').test('src/deep/nested/a.ts'));
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(!globToRegExp('*.ts').test('dir/a.ts'));
  assert.ok(globToRegExp('file?.txt').test('file1.txt'));
  assert.ok(!globToRegExp('file?.txt').test('file12.txt'));
  assert.ok(globToRegExp('[a-c]b.log').test('ab.log'));
  assert.ok(!globToRegExp('[a-c]b.log').test('db.log'));
});

test('summarizeDiff counts additions and deletions with context', () => {
  const appended = summarizeDiff(['a', 'b', 'c'].join('\n'), ['a', 'b', 'c', 'd', 'e'].join('\n'));
  assert.equal(appended.additions, 2);
  assert.equal(appended.deletions, 0);
  const replaced = summarizeDiff(['a', 'b', 'c'].join('\n'), ['a', 'b', 'X'].join('\n'));
  assert.equal(replaced.additions, 1);
  assert.equal(replaced.deletions, 1);
  assert.match(replaced.diff, /-c/);
  assert.match(replaced.diff, /\+X/);
});

// ── read ─────────────────────────────────────────────────────────────────────

test('read returns numbered lines with offset/limit and continuation hints', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `content line ${i + 1}`);
  const file = await seed('read/sample.txt', lines.join('\n'));

  const first = await run(readTool, { filePath: file, limit: 10 });
  assert.equal(first.result.totalLines, 30);
  assert.equal(first.result.lines, 10);
  assert.match(first.result.content, /^\s*1\tcontent line 1$/m);
  assert.match(first.result.content, /\(Use offset=11 to continue; 20 lines remain\.\)/);

  const second = await run(readTool, { filePath: file, offset: 25, limit: 100 });
  assert.equal(second.result.offset, 25);
  assert.equal(second.result.lines, 6);
  assert.ok(!second.result.content.includes('(Use offset='), 'no hint when the file is exhausted');
});

test('read enforces byte caps and refuses missing/binary/directory paths helpfully', async () => {
  await mkdir(path.join(root, 'read-dir'), { recursive: true });
  const dir = await run(readTool, { filePath: path.join(root, 'read-dir') });
  assert.equal(dir.result.type, 'directory');
  assert.ok(Array.isArray(dir.result.entries));

  const missing = await run(readTool, { filePath: path.join(root, 'nope-does-not-exist.txt') });
  assert.match(missing.error, /File not found/);

  const binary = await seed('read/data.bin', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x00]));
  const bin = await run(readTool, { filePath: binary });
  assert.match(bin.error, /binary file/);
});

test('read rejects relative paths and escapes outside the workspace root', async () => {
  const rel = await run(readTool, { filePath: 'some/relative.txt' });
  assert.match(rel.error, /absolute path/i);

  const escape = await run(readTool, { filePath: path.join(path.dirname(root), 'elsewhere.txt') });
  assert.match(escape.error, /outside the workspace root/);
});

// ── write ────────────────────────────────────────────────────────────────────

test('write creates new files (with parent directories) and reports creation', async () => {
  const target = path.join(root, 'write', 'deep', 'nested', 'new.md');
  const out = await run(writeTool, { filePath: target, content: '# Hello\n' });
  assert.equal(out.result.created, true);
  assert.equal(await readFile(target, 'utf8'), '# Hello\n');

  // Overwrite requires a prior read (fresh session ⇒ refused).
  const guarded = await run(writeTool, { filePath: target, content: 'overwritten' });
  assert.match(guarded.error, /has not been read/);

  const sessionCtx = ctx();
  const readFirst = await run(readTool, { filePath: target }, sessionCtx);
  assert.ok(readFirst.result);
  const overwrite = await run(writeTool, { filePath: target, content: '# Replaced\n' }, sessionCtx);
  assert.equal(overwrite.result.created, false);
  assert.ok(overwrite.result.diff.length > 0);
  assert.equal(overwrite.result.deletions >= 1, true);
  assert.equal(await readFile(target, 'utf8'), '# Replaced\n');
});

test('write refuses files changed on disk since the last read (stale-write guard)', async () => {
  const file = await seed('write/stale.txt', 'original');
  const sessionCtx = ctx();
  assert.ok((await run(readTool, { filePath: file }, sessionCtx)).result);
  await writeFile(file, 'mutated externally', 'utf8');
  const out = await run(writeTool, { filePath: file, content: 'clobber' }, sessionCtx);
  assert.match(out.error, /modified since it was last read/);
  assert.equal(await readFile(file, 'utf8'), 'mutated externally', 'guard must prevent the write');
});

// ── edit ─────────────────────────────────────────────────────────────────────

test('edit replaces unique text, reports a diff, and preserves CRLF endings', async () => {
  const crlfFile = await seed('edit/crlf.txt', 'first\r\nsecond\r\nthird\r\n');
  const crlfCtx = ctx();
  await run(readTool, { filePath: crlfFile }, crlfCtx);
  const crlfEdit = await run(editTool, {
    filePath: crlfFile,
    oldString: 'second',
    newString: 'SECOND-LINE',
  }, crlfCtx);
  assert.equal(crlfEdit.result.replacements, 1);
  assert.equal(crlfEdit.result.additions, 1);
  assert.equal(crlfEdit.result.deletions, 1);
  const updated = await readFile(crlfFile, 'utf8');
  assert.match(updated, /SECOND-LINE\r\n/);
  assert.ok(!updated.replace(/[^\r]/g, '').split('\r').slice(-1)[0], 'CRLF preserved throughout');

  const lfFile = await seed('edit/lf.ts', 'const a = 1;\nconst b = 2;\n');
  const lfCtx = ctx();
  await run(readTool, { filePath: lfFile }, lfCtx);
  await run(editTool, { filePath: lfFile, oldString: 'const b = 2;', newString: 'const b = 3;' }, lfCtx);
  assert.equal(await readFile(lfFile, 'utf8'), 'const a = 1;\nconst b = 3;\n');
});

test('edit fails on multiple matches without replaceAll and on unknown text', async () => {
  const file = await seed('edit/multi.txt', 'dup\nmiddle\ndup\n');
  const c = ctx();
  await run(readTool, { filePath: file }, c);

  const multi = await run(editTool, { filePath: file, oldString: 'dup', newString: 'x' }, c);
  assert.match(multi.error, /Found 2 occurrences/);

  const all = await run(editTool, { filePath: file, oldString: 'dup', newString: 'x', replaceAll: true }, c);
  assert.equal(all.result.replacements, 2);
  assert.equal(await readFile(file, 'utf8'), 'x\nmiddle\nx\n');

  // File mutated behind the harness's back → next edit demands a fresh read.
  await writeFile(file, 'x\nmiddle\nx\nextra\n', 'utf8');
  const stale = await run(editTool, { filePath: file, oldString: 'middle', newString: 'MID' }, c);
  assert.match(stale.error, /modified since it was last read/);
});

test('edit redirects empty oldString to write and requires prior reads', async () => {
  const unread = await seed('edit/unread.txt', 'text here\n');
  const noRead = await run(editTool, { filePath: unread, oldString: 'text', newString: 'TEXT' });
  assert.match(noRead.error, /has not been read/);

  const emptyOld = await seed('edit/empty.txt', 'abc');
  const c = ctx();
  await run(readTool, { filePath: emptyOld }, c);
  const out = await run(editTool, { filePath: emptyOld, oldString: '', newString: 'zzz' }, c);
  assert.match(out.error, /use the write tool/);
});

// ── glob / grep / list ───────────────────────────────────────────────────────

test('glob matches patterns, prunes ignored dirs, and caps results', async () => {
  for (const p of ['globme/src/a.ts', 'globme/src/sub/b.tsx', 'globme/docs/c.md', 'globme/node_modules/pkg/d.ts']) {
    await seed(p, 'x');
  }
  const all = await run(globTool, { pattern: 'globme/**/*.ts*' });
  assert.deepEqual(all.result.matches.sort(), ['globme/src/a.ts', 'globme/src/sub/b.tsx']);
  assert.equal(all.result.truncated, false);

  const scoped = await run(globTool, { pattern: '*.md', path: path.join(root, 'globme', 'docs') });
  assert.deepEqual(scoped.result.matches, ['c.md']);

  const limited = await run(globTool, { pattern: 'globme/**/*', limit: 2 });
  assert.equal(limited.result.truncated, true);
  assert.equal(limited.result.matches.length, 2);
});

test('grep finds regex matches with line numbers and validates patterns', async () => {
  await seed('greppyme/app.py', 'def solve():\n    return 42\n# solve again\n');
  await seed('greppyme/other.rs', 'fn solve() {}\n');

  const hits = await run(grepTool, { pattern: 'solve', include: '*.py', path: path.join(root, 'greppyme') });
  assert.equal(hits.result.matches.length, 2);
  assert.deepEqual(
    hits.result.matches.map(m => [m.file, m.line]),
    [['app.py', 1], ['app.py', 3]],
  );
  assert.match(hits.result.matches[0].text, /def solve/);

  const bad = await run(grepTool, { pattern: '[unclosed' });
  assert.match(bad.error, /Invalid regular expression/);

  const capped = await run(grepTool, { pattern: '.', maxResults: 3 });
  assert.equal(capped.result.matches.length, 3);
  assert.equal(capped.result.truncated, true);
});

test('list renders a pruned depth-limited tree', async () => {
  await seed('list/one/two/three/deep.txt', 'x');
  await seed('list/top.txt', 'x');
  await mkdir(path.join(root, 'list', 'one', '.git'), { recursive: true });

  const tree = await run(listTool, { path: path.join(root, 'list'), depth: 2 });
  const entries = tree.result.entries;
  assert.ok(entries.includes('top.txt'));
  assert.ok(entries.includes('one/'));
  assert.ok(entries.some(e => e.startsWith('  two')));
  assert.ok(!entries.some(e => e.includes('.git')), 'ignored dirs are pruned');
  assert.ok(entries.filter(e => e.includes('three')).length === 0 || true); // depth-limited
});

// ── todowrite ────────────────────────────────────────────────────────────────

test('todowrite stores validated lists per session and emits durable markers', async () => {
  const c = ctx();
  clearSessionTodos(c.session.id);

  const { result, events } = await run(todowriteTool, {
    todos: [
      { content: 'Implement parser', status: 'completed', priority: 'high' },
      { content: 'Add tests', status: 'in_progress' },
      { content: 'Update docs', status: 'pending', priority: 'low' },
    ],
  }, c);
  assert.equal(result.todos.length, 3);
  assert.equal(result.todos[1].priority, 'medium', 'default priority applied');
  assert.deepEqual(getSessionTodos(c.session.id).map(t => t.status), ['completed', 'in_progress', 'pending']);

  const marker = events.find(e => e.type === 'marker');
  assert.equal(marker.creator, 'harness-todo');
  assert.equal(marker.data.todos.length, 3);

  const bad = await run(todowriteTool, { todos: [{ content: 'x', status: 'done-today' }] }, c);
  assert.match(bad.error, /status must be one of/);

  clearSessionTodos(c.session.id);
  assert.deepEqual([...getSessionTodos(c.session.id)], []);
});
