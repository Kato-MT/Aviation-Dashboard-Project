import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const offlineUrl = pathToFileURL(resolve('dist-offline', 'index.html')).href;

async function waitForWorkbench(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Flight Diagnostics Workbench', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
}

async function collectTemporalEvidence(page: Page): Promise<Record<string, string | null>> {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  const investigationPanel = page.getByRole('tabpanel', { name: 'Investigation' });
  await page.getByLabel('Synthetic scenario').selectOption('oscillation');
  await investigationPanel.getByLabel('Seed', { exact: true }).fill('3101');
  await page.getByLabel('Samples').fill('180');
  await page.getByRole('button', { name: 'Run investigation' }).click();
  await page.getByLabel('Investigation sample').fill('100');
  await page.getByLabel('Seeds, comma separated').fill('3101');
  await page.getByRole('button', { name: 'Run campaign' }).click();
  await expect(page.locator('#campaign-status')).toHaveText(/Completed/, { timeout: 30_000 });
  return page.evaluate(() => ({
    phase: document.querySelector('#investigation-phase')?.textContent ?? null,
    agreement: document.querySelector('#investigation-agreement')?.textContent ?? null,
    rules: document.querySelector('#investigation-rule-count')?.textContent ?? null,
    selectedRuleEvidence:
      document
        .querySelector('#investigation-indications')
        ?.textContent?.replaceAll(/\s+/g, ' ')
        .trim() ?? null,
    campaignCases: document.querySelector('#campaign-cases')?.textContent ?? null,
    campaignF1: document.querySelector('#campaign-f1')?.textContent ?? null,
    campaignFalseAlarms: document.querySelector('#campaign-far-run')?.textContent ?? null,
    campaignDelay: document.querySelector('#campaign-delay')?.textContent ?? null,
    campaignAbstention: document.querySelector('#campaign-abstention')?.textContent ?? null,
  }));
}

test('TC-TOFF-001 TC-TOFF-002 runs Investigation and the inline campaign worker fully offline', async ({
  context,
  page,
}) => {
  const networkRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
  });
  await context.setOffline(true);
  await page.goto(offlineUrl);
  await waitForWorkbench(page);
  const evidence = await collectTemporalEvidence(page);

  expect(evidence.campaignCases).toBe('31 / 31');
  expect(evidence.rules).not.toBe('0');
  expect(networkRequests).toEqual([]);
  await expect(page.getByRole('note')).toContainText(/synthetic\s+and\s+unclassified/i);
});

test('TC-TOFF-003 normal and offline builds produce equivalent deterministic evidence', async ({
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile-chromium',
    'Exact-build parity runs once on desktop.',
  );
  await page.goto('./');
  await waitForWorkbench(page);
  const normalEvidence = await collectTemporalEvidence(page);

  const offlinePage = await context.newPage();
  await offlinePage.goto(offlineUrl);
  await waitForWorkbench(offlinePage);
  const offlineEvidence = await collectTemporalEvidence(offlinePage);
  expect(offlineEvidence).toEqual(normalEvidence);
});
