/**
 * HTTP JSON helpers validation ensures that the shared utilities for parsing
 * and responding with JSON over HTTP work correctly and safely.
 *
 * This test ensures:
 * - isJsonObject() validates that the value is a proper JSON object (not array, null, etc.)
 * - readJsonBody() validates Content-Type is application/json before parsing
 * - readJsonBody() enforces maximum body size to prevent DoS
 * - readJsonBody() validates the parsed JSON shape against a custom validator
 * - sendJson() sends proper JSON responses with 200 status
 * - sendJsonError() sends proper error responses with appropriate HTTP status codes
 * - Content-Type validation returns 415 Unsupported Media Type
 * - Invalid JSON shape returns 400 Bad Request
 * - Oversized bodies return 413 Payload Too Large
 *
 * Assumptions:
 * - The test server uses the shared HTTP utilities from http-utils
 * - The validator function receives the parsed JSON value and returns true/false
 * - The readJsonBody() function is async and returns the parsed body
 * - The server correctly handles errors and sends appropriate responses
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { isJsonObject, readJsonBody, sendJson, sendJsonError } from "../local-agent/http-utils/dist/index.js";

/**
 * T2-E2E-021: Shared HTTP JSON helpers for validation and error handling
 *
 * Validates that the shared HTTP JSON helpers correctly validate content type,
 * shape, and body size, and send appropriate error responses.
 *
 * This test ensures:
 * - isJsonObject() validates that the value is a proper JSON object (not array, null, etc.)
 * - readJsonBody() validates Content-Type is application/json before parsing
 * - readJsonBody() enforces maximum body size to prevent DoS
 * - readJsonBody() validates the parsed JSON shape against a custom validator
 * - sendJson() sends proper JSON responses with 200 status
 * - sendJsonError() sends proper error responses with appropriate HTTP status codes
 * - Content-Type validation returns 415 Unsupported Media Type
 * - Invalid JSON shape returns 400 Bad Request
 * - Oversized bodies return 413 Payload Too Large
 *
 * Assumptions:
 * - The test server uses the shared HTTP utilities from http-utils
 * - The validator function receives the parsed JSON value and returns true/false
 * - The readJsonBody() function is async and returns the parsed body
 * - The server correctly handles errors and sends appropriate responses
 */
test("T2-E2E-021 shared HTTP JSON helpers validate content type, shape, and body size", async () => {
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request, {
        maxBytes: 32,
        validate: value => isJsonObject(value) && typeof value.name === "string"
      });
      sendJson(response, 200, { ok: true, name: body.name });
    } catch (error) {
      sendJsonError(response, error);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  try {
    const valid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Cortex" })
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { ok: true, name: "Cortex" });

    const invalidType = await fetch(url, { method: "POST", body: "not-json" });
    assert.equal(invalidType.status, 415);

    const invalidShape = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: true })
    });
    assert.equal(invalidShape.status, 400);

    const oversized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(64) })
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
