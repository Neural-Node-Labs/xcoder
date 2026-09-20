import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for xcoder's UI. See e2e/test_scenario.md for the full scenario catalog
 * (smoke + regression) that these specs implement, and e2e/README.md for how to point this at
 * a real running instance and seed the accounts these tests expect.
 *
 * Everything here targets a server you already have running — this suite does NOT spin up
 * xcoder itself (no `webServer` block), because xcoder needs a real LLM backend (or
 * XCODER_MOCK_LLM=true) and, for the full matrix, a seeded admin + non-admin account. Point
 * E2E_BASE_URL at whatever instance you want to test (default: http://localhost:5173, Vite's
 * default dev port) and set the env vars in e2e/README.md before running.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false, // most specs log in as a shared seeded user/admin — avoid cross-test races
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
