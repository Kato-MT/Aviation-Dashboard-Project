import { defineConfig } from '@playwright/test';

export const G2_PLAYWRIGHT_POLICY_VERSION = 'g2-playwright-no-capture.v1' as const;
export const G2_PLAYWRIGHT_TEMPORARY_OUTPUT = '.tmp-tests/g2-playwright' as const;

/**
 * G2 is intentionally separate from ordinary browser acceptance. It retains no
 * Playwright artifact and cannot retry a real-source request. The separately
 * reviewed G2 test is responsible for writing only the two aggregate JSON files
 * accepted by operationsPrivacyAudit.ts.
 */
export default defineConfig({
  testDir: './tests/live-browser',
  testMatch: '**/g2-provider-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: true,
  retries: 0,
  reporter: [],
  outputDir: G2_PLAYWRIGHT_TEMPORARY_OUTPUT,
  preserveOutput: 'never',
  use: {
    browserName: 'chromium',
    acceptDownloads: false,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    serviceWorkers: 'block',
  },
});
