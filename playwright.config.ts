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
  use: {
    baseURL: "http://localhost:4173",
    // On Linux the browser otherwise fits the width of each glyph to the
    // pixel grid, which moves line breaks and spaces printed text unevenly.
    // The PDF is then set the same way on Linux as on macOS.
    launchOptions: { args: ["--font-render-hinting=none"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun tests/serve.ts",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
  },
});
