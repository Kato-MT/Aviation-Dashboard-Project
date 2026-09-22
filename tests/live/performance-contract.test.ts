import { describe, expect, it } from 'vitest';
import { devices } from '@playwright/test';
import { join, relative, resolve, sep } from 'node:path';

import mapManifest from '../../maps/manifest.json';
import { MAP_ID } from '../../src/map/assets';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import {
  createCompactPerformanceFailureReceipt,
  createMaximumPerformanceFailureEvidence,
  parseMaximumPerformanceFailureEvidence,
  parsePerformanceBrowserRuntimeIdentity,
  parsePerformanceMapIdentity,
  performanceBrowserRuntimeIdentityIsEligible,
  PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT,
  PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT,
  PERFORMANCE_REPORT_MAX_BYTES,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  PERFORMANCE_RUN_ENVIRONMENT_KEYS,
  performanceRunEnvironment,
  performanceRunPathsForId,
  performanceProjectConfigurationFailureCodes,
  performanceResultProjectFailureCodes,
  privacySafePerformanceRunnerMetadata,
  requirePerformanceRunPaths,
  type PerformanceServerIdentity,
} from '../../tools/live/performanceContract';

const PERFORMANCE_REPOSITORY_ROOT = resolve('test-performance-repository');
const CANONICAL_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_CANONICAL_RUN_ID = '987f6543-e21b-45d3-b456-426614174111';

describe('browser performance audit contract', () => {
  it('keeps the strict v3 budgets and canonical environment shape', () => {
    expect(PERFORMANCE_REPORT_SCHEMA_VERSION).toBe('airspace-browser-performance.v3');
    expect(RUNTIME_POLICY_LIMITS.browser.performance).toMatchObject({
      paintWarmups: 5,
      paintIterations: 30,
      paintBlocks: 3,
      paintP95Ms: { desktop: 500, mobile: 750 },
      interactionWarmups: 2,
      interactionIterations: 20,
      interactionP95Ms: { desktop: 1_000, mobile: 1_000 },
    });
    expect(PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT).toMatchObject({
      browserEngine: 'chromium',
      playwrightWorkers: 1,
      playwrightRetries: 0,
      cpuThrottleRate: 1,
      networkThrottle: 'none',
    });
  });

  it('rejects array-coerced runtime identity scalars at parsing and eligibility boundaries', () => {
    const identity = {
      browserEngine: 'chromium',
      browserVersion: '145.0.0.0',
      browserBuild: 'HeadlessChrome/145.0.0.0',
      browserConcurrencyBucket: '9-16',
      webGl: { context: 'webgl2', rendererClass: 'hardware-accelerated' },
    } as const;

    expect(parsePerformanceBrowserRuntimeIdentity(identity)).toEqual(identity);
    expect(performanceBrowserRuntimeIdentityIsEligible(identity)).toBe(true);
    for (const forged of [
      { ...identity, browserConcurrencyBucket: ['9-16'] },
      { ...identity, webGl: { ...identity.webGl, context: ['webgl2'] } },
      { ...identity, webGl: { ...identity.webGl, rendererClass: ['hardware-accelerated'] } },
    ]) {
      expect(parsePerformanceBrowserRuntimeIdentity(forged)).toBeUndefined();
      expect(performanceBrowserRuntimeIdentityIsEligible(forged)).toBe(false);
    }
  });

  it('keeps the compact failure receipt privacy-safe and below 64 KiB', () => {
    const receipt = createCompactPerformanceFailureReceipt(
      'outer-output-audit',
      'AGGREGATE_OUTPUT_REJECTED',
      '2026-08-31T00:00:00.000Z',
    );
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(PERFORMANCE_REPORT_MAX_BYTES);
    expect(receipt).toMatchObject({
      schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
      result: 'fail',
      receiptType: 'compact-failure',
      privacy: { rawSamplesRetained: false, detailedFailureRetained: false },
    });
    expect(serialized).not.toMatch(
      /(?:cpuModel|hardwareConcurrency|webGlVendor|webGlRenderer|unmasked|totalMemoryBytes)/u,
    );
  });

  it('accepts only manifest-bound, nonnegative map identities with SHA-256 digests', () => {
    const validMap: PerformanceServerIdentity['map'] = {
      id: MAP_ID,
      fileCount: mapManifest.assets.length,
      totalBytes: mapManifest.totalBytes,
      sha256: 'd'.repeat(64),
    };
    const expectedMap = {
      id: MAP_ID,
      fileCount: mapManifest.assets.length,
      totalBytes: mapManifest.totalBytes,
    };
    expect(parsePerformanceMapIdentity(validMap, expectedMap)).toEqual(validMap);

    const invalidMaps: PerformanceServerIdentity['map'][] = [
      { ...validMap, id: `${MAP_ID}-tampered` },
      { ...validMap, fileCount: -1 },
      { ...validMap, fileCount: mapManifest.assets.length + 1 },
      { ...validMap, totalBytes: -1 },
      { ...validMap, totalBytes: mapManifest.totalBytes + 1 },
      { ...validMap, sha256: 'not-a-sha256' },
    ];
    for (const map of invalidMaps) {
      expect(parsePerformanceMapIdentity(map, expectedMap)).toBeUndefined();
    }
  });

  it('recognizes only the two configured Chromium device projects with zero retries', () => {
    const configuredProjects = [
      {
        name: 'performance-desktop',
        retries: 0,
        use: devices['Desktop Chrome'],
      },
      {
        name: 'performance-mobile',
        retries: 0,
        use: devices['Pixel 5'],
      },
    ];
    const { deviceProfile: desktopProfile, ...desktopDescriptor } =
      PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT['performance-desktop'];
    const { deviceProfile: mobileProfile, ...mobileDescriptor } =
      PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT['performance-mobile'];
    expect(desktopProfile).toBe('Desktop Chrome');
    expect(mobileProfile).toBe('Pixel 5');
    expect(devices['Desktop Chrome']).toMatchObject(desktopDescriptor);
    expect(devices['Pixel 5']).toMatchObject(mobileDescriptor);
    expect(performanceProjectConfigurationFailureCodes(configuredProjects)).toEqual([]);
    expect(
      performanceProjectConfigurationFailureCodes([
        configuredProjects[0]!,
        { ...configuredProjects[1]!, use: { defaultBrowserType: 'webkit' } },
      ]),
    ).toContain('PLAYWRIGHT_PROJECT_DESCRIPTOR_MISMATCH');
    expect(
      performanceProjectConfigurationFailureCodes([
        configuredProjects[0]!,
        { ...configuredProjects[1]!, name: 'performance-tablet' },
      ]),
    ).toContain('PLAYWRIGHT_PROJECT_SET_MISMATCH');
  });

  it('rejects descriptor drift and annotation-controlled project claims', () => {
    const desktopProject = {
      name: 'performance-desktop',
      retries: 0,
      use: { ...devices['Desktop Chrome'] },
    };
    const mobileProject = {
      name: 'performance-mobile',
      retries: 0,
      use: { ...devices['Pixel 5'] },
    };
    const driftedMobile = {
      ...mobileProject,
      use: {
        ...mobileProject.use,
        viewport: { width: mobileProject.use.viewport.width + 1, height: 727 },
        userAgent: 'forged mobile profile',
        isMobile: false,
        hasTouch: false,
      },
    };
    expect(performanceProjectConfigurationFailureCodes([desktopProject, driftedMobile])).toContain(
      'PLAYWRIGHT_PROJECT_DESCRIPTOR_MISMATCH',
    );
    expect(performanceResultProjectFailureCodes(desktopProject, 'performance-desktop')).toEqual([]);
    expect(performanceResultProjectFailureCodes(desktopProject, 'performance-mobile')).toContain(
      'PLAYWRIGHT_RESULT_PROJECT_MISMATCH',
    );
    expect(performanceResultProjectFailureCodes(driftedMobile, 'performance-mobile')).toContain(
      'PLAYWRIGHT_RESULT_DESCRIPTOR_MISMATCH',
    );
  });

  it('omits arbitrary runner environment strings while retaining fixed labels', () => {
    expect(
      privacySafePerformanceRunnerMetadata({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        ImageOS: 'ubuntu24',
        ImageVersion: 'secret-build-label',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_ENVIRONMENT: 'github-hosted',
      }),
    ).toEqual({
      provider: 'github-actions',
      ci: true,
      imageOs: 'ubuntu24',
      runnerOs: 'Linux',
      runnerArchitecture: 'X64',
      runnerEnvironment: 'github-hosted',
    });
    expect(
      privacySafePerformanceRunnerMetadata({
        CI: 'true',
        ImageOS: 'arbitrary identifying text',
        RUNNER_OS: 'secret',
        RUNNER_ARCH: 'secret',
        RUNNER_ENVIRONMENT: 'secret',
      }),
    ).toMatchObject({
      provider: 'other-ci',
      imageOs: null,
      runnerOs: null,
      runnerArchitecture: null,
      runnerEnvironment: null,
    });
  });

  it('round-trips bounded maximum failure evidence with partial raw samples', () => {
    const samples = {
      search: [12, 13],
      select: [21],
      sort: [],
      close: [],
      scroll: [],
    };
    const receipt = createMaximumPerformanceFailureEvidence(
      'performance-desktop',
      'interaction-select',
      samples,
    );
    expect(parseMaximumPerformanceFailureEvidence(receipt)).toEqual(receipt);
    expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThan(
      PERFORMANCE_REPORT_MAX_BYTES,
    );
    expect(
      parseMaximumPerformanceFailureEvidence({
        ...receipt,
        failure: { ...receipt.failure, code: 'ARBITRARY_ERROR' },
      }),
    ).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toMatch(
      /(?:synthetic failure detail|[A-Za-z]:\\|\/Users\/|\/home\/|https?:\/\/)/iu,
    );
  });
});

describe('browser performance run namespace contract', () => {
  it('accepts a canonical lowercase UUIDv4 and derives the exact deterministic layout', () => {
    const paths = performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, CANONICAL_RUN_ID);
    const runsRoot = join(PERFORMANCE_REPOSITORY_ROOT, '.tmp-tests', 'live-performance-runs');
    const runRoot = join(runsRoot, CANONICAL_RUN_ID);

    expect(paths).toEqual({
      runId: CANONICAL_RUN_ID,
      runsRoot,
      runRoot,
      runReceipt: join(runRoot, 'run.json'),
      playwrightOutput: join(runRoot, 'playwright'),
      clientOutput: join(runRoot, 'client'),
      viteCache: join(runRoot, 'vite-cache'),
      identityDirectory: join(runRoot, 'identity'),
      serverIdentity: join(runRoot, 'identity', 'server.json'),
      guardianDirectory: join(runRoot, 'guardian'),
      guardianState: join(runRoot, 'guardian', 'state.json'),
      guardianResult: join(runRoot, 'guardian', 'result.json'),
      stagedDirectory: join(runRoot, 'staged'),
      stagedReport: join(runRoot, 'staged', 'report.json'),
    });
    expect(
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, performanceRunEnvironment(paths)),
    ).toEqual(paths);
  });

  it.each([
    ['', 'missing'],
    ['not-a-uuid', 'malformed'],
    ['123e4567-e89b-12d3-a456-426614174000', 'non-v4'],
    ['123e4567-e89b-42d3-7456-426614174000', 'non-RFC-4122-variant'],
    ['123E4567-E89B-42D3-A456-426614174000', 'uppercase'],
    ['../../123e4567-e89b-42d3-a456-426614174000', 'traversal'],
  ])('rejects a %s run id (%s)', (runId) => {
    expect(() => performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, runId)).toThrow();
  });

  it('rejects missing, malformed, absent-path, and traversal-path environments', () => {
    const paths = performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, CANONICAL_RUN_ID);
    const validEnvironment = performanceRunEnvironment(paths);

    expect(() => requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {})).toThrow();
    expect(() =>
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {
        ...validEnvironment,
        [PERFORMANCE_RUN_ENVIRONMENT_KEYS.runId]: 'malformed',
      }),
    ).toThrow();
    expect(() =>
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {
        ...validEnvironment,
        [PERFORMANCE_RUN_ENVIRONMENT_KEYS.clientOutput]: `${paths.runRoot}${sep}staged${sep}..${sep}client`,
      }),
    ).toThrow();

    const missingPath = { ...validEnvironment };
    delete missingPath[PERFORMANCE_RUN_ENVIRONMENT_KEYS.clientOutput];
    expect(() => requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, missingPath)).toThrow();
    expect(() =>
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {
        ...validEnvironment,
        [PERFORMANCE_RUN_ENVIRONMENT_KEYS.clientOutput]: join(
          paths.runRoot,
          '..',
          SECOND_CANONICAL_RUN_ID,
          'client',
        ),
      }),
    ).toThrow();
    expect(() =>
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {
        ...validEnvironment,
        [PERFORMANCE_RUN_ENVIRONMENT_KEYS.runRoot]: resolve(
          PERFORMANCE_REPOSITORY_ROOT,
          '..',
          'escaped-performance-run',
        ),
      }),
    ).toThrow();
  });

  it('keeps two valid run namespaces disjoint beneath the shared runs root', () => {
    const first = performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, CANONICAL_RUN_ID);
    const second = performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, SECOND_CANONICAL_RUN_ID);
    const runLocalKeys = [
      'runRoot',
      'runReceipt',
      'playwrightOutput',
      'clientOutput',
      'viteCache',
      'identityDirectory',
      'serverIdentity',
      'guardianDirectory',
      'guardianState',
      'guardianResult',
      'stagedDirectory',
      'stagedReport',
    ] as const;

    expect(first.runsRoot).toBe(second.runsRoot);
    expect(relative(first.runsRoot, first.runRoot)).toBe(CANONICAL_RUN_ID);
    expect(relative(second.runsRoot, second.runRoot)).toBe(SECOND_CANONICAL_RUN_ID);
    for (const key of runLocalKeys) {
      expect(first[key]).not.toBe(second[key]);
      expect(relative(first.runRoot, first[key])).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      expect(relative(second.runRoot, second[key])).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    }
  });

  it('rejects unknown AIRSPACE_PERFORMANCE_* environment variables', () => {
    const paths = performanceRunPathsForId(PERFORMANCE_REPOSITORY_ROOT, CANONICAL_RUN_ID);

    expect(() =>
      requirePerformanceRunPaths(PERFORMANCE_REPOSITORY_ROOT, {
        ...performanceRunEnvironment(paths),
        AIRSPACE_PERFORMANCE_CANONICAL_REPORT: join(
          PERFORMANCE_REPOSITORY_ROOT,
          'test-results',
          'live-performance',
          'report.json',
        ),
      }),
    ).toThrow(/unknown run-path variable/u);
  });
});
