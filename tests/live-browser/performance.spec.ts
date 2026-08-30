import { expect, test, type Page } from '@playwright/test';

import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { LIVE_TEST_HTTP_ORIGIN } from './testOrigin';

const PERFORMANCE_LIMITS = RUNTIME_POLICY_LIMITS.browser.performance;
const PAINT_AIRCRAFT = RUNTIME_POLICY_LIMITS.history.maximumAircraft;
const MAXIMUM_AIRCRAFT = RUNTIME_POLICY_LIMITS.protocol.maximumAircraft;
const HISTORY_RECEIPTS = RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft;
const QUALITY_EVENTS = RUNTIME_POLICY_LIMITS.history.maximumQualityEvents;
const PAINT_ITERATIONS = PERFORMANCE_LIMITS.paintIterations;
const PAINT_WARMUPS = PERFORMANCE_LIMITS.paintWarmups;
const PAINT_P95_LIMIT_MS = Object.freeze({
  'performance-desktop': PERFORMANCE_LIMITS.paintP95Ms.desktop,
  'performance-mobile': PERFORMANCE_LIMITS.paintP95Ms.mobile,
});
const INTERACTION_LIMIT_MS = Object.freeze({
  'performance-desktop': PERFORMANCE_LIMITS.interactionLimitMs.desktop,
  'performance-mobile': PERFORMANCE_LIMITS.interactionLimitMs.mobile,
});
const BROWSER_JS_HEAP_LIMIT_BYTES = PERFORMANCE_LIMITS.browserJsHeapBytes;
const AGE_TICK_JS_HEAP_GROWTH_LIMIT_BYTES = PERFORMANCE_LIMITS.ageTickJsHeapGrowthBytes;
const TRANSFER_LIMIT_BYTES = PERFORMANCE_LIMITS.responseBodyBytes;
const AGE_TICK_LIMIT_MS = Object.freeze({
  'performance-desktop': PERFORMANCE_LIMITS.ageTickLimitMs.desktop,
  'performance-mobile': PERFORMANCE_LIMITS.ageTickLimitMs.mobile,
});

interface PaintResult {
  recordCount: number;
  sequence: number;
  durationMs: number;
  validationDurationMs: number;
  wireBytes: number;
  historyAircraft: number;
  minimumHistorySamples: number;
  maximumHistorySamples: number;
  historiesAtMaximum: number;
  qualityEvents: number;
}

interface MaximumPreparationResult {
  qualityReceipts: number;
  qualityEventsGenerated: number;
  qualityTailWindowVerified: boolean;
  historyReceipts: number;
  totalReceipts: number;
  durationMs: number;
  historyAircraft: number;
  minimumHistorySamples: number;
  maximumHistorySamples: number;
  historiesAtMaximum: number;
  qualityEvents: number;
}

interface BrowserGuard {
  externalRequestCount: number;
  webSocketCount: number;
  pageErrorCount: number;
}

interface NetworkBodyCounter {
  navigation: number;
  script: number;
  style: number;
  font: number;
  map: number;
  other: number;
  responseCount: number;
  unmeasuredResponseCount: number;
}

interface HarnessSession {
  readonly guard: BrowserGuard;
  readonly network: NetworkBodyCounter;
}

async function openHarness(page: Page): Promise<HarnessSession> {
  const guard: BrowserGuard = {
    externalRequestCount: 0,
    webSocketCount: 0,
    pageErrorCount: 0,
  };
  const network: NetworkBodyCounter = {
    navigation: 0,
    script: 0,
    style: 0,
    font: 0,
    map: 0,
    other: 0,
    responseCount: 0,
    unmeasuredResponseCount: 0,
  };
  page.context().on('response', (response) => {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== LIVE_TEST_HTTP_ORIGIN) return;
    network.responseCount += 1;
    const request = response.request();
    const contentLength = response.headers()['content-length'];
    const hasNoBody = request.method() === 'HEAD' || [204, 304].includes(response.status());
    if (!hasNoBody && (contentLength === undefined || !/^\d+$/u.test(contentLength))) {
      network.unmeasuredResponseCount += 1;
      return;
    }
    const bytes = hasNoBody ? 0 : Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      network.unmeasuredResponseCount += 1;
      return;
    }
    const resourceType = request.resourceType();
    if (resourceType === 'document') network.navigation += bytes;
    else if (url.pathname.startsWith('/map-assets/')) network.map += bytes;
    else if (/\.(?:woff2?|ttf|otf)$/u.test(url.pathname)) network.font += bytes;
    else if (/\.css$/u.test(url.pathname)) network.style += bytes;
    else if (/\.js$/u.test(url.pathname) || ['script', 'worker'].includes(resourceType)) {
      network.script += bytes;
    } else network.other += bytes;
  });
  await page.route('**/*', async (route) => {
    let allowed: boolean;
    try {
      allowed = new URL(route.request().url()).origin === LIVE_TEST_HTTP_ORIGIN;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      guard.externalRequestCount += 1;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('websocket', () => {
    guard.webSocketCount += 1;
  });
  page.on('pageerror', () => {
    guard.pageErrorCount += 1;
  });
  await page.goto('/tests/live-browser/performance-harness.html');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          banner: document
            .querySelector('.source-banner')
            ?.textContent?.includes('Local synthetic'),
          mapReady:
            document.querySelector('.map-stage')?.getAttribute('data-map-status') === 'ready',
          harnessReady: window.flightPerformanceHarness !== undefined,
        })),
      { timeout: 30_000 },
    )
    .toEqual({ banner: true, mapReady: true, harnessReady: true });
  expect(guard).toEqual({ externalRequestCount: 0, webSocketCount: 0, pageErrorCount: 0 });
  return { guard, network };
}

async function renderSnapshot(
  page: Page,
  recordCount: typeof PAINT_AIRCRAFT | typeof MAXIMUM_AIRCRAFT,
): Promise<PaintResult> {
  return page.evaluate(async (count) => {
    const harness = window.flightPerformanceHarness;
    if (!harness) throw new Error('Performance harness is unavailable.');
    return harness.renderSnapshot(count);
  }, recordCount);
}

async function prepareMaximumHistory(page: Page): Promise<MaximumPreparationResult> {
  return page.evaluate(async () => {
    const harness = window.flightPerformanceHarness;
    if (!harness) throw new Error('Performance harness is unavailable.');
    return harness.prepareMaximumHistory();
  });
}

async function runAgeTick(page: Page) {
  return page.evaluate(async () => {
    const harness = window.flightPerformanceHarness;
    if (!harness) throw new Error('Performance harness is unavailable.');
    return harness.ageTick();
  });
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function projectLimit<T extends Record<string, number>>(limits: T, projectName: string): number {
  const value = limits[projectName];
  expect(value, `Unknown performance project ${projectName}`).toBeDefined();
  return value!;
}

test('500-aircraft validated snapshots reach a stable linked paint within the p95 budget', async ({
  page,
}, testInfo) => {
  const { guard, network } = await openHarness(page);
  for (let index = 0; index < PAINT_WARMUPS; index += 1) {
    await renderSnapshot(page, PAINT_AIRCRAFT);
  }
  const paints: number[] = [];
  const validations: number[] = [];
  const wireBytes: number[] = [];
  for (let index = 0; index < PAINT_ITERATIONS; index += 1) {
    const result = await renderSnapshot(page, PAINT_AIRCRAFT);
    expect(result.recordCount).toBe(PAINT_AIRCRAFT);
    expect(result.historyAircraft).toBe(PAINT_AIRCRAFT);
    expect(result.minimumHistorySamples).toBe(index + PAINT_WARMUPS + 1);
    expect(result.maximumHistorySamples).toBe(index + PAINT_WARMUPS + 1);
    expect(result.historiesAtMaximum).toBe(0);
    expect(result.qualityEvents).toBe(0);
    paints.push(result.durationMs);
    validations.push(result.validationDurationMs);
    wireBytes.push(result.wireBytes);
  }
  const pageState = await page.evaluate(
    (expectedAircraft) => ({
      rowCount: document.querySelectorAll('.aircraft-link').length,
      shownExpected: document
        .querySelector('.observation-heading')
        ?.textContent?.includes(`${expectedAircraft} shown`),
      mapReady: document.querySelector('.map-stage')?.getAttribute('data-map-status') === 'ready',
    }),
    PAINT_AIRCRAFT,
  );
  expect(pageState).toEqual({ rowCount: PAINT_AIRCRAFT, shownExpected: true, mapReady: true });
  const limitMs = projectLimit(PAINT_P95_LIMIT_MS, testInfo.project.name);
  const p95Ms = percentile95(paints);
  const validationP95Ms = percentile95(validations);
  const coldResponseBodies = {
    ...network,
    total:
      network.navigation +
      network.script +
      network.style +
      network.font +
      network.map +
      network.other,
  };
  expect(coldResponseBodies.responseCount).toBeGreaterThan(0);
  expect(coldResponseBodies.unmeasuredResponseCount).toBe(0);
  expect(coldResponseBodies.script).toBeGreaterThan(0);
  expect(coldResponseBodies.style).toBeGreaterThan(0);
  expect(coldResponseBodies.font).toBeGreaterThan(0);
  expect(coldResponseBodies.map).toBeGreaterThan(0);
  expect(coldResponseBodies.navigation).toBeGreaterThan(0);
  expect(coldResponseBodies.total).toBeLessThanOrEqual(TRANSFER_LIMIT_BYTES);
  testInfo.annotations.push({
    type: 'performance-evidence',
    description: JSON.stringify({
      case: 'paint-500',
      project: testInfo.project.name,
      samples: paints.length,
      warmups: PAINT_WARMUPS,
      p95Ms,
      limitMs,
      validationP95Ms,
      minimumWireBytes: Math.min(...wireBytes),
      maximumWireBytes: Math.max(...wireBytes),
      browserVersion: page.context().browser()?.version() ?? 'unknown',
      coldNavigationResponseBodyBytes: coldResponseBodies.navigation,
      coldScriptResponseBodyBytes: coldResponseBodies.script,
      coldStyleResponseBodyBytes: coldResponseBodies.style,
      coldFontResponseBodyBytes: coldResponseBodies.font,
      coldMapResponseBodyBytes: coldResponseBodies.map,
      coldOtherResponseBodyBytes: coldResponseBodies.other,
      coldTotalResponseBodyBytes: coldResponseBodies.total,
      coldResponseBodyLimitBytes: TRANSFER_LIMIT_BYTES,
      networkResponseCount: coldResponseBodies.responseCount,
      unmeasuredNetworkResponseCount: coldResponseBodies.unmeasuredResponseCount,
    }),
  });
  expect(p95Ms).toBeLessThanOrEqual(limitMs);
  expect(guard).toEqual({ externalRequestCount: 0, webSocketCount: 0, pageErrorCount: 0 });
});

test('near-limit 2,000-record maximum preserves bounded history and complete keyboard workflows', async ({
  page,
}, testInfo) => {
  const { guard, network } = await openHarness(page);
  const preparation = await prepareMaximumHistory(page);
  expect(preparation.qualityReceipts).toBe(100);
  expect(preparation.qualityEventsGenerated).toBe(250);
  expect(preparation.qualityTailWindowVerified).toBe(true);
  expect(preparation.historyReceipts).toBe(HISTORY_RECEIPTS);
  expect(preparation.totalReceipts).toBe(100 + HISTORY_RECEIPTS);
  expect(preparation.historyAircraft).toBe(PAINT_AIRCRAFT);
  expect(preparation.minimumHistorySamples).toBe(HISTORY_RECEIPTS);
  expect(preparation.maximumHistorySamples).toBe(HISTORY_RECEIPTS);
  expect(preparation.historiesAtMaximum).toBe(PAINT_AIRCRAFT);
  expect(preparation.qualityEvents).toBe(QUALITY_EVENTS);

  const ageTick = await runAgeTick(page);
  const ageTickLimitMs = projectLimit(AGE_TICK_LIMIT_MS, testInfo.project.name);
  expect(ageTick.historiesMapPreserved).toBe(true);
  expect(ageTick.trailsMapPreserved).toBe(true);
  expect(ageTick.historyObjectsPreserved).toBe(true);
  expect(ageTick.sampleArraysPreserved).toBe(true);
  expect(ageTick.historyAircraft).toBe(PAINT_AIRCRAFT);
  expect(ageTick.historySamples).toBe(PAINT_AIRCRAFT * HISTORY_RECEIPTS);
  expect(ageTick.durationMs).toBeLessThanOrEqual(ageTickLimitMs);
  expect(ageTick.jsHeapDeltaBytes).toBeLessThanOrEqual(AGE_TICK_JS_HEAP_GROWTH_LIMIT_BYTES);

  const result = await renderSnapshot(page, MAXIMUM_AIRCRAFT);
  expect(result.recordCount).toBe(MAXIMUM_AIRCRAFT);
  expect(result.historyAircraft).toBe(PAINT_AIRCRAFT);
  expect(result.minimumHistorySamples).toBe(HISTORY_RECEIPTS);
  expect(result.maximumHistorySamples).toBe(HISTORY_RECEIPTS);
  expect(result.historiesAtMaximum).toBe(PAINT_AIRCRAFT);
  expect(result.qualityEvents).toBe(QUALITY_EVENTS);
  expect(result.wireBytes).toBeGreaterThanOrEqual(Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.95));
  expect(result.wireBytes).toBeLessThanOrEqual(MAX_LIVE_MESSAGE_BYTES);
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.aircraft-link').length))
    .toBe(MAXIMUM_AIRCRAFT);

  const interactionDurations: Array<{
    name: 'search' | 'select' | 'sort' | 'close' | 'scroll';
    durationMs: number;
  }> = [];
  const search = page.locator('input[type="search"]');
  await search.focus();
  const searchStartedAt = await page.evaluate(() => performance.now());
  await page.keyboard.type('PX1999');
  expect(searchStartedAt).toBeGreaterThanOrEqual(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const searchInput = document.querySelector('input[type="search"]');
        return {
          count: document.querySelectorAll('.aircraft-link').length,
          focused: searchInput !== null && document.activeElement === searchInput,
          value: searchInput instanceof HTMLInputElement ? searchInput.value : '',
        };
      }),
    )
    .toEqual({ count: 1, focused: true, value: 'PX1999' });
  interactionDurations.push({
    name: 'search',
    durationMs: await page.evaluate((startedAt) => performance.now() - startedAt, searchStartedAt),
  });

  const selectionStartedAt = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
      (candidate) => candidate.textContent?.trim() === 'PX1999',
    );
    if (!button) return -1;
    button.focus();
    return performance.now();
  });
  expect(selectionStartedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => ({
        selected: document.querySelector('.aircraft-link')?.getAttribute('aria-pressed') === 'true',
        investigation:
          document.querySelector('.selection-panel h2')?.textContent?.trim() === 'PX1999',
        receiptRows: document.querySelectorAll('.history-table tbody tr').length,
      })),
    )
    .toEqual({ selected: true, investigation: true, receiptRows: HISTORY_RECEIPTS });
  interactionDurations.push({
    name: 'select',
    durationMs: await page.evaluate(
      (startedAt) => performance.now() - startedAt,
      selectionStartedAt,
    ),
  });

  await search.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.aircraft-link').length))
    .toBe(MAXIMUM_AIRCRAFT);

  const sortStartedAt = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
      (candidate) => candidate.textContent?.includes('Ground speed'),
    );
    if (!button) return -1;
    button.focus();
    return performance.now();
  });
  expect(sortStartedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const values = [
          ...document.querySelectorAll<HTMLTableRowElement>('.table-scroll tbody tr'),
        ].map((row) => Number(row.children[2]?.textContent?.replaceAll(',', '') ?? 'NaN'));
        const speedButton = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
          (button) => button.textContent?.includes('Ground speed'),
        );
        return {
          ascending: speedButton?.closest('th')?.getAttribute('aria-sort') === 'ascending',
          ordered: values.every((value, index) => index === 0 || values[index - 1]! <= value),
          count: values.length,
        };
      }),
    )
    .toEqual({ ascending: true, ordered: true, count: MAXIMUM_AIRCRAFT });
  interactionDurations.push({
    name: 'sort',
    durationMs: await page.evaluate((startedAt) => performance.now() - startedAt, sortStartedAt),
  });

  const closeStartedAt = await page.evaluate(() => {
    const close = [...document.querySelectorAll<HTMLButtonElement>('.selection-panel button')].find(
      (button) => button.textContent?.includes('Close selected track'),
    );
    if (!close) return -1;
    close.focus();
    return performance.now();
  });
  expect(closeStartedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const origin = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
          (button) => button.textContent?.trim() === 'PX1999',
        );
        return {
          selectionClosed:
            document.querySelector('.selection-panel h2')?.textContent?.trim() ===
            'Select an aircraft',
          focusRestored: origin !== undefined && document.activeElement === origin,
        };
      }),
    )
    .toEqual({ selectionClosed: true, focusRestored: true });
  interactionDurations.push({
    name: 'close',
    durationMs: await page.evaluate((startedAt) => performance.now() - startedAt, closeStartedAt),
  });

  const scrollStartedAt = await page.evaluate(() => {
    const table = document.querySelector('.table-scroll');
    if (!(table instanceof HTMLElement)) return -1;
    table.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
    table.focus();
    return performance.now();
  });
  expect(scrollStartedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('PageDown');
  await expect
    .poll(() =>
      page.evaluate(() =>
        Math.max(document.querySelector('.table-scroll')?.scrollTop ?? 0, window.scrollY),
      ),
    )
    .toBeGreaterThan(0);
  interactionDurations.push({
    name: 'scroll',
    durationMs: await page.evaluate((startedAt) => performance.now() - startedAt, scrollStartedAt),
  });

  const aggregate = await page.evaluate(async () => {
    const table = document.querySelector('.table-scroll');
    const measuredPerformance = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    return {
      rowCount: document.querySelectorAll('.aircraft-link').length,
      mapReady: document.querySelector('.map-stage')?.getAttribute('data-map-status') === 'ready',
      tableFocused: table instanceof HTMLElement && document.activeElement === table,
      tableScrolled: table instanceof HTMLElement && (table.scrollTop > 0 || window.scrollY > 0),
      fitsViewport: document.documentElement.scrollWidth <= window.innerWidth,
      localStorageEntries: localStorage.length,
      sessionStorageEntries: sessionStorage.length,
      cookieBytes: new TextEncoder().encode(document.cookie).byteLength,
      indexedDatabaseCount:
        typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      cacheCount: 'caches' in window ? (await caches.keys()).length : 0,
      serviceWorkerCount:
        'serviceWorker' in navigator
          ? (await navigator.serviceWorker.getRegistrations()).length
          : 0,
      opfsEntryCount: await (async () => {
        const storage = navigator.storage as StorageManager & {
          getDirectory?: () => Promise<{ values(): AsyncIterableIterator<unknown> }>;
        };
        if (!storage.getDirectory) return 0;
        let count = 0;
        const entries = (await storage.getDirectory()).values();
        while (!(await entries.next()).done) count += 1;
        return count;
      })(),
      browserJsHeapBytes: measuredPerformance.memory?.usedJSHeapSize ?? 0,
      limits: window.flightPerformanceHarness?.limits(),
    };
  });
  expect(aggregate.rowCount).toBe(MAXIMUM_AIRCRAFT);
  expect(aggregate.mapReady).toBe(true);
  expect(aggregate.tableFocused).toBe(true);
  expect(aggregate.tableScrolled).toBe(true);
  expect(aggregate.fitsViewport).toBe(true);
  expect(aggregate.localStorageEntries).toBe(0);
  expect(aggregate.sessionStorageEntries).toBe(0);
  expect(aggregate.cookieBytes).toBe(0);
  expect(aggregate.indexedDatabaseCount).toBe(0);
  expect(aggregate.cacheCount).toBe(0);
  expect(aggregate.serviceWorkerCount).toBe(0);
  expect(aggregate.opfsEntryCount).toBe(0);
  expect(aggregate.browserJsHeapBytes).toBeGreaterThan(0);
  expect(aggregate.browserJsHeapBytes).toBeLessThanOrEqual(BROWSER_JS_HEAP_LIMIT_BYTES);
  const resourceResponseBodyBytes =
    network.script + network.style + network.font + network.map + network.other;
  const totalResponseBodyBytes = resourceResponseBodyBytes + network.navigation;
  expect(network.responseCount).toBeGreaterThan(0);
  expect(network.unmeasuredResponseCount).toBe(0);
  expect(resourceResponseBodyBytes).toBeGreaterThan(0);
  expect(network.navigation).toBeGreaterThan(0);
  expect(totalResponseBodyBytes).toBeLessThanOrEqual(TRANSFER_LIMIT_BYTES);
  expect(aggregate.limits).toEqual({
    historyAircraft: PAINT_AIRCRAFT,
    minimumHistorySamples: HISTORY_RECEIPTS,
    maximumHistorySamples: HISTORY_RECEIPTS,
    historiesAtMaximum: PAINT_AIRCRAFT,
    qualityEvents: QUALITY_EVENTS,
  });
  const interactionLimitMs = projectLimit(INTERACTION_LIMIT_MS, testInfo.project.name);
  const interactionByName = Object.fromEntries(
    interactionDurations.map(({ name, durationMs }) => [name, durationMs]),
  ) as Record<(typeof interactionDurations)[number]['name'], number>;
  const maximumInteractionMs = Math.max(
    ...interactionDurations.map(({ durationMs }) => durationMs),
  );
  testInfo.annotations.push({
    type: 'performance-evidence',
    description: JSON.stringify({
      case: 'maximum-2000',
      project: testInfo.project.name,
      qualityPreparationReceipts: preparation.qualityReceipts,
      qualityEventsGenerated: preparation.qualityEventsGenerated,
      qualityEventsRetained: preparation.qualityEvents,
      qualityTailWindowVerified: preparation.qualityTailWindowVerified,
      historyPreparationReceipts: preparation.historyReceipts,
      totalPreparationReceipts: preparation.totalReceipts,
      preparationDurationMs: preparation.durationMs,
      stablePaintMs: result.durationMs,
      validationMs: result.validationDurationMs,
      wireBytes: result.wireBytes,
      wireLimitBytes: MAX_LIVE_MESSAGE_BYTES,
      maximumHistorySamples: result.maximumHistorySamples,
      minimumHistorySamples: result.minimumHistorySamples,
      historiesAtMaximum: result.historiesAtMaximum,
      interactionSamples: interactionDurations.length,
      searchInteractionMs: interactionByName.search,
      selectInteractionMs: interactionByName.select,
      sortInteractionMs: interactionByName.sort,
      closeInteractionMs: interactionByName.close,
      scrollInteractionMs: interactionByName.scroll,
      maximumInteractionMs,
      interactionLimitMs,
      ageTickDurationMs: ageTick.durationMs,
      ageTickLimitMs,
      ageTickJsHeapDeltaBytes: ageTick.jsHeapDeltaBytes,
      ageTickJsHeapGrowthLimitBytes: AGE_TICK_JS_HEAP_GROWTH_LIMIT_BYTES,
      ageTickHistoriesMapPreserved: ageTick.historiesMapPreserved,
      ageTickTrailsMapPreserved: ageTick.trailsMapPreserved,
      ageTickHistoryObjectsPreserved: ageTick.historyObjectsPreserved,
      ageTickSampleArraysPreserved: ageTick.sampleArraysPreserved,
      ageTickHistoryAircraft: ageTick.historyAircraft,
      ageTickHistorySamples: ageTick.historySamples,
      browserJsHeapBytes: aggregate.browserJsHeapBytes,
      browserJsHeapLimitBytes: BROWSER_JS_HEAP_LIMIT_BYTES,
      resourceResponseBodyBytes,
      navigationResponseBodyBytes: network.navigation,
      totalResponseBodyBytes,
      responseBodyLimitBytes: TRANSFER_LIMIT_BYTES,
      networkResponseCount: network.responseCount,
      unmeasuredNetworkResponseCount: network.unmeasuredResponseCount,
      browserVersion: page.context().browser()?.version() ?? 'unknown',
    }),
  });
  for (const interaction of interactionDurations) {
    expect(interaction.durationMs, `${interaction.name} interaction`).toBeLessThanOrEqual(
      interactionLimitMs,
    );
  }
  expect(guard).toEqual({ externalRequestCount: 0, webSocketCount: 0, pageErrorCount: 0 });
});
