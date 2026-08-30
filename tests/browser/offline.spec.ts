import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const offlineDirectory = resolve('dist-offline');
const offlinePath = resolve(offlineDirectory, 'index.html');
const offlineUrl = pathToFileURL(offlinePath).href;

interface OfflineNetworkProbe {
  fetches(): number;
  xhrs(): number;
  sockets(): number;
  eventSources(): number;
  beacons(): number;
  activeWorkers(): number;
  workerStarts(): number;
}

type OfflineProbedWindow = Window & { offlineNetworkProbe: OfflineNetworkProbe };

interface DeterministicEvidence {
  investigation: Record<string, unknown>;
  campaign: Record<string, unknown>;
}

async function installOfflineProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let fetches = 0;
    let xhrs = 0;
    let sockets = 0;
    let eventSources = 0;
    let beacons = 0;
    let workerStarts = 0;
    const activeWorkers = new Set<Worker>();

    const nativeFetch = window.fetch.bind(window);
    window.fetch = ((...args: Parameters<typeof window.fetch>) => {
      fetches += 1;
      return nativeFetch(...args);
    }) as typeof window.fetch;

    const NativeXhr = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends NativeXhr {
      constructor() {
        super();
        xhrs += 1;
      }
    };

    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        sockets += 1;
        super(url, protocols);
      }
    };

    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        eventSources += 1;
        super(url, eventSourceInitDict);
      }
    };

    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (...args: Parameters<typeof navigator.sendBeacon>) => {
      beacons += 1;
      return nativeBeacon(...args);
    };

    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        activeWorkers.add(this);
        workerStarts += 1;
      }

      override terminate(): void {
        activeWorkers.delete(this);
        super.terminate();
      }
    };

    (window as unknown as OfflineProbedWindow).offlineNetworkProbe = {
      fetches: () => fetches,
      xhrs: () => xhrs,
      sockets: () => sockets,
      eventSources: () => eventSources,
      beacons: () => beacons,
      activeWorkers: () => activeWorkers.size,
      workerStarts: () => workerStarts,
    };
  });
}

async function probe(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const value = (window as unknown as OfflineProbedWindow).offlineNetworkProbe;
    return {
      fetches: value.fetches(),
      xhrs: value.xhrs(),
      sockets: value.sockets(),
      eventSources: value.eventSources(),
      beacons: value.beacons(),
      activeWorkers: value.activeWorkers(),
      workerStarts: value.workerStarts(),
    };
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            if (
              element.closest(
                '.lab-subview-tabs, .lab-campaign-table-scroll, .lab-configuration-table-scroll, .evidence-table-scroll, .replay-event-strip, .table-scroll',
              )
            ) {
              return false;
            }
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const bounds = element.getBoundingClientRect();
            return bounds.right > document.documentElement.clientWidth + 1 || bounds.left < -1;
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            text: element.textContent?.trim().slice(0, 60),
          })),
      })),
    )
    .toEqual({ pageOverflows: false, offenders: [] });
}

async function downloadJson(page: Page, buttonName: string): Promise<Record<string, unknown>> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const download = await pending;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as Record<string, unknown>;
}

async function collectDeterministicEvidence(
  page: Page,
  entryUrl: string,
): Promise<DeterministicEvidence> {
  await page.goto(`${entryUrl}#lab-investigation`);
  await expect(page.getByRole('heading', { name: 'Investigation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-status')).toContainText(/rule indications/u);
  const investigation = await downloadJson(page, 'Export minimized investigation JSON');

  await page.getByRole('tab', { name: 'Campaign', exact: true }).click();
  await page.getByRole('textbox', { name: 'Deterministic seeds', exact: true }).fill('3101');
  await page.getByRole('button', { name: 'Run Campaign', exact: true }).click();
  await expect(page.locator('#campaign-status')).toHaveText('Completed', { timeout: 30_000 });
  const campaign = await downloadJson(page, 'Export minimized Campaign JSON');

  const reproduction = investigation.scenarioReproduction as Record<string, unknown>;
  return {
    investigation: {
      dataBoundary: investigation.dataBoundary,
      reproduction: {
        scenarioId: reproduction.scenarioId,
        seed: reproduction.seed,
        sampleCount: reproduction.sampleCount,
        cadenceMs: reproduction.cadenceMs,
      },
      lifecycle: investigation.verificationOnlyLifecycle,
      models: investigation.models,
      results: investigation.results,
      exportPolicy: investigation.exportPolicy,
    },
    campaign: {
      dataBoundary: campaign.dataBoundary,
      reproduction: campaign.reproduction,
      terminal: campaign.terminal,
      metrics: campaign.metrics,
      failedCaseSummaries: campaign.failedCaseSummaries,
      decisionPolicy: campaign.decisionPolicy,
      exportPolicy: campaign.exportPolicy,
    },
  };
}

async function enterOffline(context: BrowserContext, page: Page): Promise<string[]> {
  const subresourceRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url !== offlineUrl && !/^(?:blob|data):/iu.test(url)) subresourceRequests.push(url);
  });
  await installOfflineProbe(page);
  await context.setOffline(true);
  await page.goto(offlineUrl);
  return subresourceRequests;
}

test('TC-LUI-006 TC-LUI-018 opens one React artifact and completes the full zero-network offline journey', async ({
  context,
  page,
}) => {
  expect(await readdir(offlineDirectory)).toEqual(['index.html']);
  const artifact = await readFile(offlinePath, 'utf8');
  expect(artifact).toContain("connect-src 'none'");
  expect(artifact).not.toMatch(/\/api\/v1\/(?:airspace|health)/u);
  expect(artifact).not.toContain('/v2/point/');
  expect(artifact).not.toContain('maplibre-gl');

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const subresourceRequests = await enterOffline(context, page);

  await expect(page.locator('.live-app-header .development-label')).toHaveText(
    'Self-contained offline package',
  );
  await expect(page.getByRole('heading', { name: /Live Airspace.*unavailable/i })).toBeVisible();
  await expect(
    page.getByText(/No provider, regional service, map asset, or aggregate health request/u),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Synthetic Replay', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Provider outage and recovery' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Map unavailable offline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset map view', exact: true })).toHaveCount(0);

  await page.getByRole('link', { name: 'Diagnostics Lab', exact: true }).click();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect(page.locator('#metric-quarantined')).toHaveText('0');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.getByRole('tab')).toHaveCount(6);
  expect(await page.getByRole('tab').allTextContents()).toEqual([
    'Monitor',
    'Diagnostics',
    'Verification',
    'Investigation',
    'Campaign',
    'Configuration',
  ]);

  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
  await expect(page.locator('.lab-diagnostics-findings li')).toHaveCount(9);
  await page.getByRole('tab', { name: 'Verification', exact: true }).click();
  await page.getByRole('button', { name: 'Compare current with baseline', exact: true }).click();
  await expect(page.locator('.lab-verification-outcome')).toHaveAttribute('data-outcome', 'pass');

  await page.getByRole('tab', { name: 'Investigation', exact: true }).click();
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-status')).toContainText(/rule indications/u);
  await expect(page.locator('#investigation-rule-count')).not.toHaveText('0');

  await page.getByRole('tab', { name: 'Campaign', exact: true }).click();
  await page.getByRole('textbox', { name: 'Deterministic seeds', exact: true }).fill('3101');
  await page.getByRole('button', { name: 'Run Campaign', exact: true }).click();
  await expect(page.locator('#campaign-status')).toHaveText('Completed', { timeout: 30_000 });
  await expect(page.locator('#campaign-progress-label')).toHaveText('Processed 31 of 31');
  await expect.poll(() => probe(page).then((value) => value.activeWorkers)).toBe(0);
  expect((await probe(page)).workerStarts).toBe(1);

  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page.locator('#config-hash')).toHaveText(
    'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
  );
  await page.getByRole('button', { name: 'Run in-browser demo', exact: true }).click();
  await expect(page.locator('#stream-state')).toContainText(/Demo active|Demo degraded/u);
  await page.getByRole('button', { name: 'Stop simulator', exact: true }).click();
  await expect(page.locator('#stream-state')).toHaveText('Stopped');

  await page.getByRole('link', { name: 'Evidence', exact: true }).click();
  await expect(page.getByRole('note', { name: 'Offline service health' })).toContainText(
    'No health request can be made',
  );
  await expect(page.getByRole('button', { name: /health/i })).toHaveCount(0);
  await expect(page.getByText('offline', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await page.getByRole('tab', { name: 'Campaign', exact: true }).click();
  await expect(page.locator('#campaign-status')).toHaveText('Completed');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoHorizontalOverflow(page);

  await page.reload();
  await expect(page.locator('#campaign-status')).toHaveText('Not run');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });

  expect(await probe(page)).toEqual({
    fetches: 0,
    xhrs: 0,
    sockets: 0,
    eventSources: 0,
    beacons: 0,
    activeWorkers: 0,
    workerStarts: 0,
  });
  expect(subresourceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('TC-TOFF-001 TC-TOFF-002 TC-TOFF-003 normal and offline React builds produce equivalent deterministic evidence', async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Exact deterministic parity runs once.');
  await context.setOffline(false);
  const normal = await collectDeterministicEvidence(
    page,
    'http://127.0.0.1:4173/Aviation-Dashboard-Project/live.html',
  );

  const offlinePage = await context.newPage();
  const errors: string[] = [];
  offlinePage.on('pageerror', (error) => errors.push(error.message));
  offlinePage.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await installOfflineProbe(offlinePage);
  await context.setOffline(true);
  const offline = await collectDeterministicEvidence(offlinePage, offlineUrl);

  expect(offline).toEqual(normal);
  expect(await probe(offlinePage)).toEqual({
    fetches: 0,
    xhrs: 0,
    sockets: 0,
    eventSources: 0,
    beacons: 0,
    activeWorkers: 0,
    workerStarts: 1,
  });
  expect(errors).toEqual([]);
});
