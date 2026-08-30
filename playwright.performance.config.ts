import { defineConfig, devices } from '@playwright/test';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_PORT } from './tests/live-browser/testOrigin';

if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1') {
  throw new Error(
    'Browser performance tests must run through test:browser-performance so detailed Playwright failure context is disabled and privately cleaned.',
  );
}

export default defineConfig({
  testDir: './tests/live-browser',
  testMatch: '**/performance.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  preserveOutput: 'never',
  reporter: [['./tools/live/performanceReporter.ts']],
  outputDir: '.tmp-tests/live-performance-private',
  use: {
    baseURL: LIVE_TEST_HTTP_ORIGIN,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  projects: [
    { name: 'performance-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'performance-mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'pnpm exec tsx tools/live/servePerformanceHarness.ts',
    url: `${LIVE_TEST_HTTP_ORIGIN}/tests/live-browser/performance-harness.html`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      LIVE_TEST_PORT: String(LIVE_TEST_PORT),
      NODE_ENV: 'production',
      PLAYWRIGHT_NO_COPY_PROMPT: '1',
    },
  },
});
