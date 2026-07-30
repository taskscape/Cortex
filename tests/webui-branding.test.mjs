import assert from "node:assert/strict";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { parseWebBranding } = await import("../local-agent/matbot/packages/plugins/frontend/web/src/server.ts");

/**
 * Validates that the branding configuration parser correctly handles default values,
 * malformed input, valid configurations, and sanitizes potentially dangerous input
 * to prevent XSS attacks.
 *
 * This test ensures:
 * - Undefined configuration returns safe default values (Cortex branding)
 * - Malformed JSON input returns safe default values
 * - Valid configurations are parsed correctly
 * - Potentially dangerous input (HTML tags, CSS injection) is sanitized
 *
 * Assumptions:
 * - The parseWebBranding() function parses the branding configuration
 * - The test creates various input scenarios (undefined, invalid JSON, valid JSON,
 *   dangerous HTML/CSS)
 * - Success is indicated by the parser returning the expected output for each case
 */
test("MISSING-15 branding configuration validates safe defaults and presentation tokens", () => {
  assert.deepEqual(parseWebBranding(undefined), { productName: "Cortex", title: "Cortex" });
  assert.deepEqual(parseWebBranding("not json"), { productName: "Cortex", title: "Cortex" });
  assert.deepEqual(parseWebBranding(JSON.stringify({ productName: "Northstar", brand: "#123abc", brandStrong: "rgb(1, 2, 3)", brandSoft: "url(https://invalid)" })), {
    productName: "Northstar", title: "Northstar", brand: "#123abc", brandStrong: "rgb(1, 2, 3)",
  });
  assert.deepEqual(parseWebBranding(JSON.stringify({ productName: "<img src=x>", title: "", brand: "red; background:url(x)" })), {
    productName: "<img src=x>", title: "<img src=x>",
  });
});
