// @ts-check
import { defineConfig, devices } from '@playwright/test';

/**
 * SyncPad Playwright configuration.
 *
 * Tests are split across focused spec files. They run against a
 * locally-served copy of the app (http://localhost:5555).
 *
 * To run:
 *   npx playwright test
 *
 * To run a single spec:
 *   npx playwright test tests/landing.spec.js
 *
 * Headed mode:
 *   npx playwright test --headed
 */

export default defineConfig({
  testDir: './tests',

  /* Run each test file in parallel; tests within a file run serially by default */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  /* 2 retries in CI; 1 retry locally so flaky parallel tests get a second chance */
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: 'http://localhost:5555',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    /* Supabase calls are real API calls – give them enough time */
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the locally-available Chromium binary. The npm-installed browser
        // revision may differ from what's pre-cached in the environment;
        // specifying executablePath bypasses the revision check.
        launchOptions: {
          executablePath: process.env.CHROMIUM_PATH || undefined,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  /* Start a SPA-aware static server before tests.
   * tests/spa-server.js serves the repo root at /SyncPad/ (matching the
   * GitHub Pages deployment path) with SPA fallback so all /SyncPad/*
   * routes serve index.html rather than returning 404. */
  webServer: {
    command: 'node tests/spa-server.js',
    url: 'http://localhost:5555/SyncPad/',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
