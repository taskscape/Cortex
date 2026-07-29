import http from "node:http";
import path from "node:path";
import { isJsonObject, readJsonBody, requestAbortSignal, sendJson, sendJsonError } from "@local-agent/http-utils";
import { evaluateRealAccess, loadSecurityPolicy, loadWorkspaceConfig } from "@local-agent/paths";
import { ReloadingConfig } from "./config-cache.js";
import { listDirectory, readTextFile } from "./file-reader.js";
import { writeTextFile } from "./file-writer.js";

const port = Number(process.env.FILE_BROKER_PORT ?? 8878);
const workspaceConfigPath = path.resolve(process.env.WORKSPACES_CONFIG ?? "local-agent/config/workspaces.json");
const securityPolicyPath = path.resolve(process.env.SECURITY_POLICY_CONFIG ?? "local-agent/config/security-policy.json");
const workspacesConfig = new ReloadingConfig(workspaceConfigPath, loadWorkspaceConfig);
const securityPolicy = new ReloadingConfig(securityPolicyPath, loadSecurityPolicy);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const signal = requestAbortSignal(request);
    const [workspaces, policy] = await Promise.all([workspacesConfig.get(), securityPolicy.get()]);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, roots: workspaces.roots.length, maxReadBytes: policy.maxReadBytes });
      return;
    }

    if (request.method === "GET" && url.pathname === "/list") {
      signal.throwIfAborted();
      const target = requiredQuery(url, "path");
      const decision = await evaluateRealAccess(target, "list", workspaces, policy);
      if (!decision.allowed) {
        sendJson(response, 403, decision);
        return;
      }

      sendJson(response, 200, { ok: true, entries: await listDirectory(target) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/read") {
      signal.throwIfAborted();
      const target = requiredQuery(url, "path");
      const decision = await evaluateRealAccess(target, "read", workspaces, policy);
      if (!decision.allowed) {
        sendJson(response, 403, decision);
        return;
      }

      sendJson(response, 200, { ok: true, ...(await readTextFile(target, policy.maxReadBytes)) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/write") {
      const body = await readJsonBody<{ path: string; content: string; approved?: boolean }>(request, { validate: isWriteRequest });
      signal.throwIfAborted();
      const decision = await evaluateRealAccess(body.path, "write", workspaces, policy);
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
    sendJsonError(response, error);
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

function isWriteRequest(value: unknown): value is { path: string; content: string; approved?: boolean } {
  return isJsonObject(value) && typeof value.path === "string" && value.path.length > 0 &&
    typeof value.content === "string" &&
    (value.approved === undefined || typeof value.approved === "boolean");
}
