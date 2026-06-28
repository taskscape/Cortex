import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/webui",
  timeout: 30_000,
  expect: {
    timeout: 7_500
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:19787",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node tests/webui/harness.mjs",
    url: "http://127.0.0.1:19787/health",
    reuseExistingServer: false,
    timeout: 10_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] }
    }
  ]
});
