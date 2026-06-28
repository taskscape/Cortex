import http from "node:http";
import path from "node:path";
import { listDirectory, readTextFile } from "./file-reader.js";
import { writeTextFile } from "./file-writer.js";
import { evaluateAccess, loadSecurityPolicy, loadWorkspaceConfig } from "./policy.js";

const port = Number(process.env.FILE_BROKER_PORT ?? 8878);
const workspaceConfigPath = path.resolve(process.env.WORKSPACES_CONFIG ?? "local-agent/config/workspaces.json");
const securityPolicyPath = path.resolve(process.env.SECURITY_POLICY_CONFIG ?? "local-agent/config/security-policy.json");

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const workspaces = await loadWorkspaceConfig(workspaceConfigPath);
    const policy = await loadSecurityPolicy(securityPolicyPath);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, roots: workspaces.roots.length, maxReadBytes: policy.maxReadBytes });
      return;
    }

    if (request.method === "GET" && url.pathname === "/list") {
      const target = requiredQuery(url, "path");
      const decision = evaluateAccess(target, "list", workspaces, policy);
      if (!decision.allowed) {
        sendJson(response, 403, decision);
        return;
      }

      sendJson(response, 200, { ok: true, entries: await listDirectory(target) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/read") {
      const target = requiredQuery(url, "path");
      const decision = evaluateAccess(target, "read", workspaces, policy);
      if (!decision.allowed) {
        sendJson(response, 403, decision);
        return;
      }

      sendJson(response, 200, { ok: true, ...(await readTextFile(target, policy.maxReadBytes)) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/write") {
      const body = await readJson<{ path: string; content: string; approved?: boolean }>(request);
      const decision = evaluateAccess(body.path, "write", workspaces, policy);
      if (!decision.allowed) {
        sendJson(response, 403, decision);
        return;
      }

      if (decision.highRisk && !body.approved) {
        sendJson(response, 409, { ...decision, error: "High-risk write requires approved=true." });
        return;
      }

      const result = await writeTextFile(body.path, body.content, path.resolve(policy.backupRoot));
      sendJson(response, 200, { ok: true, ...result, highRisk: decision.highRisk });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, () => {
  console.log(`file-broker listening on http://localhost:${port}`);
});

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing query parameter: ${name}`);
  }

  return value;
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
