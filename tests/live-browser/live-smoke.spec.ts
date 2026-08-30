import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { getRegionConfig, REGION_CONFIGS } from '../../src/live/regions';
import { captureLiveWire } from './liveWire';
import { expectNativeEgressDenied } from './nativeEgress';
import { LIVE_TEST_HTTP_ORIGIN } from './testOrigin';

test.beforeEach(async ({ request, context }) => {
  await expectNativeEgressDenied(request);
  const mapBuckets = await request.get('/cdn-cgi/local/explorer/api/r2/buckets');
  expect(mapBuckets.ok()).toBe(true);
  expect((await mapBuckets.json()).result.buckets).toContainEqual({
    name: 'flight-airspace-local-mock-maps',
  });
  const response = await request.get('/api/v1/regions');
  expect(response.ok()).toBe(true);
  expect((await response.json()).source).toMatchObject({
    target: 'local-mock',
    mode: 'mock',
    providerId: 'synthetic-test',
    synthetic: true,
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === 'http:' && url.origin !== LIVE_TEST_HTTP_ORIGIN) ||
      url.protocol === 'https:'
    ) {
      throw new Error('Unexpected external browser request: ' + url.origin);
    }
    return route.continue();
  });
});

test('actual adapter, coordinator, HTTP and WebSocket feed renders in React without errors', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  const mapResponses: Array<{ url: string; status: number; headers: Record<string, string> }> = [];
  page.on('response', (response) => {
    if (response.url().includes('/map-assets/'))
      mapResponses.push({
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
      });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const wire = captureLiveWire(page);
  await page.goto('/live.html');
  await expect(page.getByRole('heading', { name: 'Atlanta airspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.locator('tbody [data-freshness="current"]')).toHaveCount(2);
  await expect(page.locator('tbody [data-freshness="missing"]')).toHaveCount(1);
  await expect(page.locator('.source-banner')).toContainText(
    'No real aircraft provider is contacted',
  );
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  expect(mapResponses.some((response) => response.url.endsWith('basemap.pmtiles'))).toBe(true);
  for (const response of mapResponses.filter((entry) => entry.url.endsWith('basemap.pmtiles'))) {
    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toMatch(/^bytes \d+-\d+\/122391249$/);
    expect(response.headers['etag']).toBe(
      '"286238718ff1006ada90f1bbd03958c0f4510a3e01ceee578798e81920bf72a6"',
    );
  }
  await expect
    .poll(() => wire.messages.some((message) => message.type === 'airspace.snapshot'))
    .toBe(true);
  await wire.expectAcknowledgments();
  const snapshotResponse = await request.get('/api/v1/airspace/atlanta/snapshot');
  const snapshot = await snapshotResponse.json();
  expect(snapshot.providerId).toBe('synthetic-test');
  expect(snapshot.aircraft[0].callsign).toBe('TEST01');
  expect(snapshot.feedEpoch).toBeTruthy();
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.locator('.timing-evidence')).toContainText('Backend receipt');
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  await expect(page.locator('.session-history')).toContainText('Current browser session');
  await expect(page.locator('.investigation-boundary')).toContainText(
    'does not infer a route, schedule, destination, owner, aircraft health or future position',
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('live-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'What this build is, what it uses, and what remains open',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('#evidence-boundaries')).toContainText(
    'Aircraft identifiers, callsigns, positions, and browser trails are not persisted',
  );
  await expect(page.locator('#evidence-boundaries')).toContainText(
    'does not add military-only filters, owner lookup, persistent watchlists, or nationwide tracking',
  );
  await expect(page.locator('#evidence-boundaries')).toContainText(
    'cannot establish a fault, safety condition',
  );
  expect(errors).toEqual([]);
});

test('search, keyboard selection, regions, pause and resume remain coordinated', async ({
  page,
}) => {
  await page.goto('/live.html');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByLabel('Search observations').fill('TEST02');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'TEST02', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'TEST02', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close selected track', exact: true }).click();
  await expect(page.getByRole('button', { name: 'TEST02', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'TEST02', exact: true }).click();
  await page.getByLabel('Position freshness').selectOption('missing-position');
  await expect(page.getByRole('heading', { name: 'No matching observations' })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Region', exact: true })
    .selectOption('savannah-statesboro');
  await expect(page.getByRole('heading', { name: 'Savannah / Statesboro airspace' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByLabel('Search observations')).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Select an aircraft' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause feed', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume feed', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
});

test('every regional preset supports the selected-track evidence journey', async ({ page }) => {
  await page.goto('/live.html');
  const regionControl = page.getByRole('combobox', { name: 'Region', exact: true });

  for (const region of REGION_CONFIGS) {
    await regionControl.selectOption(region.id);
    await expect(page.getByRole('heading', { name: `${region.label} airspace` })).toBeVisible();
    await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
    await expect(page.locator('.observation-panel tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'TEST01', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
    await expect(page.locator('.timing-evidence')).toContainText('Position observed');
    await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close selected track', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Select an aircraft' })).toBeVisible();
  }
});

test('mobile reflow, semantic controls and automated accessibility', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/live.html');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.skip-link')).toHaveCSS('outline-width', '3px');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  await expect(page.locator('main > .sr-only[aria-live="polite"]')).toContainText(
    'Selected track 000001',
  );
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await expect(page.locator('.selection-panel .freshness')).toContainText('Current');
  const semanticOrder = await page.evaluate(() =>
    ['.map-panel', '.selection-panel', '.observation-panel'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return [...document.querySelectorAll('main *')].indexOf(element);
    }),
  );
  expect(semanticOrder[0]).toBeLessThan(semanticOrder[1]!);
  expect(semanticOrder[1]).toBeLessThan(semanticOrder[2]!);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect
    .poll(() =>
      page.locator('.history-table-scroll').evaluate((element) => {
        return element.scrollWidth <= element.clientWidth;
      }),
    )
    .toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  expect(
    results.incomplete.filter(
      (result) => result.impact === 'serious' || result.impact === 'critical',
    ),
  ).toEqual([]);
  const selectedTrackButton = page.getByRole('button', { name: 'TEST01', exact: true });
  await selectedTrackButton.focus();
  await expect(page.locator('.skip-link')).toHaveCSS('clip-path', 'inset(50%)');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('live-mobile.png'), fullPage: true });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expect(page.locator('.source-banner')).toBeVisible();
  await expect(page.locator('#selected-title')).toBeVisible();
  await expect(page.locator('.investigation-boundary')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  // A 320 CSS-pixel viewport is the reflow layout produced by 400% browser zoom
  // on a 1280-pixel-wide display.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.source-banner')).toBeVisible();
  await expect(page.locator('#selected-title')).toBeVisible();
  await expect(page.locator('.investigation-boundary')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('combobox', { name: 'Region', exact: true })).toBeVisible();
});

test('geographic hit testing selects the same observation as the linked table', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/live.html');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await page.getByRole('combobox', { name: 'Region', exact: true }).selectOption('central-georgia');
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset map view', exact: true }).click();
  const response = await request.get('/api/v1/airspace/central-georgia/snapshot');
  const snapshot = await response.json();
  const aircraft = snapshot.aircraft.find(
    (entry: { callsign: string }) => entry.callsign === 'TEST01',
  );
  const canvas = page.locator('.maplibregl-canvas');
  const box = (await canvas.boundingBox())!;
  const { bounds } = getRegionConfig('central-georgia')!;
  const x = (longitude: number) => (longitude + 180) / 360;
  const y = (latitude: number) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / Math.PI) / 2;
  const scale = Math.min(
    (box.width - 56) / (x(bounds.east) - x(bounds.west)),
    (box.height - 56) / (y(bounds.south) - y(bounds.north)),
  );
  const position = {
    x:
      box.width / 2 +
      (x(aircraft.position.longitude) - (x(bounds.west) + x(bounds.east)) / 2) * scale,
    y:
      box.height / 2 +
      (y(aircraft.position.latitude) - (y(bounds.south) + y(bounds.north)) / 2) * scale,
  };
  await expect(async () => {
    await canvas.click({ position });
    await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible({
      timeout: 250,
    });
  }).toPass({ timeout: 5_000 });
  await expect(page.locator('.observation-panel tr[data-selected="true"]')).toContainText('TEST01');
  await page.getByRole('button', { name: 'TEST02', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST02', exact: true })).toBeVisible();
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  await page.getByLabel('Search observations').fill('nothing');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(0);
  await canvas.click({ position });
  await expect(page.getByRole('heading', { name: 'TEST02', exact: true })).toBeVisible();
});

test('missing map assets leave the feed usable and support an independent retry', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/map-assets/**', (route) => route.abort('failed'));
  await page.goto('/live.html');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'unavailable');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'TEST02', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST02', exact: true })).toBeVisible();
  await context.unroute('**/map-assets/**');
  await page.getByRole('button', { name: 'Retry map', exact: true }).click();
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(page.getByRole('heading', { name: 'TEST02', exact: true })).toBeVisible();
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  expect(errors).toEqual([]);
});

test('trail, charts and text table select the same retained receipt', async ({
  page,
}, testInfo) => {
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  const receiptButtons = page.locator('.history-table .receipt-link');
  await expect.poll(() => receiptButtons.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);

  const newestLabel = (await receiptButtons.first().textContent())!.trim();
  const oldestLabel = (await receiptButtons.last().textContent())!.trim();
  await receiptButtons.last().click();
  await expect(page.getByRole('heading', { name: `Exact receipt ${oldestLabel}` })).toBeVisible();
  await expect(page.locator('.history-table tr[data-selected="true"]')).toContainText(oldestLabel);
  await expect(page.locator('.chart-selection-value')).toHaveCount(2);
  await expect(page.locator('.chart-selection-value').first()).toContainText(
    `Receipt ${oldestLabel}`,
  );
  await expect(page.locator('.receipt-inspection')).toContainText('Position observed');
  await expect(page.locator('.receipt-inspection')).toContainText('Measurements observed');
  await page.screenshot({ path: testInfo.outputPath('live-investigation.png'), fullPage: true });

  await page.locator('.live-history-charts').focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('heading', { name: `Exact receipt ${newestLabel}` })).toBeVisible();
  await expect(page.locator('.history-table tr[data-selected="true"]')).toContainText(newestLabel);
  await page.getByRole('button', { name: 'Follow latest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Latest retained receipt' })).toBeVisible();
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
});

test('complete filters and sortable headers remain deterministic', async ({ page }) => {
  await page.goto('/live.html');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(3);

  await page.getByLabel('Altitude band').selectOption('above-25000');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'TEST02', exact: true })).toBeVisible();
  await page.getByLabel('Altitude band').selectOption('all');
  await page.getByLabel('Ground state').selectOption('unknown');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(3);
  await page.getByLabel('Ground state').selectOption('airborne');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(0);
  await page.getByLabel('Ground state').selectOption('all');
  await page.getByLabel('Position freshness').selectOption('missing-position');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'TEST03', exact: true })).toBeVisible();
  await page.getByLabel('Position freshness').selectOption('all');

  await page.getByLabel('Positioned only').check();
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(2);
  await page.getByLabel('Positioned only').uncheck();
  await page.getByRole('button', { name: /^Ground speed knots/ }).click();
  await expect(page.locator('th[aria-sort="ascending"]')).toContainText('Ground speed');
  await expect(page.locator('.aircraft-link')).toHaveText(['TEST03', 'TEST01', 'TEST02']);
  await page.locator('th[aria-sort="ascending"] .sort-button').click();
  await expect(page.locator('th[aria-sort="descending"]')).toContainText('Ground speed');
  await expect(page.locator('.aircraft-link')).toHaveText(['TEST02', 'TEST01', 'TEST03']);
});

test('actual WebGL context loss cannot break the feed, table or subsequent map retry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const wire = captureLiveWire(page);
  const latestSequence = () =>
    wire.messages.findLast((message) => message.type === 'airspace.snapshot')?.snapshot.sequence ??
    0;
  await page.goto('/live.html');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect.poll(latestSequence).toBeGreaterThan(0);
  const before = latestSequence();
  await page.locator('.maplibregl-canvas').evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2');
    const loss = gl?.getExtension('WEBGL_lose_context');
    if (!loss) throw new Error('This browser does not expose the context-loss test extension.');
    loss.loseContext();
  });
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'unavailable');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect.poll(latestSequence, { timeout: 15_000 }).toBeGreaterThan(before);
  await wire.expectAcknowledgments();
  await page.getByRole('button', { name: 'Retry map', exact: true }).click();
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('leaving Live for the React Lab closes its socket and preserves the baseline workflow', async ({
  page,
}) => {
  let liveClosed = false;
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/v1/airspace/'))
      socket.on('close', () => {
        liveClosed = true;
      });
  });
  await page.goto('/live.html');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  await page.getByRole('link', { name: 'Diagnostics Lab', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Telemetry monitor', exact: true })).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect.poll(() => liveClosed).toBe(true);
  await page.getByRole('link', { name: 'Open the existing offline Lab', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Monitor/ })).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.locator('#metric-hash')).toHaveText('b3b50781');
});
