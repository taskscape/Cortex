import assert from "node:assert/strict";
import test from "node:test";

// Installs the .ts resolution hook used by every test importing matbot sources.
await import("../local-agent/matbot/apps/cli/register.js");

// L22 — json-validation: long tool-authored patterns are rejected; invalid patterns fail closed.
test("json-validation rejects over-long regex patterns and fails closed on invalid ones", async () => {
  const { plugin } = await import("../local-agent/matbot/packages/plugins/json-validation/src/index.ts");

  const registered = [];
  await plugin.setup({ hooks: { register: hook => registered.push(hook) } });
  const hook = registered[0];
  assert.ok(hook, "validation hook registered");

  const run = schema => hook.handler.call(hook, {
    tool: { name: "t", inputSchema: { type: "object", properties: { x: schema } } },
    toolCall: { name: "t", input: { x: "value" } },
  });

  // Pattern longer than the cap is rejected outright (not compiled).
  const tooLong = await run({ type: "string", pattern: "a".repeat(1001) });
  assert.ok(tooLong?.rejectTool, "over-long pattern rejected");
  assert.match(tooLong.rejectTool.message, /pattern exceeds/);

  // Invalid pattern fails closed as a validation error instead of throwing out of the hook.
  const invalid = await run({ type: "string", pattern: "([unclosed" });
  assert.ok(invalid?.rejectTool, "invalid pattern rejected");
  assert.match(invalid.rejectTool.message, /not a valid regular expression/);

  // A normal pattern still validates as before.
  const ok = await run({ type: "string", pattern: "^val" });
  assert.equal(ok, undefined);
});

// L24 — webcrypto-vault: base64 conversion survives payloads beyond the spread-argument limit.
test("WebCryptoVault encrypt/decrypt roundtrips large payloads via chunked base64", async () => {
  const { WebCryptoVault } = await import("../local-agent/matbot/packages/plugins/browser/src/webcrypto-vault.ts");

  // ~300 KiB of mixed multibyte content — far past the old String.fromCharCode(...) RangeError.
  const big = ("cortex-πλharden-" . repeat(20_000)).slice(0, 300_000);
  const blob = await WebCryptoVault.encrypt("correct horse battery staple", big);
  assert.match(blob, /^[A-Za-z0-9+/=]+$/);
  assert.equal(await WebCryptoVault.decrypt("correct horse battery staple", blob), big);

  // Small payload still roundtrips.
  const small = await WebCryptoVault.encrypt("pw", "tiny");
  assert.equal(await WebCryptoVault.decrypt("pw", small), "tiny");

  // Wrong passphrase must not decrypt.
  await assert.rejects(() => WebCryptoVault.decrypt("wrong", blob));
});

// L9 — postgres-repository: exported identifier gate rejects injection shapes.
test("postgres quoteIdentifier enforces the safe identifier charset", async () => {
  const { quoteIdentifier } = await import("../local-agent/matbot/packages/plugins/workspace-rag/src/v2/postgres-repository.ts");

  assert.equal(quoteIdentifier("rag_v2_documents_workspace"), '"rag_v2_documents_workspace"');
  assert.equal(quoteIdentifier("_leading_underscore"), '"_leading_underscore"');

  for (const hostile of [
    "'; DROP TABLE documents; --",
    'policy"); CREATE POLICY p',
    "name-with-dash",
    "name with space",
    "",
    "1startingdigit",
    'double"quote',
  ]) {
    assert.throws(() => quoteIdentifier(hostile), /Unsafe SQL identifier/, `rejected: ${JSON.stringify(hostile)}`);
  }
});
