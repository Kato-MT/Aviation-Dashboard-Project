import { expect, test } from '@playwright/test';
import { captureLiveWire } from './liveWire';
import { expectNativeEgressDenied } from './nativeEgress';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_WEBSOCKET_ORIGIN } from './testOrigin';

test('real synthetic-provider outage and recovery preserve provenance and observation age', async ({
  page,
  context,
  request,
}, testInfo) => {
  await expectNativeEgressDenied(request);
  const metadata = await request.get('/api/v1/regions');
  expect(metadata.ok()).toBe(true);
  expect((await metadata.json()).source).toMatchObject({
    target: 'local-mock',
    mode: 'mock',
    providerId: 'synthetic-test',
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== LIVE_TEST_HTTP_ORIGIN) {
      throw new Error('Unexpected browser egress: ' + url.origin);
    }
    return route.continue();
  });
  const errors: string[] = [];
  const wire = captureLiveWire(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    expect(new URL(socket.url()).origin).toBe(LIVE_TEST_WEBSOCKET_ORIGIN);
  });
  await page.goto('/live.html');
  const observationTable = page.locator('.observation-panel');
  await expect(observationTable.locator('tbody tr')).toHaveCount(3);
  await expect(observationTable.locator('tbody [data-freshness="current"]')).toHaveCount(2);

  await expect(observationTable.locator('tbody tr')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'No aircraft reported' })).toBeVisible();
  await expect(page.locator('.feed-notice')).toContainText('responded successfully');

  await expect(observationTable.locator('tbody [data-freshness="stale"]')).toHaveCount(2, {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  const receipts = page.locator('.history-table .receipt-link');
  await expect.poll(() => receipts.count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.history-limitations')).toContainText(
    'session contains a feed or observation gap',
  );
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  const pinnedReceipt = (await receipts.last().textContent())!.trim();
  await receipts.last().click();
  await expect(page.getByRole('heading', { name: `Exact receipt ${pinnedReceipt}` })).toBeVisible();
  await expect(page.locator('.feed-notice')).toContainText('position observations are stale');
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await page.screenshot({ path: testInfo.outputPath('live-stale.png'), fullPage: true });

  await expect(page.locator('.feed-notice')).toContainText('temporarily unavailable', {
    timeout: 20_000,
  });
  await expect(observationTable.locator('tbody tr')).toHaveCount(3);
  await expect(observationTable.locator('tbody [data-freshness="current"]')).toHaveCount(0);
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await page.screenshot({ path: testInfo.outputPath('live-unavailable.png'), fullPage: true });

  await expect(observationTable.locator('tbody [data-freshness="current"]')).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator('.feed-notice')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Exact receipt ${pinnedReceipt}` })).toBeVisible();
  const snapshots = wire.messages.filter((message) => message.type === 'airspace.snapshot');
  expect(snapshots.length).toBeGreaterThanOrEqual(4);
  expect(new Set(snapshots.map((message) => message.snapshot.feedEpoch)).size).toBe(1);
  expect(snapshots.every((message) => message.snapshot.providerId === 'synthetic-test')).toBe(true);
  expect(snapshots.some((message) => message.snapshot.aircraft.length === 0)).toBe(true);
  expect(wire.messages.some((message) => message.type === 'error')).toBe(true);
  await wire.expectAcknowledgments();
  expect(errors).toEqual([]);
});
