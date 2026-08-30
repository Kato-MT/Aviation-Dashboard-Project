import { expect, test } from '@playwright/test';
import { expectNativeEgressDenied } from './nativeEgress';
import { LIVE_TEST_HTTP_ORIGIN } from './testOrigin';

test('M3 desktop and mobile portfolio walkthrough preserves every evidence boundary', async ({
  page,
  context,
  request,
}, testInfo) => {
  await expectNativeEgressDenied(request);
  const metadataResponse = await request.get('/api/v1/regions');
  expect(metadataResponse.ok()).toBe(true);
  const metadata = await metadataResponse.json();
  expect(metadata).toMatchObject({
    schemaVersion: 'airspace.v1',
    applicationVersion: '3.0.0-dev',
    releaseSha: 'local-unreleased',
    source: {
      target: 'local-mock',
      mode: 'mock',
      providerId: 'synthetic-test',
      synthetic: true,
    },
  });

  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/u.test(url.protocol) && url.origin !== LIVE_TEST_HTTP_ORIGIN) {
      throw new Error(`Unexpected browser egress: ${url.origin}`);
    }
    return route.continue();
  });

  const applicationSockets: Array<{ closed: boolean }> = [];
  const laterApiRequests: string[] = [];
  let observeLaterRequests = false;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/v1/airspace/')) return;
    const evidence = { closed: false };
    applicationSockets.push(evidence);
    socket.on('close', () => {
      evidence.closed = true;
    });
  });
  page.on('request', (browserRequest) => {
    if (!observeLaterRequests) return;
    const url = new URL(browserRequest.url());
    if (url.origin === LIVE_TEST_HTTP_ORIGIN && url.pathname.startsWith('/api/')) {
      laterApiRequests.push(`${browserRequest.method()} ${url.pathname}`);
    }
  });

  await page.goto('/live.html#live');
  await expect(page.getByRole('heading', { name: 'Atlanta airspace' })).toBeVisible();
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);

  await expect(page.locator('.observation-panel [data-freshness="stale"]')).toHaveCount(2, {
    timeout: 35_000,
  });
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await expect(page.locator('.feed-notice')).toContainText('position observations are stale');
  await expect(page.locator('.history-limitations')).toContainText(
    'session contains a feed or observation gap',
  );
  await page.screenshot({ path: testInfo.outputPath('m3-live-stale-desktop.png'), fullPage: true });

  await page.locator('.maplibregl-canvas').evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2');
    const loss = gl?.getExtension('WEBGL_lose_context');
    if (!loss) throw new Error('This browser does not expose the context-loss test extension.');
    loss.loseContext();
  });
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'unavailable');
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  await expect(page.locator('.history-table tbody tr').first()).toBeVisible();
  await page.getByRole('button', { name: 'Retry map', exact: true }).click();
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');

  await expect(page.locator('.observation-panel [data-freshness="current"]')).toHaveCount(2, {
    timeout: 45_000,
  });
  await page.getByRole('link', { name: 'Synthetic Replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();
  await expect.poll(() => applicationSockets.length).toBeGreaterThan(0);
  await expect.poll(() => applicationSockets.every((socket) => socket.closed)).toBe(true);
  observeLaterRequests = true;

  await expect(page.locator('.replay-identity')).toContainText('airspace-replay.v1');
  await expect(page.locator('.replay-identity')).toContainText('20260830');
  const digest = await page.locator('.replay-identity dd').last().getAttribute('title');
  expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  await page.getByRole('button', { name: /Synthetic outage/u }).click();
  await expect(page.locator('.replay-current-event')).toContainText('session offline');
  await expect(page.locator('.replay-notice')).toContainText(
    'This state does not imply an aircraft fault',
  );
  await page.getByRole('button', { name: /First recovery receipt/u }).click();
  await expect(page.locator('.replay-current-event')).toContainText('session live');
  await page.getByRole('button', { name: 'KEEP1', exact: true }).click();
  await expect(page.locator('.selection-panel p.identifier')).toContainText(
    'DEMO:PROVIDER-OUTAGE-RECOVERY:1',
  );
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('m3-replay-mobile.png'), fullPage: true });

  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.locator('#evidence-main')).toBeVisible();
  await expect(page.locator('.evidence-release-banner')).toContainText(
    '3.0.0-dev · local-unreleased',
  );
  await expect(page.locator('#evidence-build')).toContainText('local-mock');
  await expect(page.locator('#evidence-map')).toContainText('georgia-20260828-z12');
  await expect(page.locator('#evidence-map')).toContainText(
    '286238718ff1006ada90f1bbd03958c0f4510a3e01ceee578798e81920bf72a6',
  );
  await expect(page.locator('[data-health-state="unchecked"]')).toBeVisible();
  await page.getByRole('link', { name: 'Diagnostics Lab', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Telemetry monitor', exact: true })).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');

  expect(laterApiRequests).toEqual([]);
  expect(applicationSockets.every((socket) => socket.closed)).toBe(true);
});
