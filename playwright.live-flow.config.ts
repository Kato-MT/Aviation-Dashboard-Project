import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.live.config';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_PORT } from './tests/live-browser/testOrigin';

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: '**/live-flow.spec.ts',
  timeout: 90_000,
  outputDir: 'test-results/live-flow',
  webServer: {
    command: 'pnpm dev:live',
    url: `${LIVE_TEST_HTTP_ORIGIN}/live.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      LIVE_TEST_PORT: String(LIVE_TEST_PORT),
      LIVE_TEST_SCENARIO: 'walkthrough',
      WRANGLER_SEND_METRICS: 'false',
    },
  },
});
