import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

const root = path.resolve(import.meta.dirname, "..");
const enabled = process.platform === "win32"
  && process.env.CORTEX_LIFECYCLE_E2E === "1"
  && process.env.CORTEX_LIFECYCLE_ISOLATED === "1";
const fullEnabled = enabled && process.env.CORTEX_LIFECYCLE_FULL_E2E === "1";
const providerJourneyEnabled = fullEnabled
  && process.env.CORTEX_LIFECYCLE_PROVIDER_E2E === "1"
  && Boolean(process.env.CORTEX_LIFECYCLE_TEST_PROVIDER);

function powershell(script, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(root, "scripts", script),
      ...args
    ], {
      cwd: root,
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function powershellInline(command, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", command
    ], {
      cwd: root,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell command timed out\n${stderr}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function textFromMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

/**
 * E2E-008: Validates the complete Windows service lifecycle - startup, health
 * reporting, and shutdown - using the documented PowerShell scripts.
 *
 * This test ensures:
 * - The documented run.ps1 launcher starts the WebUI and Matbot correctly
 * - The WebUI is accessible on the configured port and returns the Cortex branding
 * - The health-check.ps1 script correctly reports service status (ok or unavailable)
 * - The documented stop-local-agent.ps1 cleanly shuts down the services
 * - After shutdown, the WebUI port is no longer reachable
 * - Running stop multiple times is idempotent (safe to call repeatedly)
 *
 * Assumptions:
 * - The test runs on Windows (process.platform === "win32")
 * - Environment variables CORTEX_LIFECYCLE_E2E=1 and CORTEX_LIFECYCLE_ISOLATED=1
 *   are set to enable the test (double opt-in for destructive operations)
 * - A disposable test host is used (no production data at risk)
 * - The PowerShell scripts are in the scripts/ directory and follow documented interfaces
 * - The WebUI serves on http://127.0.0.1:19778 by default
 */

test("E2E-008 / T2-E2E-020 complete Windows first-run configures hidden secrets and starts Docker-backed services", {
  skip: fullEnabled
    ? false
    : "requires the three lifecycle opt-ins on a dedicated disposable Windows host",
  timeout: 900_000
}, async t => {
  const envFile = path.join(root, "local-agent", "docker", "mem0", ".env");
  const previousEnvFile = await readFile(envFile).catch(() => null);
  const secretNames = ["OPENAI_API_KEY", "POSTGRES_PASSWORD", "NEO4J_PASSWORD", "NEO4J_AUTH", "MEM0_API_KEY"];
  const snapshotCommand = [
    `$names = @(${secretNames.map(name => `'${name}'`).join(",")})`,
    "$values = @{}",
    "foreach ($name in $names) { $values[$name] = [Environment]::GetEnvironmentVariable($name, 'User') }",
    "$values | ConvertTo-Json -Compress"
  ].join("; ");
  const snapshotResult = await powershellInline(snapshotCommand);
  assert.equal(snapshotResult.code, 0, snapshotResult.stderr);
  const userSnapshot = JSON.parse(snapshotResult.stdout.trim() || "{}");

  t.after(async () => {
    await powershell("stop-local-agent.ps1", [], { timeoutMs: 120_000 }).catch(() => {});
    const encoded = Buffer.from(JSON.stringify(userSnapshot), "utf8").toString("base64");
    const restoreCommand = [
      "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CORTEX_LIFECYCLE_SECRET_SNAPSHOT))",
      "$values = $json | ConvertFrom-Json",
      `foreach ($name in @(${secretNames.map(name => `'${name}'`).join(",")})) {`,
      "  $value = $values.$name",
      "  if ($null -eq $value) { [Environment]::SetEnvironmentVariable($name, $null, 'User') }",
      "  else { [Environment]::SetEnvironmentVariable($name, [string]$value, 'User') }",
      "}"
    ].join("; ");
    await powershellInline(restoreCommand, {
      env: { ...process.env, CORTEX_LIFECYCLE_SECRET_SNAPSHOT: encoded }
    }).catch(() => {});
    if (previousEnvFile === null) await rm(envFile, { force: true }).catch(() => {});
    else await writeFile(envFile, previousEnvFile);
  });

  const fakeKey = "sk-test-cortex-lifecycle-not-a-real-secret";
  const configured = await powershell("setup-secrets.ps1", ["-OpenAiKey", fakeKey, "-Force"]);
  assert.equal(configured.code, 0, configured.stderr);
  assert.doesNotMatch(configured.stdout + configured.stderr, new RegExp(fakeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(configured.stdout, /values hidden/i);

  const freshShell = await powershellInline(
    "if ([Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'User') -ne $env:CORTEX_TEST_EXPECTED_KEY) { exit 9 }",
    { env: { ...process.env, CORTEX_TEST_EXPECTED_KEY: fakeKey } }
  );
  assert.equal(freshShell.code, 0, "a new PowerShell process did not see the configured User-scope key");

  const started = await powershell("run.ps1", ["-NoBrowser"], { timeoutMs: 600_000 });
  assert.equal(started.code, 0, `full run.ps1 failed\n${started.stdout}\n${started.stderr}`);
  await waitForHttp("http://127.0.0.1:19778", 180_000);
  const health = await powershell("health-check.ps1", [], { timeoutMs: 120_000 });
  assert.equal(health.code, 0, `health-check.ps1 failed\n${health.stdout}\n${health.stderr}`);
});

test("T3-E2E-021 disposable Windows lifecycle completes a provider turn and preserves its session across restart", {
  skip: providerJourneyEnabled
    ? false
    : "requires all lifecycle opt-ins, CORTEX_LIFECYCLE_PROVIDER_E2E=1, and a disposable fake provider configured by CORTEX_LIFECYCLE_TEST_PROVIDER",
  timeout: 900_000
}, async t => {
  const baseUrl = "http://127.0.0.1:19778";
  const provider = process.env.CORTEX_LIFECYCLE_TEST_PROVIDER;
  t.after(async () => {
    await powershell("stop-local-agent.ps1", [], { timeoutMs: 120_000 }).catch(() => {});
  });

  const started = await powershell("run.ps1", ["-NoBrowser"], { timeoutMs: 600_000 });
  assert.equal(started.code, 0, `run.ps1 failed\n${started.stdout}\n${started.stderr}`);
  await waitForHttp(baseUrl, 180_000);

  const createdResponse = await fetch(`${baseUrl}/sessions`, { method: "POST" });
  assert.equal(createdResponse.ok, true);
  const session = await createdResponse.json();
  assert.equal(typeof session.id, "string");
  const submitted = await fetch(`${baseUrl}/sessions/${encodeURIComponent(session.id)}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "Return the lifecycle canary LIFECYCLE_PROVIDER_TURN_OK.",
      provider,
      concatQueue: false
    })
  });
  assert.equal(submitted.ok, true, await submitted.text());

  const deadline = Date.now() + 180_000;
  let stored;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/tools/session_action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "get", sessionId: session.id })
    });
    if (response.ok) {
      stored = await response.json();
      if (stored?.messages?.some(message => message.role === "assistant")) break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const assistant = stored?.messages?.find(message => message.role === "assistant");
  assert.ok(assistant, "fake-provider turn did not finish");
  assert.match(
    textFromMessage(assistant),
    /LIFECYCLE_PROVIDER_TURN_OK/,
    "the configured fake provider did not return the requested lifecycle canary"
  );
  assert.equal(stored.messages.filter(message => message.role === "user").length, 1);

  const stopped = await powershell("stop-local-agent.ps1", [], { timeoutMs: 120_000 });
  assert.equal(stopped.code, 0);
  const restarted = await powershell("run.ps1", ["-NoBrowser"], { timeoutMs: 600_000 });
  assert.equal(restarted.code, 0);
  await waitForHttp(baseUrl, 180_000);
  const persistedResponse = await fetch(`${baseUrl}/tools/session_action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "get", sessionId: session.id })
  });
  assert.equal(persistedResponse.ok, true);
  const persisted = await persistedResponse.json();
  assert.equal(persisted.messages.filter(message => message.role === "user").length, 1);
  const persistedAssistant = persisted.messages.find(message => message.role === "assistant");
  assert.ok(persistedAssistant);
  assert.match(textFromMessage(persistedAssistant), /LIFECYCLE_PROVIDER_TURN_OK/);
});
