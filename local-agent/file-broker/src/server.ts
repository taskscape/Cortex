/**
 * File-broker HTTP service entry point. Exposes `/health`, `/list`, `/read`,
 * and `/write` over the loopback interface, gating every operation with
 * {@link evaluateRealAccess} against reloadable workspace/security configs.
 * Requests from non-loopback `Host` headers are rejected, and an optional
 * shared-secret header (`x-cortex-token`, enabled via `CORTEX_FILE_BROKER_TOKEN`)
 * guards every route except `/health`. Writes of high-risk targets require
 * `approved=true` and always produce a pre-write backup plus diff. Reads and
 * writes perform I/O through a symlink-verified handle (H4) after policy
 * approval. This module
 * has no exports; it starts the server on `FILE_BROKER_PORT` (default 8878)
 * when run directly.
 */

import http from "node:http";
import path from "node:path";
import { HttpError, assertLoopbackRequest, assertSharedToken, isJsonObject, readJsonBody, requestAbortSignal, sendJson, sendJsonError } from "@local-agent/http-utils";
import { evaluateRealAccess, loadSecurityPolicy, loadWorkspaceConfig } from "@local-agent/paths";
import { ReloadingConfig } from "./config-cache.js";
import { listDirectory, readCappedText } from "./file-reader.js";
import { openVerified, writeTextFile } from "./file-writer.js";

const port = Number(process.env.FILE_BROKER_PORT ?? 8878);
const host = process.env.CORTEX_BROKER_HOST ?? "127.0.0.1";
const token = process.env.CORTEX_FILE_BROKER_TOKEN;
const workspaceConfigPath = path.resolve(process.env.WORKSPACES_CONFIG ?? "local-agent/config/workspaces.json");
const securityPolicyPath = path.resolve(process.env.SECURITY_POLICY_CONFIG ?? "local-agent/config/security-policy.json");
const workspacesConfig = new ReloadingConfig(workspaceConfigPath, loadWorkspaceConfig);
const securityPolicy = new ReloadingConfig(securityPolicyPath, loadSecurityPolicy);

const server = http.createServer(async (request, response) => {
  try {
    assertLoopbackRequest(request);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const signal = requestAbortSignal(request);
    const [workspaces, policy] = await Promise.all([workspacesConfig.get(), securityPolicy.get()]);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, roots: workspaces.roots.length, maxReadBytes: policy.maxReadBytes });
      return;
    }

    assertSharedToken(request, token);
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

      // H4: read through one verified handle so a link swapped in after the
      // policy check cannot redirect the I/O outside the approved real path.
      const handle = await openVerified(target, workspaces);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error("Path is not a file.");
        sendJson(response, 200, { ok: true, ...(await readCappedText(handle, stats.size, policy.maxReadBytes)) });
      } finally {
        await handle.close();
      }
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

      // L13: allow relocating backups out of the package tree without
      // changing shipped policy files; default stays the configured root.
      const backupRoot = path.resolve(process.env.CORTEX_FILE_BROKER_BACKUP_ROOT ?? policy.backupRoot);
      const result = await writeTextFile(body.path, body.content, backupRoot, workspaces);
      sendJson(response, 200, { ok: true, ...result, highRisk: decision.highRisk });
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJsonError(response, error);
  }
});

server.listen(port, host, () => {
  console.log(`file-broker listening on http://${host}:${port}`);
});

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(400, `Missing query parameter: ${name}`);
  }

  return value;
}

function isWriteRequest(value: unknown): value is { path: string; content: string; approved?: boolean } {
  return isJsonObject(value) && typeof value.path === "string" && value.path.length > 0 &&
    typeof value.content === "string" &&
    (value.approved === undefined || typeof value.approved === "boolean");
}
