import { writeFile } from "node:fs/promises";

function usage() {
  console.error("Usage: npm run eval:cortex -- <suite-id> [--candidate name] [--provider name] [--url http://127.0.0.1:19778] [--junit results.xml]");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function redactSecrets(value, key = "") {
  if (/secret|token|password|authorization|credential|api.?key|cookie/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey)]));
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}

function junit(result) {
  const rows = Array.isArray(result.results) ? result.results : [];
  const failures = rows.filter(row => !row.passed).length;
  const cases = rows.map(row => [
    `  <testcase classname="cortex.evaluation" name="${xml(`${row.caseId}:${row.scorerType}`)}">`,
    ...(row.passed ? [] : [`    <failure message="${xml(row.rationale)}">${xml(JSON.stringify({ actual: row.actual, expected: row.expected }))}</failure>`]),
    "  </testcase>",
  ].join("\n")).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Cortex evaluation" tests="${rows.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

const args = process.argv.slice(2);
const suiteId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (!suiteId) {
  usage();
  process.exit(2);
}

const baseUrl = option(args, "--url") ?? process.env.CORTEX_WEBUI_URL ?? "http://127.0.0.1:19778";
const body = {
  action: "run_suite",
  suiteId,
  candidate: option(args, "--candidate") ?? process.env.GIT_COMMIT ?? "working-tree",
  ...(option(args, "--provider") !== undefined ? { provider: option(args, "--provider") } : {}),
};

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/tools/evaluation_action`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await response.text();
let result;
try { result = JSON.parse(text); }
catch { throw new Error(`Cortex evaluation returned non-JSON (${response.status}): ${text.slice(0, 500)}`); }
if (!response.ok || result?.error) throw new Error(redactSecrets(result?.error) ?? `Cortex evaluation failed with HTTP ${response.status}.`);

result = redactSecrets(result);
console.log(JSON.stringify(result, null, 2));
const junitPath = option(args, "--junit");
if (junitPath) await writeFile(junitPath, junit(result), "utf8");
if (!result?.run?.passed) process.exitCode = 1;
