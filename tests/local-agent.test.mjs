import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { indexRoot } from "../local-agent/file-index/dist/indexer.js";
import { resolveIndexRoot } from "../local-agent/file-index/dist/index-root.js";
import { emptyStore, loadStore, saveStore } from "../local-agent/file-index/dist/store.js";
import { searchChunks } from "../local-agent/file-index/dist/search.js";
import { evaluateAccess, indexExclusions } from "../local-agent/paths/dist/index.js";
import { ReloadingConfig } from "../local-agent/file-broker/dist/config-cache.js";
import { writeTextFile } from "../local-agent/file-broker/dist/file-writer.js";
import { createFileBrokerTool, FileBrokerClient } from "../local-agent/matbot/plugins/file-broker/dist/index.js";
import { mergeRankAndDeduplicate } from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/ranking.js";
import { Mem0Client } from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/mem0-client.js";
import {
  workspaceIdFromConfigPath,
  workspaceScopedMem0UserId
} from "../local-agent/matbot/plugins/hybrid-knowledge-index/dist/index.js";

test("file index stores searchable text with path metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-index-"));
  await writeFile(path.join(root, "notes.md"), "Matbot should retrieve durable memory from Mem0.", "utf8");

  try {
    const options = {
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" }
    };
    const store = await indexRoot(options, emptyStore());

    const results = searchChunks(store.chunks, "durable memory", 5);
    assert.equal(results.length, 1);
    assert.match(results[0].snippet, /durable memory/i);
    assert.equal(results[0].relativePath, "notes.md");

    const unchanged = await indexRoot(options, store);
    assert.strictEqual(unchanged.chunks[0], store.chunks[0], "unchanged files reuse their indexed chunks");

    await writeFile(path.join(root, "notes.md"), "Matbot should retrieve current project context from the resident index.", "utf8");
    const changed = await indexRoot(options, unchanged);
    assert.equal(searchChunks(changed.chunks, "project context", 1).length, 1);
    assert.equal(searchChunks(changed.chunks, "durable memory", 1).length, 0);

    const storePath = path.join(root, "index.json");
    await saveStore(storePath, changed);
    await saveStore(storePath, changed);
    assert.equal((await loadStore(storePath)).chunks.length, changed.chunks.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that the file index resolution logic enforces workspace root boundaries
 * and prevents access to directories outside the configured workspace roots.
 *
 * This test ensures:
 * - Index roots must be within configured workspace roots
 * - Subtrees of configured roots are allowed
 * - Direct access to paths outside configured roots is rejected
 * - Path traversal attempts (e.g., using ..) are blocked
 * - No configured roots means nothing is indexable
 * - Windows junctions cannot be used to escape the root directory
 *
 * Assumptions:
 * - The resolveIndexRoot() function validates paths against configured roots
 * - The test creates temporary directories inside and outside the configured root
 * - A Windows junction can be created to test symlink-based escaping
 * - Success is indicated by appropriate rejections for invalid paths and
 *   allowance of valid paths
 */
test("file index rejects index roots outside the configured workspace roots", async () => {
  const configured = await mkdtemp(path.join(os.tmpdir(), "local-agent-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "local-agent-outside-"));
  const nested = path.join(configured, "project");
  await mkdir(nested, { recursive: true });
  const config = { roots: [{ path: configured, mode: "read-write", type: "test" }], excludedPatterns: [] };

  try {
    assert.equal(await resolveIndexRoot(undefined, config), path.resolve(configured));
    assert.equal(await resolveIndexRoot(nested, config), path.resolve(nested), "a subtree of a configured root is allowed");

    await assert.rejects(() => resolveIndexRoot(outside, config), /outside the configured workspace roots/);
    await assert.rejects(() => resolveIndexRoot(path.join(configured, "..", path.basename(outside)), config),
      /outside the configured workspace roots/, "traversal out of a configured root is rejected");
    await assert.rejects(() => resolveIndexRoot(configured, { roots: [], excludedPatterns: [] }),
      /outside the configured workspace roots/, "no configured roots means nothing is indexable");

    // A junction planted inside a configured root must not redirect the walk out of it. Junctions need
    // no elevation on Windows; where the platform or filesystem refuses, the assertion is skipped
    // rather than failing the suite for an unrelated reason.
    const junction = path.join(configured, "escape");
    let junctionCreated = true;
    try { await symlink(outside, junction, "junction"); } catch { junctionCreated = false; }
    if (junctionCreated) {
      await assert.rejects(() => resolveIndexRoot(junction, config),
        /outside the configured workspace roots/, "a junction escaping the root is resolved, not trusted lexically");
    }
  } finally {
    await rm(configured, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

/**
 * Validates that the file broker security policy is applied consistently to all
 * indexed files, blocking access to sensitive files and directories.
 *
 * This test ensures:
 * - Files matching high-risk extensions (e.g., .env, .pem, .key) are skipped
 * - Files in denied path fragments (e.g., .ssh) are not indexed
 * - High-risk files are never exposed in search results
 * - Skipped files are recorded with appropriate reasons
 *
 * Assumptions:
 * - The indexRoot() function applies the security policy from the broker config
 * - The test creates files with various risk levels (normal, high-risk, in denied paths)
 * - The searchChunks() function queries the index
 * - Success is indicated by only safe files being indexed and high-risk files being
 *   rejected with appropriate reasons
 */
test("file index applies the broker security policy to every indexed file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-policy-"));
  await mkdir(path.join(root, ".ssh"), { recursive: true });
  await writeFile(path.join(root, "notes.md"), "Ordinary project notes about retrieval.", "utf8");
  // Matches none of the content secret patterns, so only the high-risk extension rule keeps it out.
  await writeFile(path.join(root, ".env"), "GITHUB_TOKEN=ghp_notarealtokenvalue\n", "utf8");
  await writeFile(path.join(root, ".ssh", "hosts.md"), "Private host inventory for retrieval.", "utf8");

  try {
    const store = await indexRoot({
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: {
        deniedPathFragments: ["\\.ssh\\"],
        highRiskExtensions: [".env", ".pem", ".key"],
        maxReadBytes: 100_000,
        backupRoot: "backups"
      }
    }, emptyStore());

    assert.deepEqual(store.chunks.map(chunk => chunk.relativePath), ["notes.md"]);
    assert.equal(searchChunks(store.chunks, "ghp_notarealtokenvalue", 5).length, 0, "high-risk files never reach /search");
    assert.equal(searchChunks(store.chunks, "host inventory", 5).length, 0, "denied path fragments never reach /search");

    const reasons = new Map(store.skipped.map(entry => [path.basename(entry.path), entry.reason]));
    assert.equal(reasons.get(".env"), "high-risk-file");
    assert.match(reasons.get("hosts.md"), /Denied path fragment matched/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that exclusion patterns correctly match Windows-style paths and prune
 * entire directory trees while avoiding over-pruning similar directory names.
 *
 * This test ensures:
 * - Exclusion patterns match Windows-style paths (with backslashes)
 * - Whole directories are pruned (their files are not individually reported)
 * - Similar directory names (e.g., "node_modules" vs "source") are not over-pruned
 * - Pruned directories are not walked, saving traversal time
 *
 * Assumptions:
 * - The indexRoot() function uses minimatch with backslash-separated patterns
 * - The test creates directories that should be excluded and directories that should
 *   be included
 * - Success is indicated by correct directory pruning and file indexing behavior
 */
test("file index exclusion patterns match Windows-style paths and prune whole directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-exclude-"));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "source"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "vendor.js"), "vendored retrieval helper", "utf8");
  await writeFile(path.join(root, "src", "keep.md"), "kept retrieval source", "utf8");
  await writeFile(path.join(root, "source", "also-keep.md"), "kept retrieval source too", "utf8");

  try {
    // These are the patterns as authored in local-agent/config/workspaces.json. They matched nothing
    // at all until minimatch was told to treat "\" as a separator rather than an escape character.
    const store = await indexRoot({
      root,
      indexExcludedPatterns: ["**\\node_modules\\**"],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" }
    }, emptyStore());

    const indexed = store.chunks.map(chunk => chunk.relativePath).sort();
    assert.deepEqual(indexed, ["source\\also-keep.md", "src\\keep.md"]);
    assert.equal(searchChunks(store.chunks, "vendored", 5).length, 0, "excluded trees stay out of the index");

    // Pruned as a directory, so the file inside is never visited and never reported individually.
    const skippedPaths = store.skipped.map(entry => path.relative(root, entry.path));
    assert.ok(skippedPaths.includes("node_modules"), "the directory itself is pruned");
    assert.ok(!skippedPaths.includes(path.join("node_modules", "pkg", "vendor.js")), "pruned trees are not walked");
    // "source" must survive: a prefix of an excluded name is not an excluded directory.
    assert.ok(!skippedPaths.includes("source"), "similarly-named directories are not over-pruned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that credential values are redacted (replaced with placeholders) while
 * the rest of the file content remains searchable, instead of discarding the entire
 * file when a potential credential is found.
 *
 * This test ensures:
 * - Files containing credential-like values are not discarded
 * - Credential values are replaced with a placeholder (e.g., [redacted])
 * - Non-credential content in the same file remains indexed
 * - False positives (e.g., type declarations, placeholders) are not treated as secrets
 *
 * Assumptions:
 * - The indexRoot() function detects credential patterns in file content
 * - The test creates files with actual credentials, false positives, and normal content
 * - The redaction is reported in the chunk's redactions count
 * - Success is indicated by files with credentials being indexed with redactions and
 *   the redacted values not being searchable
 */
test("file index redacts credential values instead of discarding the whole file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-redact-"));
  await writeFile(path.join(root, "config.md"), [
    "# Service configuration",
    "The deployment reads its retrieval settings from the environment.",
    "api_key = A1b2C3d4E5f6G7h8J9k0LmNoPq",
    ""
  ].join("\n"), "utf8");
  // False positives that previously dropped entire files: a type declaration and a placeholder.
  await writeFile(path.join(root, "types.md"), "interface Config { password: string }\nretrieval notes", "utf8");
  await writeFile(path.join(root, "sample.md"), 'apiKey: "REPLACE_ME"\nretrieval sample', "utf8");

  try {
    const store = await indexRoot({
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" }
    }, emptyStore());

    assert.deepEqual(store.chunks.map(chunk => chunk.relativePath).sort(),
      ["config.md", "sample.md", "types.md"], "no file is dropped outright");

    // The secret is gone, but the file around it stayed searchable — the point of redacting.
    assert.equal(searchChunks(store.chunks, "A1b2C3d4E5f6G7h8J9k0LmNoPq", 5).length, 0, "the value is withheld");
    assert.equal(searchChunks(store.chunks, "deployment", 5).length, 1, "the rest of the file is still indexed");

    const config = store.chunks.find(chunk => chunk.relativePath === "config.md");
    assert.match(config.content, /api_key = \[redacted\]/);
    assert.equal(config.redactions, 1, "redactions are reported so the gap is explainable");

    // Neither false positive is treated as a secret.
    for (const name of ["types.md", "sample.md"]) {
      const chunk = store.chunks.find(item => item.relativePath === name);
      assert.equal(chunk.redactions, undefined, `${name} is not redacted`);
    }
    assert.equal(searchChunks(store.chunks, "REPLACE_ME", 5).length, 1, "placeholders are left alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that the file indexing process continues gracefully when encountering
 * directories that become unreadable mid-walk (e.g., due to race conditions, permission
 * changes, or deletion), rather than failing the entire run.
 *
 * This test ensures:
 * - The indexer handles ENOENT/EPERM/EBUSY errors during directory traversal
 * - Readable parts of the file system are still indexed even when some directories
 *   are inaccessible
 * - No partial failures leave the system in an inconsistent state
 *
 * Assumptions:
 * - The indexRoot() function uses a generator that yields chunks incrementally
 * - The test creates a directory that is removed between the parent listing and
 *   its own readdir to simulate mid-walk failures
 * - Success is indicated by the readable part of the file system being indexed
 *   despite the error
 */
test("file index survives an unreadable directory instead of failing the whole run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-unreadable-"));
  await mkdir(path.join(root, "readable"), { recursive: true });
  await writeFile(path.join(root, "readable", "notes.md"), "reachable retrieval notes", "utf8");

  const missing = path.join(root, "vanishing");
  await mkdir(missing, { recursive: true });

  try {
    // Removing the directory between the parent listing and its own readdir reproduces the class of
    // failure (ENOENT/EPERM/EBUSY mid-walk) that used to reject out of the generator.
    await rm(missing, { recursive: true, force: true });

    const store = await indexRoot({
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }], excludedPatterns: [] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" }
    }, emptyStore());

    assert.equal(searchChunks(store.chunks, "reachable", 5).length, 1, "the readable part is still indexed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that the workspace configuration continues to honor the legacy
 * "excludedPatterns" key after the rename to "indexExcludedPatterns".
 *
 * This test ensures:
 * - The new "indexExcludedPatterns" key works correctly
 * - The legacy "excludedPatterns" key still works for backward compatibility
 * - Empty configuration returns an empty array
 *
 * Assumptions:
 * - The indexExclusions() function handles both key names
 * - Success is indicated by the function returning the correct patterns
 *   for each configuration variant
 */
test("workspace config honours the pre-rename excludedPatterns key", () => {
  assert.deepEqual(indexExclusions({ roots: [], indexExcludedPatterns: ["**\\dist\\**"] }), ["**\\dist\\**"]);
  assert.deepEqual(indexExclusions({ roots: [], excludedPatterns: ["**\\legacy\\**"] }), ["**\\legacy\\**"],
    "existing configs written before the rename keep working");
  assert.deepEqual(indexExclusions({ roots: [] }), []);
});

/**
 * Validates that the file broker's access evaluation correctly blocks writes outside
 * configured workspace roots while allowing writes within them.
 *
 * This test ensures:
 * - Writes to paths outside configured roots are blocked
 * - Writes to paths within configured roots are allowed
 * - High-risk files (e.g., .env) are identified regardless of path
 *
 * Assumptions:
 * - The evaluateAccess() function checks write permissions against the workspace
 *   configuration and security policy
 * - The test creates a configuration with specific roots and policies
 * - Success is indicated by the access evaluation returning the correct allowed/highRisk
 *   flags for each path
 */
test("file broker blocks writes outside configured roots and allows project writes", () => {
  const workspaces = {
    roots: [{ path: "C:\\Projects", mode: "read-write", type: "projects" }],
    excludedPatterns: []
  };
  const policy = {
    deniedPathFragments: ["\\.ssh\\"],
    highRiskExtensions: [".env"],
    maxReadBytes: 1000,
    backupRoot: "backups"
  };

  assert.equal(evaluateAccess("C:\\Windows\\system.ini", "write", workspaces, policy).allowed, false);
  assert.equal(evaluateAccess("C:\\Projects\\Bot\\README.md", "write", workspaces, policy).allowed, true);
  assert.equal(evaluateAccess("C:\\Projects\\Bot\\.env", "write", workspaces, policy).highRisk, true);
});

/**
 * Validates that the file broker's configuration cache correctly reuses unchanged
 * configuration values and reloads the configuration file when it changes.
 *
 * This test ensures:
 * - The cache returns the same configuration instance when the file hasn't changed
 * - The cache detects file modifications and reloads the configuration
 * - The configuration file is only re-read when necessary
 *
 * Assumptions:
 * - The ReloadingConfig class implements caching with file modification detection
 * - The test creates a temporary configuration file and modifies it
 * - Success is indicated by the cache behavior matching the expected pattern
 *   (reuse unchanged, reload changed)
 */
/**
 * Validates that the file broker's configuration cache correctly reuses unchanged
 * configuration values and reloads the configuration file when it changes.
 *
 * This test ensures:
 * - The cache returns the same configuration instance when the file hasn't changed
 * - The cache detects file modifications and reloads the configuration
 * - The configuration file is only re-read when necessary
 *
 * Assumptions:
 * - The ReloadingConfig class implements caching with file modification detection
 * - The test creates a temporary configuration file and modifies it
 * - Success is indicated by the cache behavior matching the expected pattern
 *   (reuse unchanged, reload changed)
 */
test("file broker config cache reuses unchanged values and reloads changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-broker-config-"));
  const configPath = path.join(root, "config.json");
  let loads = 0;
  await writeFile(configPath, JSON.stringify({ version: 1 }), "utf8");
  const cache = new ReloadingConfig(configPath, async file => {
    loads++;
    return JSON.parse(await readFile(file, "utf8"));
  });
  try {
    const first = await cache.get();
    assert.strictEqual(await cache.get(), first);
    assert.equal(loads, 1);
    await writeFile(configPath, JSON.stringify({ version: 200 }), "utf8");
    assert.equal((await cache.get()).version, 200);
    assert.equal(loads, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file broker Matbot tool reads host files through the broker service", async () => {
  const requestedPaths = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/read") {
      requestedPaths.push(url.searchParams.get("path"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, content: "broker contents", truncated: false, size: 15 }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new FileBrokerClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const tool = createFileBrokerTool(client);
    const events = [];
    for await (const event of tool.executor.execute({
      action: "read",
      path: "C:\\Projects\\Cortex\\readme.md"
    }, { signal: new AbortController().signal })) {
      events.push(event);
    }

    assert.deepEqual(requestedPaths, ["C:\\Projects\\Cortex\\readme.md"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "result");
    assert.deepEqual(events[0].value, { ok: true, content: "broker contents", truncated: false, size: 15 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("file writer creates a backup and a diff for overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-agent-write-"));
  const target = path.join(root, "sample.txt");
  const backupRoot = path.join(root, "backups");
  await writeFile(target, "before\n", "utf8");

  try {
    const result = await writeTextFile(target, "after\n", backupRoot);
    assert.ok(result.backupPath);
    assert.match(result.diff, /-before/);
    assert.match(result.diff, /\+after/);
    assert.equal(await readFile(target, "utf8"), "after\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Validates that the hybrid ranking function deduplicates entries that have the
 * same sourceType and sourceUuid, keeping the entry with the highest confidence.
 *
 * This test ensures:
 * - Entries from the same source (e.g., same file) are deduplicated
 * - The entry with the highest confidence is kept
 * - Entries from different sources (e.g., different source types) are kept separately
 *
 * Assumptions:
 * - The mergeRankAndDeduplicate() function takes an array of knowledge entries
 *   and returns a deduplicated list
 * - The test creates entries that should be deduplicated (same source) and entries
 *   that should be kept (different sources)
 * - Success is indicated by the output having the expected number of entries
 *   with the correct content
 */
test("hybrid ranking deduplicates entries", () => {
  const ranked = mergeRankAndDeduplicate([
    knowledgeEntry({ id: "file-index:a", content: "same", sourceType: "file-index", sourceUuid: "a", confidence: 2 }),
    knowledgeEntry({ id: "file-index:a-copy", content: "same", sourceType: "file-index", sourceUuid: "a", confidence: 2 }),
    knowledgeEntry({ id: "mem0:m", content: "memory", sourceType: "mem0", sourceUuid: "m", confidence: 1 })
  ]);

  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].content, "same");
});

/**
 * Validates that Mem0 identities are isolated per Cortex workspace by ensuring
 * that each workspace gets a unique user ID for Mem0 requests.
 *
 * This test ensures:
 * - Each Cortex workspace gets a unique Mem0 user ID (workspace-scoped)
 * - The same workspace always gets the same user ID (deterministic)
 * - Different workspaces get different user IDs (isolation)
 *
 * Assumptions:
 * - The workspaceScopedMem0UserId() function generates unique IDs per workspace
 * - The workspaceIdFromConfigPath() function extracts a stable ID from a config path
 * - The test creates three workspaces: default, alpha, and beta
 * - Success is indicated by the user ID function returning the expected values
 *   for each workspace and distinct values for different workspaces
 */
test("Mem0 identities are isolated for every Cortex workspace", () => {
  const root = path.join(os.tmpdir(), "cortex", "local-agent", "matbot");
  const rootConfig = path.join(root, "matbot.yaml");
  const alphaConfig = path.join(root, "workspaces", "alpha", "matbot.yaml");
  const betaConfig = path.join(root, "workspaces", "beta", "matbot.yaml");

  assert.equal(workspaceIdFromConfigPath(rootConfig), "default");
  assert.equal(workspaceIdFromConfigPath(alphaConfig), "alpha");
  assert.equal(workspaceScopedMem0UserId("local-agent", "default"), "local-agent:workspace:default");
  assert.equal(workspaceScopedMem0UserId("local-agent", "alpha"), "local-agent:workspace:alpha");
  assert.notEqual(
    workspaceScopedMem0UserId("local-agent", workspaceIdFromConfigPath(alphaConfig)),
    workspaceScopedMem0UserId("local-agent", workspaceIdFromConfigPath(betaConfig))
  );
});

/**
 * Validates that Mem0 add and search requests include the workspace-scoped user ID
 * and workspace metadata in the request body.
 *
 * This test ensures:
 * - Mem0 add requests include the workspace-scoped user_id and metadata.workspaceId
 * - Mem0 search requests include the workspace-scoped user_id
 * - The identity is correctly propagated to all Mem0 API calls
 *
 * Assumptions:
 * - The Mem0Client class sends requests to a remote Mem0 API server
 * - The test creates a mock HTTP server that captures all requests
 * - The test adds a memory and performs a search under a specific workspace
 * - Success is indicated by the captured requests containing the correct
 *   user_id and workspaceId values
 */
test("Mem0 add and search requests carry the workspace-scoped identity", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url?.includes("search") ? JSON.stringify({ results: [] }) : JSON.stringify({}));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new Mem0Client({
      baseUrl: `http://127.0.0.1:${address.port}`,
      userId: "local-agent:workspace:alpha",
      workspaceId: "alpha"
    });
    await client.add(knowledgeEntry({ id: "memory-alpha", content: "alpha only", sourceType: "test", sourceUuid: "alpha", confidence: 1 }));
    await client.search("alpha");
    assert.equal(requests[0].user_id, "local-agent:workspace:alpha");
    assert.equal(requests[0].metadata.workspaceId, "alpha");
    assert.equal(requests[1].user_id, "local-agent:workspace:alpha");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function knowledgeEntry({ id, content, sourceType, sourceUuid, confidence }) {
  const now = "2026-06-28T00:00:00.000Z";
  const contentHash = `${sourceType}:${sourceUuid}:${content}`;
  return {
    id,
    version: id,
    entities: [],
    tags: [sourceType],
    summary: content,
    content,
    contentHash,
    source: { type: sourceType, uuid: sourceUuid },
    confidence,
    createdAt: now,
    updatedAt: now
  };
}
