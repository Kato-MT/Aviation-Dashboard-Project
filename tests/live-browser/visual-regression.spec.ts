import { expect, test, type Locator, type Page } from '@playwright/test';
import { parseLiveServerFrame, serializeLiveAcknowledgment } from '../../src/live/delivery';
import { expectNativeEgressDenied } from './nativeEgress';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_WEBSOCKET_ORIGIN } from './testOrigin';

const FIXED_BROWSER_TIME = new Date('2026-08-30T12:00:00.000Z');

function dynamicVisualRegions(page: Page): Locator[] {
  const measurements = page.locator('.selected-measurements > div');
  return [
    page.locator('.maplibregl-canvas'),
    page.locator('.live-chart-canvas canvas'),
    page.locator('.chart-selection-value'),
    page.locator('time'),
    page.locator('.feed-epoch'),
    page.locator('.observation-panel tbody td:nth-child(4)'),
    page
      .locator('.live-evidence-strip dl > div')
      .filter({ hasText: /^Backend receipt age/u })
      .locator('dd'),
    measurements.filter({ hasText: /^Latitude/u }).locator('dd'),
    measurements.filter({ hasText: /^Longitude/u }).locator('dd'),
    page.locator('.history-table .receipt-link'),
  ];
}

async function settleVisualLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function stabilizeVisualFeed(page: Page): Promise<void> {
  await page.routeWebSocket(
    (url) =>
      url.origin === LIVE_TEST_WEBSOCKET_ORIGIN &&
      /^\/api\/v1\/airspace\/[a-z0-9-]+\/stream$/u.test(url.pathname),
    (browserSocket) => {
      const serverSocket = browserSocket.connectToServer();
      let forwardedSnapshot = false;
      serverSocket.onMessage((wire) => {
        if (typeof wire !== 'string') {
          browserSocket.send(wire);
          return;
        }
        const parsed = parseLiveServerFrame(wire);
        if (!parsed.ok || parsed.message.type !== 'delivery') {
          browserSocket.send(wire);
          return;
        }
        const snapshotDelivery = parsed.message.messages.some(
          (message) => message.type === 'airspace.snapshot',
        );
        if (!snapshotDelivery || !forwardedSnapshot) {
          if (snapshotDelivery) forwardedSnapshot = true;
          browserSocket.send(wire);
          return;
        }

        // Delivery behavior has its own full suites. The visual fixture keeps the
        // first real backend snapshot stable while acknowledging later deliveries
        // so machine speed cannot add rows or trigger a server timeout mid-capture.
        serverSocket.send(serializeLiveAcknowledgment(parsed.message));
      });
    },
  );
}

test.beforeEach(async ({ context, page, request }) => {
  await expectNativeEgressDenied(request);
  // Date and performance must advance together so the production clock-discontinuity
  // guard remains active while every visual run starts from the same browser time.
  await page.clock.install({ time: FIXED_BROWSER_TIME });
  page.on('websocket', (socket) => {
    expect(new URL(socket.url()).origin).toBe(LIVE_TEST_WEBSOCKET_ORIGIN);
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== LIVE_TEST_HTTP_ORIGIN) {
      throw new Error(`Unexpected external browser request: ${url.origin}`);
    }
    return route.continue();
  });
});

test('Design A overview and Design B investigation remain visually stable', async ({ page }) => {
  await stabilizeVisualFeed(page);
  await page.goto('/live.html');
  await expect(page.locator('.source-banner')).toContainText(
    'Fictional observations through the real backend',
  );
  await expect(page.getByRole('heading', { name: 'Atlanta airspace', exact: true })).toBeVisible();
  await expect(page.locator('.transport-status')).toHaveText('Connected');
  await expect(page.locator('.observation-panel tbody tr')).toHaveCount(3);
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  await expect(
    page.getByRole('heading', { name: 'Select an aircraft', exact: true }),
  ).toBeVisible();
  await settleVisualLayout(page);

  await expect(page).toHaveScreenshot('design-a-overview.png', {
    fullPage: true,
    mask: dynamicVisualRegions(page),
    maskColor: '#dfe5e8',
  });

  await page.getByRole('button', { name: 'TEST01', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'TEST01', exact: true })).toBeVisible();
  await expect(page.locator('.selected-measurements')).toBeVisible();
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.live-history-charts canvas')).toHaveCount(2);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await settleVisualLayout(page);

  await expect(page).toHaveScreenshot('design-b-investigation.png', {
    fullPage: true,
    mask: dynamicVisualRegions(page),
    maskColor: '#dfe5e8',
  });
});
