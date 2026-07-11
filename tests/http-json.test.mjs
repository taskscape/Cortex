import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { isJsonObject, readJsonBody, sendJson, sendJsonError } from "../local-agent/http-utils/dist/index.js";

test("shared HTTP JSON helpers validate content type, shape, and body size", async () => {
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
