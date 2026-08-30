import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_WEBSOCKET_ORIGIN } from './testOrigin';

type ApiPolicy = 'forbid' | 'health-only' | 'allow-live';

interface ApplicationSocketEvidence {
  url: string;
  closed: boolean;
  forbiddenAtOpen: boolean;
}

async function installNetworkGuard(page: Page, context: BrowserContext, policy: ApiPolicy) {
  let apiPolicy = policy;
  const apiRequests: string[] = [];
  const healthRequests: string[] = [];
  const forbiddenRequests: string[] = [];
  const forbiddenSockets: string[] = [];
  const applicationSockets: ApplicationSocketEvidence[] = [];

  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    // Vite's same-origin development HMR socket is test infrastructure. Application transport is
    // versioned below /api/ and every external socket is forbidden.
    if (url.origin === LIVE_TEST_WEBSOCKET_ORIGIN && !url.pathname.startsWith('/api/')) return;
    const evidence: ApplicationSocketEvidence = {
      url: socket.url(),
      closed: false,
      forbiddenAtOpen: apiPolicy !== 'allow-live',
    };
    applicationSockets.push(evidence);
    if (evidence.forbiddenAtOpen) forbiddenSockets.push(socket.url());
    socket.on('close', () => {
      evidence.closed = true;
    });
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      await route.continue();
      return;
    }
    const sameOrigin = url.origin === LIVE_TEST_HTTP_ORIGIN;
    const mapAsset =
      sameOrigin && (url.pathname === '/map-assets' || url.pathname.startsWith('/map-assets/'));
    if (mapAsset) {
      await route.continue();
      return;
    }
    const api = sameOrigin && url.pathname.startsWith('/api/');
    const health = api && url.pathname === '/api/v1/operations';
    const analytics =
      sameOrigin && /(?:^|\/)(?:analytics|telemetry|beacon)(?:\/|$)/u.test(url.pathname);
    if (api) {
      apiRequests.push(url.pathname);
      if (health) healthRequests.push(url.pathname);
    }
    const apiAllowed =
      apiPolicy === 'allow-live' ||
      (apiPolicy === 'health-only' && health && request.method() === 'GET');
    if (!sameOrigin || analytics || (api && !apiAllowed)) {
      forbiddenRequests.push(request.method() + ' ' + request.url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  return {
    apiRequests,
    healthRequests,
    forbiddenRequests,
    forbiddenSockets,
    applicationSockets,
    setPolicy(value: ApiPolicy) {
      apiPolicy = value;
    },
  };
}

function seriousOrCritical(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) {
  return violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

test('Replay is explicitly synthetic, transport-isolated, and reproduces outage recovery', async ({
  page,
  context,
}) => {
  const network = await installNetworkGuard(page, context, 'forbid');
  await page.goto('/live.html#replay');

  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();
  await expect(page.locator('.workbench-nav a[aria-current="page"]')).toHaveText(
    'Synthetic Replay',
  );
  await expect(page.locator('.replay-source-banner')).toContainText('Synthetic Replay');
  await expect(page.locator('.replay-source-banner')).toContainText(
    'No aircraft provider, catalog, health endpoint, or Live socket is used',
  );
  await expect(page.locator('.replay-identity')).toContainText('airspace-replay.v1');
  await expect(page.locator('.replay-identity')).toContainText('20260830');
  await expect(page.locator('.replay-identity')).toContainText('SYNTHETIC UNCLASSIFIED');
  await expect(page.locator('.map-stage')).toHaveAttribute('data-map-status', 'ready');
  expect(network.apiRequests).toEqual([]);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.forbiddenSockets).toEqual([]);

  await page.getByRole('button', { name: /Synthetic outage/ }).click();
  await expect(page.locator('.replay-current-event')).toContainText('Synthetic outage');
  await expect(page.locator('.replay-current-event')).toContainText('session offline');
  await expect(page.locator('.replay-notice')).toContainText(
    'This state does not imply an aircraft fault',
  );

  await page.getByRole('button', { name: /First recovery receipt/ }).click();
  await expect(page.locator('.replay-current-event')).toContainText('First recovery receipt');
  await expect(page.locator('.replay-current-event')).toContainText('session live');
  await expect(page.getByRole('button', { name: 'KEEP1', exact: true })).toBeVisible();
  await expect(page.locator('.identifier')).toContainText('DEMO:PROVIDER-OUTAGE-RECOVERY:1');
  await page.getByRole('button', { name: 'KEEP1', exact: true }).click();
  await expect(page.locator('.timing-evidence')).toContainText('Backend receipt');
  await expect(page.locator('.session-history')).toContainText('1 receipts');
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);

  expect(network.apiRequests).toEqual([]);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.forbiddenSockets).toEqual([]);
  expect(network.applicationSockets).toEqual([]);
});

test('Evidence is useful statically and performs exactly one explicit aggregate health read', async ({
  page,
  context,
}) => {
  const network = await installNetworkGuard(page, context, 'health-only');
  await page.goto('/live.html#evidence');

  await expect(
    page.getByRole('heading', {
      name: 'What this build is, what it uses, and what remains open',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.evidence-release-banner')).toContainText(
    'Unreleased development build',
  );
  await expect(page.locator('.evidence-release-banner')).toContainText(
    '3.0.0-dev · local-unreleased',
  );
  await expect(page.locator('#evidence-build')).toContainText('local-mock');
  await expect(page.locator('#evidence-map')).toContainText('georgia-20260828-z12');
  await expect(page.locator('#evidence-map')).toContainText(
    '286238718ff1006ada90f1bbd03958c0f4510a3e01ceee578798e81920bf72a6',
  );
  await expect(page.locator('#evidence-gates')).toContainText('Pending');
  await expect(page.locator('[data-health-state="unchecked"]')).toContainText(
    'No operational request has been made',
  );
  expect(network.apiRequests).toEqual([]);
  expect(network.applicationSockets).toEqual([]);

  await page.getByRole('button', { name: 'Check service health once', exact: true }).click();
  await expect(page.locator('[data-health-state="available"]')).toBeVisible();
  await expect(page.locator('.evidence-health-announcement')).toContainText(
    'Operational evidence received. Application state is Available',
  );
  await expect(page.locator('.evidence-health-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.evidence-health-summary')).toContainText(
    'Synthetic integration feed',
  );

  expect(network.apiRequests).toEqual(['/api/v1/operations']);
  expect(network.healthRequests).toEqual(['/api/v1/operations']);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.forbiddenSockets).toEqual([]);
  expect(network.applicationSockets).toEqual([]);
});

test('leaving Live closes its socket and Replay resets after an Evidence round trip', async ({
  page,
  context,
}) => {
  const network = await installNetworkGuard(page, context, 'allow-live');
  await page.goto('/live.html#live');
  await expect(page.getByRole('heading', { name: 'Atlanta airspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  await expect
    .poll(() => network.applicationSockets.filter(({ closed }) => !closed).length)
    .toBe(1);
  const observedLiveSocketCount = network.applicationSockets.length;
  expect(observedLiveSocketCount).toBeGreaterThanOrEqual(1);
  expect(network.applicationSockets.every(({ forbiddenAtOpen }) => !forbiddenAtOpen)).toBe(true);

  network.setPolicy('forbid');
  await page.getByRole('link', { name: 'Synthetic Replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();
  await expect.poll(() => network.applicationSockets.every(({ closed }) => closed)).toBe(true);
  expect(network.applicationSockets).toHaveLength(observedLiveSocketCount);

  await page.getByRole('button', { name: /Synthetic outage/ }).click();
  await expect(page.locator('.replay-current-event')).toContainText('Synthetic outage');
  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.locator('#evidence-main')).toBeVisible();
  await expect(page.locator('[data-health-state="unchecked"]')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();
  await expect(page.locator('.replay-current-event')).toContainText('Synthetic source ready');
  await expect(page.locator('.replay-current-event')).not.toContainText('Synthetic outage');

  expect(network.applicationSockets).toHaveLength(observedLiveSocketCount);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.forbiddenSockets).toEqual([]);
});

test('Replay and Evidence preserve keyboard access, reflow, and serious accessibility', async ({
  page,
  context,
}) => {
  const network = await installNetworkGuard(page, context, 'forbid');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/live.html#replay');
  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toHaveAttribute('href', '#replay-main');
  await expect(page.locator('.skip-link')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('#replay-main')).toBeFocused();
  const outage = page.getByRole('button', { name: /Synthetic outage/ });
  await outage.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.replay-current-event')).toContainText('Synthetic outage');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const replayAxe = await new AxeBuilder({ page }).analyze();
  expect(seriousOrCritical(replayAxe.violations)).toEqual([]);

  await page.goto('/live.html#evidence');
  await expect(page.locator('#evidence-main')).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expect(page.locator('#evidence-main h1')).toBeVisible();
  await expect(page.locator('.evidence-table-scroll').first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const evidenceTextZoomAxe = await new AxeBuilder({ page }).analyze();
  expect(seriousOrCritical(evidenceTextZoomAxe.violations)).toEqual([]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  await expect(page.locator('#evidence-main')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toHaveAttribute('href', '#evidence-main');
  await page.keyboard.press('Enter');
  await expect(page.locator('#evidence-main')).toBeFocused();
  await expect(page.locator('.evidence-table-scroll').first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  const evidenceAxe = await new AxeBuilder({ page }).analyze();
  expect(seriousOrCritical(evidenceAxe.violations)).toEqual([]);

  expect(network.apiRequests).toEqual([]);
  expect(network.forbiddenRequests).toEqual([]);
  expect(network.forbiddenSockets).toEqual([]);
});
