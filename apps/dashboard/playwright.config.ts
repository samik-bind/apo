import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E testing configuration for the agent testing dashboard.
 *
 * Key test scenarios:
 * - Project setup, task sync, and task runs
 * - Schedule lifecycle
 * - Trace drilldown and inspection
 *
 * HOSTED_ALPHA_JOURNEY_BASE_URL points the hosted-alpha adopter journey
 * (e2e/hosted-alpha-adopter-journey.spec.ts) at a dedicated production-shaped
 * local stack instead of the dev server, and disables the dev webServer for
 * that invocation. Normal E2E never targets production; the live production
 * check is the read-only scripts/hosted-alpha-live-smoke.sh.
 */
const hostedAlphaBaseUrl = process.env.HOSTED_ALPHA_JOURNEY_BASE_URL;

export default defineConfig({
  testDir: './e2e',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use for process */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],

  /* Shared settings for all tests */
  use: {
    /* Base URL for tests - the dedicated journey stack when provided */
    baseURL: hostedAlphaBaseUrl ?? 'http://localhost:3000',

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  /* Run your local dev server before starting the tests — skipped when the
     hosted-alpha journey targets its dedicated production-shaped stack */
  webServer: hostedAlphaBaseUrl
    ? undefined
    : {
        command: 'pnpm run dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});
