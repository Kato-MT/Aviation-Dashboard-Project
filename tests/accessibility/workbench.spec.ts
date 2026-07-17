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
  await page.goto('./');
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
});

test('TC-A11Y-006 preserves a visible skip link for keyboard users', async ({ page }) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to workbench' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Skip to workbench' })).toBeVisible();
});
