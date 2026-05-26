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
  retries: process.env.CI ? 2 : 0,
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  /* Start a simple static server before tests */
  webServer: {
    command: 'npx serve . -l 5555 --no-clipboard',
    url: 'http://localhost:5555',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
