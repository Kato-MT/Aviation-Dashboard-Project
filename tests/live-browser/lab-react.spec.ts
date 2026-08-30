import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  genericFixedWingProfile,
  genericRotaryWingProfile,
  includedBaselineProfile,
} from '../../src/profiles';
import { generateSyntheticDocument } from '../../src/ui/generate';
import type { VersionedDiagnosticReport } from '../../src/export/reports';
import type { ConfigurationReportV1 } from '../../src/export/configurationReport';
import type { InvestigationReportV1 } from '../../src/export/investigationReport';
import type { CampaignReportV1 } from '../../src/export/campaignReport';
import { LIVE_TEST_HTTP_ORIGIN } from './testOrigin';

interface ResourceProbe {
  labObservers(): number;
  replayTimers(): number;
  simulatorTimers(): number;
  campaignWorkers(): number;
  campaignWorkerStarts(): number;
}
type ProbedWindow = Window & { labResourceProbe: ResourceProbe };
type ConfigurationNetworkProbe = {
  fetchCalls(): number;
  socketCalls(): number;
};

test.beforeEach(async ({ request, context, page }) => {
  const metadata = await request.get('/api/v1/regions');
  expect(metadata.ok()).toBe(true);
  expect((await metadata.json()).source).toMatchObject({
    target: 'local-mock',
    mode: 'mock',
    synthetic: true,
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== LIVE_TEST_HTTP_ORIGIN)
      throw new Error('Unexpected external browser request: ' + url.origin);
    return route.continue();
  });
  // Observe real Chart.js ownership without replacing the charts or exposing production test hooks.
  await page.addInitScript(() => {
    const targets = new Map<ResizeObserver, Set<Element>>();
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (!targets.has(this)) targets.set(this, new Set());
        targets.get(this)!.add(target);
        super.observe(target, options);
      }
      override unobserve(target: Element) {
        targets.get(this)?.delete(target);
        super.unobserve(target);
      }
      override disconnect() {
        targets.delete(this);
        super.disconnect();
      }
    };
    const timers = new Map<number, number | undefined>();
    const originalSet = window.setInterval.bind(window);
    const originalClear = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = originalSet(handler, timeout, ...args);
      timers.set(id, timeout);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id) => {
      if (typeof id === 'number') timers.delete(id);
      originalClear(id);
    };
    const NativeWorker = window.Worker;
    const activeWorkers = new Set<Worker>();
    let workerStarts = 0;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        activeWorkers.add(this);
        workerStarts += 1;
      }

      override terminate() {
        activeWorkers.delete(this);
        super.terminate();
      }
    };
    (window as unknown as ProbedWindow).labResourceProbe = {
      labObservers: () =>
        [...targets.values()].filter((values) =>
          [...values].some((target) => target.classList.contains('lab-chart-canvas')),
        ).length,
      replayTimers: () =>
        [...timers.values()].filter(
          (timeout) => timeout === 150 || timeout === 300 || timeout === 600,
        ).length,
      simulatorTimers: () => [...timers.values()].filter((timeout) => timeout === 150).length,
      campaignWorkers: () => activeWorkers.size,
      campaignWorkerStarts: () => workerStarts,
    };
    const nativeFetch = window.fetch.bind(window);
    let fetchCalls = 0;
    window.fetch = ((...args: Parameters<typeof window.fetch>) => {
      fetchCalls += 1;
      return nativeFetch(...args);
    }) as typeof window.fetch;
    const NativeWebSocket = window.WebSocket;
    let socketCalls = 0;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        socketCalls += 1;
        super(url, protocols);
      }
    };
    (
      window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe }
    ).configurationNetworkProbe = {
      fetchCalls: () => fetchCalls,
      socketCalls: () => socketCalls,
    };
  });
});

async function golden(page: Page) {
  await expect(page.getByRole('heading', { name: 'Telemetry monitor', exact: true })).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect(page.locator('#metric-quarantined')).toHaveText('0');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.locator('#metric-hash')).toHaveText('b3b50781');
  await expect(page.locator('.lab-charts canvas')).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(3);
}

async function expectNoPageHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => {
            if (
              element.closest(
                '.lab-subview-tabs, .lab-configuration-table-scroll, .lab-campaign-table-scroll',
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
            bounds: (() => {
              const bounds = element.getBoundingClientRect();
              return {
                left: Math.round(bounds.left),
                right: Math.round(bounds.right),
                width: Math.round(bounds.width),
              };
            })(),
            className: element.className,
            parentClassName: element.parentElement?.className,
            tag: element.tagName,
            text: element.textContent?.trim().slice(0, 60),
          })),
      })),
    )
    .toEqual({ pageOverflows: false, offenders: [] });
}

async function expectDiagnosticsControlsReachable(page: Page) {
  const controls = [
    page.getByRole('combobox', { name: /^Severity/u }),
    page.getByRole('searchbox', { name: 'Search evidence', exact: true }),
    page.getByRole('combobox', { name: /^Declared scenario/u }),
    page.getByRole('spinbutton', { name: 'Deterministic seed', exact: true }),
    page.getByRole('button', { name: 'Create candidate and verify', exact: true }),
  ];
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
  }
}

async function downloadReport(page: Page): Promise<VersionedDiagnosticReport> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export diagnostic JSON', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/-diagnostic-report\.json$/);
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}
async function downloadVerificationReport(page: Page): Promise<VersionedDiagnosticReport> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export minimized verification JSON' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/-verification-report\.json$/);
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

async function downloadConfigurationReport(page: Page): Promise<ConfigurationReportV1> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export minimized configuration JSON' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^configuration-.+\.json$/u);
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as ConfigurationReportV1;
}

async function downloadInvestigationReport(page: Page): Promise<InvestigationReportV1> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export minimized investigation JSON' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^temporal-investigation-.+-seed-\d+\.json$/u);
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as InvestigationReportV1;
}

async function downloadCampaignReport(page: Page): Promise<CampaignReportV1> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export minimized Campaign JSON' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^temporal-campaign-.+\.json$/u);
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as CampaignReportV1;
}

test('React Monitor opens directly with the golden baseline, real charts and no live data requests', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const airspaceRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/(api\/v1\/airspace|map-assets)\//.test(request.url()))
      airspaceRequests.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/live.html#lab');
  await golden(page);
  await expect(page.locator('.lab-findings li')).toHaveCount(9);
  await expect(page.locator('.source-banner')).toContainText(
    'Separate from public aircraft surveillance',
  );
  expect(
    await page.locator('.lab-charts canvas').evaluateAll((elements) =>
      elements.every((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((channel, index) => index % 4 === 3 && channel > 0);
      }),
    ),
  ).toBe(true);
  const excluded = await downloadReport(page);
  expect(excluded.run.provenance.datasetSha256).toBe(
    'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
  );
  expect(excluded.exportPolicy.sourceDataIncluded).toBe(false);
  expect(excluded.run.samples).toBeUndefined();
  await page
    .getByRole('checkbox', { name: 'Include source samples and raw rows in the JSON report' })
    .check();
  const included = await downloadReport(page);
  expect(included.exportPolicy.sourceDataIncluded).toBe(true);
  expect(included.run.samples).toHaveLength(85);
  const pendingCsv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export findings CSV', exact: true }).click();
  const csv = await readFile((await (await pendingCsv).path())!, 'utf8');
  expect(csv.split('\r\n')).toHaveLength(10);
  await page
    .getByRole('checkbox', { name: 'Include source samples and raw rows in the JSON report' })
    .uncheck();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('lab-react-desktop.png'), fullPage: true });
  expect(airspaceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('CSV and JSON imports preserve validation, quarantine, declared profiles and safe export defaults', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/live.html#lab');
  await golden(page);
  const file = page.getByLabel('Import synthetic CSV or JSON');
  await file.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await expect(page.locator('.lab-message')).toHaveAttribute('data-status', 'blocked');
  await expect(page.locator('#metric-accepted')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Start replay', exact: true })).toBeDisabled();
  await expect(page.locator('.lab-validation')).toContainText('SCHEMA_MISMATCH');
  await file.setInputFiles({
    name: 'oversized.csv',
    mimeType: 'text/csv',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 'a'),
  });
  await expect(page.locator('.lab-message')).toHaveAttribute('data-status', 'error');
  await expect(page.locator('.lab-message')).toContainText('10 MiB');
  await expect(page.locator('.lab-charts canvas')).toHaveCount(0);
  const hostile =
    'timestamp,altitude_ft,speed_kts,fuel_pct\n<img src=x onerror=alert(1)>,1000,100,90\n00:10,1100,105,89.9';
  await file.setInputFiles({
    name: 'hostile.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(hostile),
  });
  await expect(page.locator('#metric-accepted')).toHaveText('1');
  await expect(page.locator('#metric-quarantined')).toHaveText('1');
  await expect(page.locator('.lab-validation')).toContainText('INVALID_TIMESTAMP');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect((await downloadReport(page)).run.quarantinedRows[0]?.raw).toBeUndefined();
  const json = generateSyntheticDocument(genericRotaryWingProfile, 18);
  await file.setInputFiles({
    name: 'rotary.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });
  await expect(page.locator('#metric-accepted')).toHaveText('18');
  await expect(page.getByLabel('Detection profile')).toHaveValue(genericRotaryWingProfile.id);
  await expect(page.locator('.lab-message')).toHaveAttribute('data-status', 'ready');
  await page.getByRole('button', { name: 'Load included baseline', exact: true }).click();
  await golden(page);
  await expect(page.getByLabel('Detection profile')).toHaveValue(includedBaselineProfile.id);
  expect(errors).toEqual([]);
});

test('React Diagnostics routes directly, filters evidence, verifies a quarantined CSV candidate and retains it across Back navigation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const forbiddenSockets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      /\/api\/v1\/(?:airspace|health|regions)(?:\/|$)/u.test(url.pathname) ||
      /\/map-assets(?:\/|$)/u.test(url.pathname) ||
      /\/v2\/point\//u.test(url.pathname)
    ) {
      forbiddenRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => {
    if (/\/api\/v1\/airspace(?:\/|$)/u.test(new URL(socket.url()).pathname)) {
      forbiddenSockets.push(socket.url());
    }
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/live.html#lab-diagnostics');
  await expect(page).toHaveURL(/#lab-diagnostics$/u);
  await expect(page).toHaveTitle('Diagnostics | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Diagnostics Lab', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.source-banner')).toContainText(
    'Separate from public aircraft surveillance',
  );
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect(page.locator('#metric-quarantined')).toHaveText('0');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.locator('#metric-hash')).toHaveText('b3b50781');
  const findings = page.locator('.lab-diagnostics-findings > ol > li');
  await expect(findings).toHaveCount(9);

  const severity = page.getByRole('combobox', { name: /^Severity/u });
  const searchEvidence = page.getByRole('searchbox', {
    name: 'Search evidence',
    exact: true,
  });
  await severity.selectOption('error');
  await expect(findings).toHaveCount(3);
  await expect(page.locator('.lab-diagnostics-result')).toHaveText('3 of 9 findings match.');
  await searchEvidence.fill('no matching evidence');
  await expect(findings).toHaveCount(0);
  await expect(page.locator('.lab-diagnostics-findings .lab-empty-state')).toHaveText(
    'No findings match the active filters.',
  );
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(findings).toHaveCount(9);
  await expect(severity).toHaveValue('all');
  await expect(searchEvidence).toHaveValue('');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-diagnostics-desktop.png'),
    fullPage: true,
  });
  await severity.selectOption('error');
  await expect(findings).toHaveCount(3);

  const declaredScenario = page.getByRole('combobox', { name: /^Declared scenario/u });
  const deterministicSeed = page.getByRole('spinbutton', {
    name: 'Deterministic seed',
    exact: true,
  });
  await declaredScenario.selectOption('nonnumeric-csv-value');
  await deterministicSeed.fill('1337');
  await page.getByRole('button', { name: 'Create candidate and verify', exact: true }).click();
  await expect(page).toHaveURL(/#lab-verification$/u);
  await expect(page).toHaveTitle('Verification | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(
    page.getByRole('heading', { name: 'Baseline and candidate verification', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Verification', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const candidate = page.locator('.lab-verification-run').nth(1);
  await expect(candidate).toContainText('Nonnumeric CSV value · seed 1337');
  await expect(candidate).toContainText('Quarantined');
  await expect(candidate).toContainText('1');
  const candidateHash = (
    await candidate.locator('.lab-verification-hash dd').textContent()
  )?.trim();
  expect(candidateHash).toMatch(/^[a-f0-9]{64}$/u);

  await page.goBack();
  await expect(page).toHaveURL(/#lab-diagnostics$/u);
  await expect(page).toHaveTitle('Diagnostics | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(declaredScenario).toHaveValue('nonnumeric-csv-value');
  await expect(deterministicSeed).toHaveValue('1337');
  await expect(
    page.getByRole('heading', { name: 'Nonnumeric CSV value · seed 1337', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#metric-accepted')).toHaveText('84');
  await expect(page.locator('#metric-quarantined')).toHaveText('1');
  await expect(page.locator('#metric-hash')).toHaveText(candidateHash!.slice(0, 8));
  await expect(severity).toHaveValue('error');
  await expect(findings).toHaveCount(4);
  await expect(page.locator('.lab-diagnostics-result')).toHaveText('4 of 11 findings match.');
  const quarantine = page.locator('.lab-quarantine-evidence');
  await expect(quarantine.locator('li')).toHaveCount(1);
  await expect(quarantine).toContainText('NONNUMERIC_VALUE');
  await expect(quarantine).not.toContainText('not-a-number');
  await page.getByText('Run provenance', { exact: true }).click();
  await expect(page.locator('.lab-provenance')).toContainText(candidateHash!);

  await page.goForward();
  await expect(page).toHaveURL(/#lab-verification$/u);
  await expect(page.locator('.lab-verification-outcome')).toHaveAttribute('data-outcome', 'fail');
  await expect(
    page.getByRole('heading', { name: 'Regression detected', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.lab-verification-run').nth(1)).toContainText(
    'Nonnumeric CSV value · seed 1337',
  );
  await page.goBack();
  await expect(page).toHaveURL(/#lab-diagnostics$/u);
  await expect(severity).toHaveValue('error');
  await expect(findings).toHaveCount(4);
  await expect(quarantine).toContainText('NONNUMERIC_VALUE');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectDiagnosticsControlsReachable(page);
  await expectNoPageHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-diagnostics-mobile.png'),
    fullPage: true,
  });

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectDiagnosticsControlsReachable(page);
  await expectNoPageHorizontalOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-diagnostics-zoom-200.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });

  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('tab')).toHaveCount(6);
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectDiagnosticsControlsReachable(page);
  await expectNoPageHorizontalOverflow(page);

  await page.reload();
  await expect(page).toHaveURL(/#lab-diagnostics$/u);
  await expect(page).toHaveTitle('Diagnostics | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await expect(page.locator('#metric-quarantined')).toHaveText('0');
  await expect(page.locator('#metric-findings')).toHaveText('9');
  await expect(page.locator('#metric-hash')).toHaveText('b3b50781');
  await expectNoPageHorizontalOverflow(page);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(forbiddenRequests).toEqual([]);
  expect(forbiddenSockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('an older asynchronous file read cannot replace a newer accepted input', async ({ page }) => {
  await page.goto('/live.html#lab');
  await golden(page);
  await page.evaluate(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'older.csv') return read.call(this);
      return new Promise<string>((resolve) => {
        (window as unknown as { finishOldRead: () => void }).finishOldRead = () => {
          File.prototype.text = read;
          resolve('invalid obsolete input');
        };
      });
    };
  });
  await page
    .getByLabel('Import synthetic CSV or JSON')
    .setInputFiles({ name: 'older.csv', mimeType: 'text/csv', buffer: Buffer.from('old input') });
  await expect(page.locator('.lab-message')).toHaveAttribute('data-status', 'loading');
  await page.getByRole('button', { name: 'Load included baseline', exact: true }).click();
  await golden(page);
  await page.evaluate(() => (window as unknown as { finishOldRead: () => void }).finishOldRead());
  await golden(page);
  await expect(
    page.getByRole('heading', { name: 'Included 85-record synthetic baseline', exact: true }),
  ).toBeVisible();
});

test('React Verification routes directly, proves pass, regression and blocked states, and releases Monitor resources', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const airspaceRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/(api\/v1\/airspace|map-assets)\//.test(request.url())) {
      airspaceRequests.push(request.url());
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/live.html#lab-verification');
  await expect(
    page.getByRole('heading', { name: 'Baseline and candidate verification', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Verification | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('tab', { name: 'Verification' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Diagnostics Lab', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(
    await page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.replayTimers()),
  ).toBe(0);

  await page.getByRole('button', { name: 'Compare current with baseline' }).click();
  await expect(page.locator('.lab-verification-outcome')).toHaveAttribute('data-outcome', 'pass');
  await expect(page.getByRole('heading', { name: 'Verification passed' })).toBeVisible();
  await expect(
    page.locator('.lab-classification-group').filter({ hasText: 'Persisting' }).locator('li'),
  ).toHaveCount(9);
  await expect(page.locator('.lab-requirement-evidence li')).toHaveCount(8);
  const passingReport = await downloadVerificationReport(page);
  expect(passingReport.verification).toMatchObject({
    schemaVersion: 'verification.v2',
    status: 'pass',
    summary: { resolved: 0, persisting: 9, newlyIntroduced: 0 },
  });
  expect(passingReport.verification?.requirementResults).toHaveLength(8);
  expect(passingReport.run.samples).toBeUndefined();
  expect(passingReport.run.sources).toBeUndefined();
  expect(passingReport.exportPolicy.sourceDataIncluded).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-verification-desktop.png'),
    fullPage: true,
  });

  await page.getByRole('tab', { name: 'Monitor' }).click();
  await golden(page);
  await page.getByRole('button', { name: 'Start replay', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.replayTimers()),
    )
    .toBe(1);
  await page.getByRole('tab', { name: 'Verification' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.replayTimers()),
    )
    .toBe(0);
  await page.goBack();
  await golden(page);
  await expect(page.getByRole('tab', { name: 'Monitor' })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Verification passed' })).toBeVisible();

  const baseline = await readFile(new URL('../../data/flight.csv', import.meta.url), 'utf8');
  const changed = baseline.replace('00:10,800,120,99.6', '00:10,800,999,99.6');
  expect(changed).not.toBe(baseline);
  const input = page.getByLabel('Import synthetic CSV or JSON');
  await input.setInputFiles({
    name: 'overspeed-candidate.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(changed),
  });
  await page.getByRole('button', { name: 'Compare current with baseline' }).click();
  await expect(page.locator('.lab-verification-outcome')).toHaveAttribute('data-outcome', 'fail');
  await expect(page.getByRole('heading', { name: 'Regression detected' })).toBeVisible();
  await expect(
    page.locator('.lab-classification-group').filter({ hasText: 'Newly introduced' }).locator('li'),
  ).not.toHaveCount(0);

  await input.setInputFiles({
    name: 'malformed-candidate.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await page.getByRole('button', { name: 'Compare current with baseline' }).click();
  await expect(page.locator('.lab-verification-outcome')).toHaveAttribute(
    'data-outcome',
    'blocked',
  );
  await expect(page.getByRole('heading', { name: 'Verification blocked' })).toBeVisible();
  await expect(page.locator('.lab-verification-outcome')).toContainText('not proof of improvement');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(airspaceRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('Verification preserves its route through the skip anchor and reflows at mobile widths', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/live.html#lab-verification');
  await expect(page.getByRole('heading', { name: 'Verification pending' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  await expect(page).toHaveURL(/#lab-main$/);
  await expect(page.getByRole('tab', { name: 'Verification' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Compare current with baseline' }).click();
  await expect(page.getByRole('heading', { name: 'Verification passed' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expect(page.getByRole('heading', { name: 'Verification passed' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export minimized verification JSON' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            right: element.getBoundingClientRect().right,
            text: element.textContent?.slice(0, 80),
          })),
      ),
    )
    .toEqual([]);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-verification-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            right: element.getBoundingClientRect().right,
            text: element.textContent?.slice(0, 80),
          })),
      ),
    )
    .toEqual([]);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test('React Investigation proves deterministic linked evidence, strict comparison, minimized export and lifecycle cleanup', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const forbiddenSockets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      /\/api\/v1\/(?:airspace|health|regions)(?:\/|$)/u.test(url.pathname) ||
      /\/map-assets(?:\/|$)/u.test(url.pathname) ||
      /\/v2\/point\//u.test(url.pathname)
    ) {
      forbiddenRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => {
    if (/\/api\/v1\//u.test(new URL(socket.url()).pathname)) forbiddenSockets.push(socket.url());
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/live.html#lab-investigation');
  await expect(page).toHaveURL(/#lab-investigation$/u);
  await expect(page).toHaveTitle('Investigation | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('heading', { name: 'Investigation', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(6);
  const investigationTab = page.getByRole('tab', { name: 'Investigation', exact: true });
  await expect(investigationTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: 'Diagnostics Lab', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('#investigation-status')).toHaveText('Not run');
  await expect(page.getByRole('combobox', { name: 'Synthetic scenario' })).toHaveValue(
    'gradual-drift',
  );
  await expect(page.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('3101');
  await expect(page.getByRole('spinbutton', { name: 'Samples', exact: true })).toHaveValue('180');
  await expect(page.locator('#investigation-replay-position')).toContainText('0 / 0');
  await expect(
    page.getByRole('button', { name: 'Export minimized investigation JSON' }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Capture comparison baseline' })).toBeDisabled();

  const initialNetwork = await page.evaluate(() => {
    const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
      .configurationNetworkProbe;
    return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
  });

  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-status')).toHaveText('Analysis failed');
  await expect(page.getByRole('alert')).toContainText(
    'Investigation seed must be between 1 and 2147483647.',
  );
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  const investigationTemporalToggle = page.getByRole('checkbox', {
    name: 'Enable experimental temporal hypotheses',
  });
  const investigationPointwiseToggle = page.getByRole('checkbox', {
    name: 'Enable experimental pointwise comparison',
  });
  await expect(investigationTemporalToggle).toBeEnabled();
  await investigationTemporalToggle.check();
  await page.locator('#profile-select').selectOption(genericFixedWingProfile.id);
  await page.getByRole('button', { name: 'Generate synthetic demo', exact: true }).click();
  await expect(page.locator('#metric-accepted')).toHaveText('240');
  await expect(investigationPointwiseToggle).toBeEnabled();
  await investigationPointwiseToggle.check();
  await investigationTab.click();
  await expect(page).toHaveURL(/#lab-investigation$/u);
  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('3101');
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-status')).toContainText(/rule indications/u);
  await expect(page.locator('#investigation-replay-position')).toContainText(/\d+ \/ 180/u);
  await expect(page.getByRole('img', { name: /Investigation .* chart/u })).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(2);
  await expect(
    page.getByText('Expected, observed, predicted and estimated', { exact: true }),
  ).toBeVisible();
  const projectedState = page.getByRole('region', {
    name: 'Expected, observed, predicted and estimated',
  });
  for (const label of [
    'Expected altitude',
    'Observed altitude',
    'Predicted altitude',
    'Estimated altitude',
  ]) {
    await expect(projectedState.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByText('Deterministic rules | authoritative', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Robust covariance | advisory', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Kalman innovation | supporting evidence', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Temporal model | advisory', { exact: true })).toBeVisible();
  await expect(page.locator('#investigation-temporal-activation-state')).toHaveText('Active');
  await expect(page.locator('#investigation-robust-activation-state')).toHaveText('Active');
  await page.locator('#investigation-replay-slider').fill('50');
  await expect(page.locator('#investigation-model-confidence')).not.toHaveText(/Warmup|Disabled/u);

  const stateChart = page.getByRole('img', { name: /observed and predicted state chart/u });
  await stateChart.focus();
  await page.keyboard.press('End');
  await expect(page.locator('#investigation-replay-position')).toContainText('180 / 180');
  await page.keyboard.press('Home');
  await expect(page.locator('#investigation-replay-position')).toContainText('1 / 180');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#investigation-replay-position')).toContainText('11 / 180');

  await page.getByRole('button', { name: 'Capture comparison baseline' }).click();
  await expect(page.locator('#investigation-comparison-status')).toContainText('Overlay active');
  await page.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('3102');
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-status')).toContainText(/rule indications/u);
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'baseline gradual-drift, seed 3101, versus current gradual-drift, seed 3102',
  );
  await expect(page.locator('#investigation-comparison-overlay')).toBeEnabled();
  await expect(page.locator('#investigation-comparison-overlay')).toBeChecked();

  await page.getByRole('spinbutton', { name: 'Samples', exact: true }).fill('60');
  await page.getByRole('button', { name: 'Run investigation', exact: true }).click();
  await expect(page.locator('#investigation-replay-position')).toContainText(/\d+ \/ 60/u);
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'Sample count differs: baseline 180, current 60.',
  );
  await expect(page.locator('#investigation-comparison-overlay')).toBeDisabled();

  const report = await downloadInvestigationReport(page);
  expect(report).toMatchObject({
    reportSchemaVersion: 'investigation-report.v1',
    dataBoundary: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      generatorSchemaVersion: 'temporal-synthetic.v1',
    },
    scenarioReproduction: {
      scenarioId: 'gradual-drift',
      seed: 3102,
      sampleCount: 60,
      cadenceMs: 1_000,
    },
    results: { authority: 'deterministic-rules' },
    models: {
      temporalModel: {
        userSelection: 'enabled',
        supported: true,
        eligible: true,
        active: true,
        authority: 'deterministic-rules',
      },
      robustCovariance: {
        userSelection: 'enabled',
        supported: true,
        eligible: true,
        active: true,
        authority: 'deterministic-rules',
      },
    },
    exportPolicy: {
      sourceDataIncluded: false,
      samplesIncluded: false,
      pointsIncluded: false,
      seriesIncluded: false,
      measurementsIncluded: false,
      truthIncluded: false,
      perSampleLabelsIncluded: false,
      browserStateIncluded: false,
      endpointsIncluded: false,
    },
  });
  const reportText = JSON.stringify(report);
  for (const forbidden of ['"samples"', '"points"', '"series"', '"measurements"', '"truth"']) {
    expect(reportText).not.toContain(forbidden);
  }
  expect(
    await page.evaluate(() => {
      const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
        .configurationNetworkProbe;
      return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
    }),
  ).toEqual(initialNetwork);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageHorizontalOverflow(page);
  const populatedAxe = await new AxeBuilder({ page }).analyze();
  expect(
    populatedAxe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-investigation-populated-mobile.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoPageHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoPageHorizontalOverflow(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-investigation$/u);
  await expect(page.locator('#investigation-replay-position')).toContainText(/\d+ \/ 60/u);
  await expect(page.locator('#investigation-comparison-status')).toContainText(
    'Sample count differs: baseline 180, current 60.',
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(2);
  await page.goForward();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-investigation$/u);

  await page.reload();
  await expect(page).toHaveURL(/#lab-investigation$/u);
  await expect(page.locator('#investigation-status')).toHaveText('Not run');
  await expect(page.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('3101');
  await expect(page.getByRole('spinbutton', { name: 'Samples', exact: true })).toHaveValue('180');
  await expect(page.locator('#investigation-comparison-status')).toHaveText(
    'No comparison baseline captured.',
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
    )
    .toBe(0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  await expect(page).toHaveURL(/#lab-main$/u);
  await expect(investigationTab).toHaveAttribute('aria-selected', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-investigation-mobile.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoPageHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoPageHorizontalOverflow(page);
  await expect(investigationTab).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(forbiddenRequests).toEqual([]);
  expect(forbiddenSockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('React Campaign proves bounded Worker execution, minimized aggregate evidence and route-scoped cleanup', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const forbiddenSockets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      /\/api\/v1\/(?:airspace|health|regions)(?:\/|$)/u.test(url.pathname) ||
      /\/map-assets(?:\/|$)/u.test(url.pathname) ||
      /\/v2\/point\//u.test(url.pathname)
    ) {
      forbiddenRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => {
    if (/\/api\/v1\//u.test(new URL(socket.url()).pathname)) forbiddenSockets.push(socket.url());
  });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/live.html#lab-campaign');
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(page).toHaveTitle('Campaign | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('heading', { name: 'Campaign', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(6);
  expect(await page.getByRole('tab').allTextContents()).toEqual([
    'Monitor',
    'Diagnostics',
    'Verification',
    'Investigation',
    'Campaign',
    'Configuration',
  ]);
  const campaignTab = page.getByRole('tab', { name: 'Campaign', exact: true });
  await expect(campaignTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: 'Diagnostics Lab', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const seeds = page.getByRole('textbox', { name: 'Deterministic seeds', exact: true });
  const run = page.getByRole('button', { name: 'Run Campaign', exact: true });
  const status = page.locator('#campaign-status');
  const progress = page.locator('#campaign-progress-label');
  await expect(seeds).toHaveValue('3101, 3102, 3103');
  await expect(page.locator('#campaign-matrix-preview')).toHaveText(
    '3 seeds × 31 scenarios = 93 planned cases',
  );
  await expect(status).toHaveText('Not run');
  await expect(progress).toHaveText('Processed 0 of 93');
  await expect(run).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Export minimized Campaign JSON', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => ({
      active: (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers(),
      starts: (window as unknown as ProbedWindow).labResourceProbe.campaignWorkerStarts(),
    })),
  ).toEqual({ active: 0, starts: 0 });

  await campaignTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect(page.getByRole('tab', { name: 'Configuration', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goBack();
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(campaignTab).toHaveAttribute('aria-selected', 'true');

  const initialNetwork = await page.evaluate(() => {
    const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
      .configurationNetworkProbe;
    return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
  });
  await seeds.fill('3101, 3101');
  await expect(page.locator('#campaign-matrix-preview')).toContainText('Configuration issue:');
  await expect(page.locator('.lab-inline-warning')).toContainText('Campaign seeds must be unique.');
  await expect(run).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbedWindow).labResourceProbe.campaignWorkerStarts(),
    ),
  ).toBe(0);

  const maximumSeeds = Array.from({ length: 12 }, (_, index) => String(3101 + index)).join(', ');
  await seeds.fill(maximumSeeds);
  await expect(page.locator('#campaign-matrix-preview')).toHaveText(
    '12 seeds × 31 scenarios = 372 planned cases',
  );
  await run.click();
  await expect(status).toHaveAttribute('data-phase', 'running');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers()),
    )
    .toBe(1);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbedWindow).labResourceProbe.campaignWorkerStarts(),
    ),
  ).toBe(1);
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers()),
    )
    .toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(status).toHaveAttribute('data-phase', 'stopped');
  await expect(status).toHaveText('Stopped without partial evidence');
  await expect(page.locator('.lab-inline-warning')).toContainText(
    'The active worker was terminated before verified partial evidence was returned.',
  );

  await seeds.fill('3101');
  await expect(page.locator('#campaign-matrix-preview')).toHaveText(
    '1 seeds × 31 scenarios = 31 planned cases',
  );
  await run.click();
  await expect(status).toHaveAttribute('data-phase', 'completed', { timeout: 30_000 });
  await expect(status).toHaveText('Completed');
  await expect(progress).toHaveText('Processed 31 of 31');
  await expect(page.locator('#campaign-progress')).toHaveAttribute('value', '31');
  await expect(page.locator('#campaign-progress')).toHaveAttribute('max', '31');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers()),
    )
    .toBe(0);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbedWindow).labResourceProbe.campaignWorkerStarts(),
    ),
  ).toBe(2);

  const outcome = page.locator('.lab-investigation-summary');
  await expect(outcome).toContainText(/Planned\s*31/u);
  await expect(outcome).toContainText(/Attempted\s*31/u);
  await expect(outcome).toContainText(/Completed\s*31/u);
  await expect(outcome).toContainText(/Failed\s*0/u);
  await expect(outcome).toContainText(/Remaining\s*0/u);
  const metrics = page.locator('.lab-campaign-metrics');
  await expect(metrics).toContainText('Matched opportunities');
  await expect(metrics).toContainText('Episode precision');
  await expect(metrics).toContainText('False alarms per synthetic hour');
  await expect(metrics).toContainText('Calibration observations');
  await expect(metrics).toContainText('Bootstrap intervals');
  await expect(
    page
      .getByRole('region', { name: 'Campaign scenario coverage table', exact: true })
      .locator('tbody tr'),
  ).toHaveCount(31);
  await expect(
    page
      .getByRole('region', { name: 'Campaign confusion by phase', exact: true })
      .locator('tbody tr'),
  ).not.toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Campaign confusion by scenario', exact: true })
      .locator('tbody tr'),
  ).not.toHaveCount(0);
  await expect(page.locator('.lab-campaign-failures')).toContainText('No contained case failures.');
  const identityValues = page.locator('.lab-campaign-identity dd');
  await expect(identityValues.nth(0)).not.toHaveText('Unavailable');
  await expect(identityValues.nth(1)).not.toHaveText('Unavailable');
  await expect(identityValues.nth(2)).toHaveText(/^[a-f0-9]{64}$/u);
  const retainedSpecSha = await identityValues.nth(2).textContent();

  const report = await downloadCampaignReport(page);
  expect(report).toMatchObject({
    reportSchemaVersion: 'campaign-report.v1',
    dataBoundary: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      campaignSchemaVersion: 'campaign.v1',
    },
    reproduction: {
      profile: { profileId: 'generic-fixed-wing', profileVersion: '1.0.0' },
      seeds: [3101],
      matrix: { seedCount: 1, scenarioCount: 31, plannedCases: 31 },
      generator: { sampleCount: 180, cadenceMs: 1_000, syntheticDurationMs: 179_000 },
      bootstrap: { iterations: 300, confidenceLevel: 0.95, seed: 22_072 },
    },
    terminal: {
      status: 'completed',
      summary: {
        plannedCases: 31,
        attemptedCases: 31,
        completedCases: 31,
        failedCases: 0,
        remainingCases: 0,
      },
    },
    decisionPolicy: {
      authority: 'deterministic-rules',
      temporalCalibrationRole: 'advisory-only',
      temporalArtifactIdentityBound: false,
      verificationLabelsAuthoritativeInputs: false,
    },
  });
  expect(report.reproduction.variations).toHaveLength(3);
  expect(report.metrics.scenarioCoverage).toHaveLength(31);
  expect(report.metrics.confusion.truePositives).toBeGreaterThan(0);
  expect(report.failedCaseSummaries).toEqual([]);
  expect(Object.values(report.exportPolicy).every((included) => included === false)).toBe(true);
  const reportText = JSON.stringify(report);
  for (const forbiddenKey of [
    'cases',
    'samples',
    'points',
    'series',
    'measurements',
    'successfulCaseRows',
    'detections',
    'detectionDetails',
    'sensorIds',
    'sampleIndices',
    'calibrationObservations',
    'replayManifest',
    'truth',
    'lifecycleRows',
    'browserState',
    'storage',
    'endpoints',
  ]) {
    expect(reportText).not.toContain(`"${forbiddenKey}":`);
  }

  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers(),
    ),
  ).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(status).toHaveText('Completed');
  await expect(progress).toHaveText('Processed 31 of 31');
  await expect(identityValues.nth(2)).toHaveText(retainedSpecSha!);
  await page.goForward();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(status).toHaveText('Completed');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageHorizontalOverflow(page);
  const populatedAxe = await new AxeBuilder({ page }).analyze();
  expect(
    populatedAxe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('lab-campaign-mobile.png'), fullPage: true });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoPageHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoPageHorizontalOverflow(page);
  await expect(campaignTab).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => {
      const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
        .configurationNetworkProbe;
      return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
    }),
  ).toEqual(initialNetwork);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });

  await page.reload();
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(status).toHaveText('Not run');
  await expect(seeds).toHaveValue('3101, 3102, 3103');
  await expect(progress).toHaveText('Processed 0 of 93');
  expect(
    await page.evaluate(() => ({
      active: (window as unknown as ProbedWindow).labResourceProbe.campaignWorkers(),
      starts: (window as unknown as ProbedWindow).labResourceProbe.campaignWorkerStarts(),
    })),
  ).toEqual({ active: 0, starts: 0 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  await expect(page).toHaveURL(/#lab-main$/u);
  await expect(campaignTab).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(forbiddenRequests).toEqual([]);
  expect(forbiddenSockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('React Configuration proves exact contracts, explicit model intent, zero-network simulation, minimized export and lifecycle cleanup', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const forbiddenSockets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      /\/api\/v1\/(?:airspace|health|regions)(?:\/|$)/u.test(url.pathname) ||
      /\/map-assets(?:\/|$)/u.test(url.pathname) ||
      /\/v2\/point\//u.test(url.pathname)
    ) {
      forbiddenRequests.push(request.url());
    }
  });
  page.on('websocket', (socket) => {
    if (/\/api\/v1\//u.test(new URL(socket.url()).pathname)) forbiddenSockets.push(socket.url());
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/live.html#lab-configuration');
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect(page).toHaveTitle('Configuration | Diagnostics Lab | Flight Diagnostics Workbench');
  await expect(page.getByRole('heading', { name: 'Configuration', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(6);
  const configurationTab = page.getByRole('tab', { name: 'Configuration', exact: true });
  await expect(configurationTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: 'Diagnostics Lab', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('#config-app-version')).toHaveText('2.2.0');
  await expect(page.locator('#config-schema')).toHaveText('telemetry.v1');
  await expect(page.locator('#config-adapter')).toHaveText('legacy-csv@2.0.0');
  await expect(page.locator('#config-profile')).toHaveText('Included Baseline');
  await expect(page.locator('#config-profile-version')).toHaveText('1.0.0');
  await expect(page.locator('#config-hash')).toHaveText(
    'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
  );
  await expect(page.locator('#rule-count')).toHaveText('12');
  await expect(page.locator('#rules-body tr')).toHaveCount(12);
  await expect(page.getByText('Inspect field and unit mappings', { exact: true })).toBeVisible();
  await configurationTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#lab-monitor$/u);
  await expect(page.getByRole('tab', { name: 'Monitor', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.goBack();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect(configurationTab).toHaveAttribute('aria-selected', 'true');

  const temporalToggle = page.getByRole('checkbox', {
    name: 'Enable experimental temporal hypotheses',
  });
  const pointwiseToggle = page.getByRole('checkbox', {
    name: 'Enable experimental pointwise comparison',
  });
  await expect(temporalToggle).not.toBeChecked();
  await expect(pointwiseToggle).not.toBeChecked();
  await expect(temporalToggle).toBeEnabled();
  await expect(page.locator('#temporal-model-state')).toHaveText('Supported, user disabled');
  await temporalToggle.check();
  await expect(page.locator('#temporal-model-state')).toHaveText('Supported and active');

  await page.locator('#profile-select').selectOption(genericFixedWingProfile.id);
  await page.getByRole('button', { name: 'Generate synthetic demo', exact: true }).click();
  await expect(page.locator('#metric-accepted')).toHaveText('240');
  await expect(page.locator('#config-profile')).toHaveText(genericFixedWingProfile.label);
  await expect(pointwiseToggle).toBeEnabled();
  await expect(page.locator('#model-state')).toHaveText('Supported, user disabled');
  await pointwiseToggle.check();
  await expect(page.locator('#model-state')).toHaveText('Supported and active');
  await expect(page.locator('#model-score')).toContainText('active advisory');

  const initialNetwork = await page.evaluate(() => {
    const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
      .configurationNetworkProbe;
    return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
  });
  await expect(page.getByRole('button', { name: 'Stop simulator', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Run in-browser demo', exact: true }).click();
  await expect(page.locator('#stream-state')).toContainText(/Demo active|Demo degraded/u);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.simulatorTimers()),
    )
    .toBe(2);
  await expect
    .poll(async () => Number(await page.locator('#health-messages').textContent()))
    .toBeGreaterThan(4);
  const retainedMessageCount = Number(await page.locator('#health-messages').textContent());
  await page.getByRole('button', { name: 'Stop simulator', exact: true }).click();
  await expect(page.locator('#stream-state')).toHaveText('Stopped');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.simulatorTimers()),
    )
    .toBe(0);
  expect(
    await page.evaluate(() => {
      const probe = (window as unknown as { configurationNetworkProbe: ConfigurationNetworkProbe })
        .configurationNetworkProbe;
      return { fetches: probe.fetchCalls(), sockets: probe.socketCalls() };
    }),
  ).toEqual(initialNetwork);

  const report = await downloadConfigurationReport(page);
  expect(report).toMatchObject({
    reportSchemaVersion: 'configuration-report.v1',
    buildIdentities: {
      deterministicEngine: {
        applicationVersion: '2.2.0',
        authority: 'deterministic-rules',
      },
    },
    run: {
      state: 'ready',
      counts: { acceptedRecords: 240, quarantinedRecords: 0 },
    },
    selectedAnalysisProfile: {
      id: genericFixedWingProfile.id,
      version: genericFixedWingProfile.version,
    },
    simulator: {
      phase: 'stopped',
      aggregateTotals: { sourceCount: 2, receivedMessages: retainedMessageCount },
    },
    exportPolicy: { sourceDataIncluded: false, streamPayloadsIncluded: false },
  });
  expect(report.selectedAnalysisProfile.rules).toHaveLength(8);
  expect(report.models.find((model) => model.family === 'robust-covariance')).toMatchObject({
    activationPurpose: 'integrated-advisory',
    userSelection: 'enabled',
    supported: true,
    eligibility: 'eligible',
    active: true,
    authority: 'deterministic-rules',
  });
  expect(report.models.find((model) => model.key.endsWith('@2.0.0'))).toMatchObject({
    family: 'temporal',
    activationPurpose: 'integrated-advisory',
    userSelection: 'enabled',
    active: true,
  });
  expect(report).not.toHaveProperty('sources');
  expect(report).not.toHaveProperty('sourceHealth');
  expect(report).not.toHaveProperty('payloads');
  expect(report).not.toHaveProperty('measurements');
  expect(JSON.stringify(report)).not.toContain('demo-alpha');
  expect(JSON.stringify(report)).not.toContain('demo-bravo');

  await page.getByRole('tab', { name: 'Verification', exact: true }).click();
  await expect(page).toHaveURL(/#lab-verification$/u);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.simulatorTimers()),
    )
    .toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect(page.locator('#stream-state')).toHaveText('Stopped');
  await expect(page.locator('#health-messages')).toHaveText(String(retainedMessageCount));
  await expect(pointwiseToggle).toBeChecked();
  await expect(temporalToggle).toBeChecked();
  await page.goForward();
  await expect(page).toHaveURL(/#lab-verification$/u);
  await page.goBack();
  await expect(page).toHaveURL(/#lab-configuration$/u);

  await page.reload();
  await expect(page).toHaveURL(/#lab-configuration$/u);
  await expect(page.locator('#stream-state')).toHaveText('Not started');
  await expect(temporalToggle).not.toBeChecked();
  await expect(pointwiseToggle).not.toBeChecked();
  await expect(page.locator('#metric-accepted')).toHaveText('85');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  await expect(page).toHaveURL(/#lab-main$/u);
  await expect(configurationTab).toHaveAttribute('aria-selected', 'true');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageHorizontalOverflow(page);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('lab-configuration-mobile.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await expectNoPageHorizontalOverflow(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expectNoPageHorizontalOverflow(page);
  await expect(configurationTab).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(forbiddenRequests).toEqual([]);
  expect(forbiddenSockets).toEqual([]);
  expect(errors).toEqual([]);
});

test('repeated Live and Lab navigation retains in-memory data and releases real charts, timers and sockets', async ({
  page,
}) => {
  const errors: string[] = [];
  const sockets = new Set<string>();
  page.on('pageerror', (error) => errors.push(error.message));
  let socketId = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/v1/airspace/')) return;
    const id = String(++socketId);
    sockets.add(id);
    socket.on('close', () => sockets.delete(id));
  });
  await page.goto('/live.html#lab');
  await golden(page);
  await page.getByLabel('Detection profile').selectOption(genericRotaryWingProfile.id);
  await page.getByRole('button', { name: 'Generate synthetic demo', exact: true }).click();
  await expect(page.locator('#metric-accepted')).toHaveText('240');
  await page
    .getByRole('checkbox', { name: 'Include source samples and raw rows in the JSON report' })
    .check();
  const hash = await page.locator('#metric-hash').textContent();
  await page.getByRole('slider', { name: /Selected sample/ }).fill('42');
  await page.getByLabel('Replay pace').selectOption('150');
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole('button', { name: 'Start replay', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.replayTimers()),
      )
      .toBe(1);
    await expect(page.locator('#lab-replay-position')).not.toHaveText('43 / 240');
    await page.getByRole('link', { name: 'Live Airspace', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Atlanta airspace', exact: true }),
    ).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await expect.poll(() => sockets.size).toBe(1);
    expect(
      await page.evaluate(() =>
        (window as unknown as ProbedWindow).labResourceProbe.labObservers(),
      ),
    ).toBe(0);
    expect(
      await page.evaluate(() =>
        (window as unknown as ProbedWindow).labResourceProbe.replayTimers(),
      ),
    ).toBe(0);
    await page.getByRole('link', { name: 'Diagnostics Lab', exact: true }).click();
    await expect(page.locator('#metric-accepted')).toHaveText('240');
    await expect(page.locator('#metric-hash')).toHaveText(hash!);
    await expect(page.getByLabel('Detection profile')).toHaveValue(genericRotaryWingProfile.id);
    await expect(
      page.getByRole('checkbox', {
        name: 'Include source samples and raw rows in the JSON report',
      }),
    ).toBeChecked();
    await expect.poll(() => sockets.size).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as ProbedWindow).labResourceProbe.labObservers()),
      )
      .toBe(3);
    expect(
      await page.evaluate(() =>
        (window as unknown as ProbedWindow).labResourceProbe.replayTimers(),
      ),
    ).toBe(0);
    await expect(page.getByRole('button', { name: 'Start replay', exact: true })).toBeEnabled();
    await page.getByRole('slider', { name: /Selected sample/ }).fill('42');
  }
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  await page.reload();
  await golden(page);
  await expect(
    page.getByRole('checkbox', { name: 'Include source samples and raw rows in the JSON report' }),
  ).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('Back navigation, first-Tab skip links, mobile reflow and accessibility preserve the active workspace', async ({
  page,
}, testInfo) => {
  await page.goto('/live.html');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const liveUrl = page.url();
  expect(new URL(liveUrl).hash).toBe('');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to airspace workspace' })).toBeFocused();
  await page.getByRole('link', { name: 'Diagnostics Lab', exact: true }).click();
  await golden(page);
  await page.goBack();
  await expect(page).toHaveURL(liveUrl);
  await expect(page.getByRole('heading', { name: 'Atlanta airspace', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/live.html#lab');
  await page.reload();
  await golden(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to Lab workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#lab-main')).toBeFocused();
  await expect(page).toHaveURL(/#lab-main$/);
  await golden(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Load included baseline', exact: true }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('lab-react-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            right: element.getBoundingClientRect().right,
            text: element.textContent?.slice(0, 80),
          })),
      ),
    )
    .toEqual([]);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Start replay', exact: true })).toBeVisible();
});
