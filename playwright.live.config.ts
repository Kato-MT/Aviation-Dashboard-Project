import { defineConfig, devices } from '@playwright/test';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_PORT } from './tests/live-browser/testOrigin';

export default defineConfig({
  testDir: './tests/live-browser',
  testIgnore: [
    '**/live-flow.spec.ts',
    '**/m3-walkthrough.spec.ts',
    '**/m34-entry-artifact.spec.ts',
    '**/performance.spec.ts',
    '**/visual-regression.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/live',
  use: {
    baseURL: LIVE_TEST_HTTP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'live-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev:live',
    url: `${LIVE_TEST_HTTP_ORIGIN}/live.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      LIVE_TEST_PORT: String(LIVE_TEST_PORT),
      LIVE_TEST_SCENARIO: 'nominal',
      WRANGLER_SEND_METRICS: 'false',
    },
  },
});
