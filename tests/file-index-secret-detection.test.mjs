import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRoot } from "../local-agent/file-index/dist/indexer.js";
import { emptyStore } from "../local-agent/file-index/dist/store.js";
import { fileLevelSecret, redactSecrets } from "../local-agent/file-index/dist/secrets.js";

/**
 * Test 1: File-level secret detection
 *
 * Validates that the file-index can identify file-level secret patterns (API keys,
 * private keys) without false positives on ordinary text that happens to contain
 * similar prefixes or formats.
 *
 * Assumptions:
 * - fileLevelSecret() returns a category string for files containing actual secrets
 * - fileLevelSecret() returns undefined for files without any secret patterns
 * - The function can distinguish between literal credential patterns and
 *   documentation that mentions similar patterns in context
 * - The test covers both API key patterns and private key block patterns
 */
test("file-index recognizes file-level API-key and private-key shapes without rejecting ordinary prose", () => {
  const apiKey = "sk-proj-cortexSyntheticCanary_0123456789";

  assert.equal(fileLevelSecret(`OPENAI_API_KEY=${apiKey}`), "api-key-literal");
  assert.equal(
    fileLevelSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----"),
    "private-key-block",
  );
  assert.equal(fileLevelSecret("The sk- prefix appears in documentation, but no credential is present."), undefined);
  assert.equal(fileLevelSecret("token format is a product concern, not a stored secret"), undefined);
});

/**
 * Test 1b: Additional high-confidence credential shapes
 *
 * Validates the FILE_LEVEL_SECRETS entries added for AWS access key ids,
 * GitHub tokens, and Google API keys, including near-miss shapes that must
 * NOT trigger a whole-file withhold.
 */
test("file-index recognizes AWS, GitHub, and Google credential shapes without false positives on lookalikes", () => {
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const githubToken = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;
  const googleKey = `AIza${"aB3_-".repeat(7)}`;

  assert.equal(githubToken.length, 40);
  assert.equal(fileLevelSecret(`aws_access_key_id = ${awsKey}`), "aws-access-key-id");
  assert.equal(fileLevelSecret(`token: ${githubToken}`), "github-token");
  assert.equal(fileLevelSecret(`key=${googleKey}`), "google-api-key");

  // Near-misses stay unflagged.
  assert.equal(fileLevelSecret(`AKIA short: ${"AKIA123"}`), undefined);
  assert.equal(fileLevelSecret(`ghp_ too short: ${"ghp_abc123"}`), undefined);
  assert.equal(fileLevelSecret(`AIza too short: AIza${"a".repeat(34)}`), undefined);
});

/**
 * Test 2: Credential redaction in content
 *
 * Validates that the redactSecrets() function properly identifies and redacts
 * credential-like patterns in text content while preserving legitimate uses of
 * similar-looking terms (like type annotations, placeholder text, etc.).
 *
 * Assumptions:
 * - redactSecrets() processes text and returns both the redacted content and
 *   a count of redactions made
 * - Credential patterns include API keys, tokens (JWT format), and passwords
 * - The function correctly handles various assignment formats (=, :, =")
 * - Safe lookalikes are preserved: type annotations, placeholder values like "REPLACE_ME",
 *   and short/invalid token formats
 * - Redaction markers are consistent ([redacted])
 */
test("file-index redacts credential-shaped assignments across common formats and preserves safe lookalikes", () => {
  const apiKey = "A1b2C3d4E5f6G7h8J9k0LmNoPq";
  const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
  const password = "SuperSecret-Value_123";
  const input = [
    `api_key = ${apiKey}`,
    `service-token: '${token}'`,
    `databasePassword = \"${password}\"`,
    "interface Options { password: string }",
    'exampleApiKey: "REPLACE_ME"',
    "shortToken = abc123",
    "notes = token values must be configured elsewhere",
  ].join("\n");

  const result = redactSecrets(input);
  assert.equal(result.redactions, 3);
  assert.doesNotMatch(result.text, new RegExp(apiKey));
  assert.doesNotMatch(result.text, new RegExp(token.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(result.text, new RegExp(password));
  assert.match(result.text, /api_key = \[redacted\]/);
  assert.match(result.text, /service-token: '\[redacted\]'/);
  assert.match(result.text, /databasePassword = "\[redacted\]"/);
  assert.match(result.text, /password: string/);
  assert.match(result.text, /REPLACE_ME/);
  assert.match(result.text, /shortToken = abc123/);
  assert.match(result.text, /token values must be configured elsewhere/);
});

/**
 * T3-E2E-036: File-index secret file handling and redacted document indexing
 *
 * Validates that the file-index can:
 * - Detect and skip files with high-confidence secrets (to prevent accidental exposure)
 * - Process files with partial credential patterns (redacting the secret but keeping the file)
 * - Preserve searchability of non-secret content in files that had secrets redacted
 * - Handle edge cases like files with only placeholder values
 *
 * This test ensures:
 * - Files with high-confidence secrets (e.g., raw API keys, private key blocks) are skipped
 * - Skipped files are logged with a reason (e.g., "possible-secret: api-key-literal")
 * - Files with some credential patterns have those patterns redacted but remain searchable
 * - The redaction preserves surrounding context for searchability
 * - The indexer can distinguish between actual secrets and safe patterns like "REPLACE_ME"
 *
 * Assumptions:
 * - The indexer correctly identifies and handles secret patterns
 * - The test creates files with various secret patterns and edge cases
 * - Success is indicated by correct file handling and redaction behavior
 */
test("T3-E2E-036 file-index skips high-confidence secret files and keeps surrounding redacted documents searchable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cortex-file-index-secrets-"));
  const apiKey = "sk-proj-cortexSyntheticCanary_0123456789";
  const assignment = "LongAssignedSecretValue_012345";
  try {
    await writeFile(path.join(root, "private-key.md"), `# Unsafe\n${apiKey}\n`, "utf8");
    await writeFile(path.join(root, "deployment.md"), [
      "# Deployment runbook",
      "Deploy the service after the approval check.",
      `deployment_token = ${assignment}`,
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "examples.md"), [
      "# Example",
      'apiKey: "REPLACE_ME"',
      "This document remains safe to retrieve.",
    ].join("\n"), "utf8");

    const store = await indexRoot({
      root,
      indexExcludedPatterns: [],
      maxFileBytes: 100_000,
      workspaces: { roots: [{ path: root, mode: "read-write", type: "test" }] },
      policy: { deniedPathFragments: [], highRiskExtensions: [], maxReadBytes: 100_000, backupRoot: "backups" },
    }, emptyStore());

    assert.deepEqual(store.chunks.map(chunk => chunk.relativePath).sort(), ["deployment.md", "examples.md"]);
    assert.ok(store.skipped.some(entry => entry.path.endsWith("private-key.md") && entry.reason === "possible-secret: api-key-literal"));
    const deployment = store.chunks.find(chunk => chunk.relativePath === "deployment.md");
    assert.equal(deployment?.redactions, 1);
    assert.doesNotMatch(deployment?.content ?? "", new RegExp(assignment));
    assert.match(deployment?.content ?? "", /Deploy the service after the approval check/);
    assert.match(store.chunks.find(chunk => chunk.relativePath === "examples.md")?.content ?? "", /REPLACE_ME/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
