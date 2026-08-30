import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_PORT } from './tests/live-browser/testOrigin';

const configuredCandidate = process.env.M34_CANDIDATE_DIRECTORY?.trim();
if (!configuredCandidate) {
  throw new Error('M34_CANDIDATE_DIRECTORY is required for retained-candidate acceptance.');
}
const expectedSelectionRecordSha256 = process.env.M34_EXPECTED_SELECTION_SHA256?.trim();
const expectedCandidateId = process.env.M34_EXPECTED_CANDIDATE_ID?.trim();
if (!expectedSelectionRecordSha256 && !expectedCandidateId) {
  throw new Error(
    'M34_EXPECTED_SELECTION_SHA256 or M34_EXPECTED_CANDIDATE_ID is required for retained-candidate acceptance.',
  );
}

const candidateDirectory = resolve(configuredCandidate);
const resultRoot = 'test-results/m34-entry-artifact';

export default defineConfig({
  testDir: './tests/live-browser',
  testMatch: '**/m34-entry-artifact.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['junit', { outputFile: `${resultRoot}/results.xml` }]],
  outputDir: `${resultRoot}/artifacts`,
  use: {
    baseURL: LIVE_TEST_HTTP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'm34-built-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec tsx tools/live/serveCandidate.ts',
    url: `${LIVE_TEST_HTTP_ORIGIN}/`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      M34_CANDIDATE_DIRECTORY: candidateDirectory,
      LIVE_TEST_PORT: String(LIVE_TEST_PORT),
      WRANGLER_SEND_METRICS: 'false',
      ...(process.env.M34_SELECTION_RECORD_PATH?.trim()
        ? { M34_SELECTION_RECORD_PATH: resolve(process.env.M34_SELECTION_RECORD_PATH.trim()) }
        : {}),
      ...(expectedSelectionRecordSha256
        ? { M34_EXPECTED_SELECTION_SHA256: expectedSelectionRecordSha256 }
        : {}),
      ...(expectedCandidateId ? { M34_EXPECTED_CANDIDATE_ID: expectedCandidateId } : {}),
      ...(process.env.M34_EXPECTED_SOURCE_HEAD?.trim()
        ? { M34_EXPECTED_SOURCE_HEAD: process.env.M34_EXPECTED_SOURCE_HEAD.trim() }
        : {}),
    },
  },
});
