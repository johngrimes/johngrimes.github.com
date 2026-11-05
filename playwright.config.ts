/**
 * Playwright configuration: runs the CV tests in Chromium against the local
 * static server.
 *
 * @author John Grimes
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:4173" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun tests/serve.ts",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
