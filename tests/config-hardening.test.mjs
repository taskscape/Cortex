/**
 * Hardening regression tests for @matatbread/matbot-config.
 *
 * Covers:
 * - M3: comment stripping must not corrupt '#' inside quoted scalar values
 * - M4a: sequences of mappings (- name: x) parse as records, not strings
 * - M4b: block scalars honour clip / strip / keep chomping indicators
 * - L5: provider/model name collisions warn instead of silently overwriting;
 *       non-scalar parameter values are warned about and skipped
 *
 * The matbot packages ship TypeScript source without compiled output, so the
 * apps/cli resolution hook (.js -> .ts remap) is registered before importing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

register(
  "./ts-hooks.js",
  pathToFileURL(fileURLToPath(new URL("../local-agent/matbot/apps/cli/ts-hooks.js", import.meta.url))),
);

const { parseYaml } = await import(
  new URL("../local-agent/matbot/packages/core/config/src/yaml.ts", import.meta.url)
);
const { parseConfig } = await import(
  new URL("../local-agent/matbot/packages/core/config/src/loader.ts", import.meta.url)
);

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test("M3: '#' inside double-quoted values survives comment stripping", () => {
  const doc = parseYaml('providers:\n  claude:\n    apiKey: "abc#123"\n');
  assert.equal(doc.providers.claude.apiKey, "abc#123");
});

test("M3: '#' inside single-quoted values survives comment stripping", () => {
  const doc = parseYaml("key: 'it#s'\n");
  assert.equal(doc.key, "it#s");
});

test("M3: real comments after quoted values are still stripped", () => {
  const doc = parseYaml('key: "a#b" # trailing comment\nother: 2 # plain comment\n');
  assert.equal(doc.key, "a#b");
  assert.equal(doc.other, 2);
});

test("M4a: sequence items containing mappings parse as records", () => {
  const doc = parseYaml([
    "available_models:",
    "  - name: claude",
    "    context_tokens: 200000",
    "  - name: gpt",
    "    context_tokens: 128000",
    "",
  ].join("\n"));
  assert.deepEqual(doc.available_models, [
    { name: "claude", context_tokens: 200000 },
    { name: "gpt", context_tokens: 128000 },
  ]);
});

test("M4a: plain scalars containing ':' without ': ' stay scalars", () => {
  const doc = parseYaml("endpoints:\n  - http://example.com\n");
  assert.deepEqual(doc.endpoints, ["http://example.com"]);
});

test("M4a: sequences of mappings flow through parseConfig's available_models", () => {
  const config = parseConfig([
    "language_models:",
    "  openai_compatible:",
    "    local:",
    "      api_url: http://localhost:8080",
    "      available_models:",
    "        - name: claude",
    "",
  ].join("\n"));
  const provider = config.providers.get("local");
  assert.ok(provider);
  assert.equal(provider.model, "claude");
});

test("M4b: literal block scalar defaults to clip chomping", () => {
  const doc = parseYaml("script: |\n  line1\n  line2\nafter: true\n");
  assert.equal(doc.script, "line1\nline2\n");
});

test("M4b: '|-' strips the trailing newline", () => {
  const doc = parseYaml("script: |-\n  line1\n  line2\n");
  assert.equal(doc.script, "line1\nline2");
});

test("M4b: '|+' keeps the trailing newline like clip when no blank lines follow", () => {
  const doc = parseYaml("script: |+\n  line1\n  line2\n");
  assert.equal(doc.script, "line1\nline2\n");
});

test("M4b: '>' folds lines with spaces (clip)", () => {
  const doc = parseYaml("text: >\n  hello\n  world\n");
  assert.equal(doc.text, "hello world\n");
});

test("M4b: '>-' strips the folded result", () => {
  const doc = parseYaml("text: >-\n  hello\n  world\n");
  assert.equal(doc.text, "hello world");
});

test("L5: duplicate model names inside one group warn instead of silently overwriting", () => {
  const warnings = captureWarnings(() => {
    const config = parseConfig([
      "language_models:",
      "  openai_compatible:",
      "    local:",
      "      api_url: http://localhost:8080",
      "      available_models:",
      "        - name: claude",
      "        - name: claude",
      "",
    ].join("\n"));
    assert.equal(config.providers.size, 1);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /provider "local-claude"/);
});

test("L5: openai_compatible group colliding with a providers key warns", () => {
  const warnings = captureWarnings(() => {
    const config = parseConfig([
      "language_models:",
      "  openai_compatible:",
      "    shared:",
      "      api_url: http://localhost:8080",
      "      available_models:",
      "        - name: m1",
      "providers:",
      "  shared:",
      "    module: ./some-module",
      "    model: other-model",
      "",
    ].join("\n"));
    assert.equal(config.providers.size, 1);
    assert.equal(config.providers.get("shared").model, "other-model");
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /provider "shared"/);
});

test("L5: nested provider parameters survive config parsing", () => {
  const config = parseConfig([
    "providers:",
    "  p:",
    "    module: ./some-module",
    "    model: m",
    "    parameters:",
    "      nested:",
    "        a: 1",
    "        flags:",
    "          - true",
    "          - false",
    "",
  ].join("\n"));
  const params = config.providers.get("p").parameters;
  assert.deepEqual(params.nested, { a: 1, flags: [true, false] });
});

test("L5: numeric strings for known numeric parameters are coerced", () => {
  const config = parseConfig([
    "providers:",
    "  p:",
    "    module: ./some-module",
    "    model: m",
    "    parameters:",
    '      temperature: "0.7"',
    '      maxTokens: "4096"',
    "      note: keep-me",
    "",
  ].join("\n"));
  const params = config.providers.get("p").parameters;
  assert.equal(params.temperature, 0.7);
  assert.equal(params.maxTokens, 4096);
  assert.equal(params.note, "keep-me");
});
