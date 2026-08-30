import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    severe,
    severe.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./v2.html');
  await expect(page.locator('#metric-accepted')).toHaveText('85');
});

test('TC-A11Y-001 has no serious or critical automated findings in Monitor', async ({ page }) => {
  await expectNoSeriousAxeViolations(page);
});

test('TC-A11Y-002 has no serious or critical automated findings in Diagnostics', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  await expectNoSeriousAxeViolations(page);
});

test('TC-A11Y-003 has no serious or critical automated findings in Verification', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Verification/ }).click();
  await expectNoSeriousAxeViolations(page);
});

test('TC-A11Y-004 has no serious or critical automated findings in Configuration', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Configuration/ }).click();
  await expectNoSeriousAxeViolations(page);
});

test('TC-A11Y-007 has no serious or critical findings in Investigation states', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await expectNoSeriousAxeViolations(page);
  await page.getByRole('button', { name: 'Run investigation' }).click();
  await expect(page.getByLabel('Investigation sample')).toBeEnabled();
  await expectNoSeriousAxeViolations(page);
});

test('TC-TACC-001 TC-TACC-002 exposes announced campaign progress and stays accessible while running', async ({
  page,
}) => {
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await page
    .getByLabel('Seeds, comma separated')
    .fill('3101,3102,3103,3104,3105,3106,3107,3108,3109,3110,3111,3112');
  const run = page.getByRole('button', { name: 'Run campaign' });
  await run.focus();
  await expect(run).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#campaign-progress-label')).toHaveAttribute('role', 'status');
  await expect(page.locator('#campaign-status')).toHaveAttribute('aria-live', 'polite');
  await expect(run).toBeDisabled();
  await expectNoSeriousAxeViolations(page);
  const cancel = page.getByRole('button', { name: 'Cancel' });
  if (await cancel.isEnabled()) await cancel.click();
});

test('TC-A11Y-005 exposes labeled controls for the active release capabilities', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Start replay' })).toBeVisible();
  await expect(page.getByLabel('Replay sample')).toBeVisible();
  await page.getByRole('tab', { name: /Diagnostics/ }).click();
  await expect(page.getByLabel('Severity')).toBeVisible();
  await expect(page.getByLabel('Search evidence')).toBeVisible();
  await page.getByRole('tab', { name: /Configuration/ }).click();
  const streamEndpoint = page.getByLabel('WebSocket endpoint');
  const applicationVersion = await page.locator('#app-version').textContent();
  if (applicationVersion === 'v2.0.0') {
    await expect(streamEndpoint).toBeHidden();
  } else {
    await expect(streamEndpoint).toBeVisible();
  }
  await expect(page.getByLabel('Include uploaded source data in JSON export')).toBeVisible();
  await expect(page.getByLabel('Enable experimental temporal hypotheses')).toBeVisible();
  await page.getByRole('tab', { name: /Investigation/ }).click();
  await expect(page.getByLabel('Synthetic scenario')).toBeVisible();
  await expect(page.getByLabel('Investigation sample')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Visible evidence overlays' })).toBeVisible();
});

test('TC-A11Y-006 preserves a visible skip link for keyboard users', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to workbench' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to workbench' })).toBeVisible();
});
