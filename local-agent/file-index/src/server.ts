/**
 * File-index HTTP service entry point. Exposes `/health`, `/index` (re-index a
 * configured workspace root, serialised through an internal queue), and
 * `/search` (scored keyword search over the persisted store). This module has
 * no exports; it loads any existing store, then listens on `FILE_INDEX_PORT`
 * (default 8877) when run directly.
 */

import http from "node:http";
import path from "node:path";
import { isJsonObject, readJsonBody, requestAbortSignal, sendJson, sendJsonError } from "@local-agent/http-utils";
import { indexExclusions, loadSecurityPolicy, loadWorkspaceConfig } from "@local-agent/paths";
import { resolveIndexRoot } from "./index-root.js";
import { indexRoot, summarize } from "./indexer.js";
import { searchChunks } from "./search.js";
import { loadStore, saveStore } from "./store.js";

const port = Number(process.env.FILE_INDEX_PORT ?? 8877);
const storePath = path.resolve(process.env.FILE_INDEX_STORE ?? "local-agent/file-index/data/index.json");
const workspaceConfigPath = path.resolve(process.env.WORKSPACES_CONFIG ?? "local-agent/config/workspaces.json");
const securityPolicyPath = path.resolve(process.env.SECURITY_POLICY_CONFIG ?? "local-agent/config/security-policy.json");

let storeSnapshot = loadStore(storePath);
let indexQueue: Promise<void> = Promise.resolve();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const signal = requestAbortSignal(request);

    if (request.method === "GET" && url.pathname === "/health") {
      const store = await storeSnapshot;
      sendJson(response, 200, { ok: true, storePath, ...summarize(store) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/index") {
      const body = await readJsonBody<{ root?: string }>(request, { validate: isIndexRequest });
      const [config, policy] = await Promise.all([
        loadWorkspaceConfig(workspaceConfigPath),
        loadSecurityPolicy(securityPolicyPath)
      ]);
      const root = await resolveIndexRoot(body.root, config);

      const next = await enqueueIndex(async current => indexRoot({
          root,
          indexExcludedPatterns: indexExclusions(config),
          maxFileBytes: Number(process.env.FILE_INDEX_MAX_FILE_BYTES ?? 1_000_000),
          workspaces: config,
          policy,
          signal
        }, current));
      sendJson(response, 200, { ok: true, root, ...summarize(next) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/search") {
      const body = await readJsonBody<{ query: string; limit?: number }>(request, { validate: isSearchRequest });
      const store = await storeSnapshot;
      const results = searchChunks(store.chunks, body.query, Math.min(body.limit ?? 10, 50));
      sendJson(response, 200, { ok: true, results });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJsonError(response, error);
  }
});

async function enqueueIndex(build: (current: Awaited<typeof storeSnapshot>) => Promise<Awaited<typeof storeSnapshot>>): Promise<Awaited<typeof storeSnapshot>> {
  let resolveResult!: (value: Awaited<typeof storeSnapshot>) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<Awaited<typeof storeSnapshot>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  indexQueue = indexQueue.then(async () => {
    try {
      const next = await build(await storeSnapshot);
      await saveStore(storePath, next);
      storeSnapshot = Promise.resolve(next);
      resolveResult(next);
    } catch (error) {
      rejectResult(error);
    }
  });
  await indexQueue;
  return result;
}

server.listen(port, () => {
  console.log(`file-index listening on http://localhost:${port}`);
});

function isIndexRequest(value: unknown): value is { root?: string } {
  return isJsonObject(value) && (value.root === undefined || typeof value.root === "string");
}

function isSearchRequest(value: unknown): value is { query: string; limit?: number } {
  return isJsonObject(value) && typeof value.query === "string" && value.query.trim().length > 0 &&
    (value.limit === undefined || (typeof value.limit === "number" && Number.isFinite(value.limit)));
}
