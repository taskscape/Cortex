import http from "node:http";
import path from "node:path";
import { indexRoot, summarize } from "./indexer.js";
import { searchChunks } from "./search.js";
import { loadStore, saveStore } from "./store.js";

const port = Number(process.env.FILE_INDEX_PORT ?? 8877);
const storePath = path.resolve(process.env.FILE_INDEX_STORE ?? "local-agent/file-index/data/index.json");
const workspaceConfigPath = path.resolve(process.env.WORKSPACES_CONFIG ?? "local-agent/config/workspaces.json");

interface WorkspaceConfig {
  roots: Array<{ path: string; mode: "read-only" | "read-write"; type: string }>;
  excludedPatterns: string[];
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const store = await loadStore(storePath);
      sendJson(response, 200, { ok: true, storePath, ...summarize(store) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/index") {
      const body = await readJson<{ root?: string }>(request);
      const config = await readWorkspaceConfig();
      const root = body.root ?? config.roots[0]?.path;

      if (!root) {
        sendJson(response, 400, { error: "No root supplied and no configured roots exist." });
        return;
      }

      const current = await loadStore(storePath);
      const next = await indexRoot({
        root,
        excludedPatterns: config.excludedPatterns,
        maxFileBytes: Number(process.env.FILE_INDEX_MAX_FILE_BYTES ?? 1_000_000)
      }, current);
      await saveStore(storePath, next);
      sendJson(response, 200, { ok: true, root, ...summarize(next) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/search") {
      const body = await readJson<{ query: string; limit?: number }>(request);
      const store = await loadStore(storePath);
      const results = searchChunks(store.chunks, body.query, Math.min(body.limit ?? 10, 50));
      sendJson(response, 200, { ok: true, results });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`file-index listening on http://localhost:${port}`);
});

async function readWorkspaceConfig(): Promise<WorkspaceConfig> {
  const raw = await import("node:fs/promises").then(fs => fs.readFile(workspaceConfigPath, "utf8"));
  return JSON.parse(raw) as WorkspaceConfig;
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
