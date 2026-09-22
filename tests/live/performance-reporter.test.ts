import { resolve } from 'node:path';

import { devices } from '@playwright/test';
import type { TestCase } from '@playwright/test/reporter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  performanceRunEnvironment,
  performanceRunPathsForId,
} from '../../tools/live/performanceContract';

const PAINT_TITLE =
  '500-aircraft validated snapshots reach the stable linked render barrier within the p95 budget';
let performanceEvidenceMatchesTestInventory: typeof import('../../tools/live/performanceReporter').performanceEvidenceMatchesTestInventory;
let performanceReporterOutputPath: typeof import('../../tools/live/performanceReporter').performanceReporterOutputPath;
let performanceTestInventoryEntryFor: typeof import('../../tools/live/performanceReporter').performanceTestInventoryEntryFor;
const REPORTER_RUN_PATHS = performanceRunPathsForId(
  resolve('.'),
  '123e4567-e89b-42d3-a456-426614174000',
);

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PLAYWRIGHT_NO_COPY_PROMPT', '1');
  vi.stubEnv('LIVE_TEST_PORT', '4174');
  for (const [key, value] of Object.entries(performanceRunEnvironment(REPORTER_RUN_PATHS))) {
    vi.stubEnv(key, value);
  }
  ({
    performanceEvidenceMatchesTestInventory,
    performanceReporterOutputPath,
    performanceTestInventoryEntryFor,
  } = await import('../../tools/live/performanceReporter'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function desktopTest(overrides: Record<string, unknown> = {}): TestCase {
  const project = {
    name: 'performance-desktop',
    retries: 0,
    use: { ...devices['Desktop Chrome'] },
  };
  return {
    id: 'desktop-paint-test',
    title: PAINT_TITLE,
    parent: { project: () => project },
    location: {
      file: resolve('tests/live-browser/performance.spec.ts'),
      line: 617,
      column: 1,
    },
    repeatEachIndex: 0,
    retries: 0,
    ...overrides,
  } as unknown as TestCase;
}

describe('browser performance reporter test identity binding', () => {
  it('can write only the staged report in its validated run namespace', () => {
    expect(performanceReporterOutputPath()).toBe(REPORTER_RUN_PATHS.stagedReport);
    expect(performanceReporterOutputPath()).not.toBe(
      resolve('test-results/live-performance/report.json'),
    );
  });

  it('binds Playwright and Vite generated outputs to the same run namespace', async () => {
    const [{ default: playwrightConfig }, { default: viteConfig }] = await Promise.all([
      import('../../playwright.performance.config'),
      import('../../vite.performance.config'),
    ]);
    expect(playwrightConfig.outputDir).toBe(REPORTER_RUN_PATHS.playwrightOutput);
    expect(playwrightConfig.webServer).toMatchObject({
      env: performanceRunEnvironment(REPORTER_RUN_PATHS),
    });
    expect(viteConfig.cacheDir).toBe(REPORTER_RUN_PATHS.viteCache);
    expect(viteConfig.build?.outDir).toBe(REPORTER_RUN_PATHS.clientOutput);
  });

  it('derives project and case only from the actual Playwright TestCase', () => {
    const inventory = performanceTestInventoryEntryFor(desktopTest());
    expect(inventory).toMatchObject({
      id: 'desktop-paint-test',
      project: 'performance-desktop',
      case: 'paint-500',
      repeatEachIndex: 0,
      retries: 0,
    });
    expect(
      performanceEvidenceMatchesTestInventory(inventory!, {
        project: 'performance-desktop',
        case: 'paint-500',
      }),
    ).toBe(true);
    expect(
      performanceEvidenceMatchesTestInventory(inventory!, {
        project: 'performance-mobile',
        case: 'paint-500',
      }),
    ).toBe(false);
    expect(
      performanceEvidenceMatchesTestInventory(inventory!, {
        project: 'performance-desktop',
        case: 'maximum-2000',
      }),
    ).toBe(false);
  });

  it('rejects title, file, repeat, retry, and descriptor drift', () => {
    expect(performanceTestInventoryEntryFor(desktopTest({ title: 'forged paint title' }))).toBe(
      undefined,
    );
    expect(
      performanceTestInventoryEntryFor(
        desktopTest({
          location: { file: resolve('tests/live-browser/other.spec.ts'), line: 1, column: 1 },
        }),
      ),
    ).toBeUndefined();
    expect(performanceTestInventoryEntryFor(desktopTest({ repeatEachIndex: 1 }))).toBeUndefined();
    expect(performanceTestInventoryEntryFor(desktopTest({ retries: 1 }))).toBeUndefined();
    expect(
      performanceTestInventoryEntryFor(
        desktopTest({
          parent: {
            project: () => ({
              name: 'performance-desktop',
              retries: 0,
              use: { ...devices['Desktop Chrome'], hasTouch: true },
            }),
          },
        }),
      ),
    ).toBeUndefined();
  });
});
