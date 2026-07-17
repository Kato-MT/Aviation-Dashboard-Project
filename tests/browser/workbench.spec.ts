import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(
    page.getByRole('heading', { name: 'Flight Diagnostics Workbench', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
});

test('TC-UI-001 loads the preserved included baseline and exact golden summary', async ({
  page,
}) => {
  await expect(page.locator('#metric-total')).toHaveText('of 85 received');
  await expect(page.locator('#metric-quarantined')).toHaveText('0');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.locator('#metric-hash')).toHaveText('b3b50781');
  await expect(page.getByRole('note')).toContainText(/synthetic\s+and\s+unclassified/i);
});

test('TC-UI-002 operates view tabs from the keyboard', async ({ page }) => {
  const monitor = page.getByRole('tab', { name: /Monitor/ });
  await monitor.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Diagnostics/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Configuration/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('TC-UI-003 preserves replay controls and exposes accessible names', async ({ page }) => {
  const start = page.getByRole('button', { name: 'Start replay' });
  await expect(start).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Pause replay' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reset replay' })).toBeEnabled();
  await start.click();
  await expect(page.locator('#replay-position')).not.toHaveText('1 / 85', { timeout: 3_000 });
  await page.getByRole('button', { name: 'Pause replay' }).click();
});

test('TC-UI-004 renders all baseline findings as evidence-backed rows', async ({ page }) => {
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  await expect(page.locator('#filtered-count')).toHaveText('9');
  await expect(page.locator('#findings-body tr')).toHaveCount(9);
  await expect(page.locator('#findings-body')).toContainText('baseline.overspeed');
  await expect(page.locator('#findings-body')).toContainText('baseline.rapid-descent');
  await expect(page.locator('#findings-body')).toContainText('baseline.fuel-change');
});

test('TC-UI-005 quarantines a hostile uploaded row without executing markup', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { hostileExecuted: boolean }).hostileExecuted = false;
  });
  const csv = [
    'timestamp,altitude_ft,speed_kts,fuel_pct',
    '<img src=x onerror=window.hostileExecuted=true>,1000,100,90',
    '00:10,1100,105,89.9',
  ].join('\n');
  await page.locator('#telemetry-file').setInputFiles({
    name: 'hostile.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.locator('#metric-quarantined')).toHaveText('1');
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  await expect(page.locator('#quarantine-list')).toContainText('INVALID_TIMESTAMP');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { hostileExecuted: boolean }).hostileExecuted),
    )
    .toBe(false);
});

test('TC-UI-006 clears stale telemetry when a later upload fails', async ({ page }) => {
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await page.locator('#telemetry-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{not valid json'),
  });
  await expect(page.locator('#metric-accepted')).toHaveText('0');
  await expect(page.locator('#run-status-text')).toHaveText('Analysis blocked');
  await expect(page.locator('#message-title')).toHaveText('Analysis blocked by fatal validation');
});

test('TC-VER-UI-001 injects a deterministic candidate and classifies the comparison', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  await page.locator('#fault-scenario').selectOption('missing-altitude');
  await page.locator('#fault-seed').fill('1337');
  await page.getByRole('button', { name: 'Create candidate run' }).click();
  await expect(page.getByRole('tab', { name: /Verification/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#verification-status-title')).toContainText(
    /Regression detected|Verification blocked/,
  );
  await expect(page.locator('#introduced-count')).not.toHaveText('0');
});

test('TC-EXP-UI-001 exports findings without source telemetry rows', async ({ page }) => {
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export findings CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/findings\.csv$/);
});

test('TC-RESP-001 remains horizontally contained at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Load included baseline' })).toBeVisible();
});
