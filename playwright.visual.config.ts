import { defineConfig } from '@playwright/test';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_PORT } from './tests/live-browser/testOrigin';

export default defineConfig({
  testDir: './tests/live-browser',
  testMatch: '**/visual-regression.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      threshold: 0.2,
      maxDiffPixelRatio: 0.001,
    },
  },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/visual-regression',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}',
  use: {
    baseURL: LIVE_TEST_HTTP_ORIGIN,
    browserName: 'chromium',
    colorScheme: 'light',
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1440, height: 1100 },
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
      },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
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
