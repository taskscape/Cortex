import { readFile } from "node:fs/promises";

let spec = "";
try {
  spec = await readFile(new URL("../specification.md", import.meta.url), "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

const key = spec.match(/sk-[A-Za-z0-9_-]{20,}/)?.[0] ?? process.env.OPENAI_API_KEY;

if (!key) {
  throw new Error("No OpenAI API key found in specification.md or OPENAI_API_KEY.");
}

const response = await fetch("https://api.openai.com/v1/models", {
  headers: {
    authorization: `Bearer ${key}`
  }
});

if (!response.ok) {
  throw new Error(`OpenAI key verification failed: ${response.status} ${response.statusText}`);
}

const payload = await response.json();
const modelCount = Array.isArray(payload.data) ? payload.data.length : 0;

if (modelCount === 0) {
  throw new Error("OpenAI key verification returned no accessible models.");
}

console.log(`OpenAI key verification succeeded. Accessible models: ${modelCount}.`);
