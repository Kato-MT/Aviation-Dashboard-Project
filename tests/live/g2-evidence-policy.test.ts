import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import g2Config, {
  G2_PLAYWRIGHT_POLICY_VERSION,
  G2_PLAYWRIGHT_TEMPORARY_OUTPUT,
} from '../../playwright.g2.config';
import {
  G2_EVIDENCE_POLICY,
  G2_RETAINED_FILES,
  OPERATIONS_PRIVACY_AUDIT_VERSION,
} from '../../tools/live/operationsPrivacyAudit';

describe('G2 no-capture firebreak', () => {
  it('uses a separate one-worker zero-retry Playwright policy with every capture disabled', () => {
    expect(G2_PLAYWRIGHT_POLICY_VERSION).toBe('g2-playwright-no-capture.v1');
    expect(g2Config.fullyParallel).toBe(false);
    expect(g2Config.workers).toBe(1);
    expect(g2Config.retries).toBe(0);
    expect(g2Config.testMatch).toBe('**/g2-provider-smoke.spec.ts');
    expect(g2Config.reporter).toEqual([]);
    expect(g2Config.outputDir).toBe(G2_PLAYWRIGHT_TEMPORARY_OUTPUT);
    expect(g2Config.preserveOutput).toBe('never');
    expect(g2Config.webServer).toBeUndefined();
    expect(g2Config.use).toMatchObject({
      acceptDownloads: false,
      screenshot: 'off',
      trace: 'off',
      video: 'off',
      serviceWorkers: 'block',
    });
    expect(g2Config.use).not.toHaveProperty('recordHar');
  });

  it('retains only the exact aggregate manifest and receipt policy', () => {
    expect(OPERATIONS_PRIVACY_AUDIT_VERSION).toBe('operations-privacy-audit.v1');
    expect(G2_EVIDENCE_POLICY).toBe('aggregate-only-no-capture');
    expect(G2_RETAINED_FILES).toEqual(['g2-aggregate-receipt.json', 'g2-evidence-manifest.json']);
  });

  it('declares no HAR, body, trace, screenshot, video, or retry configuration escape hatch', async () => {
    const source = await readFile('playwright.g2.config.ts', 'utf8');
    expect(source).not.toMatch(/recordHar|retain-on-failure|only-on-failure|retries:\s*[1-9]/u);
    expect(source).toMatch(/acceptDownloads:\s*false/u);
    expect(source).toMatch(/screenshots?[\s\S]*off|screenshot:\s*'off'/u);
  });

  it('runs the existing browser observation harness from the privacy verification script', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['test:g2-firebreak']).toBe('tsx tools/live/runG2Firebreak.ts');
    expect(packageJson.scripts['privacy:verify']).toContain('pnpm test:g2-firebreak');

    const harness = await readFile('tests/live-browser/g2-provider-smoke.spec.ts', 'utf8');
    expect(harness).toContain('context.cookies');
    expect(harness).toContain('indexedDB.databases');
    expect(harness).toContain('caches.keys');
    expect(harness).toContain('navigator.storage.getDirectory');
    expect(harness).toContain('navigator.serviceWorker.getRegistrations');
    expect(harness).toContain('testInfo.outputDir');
    expect(harness).toContain('readdir(testInfo.outputDir)');

    const runner = await readFile('tools/live/runG2Firebreak.ts', 'utf8');
    expect(runner).toContain("'playwright.g2.config.ts'");
    expect(runner).toContain('finally');
    expect(runner).toContain('removeTemporaryOutput');
  });
});
