import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./v2.html');
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

test('TC-TEMP-UI-001 runs an accessible linked temporal investigation', async ({ page }) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  const investigationPanel = page.getByRole('tabpanel', { name: 'Investigation' });
  await page.getByLabel('Synthetic scenario').selectOption('gradual-drift');
  await investigationPanel.getByLabel('Seed', { exact: true }).fill('3101');
  await page.getByLabel('Samples').fill('180');
  await page.getByRole('button', { name: 'Run investigation' }).click();

  await expect(page.locator('#investigation-status')).toContainText(/rule indications|nominal/i);
  await expect(page.getByLabel('Investigation sample')).toBeEnabled();
  await expect(page.locator('#investigation-timeline')).toContainText('Gradual altitude drift');
  await expect(page.locator('#investigation-phase-log li')).not.toHaveCount(0);
  await expect(page.locator('#investigation-state-chart')).toBeVisible();
  await expect(page.locator('#investigation-residual-chart')).toBeVisible();

  const slider = page.getByLabel('Investigation sample');
  await slider.focus();
  const before = await slider.inputValue();
  await page.keyboard.press('ArrowRight');
  await expect(slider).not.toHaveValue(before);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export investigation JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /temporal-investigation-gradual-drift-seed-3101\.json$/,
  );
  const minimizedPath = await download.path();
  expect(minimizedPath).not.toBeNull();
  const minimized = JSON.parse(await readFile(minimizedPath!, 'utf8')) as {
    exportPolicy: { sourceDataIncluded: boolean };
    sourceData?: unknown;
    scenario: { samples?: unknown };
    investigation: { points?: unknown; series?: unknown };
  };
  expect(minimized.exportPolicy.sourceDataIncluded).toBe(false);
  expect(minimized.sourceData).toBeUndefined();
  expect(minimized.scenario.samples).toBeUndefined();
  expect(minimized.investigation.points).toBeUndefined();
  expect(minimized.investigation.series).toBeUndefined();

  await page.getByLabel('Include generated source windows').check();
  const sourceDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export investigation JSON' }).click();
  const sourceDownload = await sourceDownloadPromise;
  const sourcePath = await sourceDownload.path();
  expect(sourcePath).not.toBeNull();
  const withSource = JSON.parse(await readFile(sourcePath!, 'utf8')) as {
    exportPolicy: { sourceDataIncluded: boolean };
    sourceData: { samples: unknown[]; points: unknown[]; series: unknown };
  };
  expect(withSource.exportPolicy.sourceDataIncluded).toBe(true);
  expect(withSource.sourceData.samples).toHaveLength(180);
  expect(withSource.sourceData.points).toHaveLength(180);
  expect(withSource.sourceData.series).toBeDefined();
});

test('TC-TEMP-UI-002 keeps temporal ML user-controlled and advisory', async ({ page }) => {
  await page.getByRole('tab', { name: /Configuration/ }).click();
  await expect(page.getByLabel('Enable experimental pointwise comparison')).not.toBeChecked();
  await expect(page.getByLabel('Enable experimental temporal hypotheses')).not.toBeChecked();
  await expect(page.locator('#temporal-training-evidence')).toContainText('1101 through 1140');
  await expect(page.locator('#temporal-calibration-evidence')).toContainText('2101 through 2120');
  await expect(page.locator('#temporal-evaluation-evidence')).toContainText('9101 through 9140');
  await page.getByLabel('Enable experimental pointwise comparison').check();
  await page.getByLabel('Enable experimental temporal hypotheses').check();
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await page.getByLabel('Synthetic scenario').selectOption('oscillation');
  await page.getByRole('button', { name: 'Run investigation' }).click();
  await page.getByLabel('Investigation sample').fill('100');

  await expect(page.locator('#investigation-model-confidence')).not.toHaveText(/Disabled|Warmup/);
  await expect(page.locator('#investigation-rule-detail')).toContainText('deterministic authority');
  await expect(page.locator('#investigation-agreement')).toHaveText(
    /unanimous indicate|unanimous nominal|mixed|partial indicate|partial nominal|partial mixed/,
  );
  await expect(page.locator('#investigation-detector-agreement')).toContainText(
    'Deterministic rules | authoritative',
  );
  await expect(page.locator('#investigation-detector-agreement')).toContainText(
    'Robust covariance | advisory',
  );
  await expect(page.locator('#investigation-detector-agreement')).toContainText(
    'Kalman innovation | supporting evidence',
  );
  await expect(page.locator('#investigation-detector-agreement')).toContainText(
    'Temporal model | advisory',
  );
});

test('TC-TEMP-UI-003 overlays only compatible captured investigation waveforms', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  const investigationPanel = page.getByRole('tabpanel', { name: 'Investigation' });
  await expect(page.getByRole('button', { name: 'Capture comparison baseline' })).toBeDisabled();
  await expect(page.locator('#investigation-comparison-status')).toHaveText(
    'No comparison baseline captured.',
  );
  await page.getByLabel('Synthetic scenario').selectOption('gradual-drift');
  await investigationPanel.getByLabel('Seed', { exact: true }).fill('3101');
  await page.getByLabel('Samples').fill('180');
  await page.getByRole('button', { name: 'Run investigation' }).click();

  const capture = page.getByRole('button', { name: 'Capture comparison baseline' });
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect(page.getByLabel('Comparison baseline waveforms')).toBeEnabled();
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'Overlay active: baseline gradual-drift, seed 3101',
  );
  await expect(page.locator('#investigation-comparison-authority')).toContainText(
    'Deterministic rules remain authoritative',
  );
  await expect(page.locator('#investigation-state-chart')).toHaveAttribute(
    'aria-label',
    /Current and comparison baseline observed and predicted temporal state/,
  );

  await page.getByLabel('Synthetic scenario').selectOption('oscillation');
  await investigationPanel.getByLabel('Seed', { exact: true }).fill('3102');
  await page.getByRole('button', { name: 'Run investigation' }).click();
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'versus current oscillation, seed 3102',
  );

  await page.getByLabel('Samples').fill('181');
  await page.getByRole('button', { name: 'Run investigation' }).click();
  await expect(page.getByLabel('Comparison baseline waveforms')).toBeDisabled();
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'Baseline not overlaid. Sample count differs: baseline 180, current 181.',
  );
});

test('TC-CAMP-UI-001 executes a worker campaign with progress and export evidence', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await page.getByLabel('Seeds, comma separated').fill('3101');
  await page.getByRole('button', { name: 'Run campaign' }).click();
  await expect(page.locator('#campaign-status')).toHaveText(/Completed/, { timeout: 30_000 });
  await expect(page.locator('#campaign-cases')).toHaveText('31 / 31');
  await expect(page.locator('#campaign-summary')).toContainText('Replay evidence');
  await expect(page.getByRole('button', { name: 'Export campaign JSON' })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export campaign JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/campaign\.json$/);
});

test('TC-CAM-013 renders and exports validated partial cancellation evidence', async ({ page }) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await page
    .getByLabel('Seeds, comma separated')
    .fill('3101,3102,3103,3104,3105,3106,3107,3108,3109,3110,3111,3112');
  await page.getByRole('button', { name: 'Run campaign' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeEnabled();
  await cancel.click();

  await expect(page.locator('#campaign-status')).toHaveText('Cancelled with partial evidence', {
    timeout: 30_000,
  });
  await expect(page.locator('#campaign-cases')).toHaveText(/\d+ \/ 372/);
  await expect(page.locator('#campaign-progress-label')).toHaveText(
    /\d+ completed, \d+ failed, \d+ remaining/,
  );
  await expect(page.locator('#campaign-summary')).toContainText(
    'The in-flight case was not committed.',
  );

  const exportButton = page.getByRole('button', { name: 'Export campaign JSON' });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const result = JSON.parse(await readFile(path!, 'utf8')) as {
    status: string;
    cases: unknown[];
    summary: {
      plannedCases: number;
      attemptedCases: number;
      completedCases: number;
      failedCases: number;
      remainingCases: number;
    };
  };
  expect(result.status).toBe('cancelled');
  expect(result.summary.plannedCases).toBe(372);
  expect(result.summary.remainingCases).toBeGreaterThan(0);
  expect(result.summary.attemptedCases).toBe(
    result.summary.completedCases + result.summary.failedCases,
  );
  expect(result.cases).toHaveLength(result.summary.attemptedCases);
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

test('TC-TACC-003 keeps Investigation controls usable at 200 percent zoom', async ({ page }) => {
  // A 640 CSS-pixel viewport represents the reflow width of a 1280-pixel window at 200% zoom.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await expect(page.getByLabel('Synthetic scenario')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run investigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run campaign' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
});
