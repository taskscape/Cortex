/**
 * E2E-016 / T2-E2E-016: Evaluation CLI validation ensures that the command-line
 * tool for running evaluation suites returns appropriate exit codes and generates
 * valid, properly escaped JUnit XML output.
 *
 * This test ensures:
 * - Passing suites exit with code 0, failing suites exit with code 1
 * - JUnit XML output is properly escaped (XML entities are encoded)
 * - Suite IDs and case IDs with special characters are handled correctly
 * - The CLI correctly reports pass/fail status based on the evaluation results
 *
 * Assumptions:
 * - A fake evaluation server returns predetermined results based on the suite ID
 * - The JUnit XML format follows standard conventions with proper escaping
 * - Special characters in IDs (<, >, &, ") are XML-escaped
 * - Success is indicated by matching XML content and correct exit codes
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/evaluate.mjs", ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}

test("T2-E2E-016 evaluation CLI returns release-gate exit codes and valid escaped JUnit", async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    received.push(input);
    const passed = input.suiteId === "passing-suite";
    const result = {
      run: { id: `run:${input.suiteId}`, passed },
      results: [{
        caseId: 'case:<invoice>&"quote"',
        scorerType: "exact_match",
        passed,
        rationale: passed ? "matched" : 'expected <safe> & "escaped"',
        actual: passed ? "yes" : "<no>",
        expected: "yes"
      }]
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(path.join(tmpdir(), "cortex-evaluation-cli-"));

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const passingJunit = path.join(root, "passing.xml");
    const passing = await runCli([
      "passing-suite", "--candidate", "release-candidate-42", "--provider", "openai-enterprise",
      "--url", baseUrl, "--junit", passingJunit,
    ]);
    assert.equal(passing.code, 0, passing.stderr);
    assert.deepEqual(received.at(-1), {
      action: "run_suite",
      suiteId: "passing-suite",
      candidate: "release-candidate-42",
      provider: "openai-enterprise",
    }, "explicit candidate and provider must reach the governed evaluation endpoint unchanged");
    const passingXml = await readFile(passingJunit, "utf8");
    assert.match(passingXml, /tests="1" failures="0"/);
    assert.match(passingXml, /case:&lt;invoice&gt;&amp;&quot;quote&quot;/);

    const failingJunit = path.join(root, "failing.xml");
    const failing = await runCli(["failing-suite", "--url", baseUrl, "--junit", failingJunit]);
    assert.equal(failing.code, 1, failing.stderr);
    const failingXml = await readFile(failingJunit, "utf8");
    assert.match(failingXml, /tests="1" failures="1"/);
    assert.match(failingXml, /expected &lt;safe&gt; &amp; &quot;escaped&quot;/);
    assert.doesNotMatch(failingXml, /<safe>/);

    const environmentCandidate = await runCli(["passing-suite", "--url", baseUrl], { GIT_COMMIT: "build-from-env" });
    assert.equal(environmentCandidate.code, 0, environmentCandidate.stderr);
    assert.equal(received.at(-1).candidate, "build-from-env", "the CLI uses the CI commit as its default candidate");
    assert.equal("provider" in received.at(-1), false, "the provider stays unpinned unless explicitly selected");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * T3-E2E-007: Credential redaction validation ensures that sensitive data
 * (API keys, tokens, etc.) is removed from all output, including stdout,
 * stderr, and JUnit XML reports.
 *
 * This test ensures:
 * - API keys and other credentials are not exposed in stdout
 * - Credentials are not exposed in stderr
 * - Credentials are not exposed in JUnit XML output
 * - Redacted values are replaced with a placeholder (e.g., "REDACTED")
 * - The CLI correctly detects and redacts credential patterns
 *
 * Assumptions:
 * - The fake evaluation server returns results containing a synthetic API key
 * - The CLI has a credential detection mechanism that identifies patterns like
 *   "sk-...", "Bearer ...", etc.
 * - The redaction is applied before any output is written
 * - Success is indicated by absence of the secret in all outputs and presence
 *   of "REDACTED" placeholder
 */
test("T3-E2E-007 evaluation CLI redacts credentials from stdout and JUnit", async () => {
  const secret = "sk-proj-THIS_IS_A_SYNTHETIC_CANARY_123456";
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      run: { id: "run:secret-redaction", passed: false },
      results: [{
        caseId: "credential-redaction",
        scorerType: "policy",
        passed: false,
        rationale: `provider rejected ${secret}`,
        actual: { note: `Bearer ${secret}` },
        expected: "redacted"
      }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const root = await mkdtemp(path.join(tmpdir(), "cortex-evaluation-secret-"));
  try {
    const junitPath = path.join(root, "redacted.xml");
    const result = await runCli([
      "secret-suite",
      "--url", `http://127.0.0.1:${address.port}`,
      "--junit", junitPath
    ]);
    assert.equal(result.code, 1);
    const junitText = await readFile(junitPath, "utf8");
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.doesNotMatch(junitText, new RegExp(secret));
    assert.match(`${result.stdout}\n${junitText}`, /REDACTED/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
