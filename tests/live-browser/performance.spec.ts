import { expect, test, type Page } from '@playwright/test';

import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import type {
  MaximumPerformanceFailureStage,
  PerformanceBrowserRuntimeIdentity,
  PerformanceConcurrencyBucket,
  PerformanceRendererClass,
} from '../../tools/live/performanceContract';
import { createMaximumPerformanceFailureEvidence } from '../../tools/live/performanceContract';
import { LIVE_TEST_HTTP_ORIGIN } from './testOrigin';

const PERFORMANCE_LIMITS = RUNTIME_POLICY_LIMITS.browser.performance;
const PAINT_AIRCRAFT = RUNTIME_POLICY_LIMITS.history.maximumAircraft;
const MAXIMUM_AIRCRAFT = RUNTIME_POLICY_LIMITS.protocol.maximumAircraft;
const HISTORY_RECEIPTS = RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft;
const QUALITY_EVENTS = RUNTIME_POLICY_LIMITS.history.maximumQualityEvents;
const PAINT_ITERATIONS = PERFORMANCE_LIMITS.paintIterations;
const PAINT_WARMUPS = PERFORMANCE_LIMITS.paintWarmups;
const PAINT_BLOCKS = PERFORMANCE_LIMITS.paintBlocks;
const PAINT_SAMPLES_PER_BLOCK = PAINT_ITERATIONS / PAINT_BLOCKS;
const CONTROL_SAMPLES_PER_BLOCK = 10;
const INTERACTION_WARMUPS = PERFORMANCE_LIMITS.interactionWarmups;
const INTERACTION_ITERATIONS = PERFORMANCE_LIMITS.interactionIterations;
const PAINT_P95_LIMIT_MS = Object.freeze({
  'performance-desktop': PERFORMANCE_LIMITS.paintP95Ms.desktop,
  'performance-mobile': PERFORMANCE_LIMITS.paintP95Ms.mobile,
});
const INTERACTION_P95_LIMIT_MS = Object.freeze({
  'performance-desktop': PERFORMANCE_LIMITS.interactionP95Ms.desktop,
  'performance-mobile': PERFORMANCE_LIMITS.interactionP95Ms.mobile,
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
  domStableDurationMs: number;
  mapStableDurationMs: number;
  validationDurationMs: number;
  wireBytes: number;
  visualFixtureKey: string;
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
  readonly runtimeIdentity: PerformanceBrowserRuntimeIdentity;
}

type InteractionName = 'search' | 'select' | 'sort' | 'close' | 'scroll';

type InteractionSamples = Record<InteractionName, number[]>;

const INTERACTION_NAMES = ['search', 'select', 'sort', 'close', 'scroll'] as const;

async function captureBrowserRuntimeIdentity(
  page: Page,
): Promise<PerformanceBrowserRuntimeIdentity> {
  const browser = page.context().browser();
  const pageIdentity = await page.evaluate(() => {
    const concurrencyBucket = (value: number): PerformanceConcurrencyBucket => {
      if (value <= 2) return '1-2';
      if (value <= 4) return '3-4';
      if (value <= 8) return '5-8';
      if (value <= 16) return '9-16';
      if (value <= 32) return '17-32';
      return '33+';
    };
    const canvas = document.createElement('canvas');
    const webGl2 = canvas.getContext('webgl2');
    const webGl = webGl2 ?? canvas.getContext('webgl');
    const build = navigator.userAgent.match(/(?:HeadlessChrome|Chrome)\/[\d.]+/u)?.[0] ?? 'unknown';
    if (!Number.isSafeInteger(navigator.hardwareConcurrency) || navigator.hardwareConcurrency < 1) {
      throw new Error('Browser hardware concurrency is unavailable for performance eligibility.');
    }
    if (webGl === null) {
      return {
        browserBuild: build,
        browserConcurrencyBucket: concurrencyBucket(navigator.hardwareConcurrency),
        webGl: {
          context: 'unavailable' as const,
          rendererClass: 'unknown' as const,
        },
      };
    }
    const debug = webGl.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_VENDOR_WEBGL: number;
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const stringParameter = (parameter: number): string | null => {
      const value = webGl.getParameter(parameter) as unknown;
      return typeof value === 'string' ? value.slice(0, 256) : null;
    };
    const rendererText = [
      stringParameter(webGl.VENDOR),
      stringParameter(webGl.RENDERER),
      debug === null ? null : stringParameter(debug.UNMASKED_VENDOR_WEBGL),
      debug === null ? null : stringParameter(debug.UNMASKED_RENDERER_WEBGL),
    ]
      .filter((value): value is string => value !== null)
      .join(' ')
      .toLowerCase();
    const rendererClass: PerformanceRendererClass =
      /swiftshader|llvmpipe|softpipe|software rasterizer/u.test(rendererText)
        ? 'software'
        : /vmware|virtualbox|parallels|virgl|microsoft basic render/u.test(rendererText)
          ? 'virtualized'
          : rendererText.length > 0
            ? 'hardware-accelerated'
            : 'unknown';
    return {
      browserBuild: build,
      browserConcurrencyBucket: concurrencyBucket(navigator.hardwareConcurrency),
      webGl: {
        context: webGl2 === null ? ('webgl' as const) : ('webgl2' as const),
        rendererClass,
      },
    };
  });
  const browserEngine = browser?.browserType().name();
  if (browserEngine !== 'chromium') {
    throw new Error('The performance environment requires Chromium.');
  }
  return {
    browserEngine,
    browserVersion: browser?.version() ?? 'unknown',
    ...pageIdentity,
  };
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
  return { guard, network, runtimeIdentity: await captureBrowserRuntimeIdentity(page) };
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

async function settleInteractionPresentation(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function finishInteractionMeasurement(page: Page, startedAt: number): Promise<number> {
  await settleInteractionPresentation(page);
  return page.evaluate((start) => performance.now() - start, startedAt);
}

async function runEnvironmentControlBlock(page: Page): Promise<number[]> {
  return page.evaluate(async (sampleCount) => {
    const samples: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const durationMs = await new Promise<number>((resolve) => {
        const startedAt = performance.now();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve(performance.now() - startedAt));
        });
      });
      samples.push(durationMs);
    }
    return samples;
  }, CONTROL_SAMPLES_PER_BLOCK);
}

function projectLimit<T extends Record<string, number>>(limits: T, projectName: string): number {
  const value = limits[projectName];
  expect(value, `Unknown performance project ${projectName}`).toBeDefined();
  return value!;
}

async function closeSelectionIfOpen(page: Page): Promise<void> {
  const close = page.locator('.selection-panel button').filter({ hasText: 'Close selected track' });
  if ((await close.count()) === 0) return;
  await close.click();
  await expect
    .poll(() => page.locator('.selection-panel h2').textContent())
    .toBe('Select an aircraft');
}

async function setSearchState(page: Page, value: '' | 'PX1999'): Promise<void> {
  const search = page.locator('input[type="search"]');
  await search.fill(value);
  await expect
    .poll(() =>
      page.evaluate((expectedValue) => {
        const input = document.querySelector('input[type="search"]');
        return {
          count: document.querySelectorAll('.aircraft-link').length,
          value: input instanceof HTMLInputElement ? input.value : '',
          onlyIdentifier:
            expectedValue === ''
              ? null
              : (document.querySelector('.aircraft-link')?.textContent?.trim() ?? null),
        };
      }, value),
    )
    .toEqual({
      count: value === '' ? MAXIMUM_AIRCRAFT : 1,
      value,
      onlyIdentifier: value === '' ? null : 'PX1999',
    });
}

async function measureSearchInteraction(page: Page): Promise<number> {
  await closeSelectionIfOpen(page);
  await setSearchState(page, '');
  const search = page.locator('input[type="search"]');
  await search.focus();
  await settleInteractionPresentation(page);
  const startedAt = await page.evaluate(() => {
    const input = document.querySelector('input[type="search"]');
    if (
      !(input instanceof HTMLInputElement) ||
      input.value !== '' ||
      document.activeElement !== input
    ) {
      return -1;
    }
    return performance.now();
  });
  expect(startedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.type('PX1999');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const input = document.querySelector('input[type="search"]');
        return {
          count: document.querySelectorAll('.aircraft-link').length,
          focused: input !== null && document.activeElement === input,
          value: input instanceof HTMLInputElement ? input.value : '',
        };
      }),
    )
    .toEqual({ count: 1, focused: true, value: 'PX1999' });
  return finishInteractionMeasurement(page, startedAt);
}

async function measureSelectInteraction(page: Page): Promise<number> {
  await closeSelectionIfOpen(page);
  await setSearchState(page, 'PX1999');
  const focused = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
      (candidate) => candidate.textContent?.trim() === 'PX1999',
    );
    if (!button || button.getAttribute('aria-pressed') !== 'false') return false;
    button.focus();
    return true;
  });
  expect(focused).toBe(true);
  await settleInteractionPresentation(page);
  const startedAt = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
      (candidate) => candidate.textContent?.trim() === 'PX1999',
    );
    if (!button || button.getAttribute('aria-pressed') !== 'false') return -1;
    if (document.activeElement !== button) return -1;
    return performance.now();
  });
  expect(startedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => ({
        selected: document.querySelector('.aircraft-link')?.getAttribute('aria-pressed') === 'true',
        investigation: document.querySelector('.selection-panel h2')?.textContent?.trim(),
        receiptRows: document.querySelectorAll('.history-table tbody tr').length,
      })),
    )
    .toEqual({ selected: true, investigation: 'PX1999', receiptRows: HISTORY_RECEIPTS });
  return finishInteractionMeasurement(page, startedAt);
}

async function restoreIdentifierSort(page: Page): Promise<void> {
  await closeSelectionIfOpen(page);
  await setSearchState(page, '');
  const identifierSort = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
      (candidate) => candidate.textContent?.trim() === 'Aircraft',
    );
    return button?.closest('th')?.getAttribute('aria-sort') ?? null;
  });
  if (identifierSort !== 'ascending') {
    const started = await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
        (candidate) => candidate.textContent?.trim() === 'Aircraft',
      );
      button?.focus();
      return button !== undefined;
    });
    expect(started).toBe(true);
    await page.keyboard.press('Enter');
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
          (candidate) => candidate.textContent?.trim() === 'Aircraft',
        );
        return button?.closest('th')?.getAttribute('aria-sort') ?? null;
      }),
    )
    .toBe('ascending');
}

async function measureSortInteraction(page: Page): Promise<number> {
  await restoreIdentifierSort(page);
  const focused = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
      (candidate) => candidate.textContent?.includes('Ground speed'),
    );
    if (!button || button.closest('th')?.getAttribute('aria-sort') !== 'none') return false;
    button.focus();
    return true;
  });
  expect(focused).toBe(true);
  await settleInteractionPresentation(page);
  const startedAt = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.sort-button')].find(
      (candidate) => candidate.textContent?.includes('Ground speed'),
    );
    if (!button || button.closest('th')?.getAttribute('aria-sort') !== 'none') return -1;
    if (document.activeElement !== button) return -1;
    return performance.now();
  });
  expect(startedAt).toBeGreaterThanOrEqual(0);
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
  return finishInteractionMeasurement(page, startedAt);
}

async function measureCloseInteraction(page: Page): Promise<number> {
  await closeSelectionIfOpen(page);
  await setSearchState(page, 'PX1999');
  const selected = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
      (candidate) => candidate.textContent?.trim() === 'PX1999',
    );
    button?.focus();
    return button !== undefined;
  });
  expect(selected).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('.selection-panel h2').textContent()).toBe('PX1999');
  const focused = await page.evaluate(() => {
    const close = [...document.querySelectorAll<HTMLButtonElement>('.selection-panel button')].find(
      (button) => button.textContent?.includes('Close selected track'),
    );
    if (!close) return false;
    close.focus();
    return true;
  });
  expect(focused).toBe(true);
  await settleInteractionPresentation(page);
  const startedAt = await page.evaluate(() => {
    const close = [...document.querySelectorAll<HTMLButtonElement>('.selection-panel button')].find(
      (button) => button.textContent?.includes('Close selected track'),
    );
    if (!close || document.activeElement !== close) return -1;
    return performance.now();
  });
  expect(startedAt).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const origin = [...document.querySelectorAll<HTMLButtonElement>('.aircraft-link')].find(
          (button) => button.textContent?.trim() === 'PX1999',
        );
        return {
          selectionClosed: document.querySelector('.selection-panel h2')?.textContent?.trim(),
          focusRestored: origin !== undefined && document.activeElement === origin,
        };
      }),
    )
    .toEqual({ selectionClosed: 'Select an aircraft', focusRestored: true });
  return finishInteractionMeasurement(page, startedAt);
}

async function measureScrollInteraction(page: Page): Promise<number> {
  await restoreIdentifierSort(page);
  const targetScrollTop = await page.evaluate(() => {
    const table = document.querySelector('.table-scroll');
    if (!(table instanceof HTMLElement)) return -1;
    table.style.maxHeight = '320px';
    table.style.overflowY = 'auto';
    table.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'instant' });
    table.focus();
    return table.scrollHeight - table.clientHeight;
  });
  expect(targetScrollTop).toBeGreaterThan(0);
  await settleInteractionPresentation(page);
  const measurement = await page.evaluate((expectedTarget) => {
    const table = document.querySelector('.table-scroll');
    if (!(table instanceof HTMLElement)) return { pageScrollY: -1, startedAt: -1 };
    if (
      table.scrollTop !== 0 ||
      table.scrollHeight - table.clientHeight !== expectedTarget ||
      document.activeElement !== table
    ) {
      return { pageScrollY: -1, startedAt: -1 };
    }
    table.dataset.performancePageScrollBaseline = String(window.scrollY);
    return { pageScrollY: window.scrollY, startedAt: performance.now() };
  }, targetScrollTop);
  expect(measurement.startedAt).toBeGreaterThanOrEqual(0);
  expect(measurement.pageScrollY).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('End');
  await expect
    .poll(() =>
      page.evaluate((expectedTarget) => {
        const table = document.querySelector('.table-scroll');
        return {
          tableFocused: table instanceof HTMLElement && document.activeElement === table,
          tableScrollTop: table instanceof HTMLElement ? table.scrollTop : -1,
          targetScrollTop: expectedTarget,
          windowScrollY: window.scrollY,
        };
      }, targetScrollTop),
    )
    .toEqual({
      tableFocused: true,
      tableScrollTop: targetScrollTop,
      targetScrollTop,
      windowScrollY: measurement.pageScrollY,
    });
  return finishInteractionMeasurement(page, measurement.startedAt);
}

async function collectInteractionSamples(
  measure: () => Promise<number>,
  samples: number[],
  updateEvidence: () => void,
): Promise<void> {
  for (let index = 0; index < INTERACTION_WARMUPS; index += 1) await measure();
  for (let index = 0; index < INTERACTION_ITERATIONS; index += 1) {
    samples.push(await measure());
    updateEvidence();
  }
}

test('500-aircraft validated snapshots reach the stable linked render barrier within the p95 budget', async ({
  page,
}, testInfo) => {
  const { guard, network, runtimeIdentity } = await openHarness(page);
  for (let index = 0; index < PAINT_WARMUPS; index += 1) {
    await renderSnapshot(page, PAINT_AIRCRAFT);
  }
  const paints: number[] = [];
  const validations: number[] = [];
  const domStableDurations: number[] = [];
  const mapStableDurations: number[] = [];
  const wireBytes: number[] = [];
  const visualFixtureKeys: string[] = [];
  const environmentControlBlocksMs: number[][] = [];
  for (let block = 0; block < PAINT_BLOCKS; block += 1) {
    environmentControlBlocksMs.push(await runEnvironmentControlBlock(page));
    for (let index = 0; index < PAINT_SAMPLES_PER_BLOCK; index += 1) {
      const measurementIndex = block * PAINT_SAMPLES_PER_BLOCK + index;
      const result = await renderSnapshot(page, PAINT_AIRCRAFT);
      expect(result.recordCount).toBe(PAINT_AIRCRAFT);
      expect(result.historyAircraft).toBe(PAINT_AIRCRAFT);
      expect(result.minimumHistorySamples).toBe(measurementIndex + PAINT_WARMUPS + 1);
      expect(result.maximumHistorySamples).toBe(measurementIndex + PAINT_WARMUPS + 1);
      expect(result.historiesAtMaximum).toBe(0);
      expect(result.qualityEvents).toBe(0);
      paints.push(result.durationMs);
      domStableDurations.push(result.domStableDurationMs);
      mapStableDurations.push(result.mapStableDurationMs);
      validations.push(result.validationDurationMs);
      wireBytes.push(result.wireBytes);
      visualFixtureKeys.push(result.visualFixtureKey);
    }
  }
  environmentControlBlocksMs.push(await runEnvironmentControlBlock(page));
  expect(new Set(visualFixtureKeys).size).toBe(PAINT_ITERATIONS);
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
  const overBudgetSamples = paints.filter((durationMs) => durationMs > limitMs).length;
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
      schemaVersion: 'airspace-performance-case.v3',
      case: 'paint-500',
      project: testInfo.project.name,
      performanceProfileId: PERFORMANCE_LIMITS.performanceProfileId,
      paintWarmups: PAINT_WARMUPS,
      paintIterations: PAINT_ITERATIONS,
      paintBlocks: PAINT_BLOCKS,
      paintSamplesPerBlock: PAINT_SAMPLES_PER_BLOCK,
      paintP95LimitMs: limitMs,
      paintDurationSamplesMs: paints,
      domStableDurationSamplesMs: domStableDurations,
      mapStableDurationSamplesMs: mapStableDurations,
      validationDurationSamplesMs: validations,
      wireByteSamples: wireBytes,
      environmentControl: {
        metric: 'two-animation-frame-scheduling-delay',
        samplesPerBlock: CONTROL_SAMPLES_PER_BLOCK,
        blocksMs: environmentControlBlocksMs,
        comparisonEligible: false,
        baselineRunCount: 0,
      },
      runtimeIdentity,
      network: {
        coldNavigationResponseBodyBytes: coldResponseBodies.navigation,
        coldScriptResponseBodyBytes: coldResponseBodies.script,
        coldStyleResponseBodyBytes: coldResponseBodies.style,
        coldFontResponseBodyBytes: coldResponseBodies.font,
        coldMapResponseBodyBytes: coldResponseBodies.map,
        coldOtherResponseBodyBytes: coldResponseBodies.other,
        coldTotalResponseBodyBytes: coldResponseBodies.total,
        coldResponseBodyLimitBytes: TRANSFER_LIMIT_BYTES,
        responseCount: coldResponseBodies.responseCount,
        unmeasuredResponseCount: coldResponseBodies.unmeasuredResponseCount,
      },
    }),
  });
  expect(p95Ms).toBeLessThanOrEqual(limitMs);
  expect(overBudgetSamples).toBeLessThanOrEqual(1);
  expect(guard).toEqual({ externalRequestCount: 0, webSocketCount: 0, pageErrorCount: 0 });
});

test('near-limit 2,000-record maximum preserves bounded history and complete keyboard workflows', async ({
  page,
}, testInfo) => {
  const interactionSamplesMs: InteractionSamples = {
    search: [],
    select: [],
    sort: [],
    close: [],
    scroll: [],
  };
  let failureStage: MaximumPerformanceFailureStage = 'open-harness';
  const evidenceAnnotation = {
    type: 'performance-evidence',
    description: JSON.stringify(
      createMaximumPerformanceFailureEvidence(
        testInfo.project.name,
        failureStage,
        interactionSamplesMs,
      ),
    ),
  };
  testInfo.annotations.push(evidenceAnnotation);
  const setFailureStage = (stage: MaximumPerformanceFailureStage) => {
    failureStage = stage;
    evidenceAnnotation.description = JSON.stringify(
      createMaximumPerformanceFailureEvidence(
        testInfo.project.name,
        failureStage,
        interactionSamplesMs,
      ),
    );
  };
  try {
    const { guard, network, runtimeIdentity } = await openHarness(page);
    setFailureStage('prepare-history');
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

    setFailureStage('age-tick');
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

    setFailureStage('maximum-paint');
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

    setFailureStage('interaction-search');
    await collectInteractionSamples(
      () => measureSearchInteraction(page),
      interactionSamplesMs.search,
      () => setFailureStage('interaction-search'),
    );
    setFailureStage('interaction-select');
    await collectInteractionSamples(
      () => measureSelectInteraction(page),
      interactionSamplesMs.select,
      () => setFailureStage('interaction-select'),
    );
    setFailureStage('interaction-sort');
    await collectInteractionSamples(
      () => measureSortInteraction(page),
      interactionSamplesMs.sort,
      () => setFailureStage('interaction-sort'),
    );
    setFailureStage('interaction-close');
    await collectInteractionSamples(
      () => measureCloseInteraction(page),
      interactionSamplesMs.close,
      () => setFailureStage('interaction-close'),
    );
    setFailureStage('interaction-scroll');
    await collectInteractionSamples(
      () => measureScrollInteraction(page),
      interactionSamplesMs.scroll,
      () => setFailureStage('interaction-scroll'),
    );

    setFailureStage('aggregate-ui-audit');
    const aggregate = await page.evaluate(async () => {
      const table = document.querySelector('.table-scroll');
      const measuredPerformance = performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      };
      return {
        rowCount: document.querySelectorAll('.aircraft-link').length,
        mapReady: document.querySelector('.map-stage')?.getAttribute('data-map-status') === 'ready',
        tableFocused: table instanceof HTMLElement && document.activeElement === table,
        tableScrolled: table instanceof HTMLElement && table.scrollTop > 0,
        pageScrollStayedAtBaseline:
          table instanceof HTMLElement &&
          Number(table.dataset.performancePageScrollBaseline) === window.scrollY,
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
    expect(aggregate.pageScrollStayedAtBaseline).toBe(true);
    expect(aggregate.fitsViewport).toBe(true);
    setFailureStage('aggregate-privacy-audit');
    expect(aggregate.localStorageEntries).toBe(0);
    expect(aggregate.sessionStorageEntries).toBe(0);
    expect(aggregate.cookieBytes).toBe(0);
    expect(aggregate.indexedDatabaseCount).toBe(0);
    expect(aggregate.cacheCount).toBe(0);
    expect(aggregate.serviceWorkerCount).toBe(0);
    expect(aggregate.opfsEntryCount).toBe(0);
    setFailureStage('aggregate-resource-audit');
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
    setFailureStage('aggregate-limits-audit');
    expect(aggregate.limits).toEqual({
      historyAircraft: PAINT_AIRCRAFT,
      minimumHistorySamples: HISTORY_RECEIPTS,
      maximumHistorySamples: HISTORY_RECEIPTS,
      historiesAtMaximum: PAINT_AIRCRAFT,
      qualityEvents: QUALITY_EVENTS,
    });
    const interactionP95LimitMs = projectLimit(INTERACTION_P95_LIMIT_MS, testInfo.project.name);
    setFailureStage('budget-audit');
    evidenceAnnotation.description = JSON.stringify({
      schemaVersion: 'airspace-performance-case.v3',
      case: 'maximum-2000',
      project: testInfo.project.name,
      performanceProfileId: PERFORMANCE_LIMITS.performanceProfileId,
      preparation: {
        qualityReceipts: preparation.qualityReceipts,
        qualityEventsGenerated: preparation.qualityEventsGenerated,
        qualityEventsRetained: preparation.qualityEvents,
        qualityTailWindowVerified: preparation.qualityTailWindowVerified,
        historyReceipts: preparation.historyReceipts,
        totalReceipts: preparation.totalReceipts,
        durationMs: preparation.durationMs,
      },
      maximumPaint: {
        durationMs: result.durationMs,
        domStableDurationMs: result.domStableDurationMs,
        mapStableDurationMs: result.mapStableDurationMs,
        validationDurationMs: result.validationDurationMs,
        wireBytes: result.wireBytes,
        wireLimitBytes: MAX_LIVE_MESSAGE_BYTES,
        maximumHistorySamples: result.maximumHistorySamples,
        minimumHistorySamples: result.minimumHistorySamples,
        historiesAtMaximum: result.historiesAtMaximum,
      },
      interactionWarmups: INTERACTION_WARMUPS,
      interactionIterations: INTERACTION_ITERATIONS,
      interactionP95LimitMs,
      interactionSamplesMs,
      ageTick: {
        durationMs: ageTick.durationMs,
        limitMs: ageTickLimitMs,
        jsHeapDeltaBytes: ageTick.jsHeapDeltaBytes,
        jsHeapGrowthLimitBytes: AGE_TICK_JS_HEAP_GROWTH_LIMIT_BYTES,
        historiesMapPreserved: ageTick.historiesMapPreserved,
        trailsMapPreserved: ageTick.trailsMapPreserved,
        historyObjectsPreserved: ageTick.historyObjectsPreserved,
        sampleArraysPreserved: ageTick.sampleArraysPreserved,
        historyAircraft: ageTick.historyAircraft,
        historySamples: ageTick.historySamples,
      },
      browserJsHeapBytes: aggregate.browserJsHeapBytes,
      browserJsHeapLimitBytes: BROWSER_JS_HEAP_LIMIT_BYTES,
      network: {
        resourceResponseBodyBytes,
        navigationResponseBodyBytes: network.navigation,
        totalResponseBodyBytes,
        responseBodyLimitBytes: TRANSFER_LIMIT_BYTES,
        responseCount: network.responseCount,
        unmeasuredResponseCount: network.unmeasuredResponseCount,
      },
      runtimeIdentity,
    });
    for (const name of INTERACTION_NAMES) {
      const samples = interactionSamplesMs[name];
      expect(percentile95(samples), `${name} interaction p95`).toBeLessThanOrEqual(
        interactionP95LimitMs,
      );
      expect(
        samples.filter((durationMs) => durationMs > interactionP95LimitMs).length,
        `${name} interaction over-budget samples`,
      ).toBeLessThanOrEqual(1);
    }
    expect(guard).toEqual({ externalRequestCount: 0, webSocketCount: 0, pageErrorCount: 0 });
  } catch (error) {
    evidenceAnnotation.description = JSON.stringify(
      createMaximumPerformanceFailureEvidence(
        testInfo.project.name,
        failureStage,
        interactionSamplesMs,
      ),
    );
    throw error;
  }
});
