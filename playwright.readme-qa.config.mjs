// Playwright config for the static README question set.
//
// The main `playwright.config.mjs` boots the fake Matbot harness, which never
// answers content questions. This config targets a real, already running Cortex
// WebUI instead, so answers come from the configured provider while grading
// stays deterministic (see tests/readme-qa/score.mjs).
//
//   scripts\run.ps1              # start Cortex first
//   npm run test:readme-qa

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/readme-qa",
  globalSetup: "./tests/readme-qa/global-setup.mjs",
  globalTeardown: "./tests/readme-qa/global-teardown.mjs",
  timeout: Number(process.env.CORTEX_QA_TEST_TIMEOUT_MS ?? 240_000),
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/readme-qa/playwright.json" }]],
  use: {
    baseURL: process.env.CORTEX_WEBUI_URL ?? "http://127.0.0.1:19778",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
