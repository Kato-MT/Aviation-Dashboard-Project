import { join, relative, resolve, sep } from 'node:path';

import {
  RUNTIME_POLICY_LIMITS,
  type RuntimePolicyLimits,
} from '../../src/live/runtimePolicyLimits';

export const PERFORMANCE_RUN_ENVIRONMENT_KEYS = Object.freeze({
  runId: 'AIRSPACE_PERFORMANCE_RUN_ID',
  runRoot: 'AIRSPACE_PERFORMANCE_RUN_ROOT',
  playwrightOutput: 'AIRSPACE_PERFORMANCE_PLAYWRIGHT_OUTPUT',
  clientOutput: 'AIRSPACE_PERFORMANCE_CLIENT_OUTPUT',
  viteCache: 'AIRSPACE_PERFORMANCE_VITE_CACHE',
  serverIdentity: 'AIRSPACE_PERFORMANCE_SERVER_IDENTITY',
  guardianState: 'AIRSPACE_PERFORMANCE_GUARDIAN_STATE',
  guardianResult: 'AIRSPACE_PERFORMANCE_GUARDIAN_RESULT',
  stagedReport: 'AIRSPACE_PERFORMANCE_STAGED_REPORT',
} as const);

export const PERFORMANCE_RUN_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export interface PerformanceRunPaths {
  readonly runId: string;
  readonly runsRoot: string;
  readonly runRoot: string;
  readonly runReceipt: string;
  readonly playwrightOutput: string;
  readonly clientOutput: string;
  readonly viteCache: string;
  readonly identityDirectory: string;
  readonly serverIdentity: string;
  readonly guardianDirectory: string;
  readonly guardianState: string;
  readonly guardianResult: string;
  readonly stagedDirectory: string;
  readonly stagedReport: string;
}

function boundedChild(path: string, parent: string, label: string): string {
  const target = resolve(path);
  const difference = relative(resolve(parent), target);
  if (
    difference.length === 0 ||
    difference === '..' ||
    difference.startsWith(`..${sep}`) ||
    difference.startsWith('/')
  ) {
    throw new Error(`${label} is not a bounded child path.`);
  }
  return target;
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return left === normalizedLeft && right === normalizedRight && normalizedLeft === normalizedRight;
}

export function performanceRunPathsForId(
  repositoryRootInput: string,
  runId: string,
): PerformanceRunPaths {
  if (!PERFORMANCE_RUN_ID_PATTERN.test(runId)) {
    throw new Error('Browser performance run id must be a canonical UUID.');
  }
  const repositoryRoot = resolve(repositoryRootInput);
  const temporaryRoot = boundedChild(
    join(repositoryRoot, '.tmp-tests'),
    repositoryRoot,
    'Browser performance temporary root',
  );
  const runsRoot = boundedChild(
    join(temporaryRoot, 'live-performance-runs'),
    temporaryRoot,
    'Browser performance runs root',
  );
  const runRoot = boundedChild(join(runsRoot, runId), runsRoot, 'Browser performance run root');
  const identityDirectory = boundedChild(
    join(runRoot, 'identity'),
    runRoot,
    'Browser performance identity directory',
  );
  const guardianDirectory = boundedChild(
    join(runRoot, 'guardian'),
    runRoot,
    'Browser performance guardian directory',
  );
  const stagedDirectory = boundedChild(
    join(runRoot, 'staged'),
    runRoot,
    'Browser performance staged-report directory',
  );
  return Object.freeze({
    runId,
    runsRoot,
    runRoot,
    runReceipt: boundedChild(join(runRoot, 'run.json'), runRoot, 'Browser performance run receipt'),
    playwrightOutput: boundedChild(
      join(runRoot, 'playwright'),
      runRoot,
      'Browser performance Playwright output',
    ),
    clientOutput: boundedChild(
      join(runRoot, 'client'),
      runRoot,
      'Browser performance client output',
    ),
    viteCache: boundedChild(join(runRoot, 'vite-cache'), runRoot, 'Browser performance Vite cache'),
    identityDirectory,
    serverIdentity: boundedChild(
      join(identityDirectory, 'server.json'),
      identityDirectory,
      'Browser performance server identity',
    ),
    guardianDirectory,
    guardianState: boundedChild(
      join(guardianDirectory, 'state.json'),
      guardianDirectory,
      'Browser performance guardian state',
    ),
    guardianResult: boundedChild(
      join(guardianDirectory, 'result.json'),
      guardianDirectory,
      'Browser performance guardian result',
    ),
    stagedDirectory,
    stagedReport: boundedChild(
      join(stagedDirectory, 'report.json'),
      stagedDirectory,
      'Browser performance staged report',
    ),
  });
}

export function performanceRunEnvironment(
  paths: PerformanceRunPaths,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.runId]: paths.runId,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.runRoot]: paths.runRoot,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.playwrightOutput]: paths.playwrightOutput,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.clientOutput]: paths.clientOutput,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.viteCache]: paths.viteCache,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.serverIdentity]: paths.serverIdentity,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.guardianState]: paths.guardianState,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.guardianResult]: paths.guardianResult,
    [PERFORMANCE_RUN_ENVIRONMENT_KEYS.stagedReport]: paths.stagedReport,
  });
}

export function requirePerformanceRunPaths(
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): PerformanceRunPaths {
  const allowedKeys = new Set<string>(Object.values(PERFORMANCE_RUN_ENVIRONMENT_KEYS));
  const unexpectedKey = Object.keys(environment).find(
    (key) => /^AIRSPACE_PERFORMANCE_/u.test(key) && !allowedKeys.has(key),
  );
  if (unexpectedKey !== undefined) {
    throw new Error('Browser performance environment contains an unknown run-path variable.');
  }
  const runId = environment[PERFORMANCE_RUN_ENVIRONMENT_KEYS.runId];
  if (runId === undefined) {
    throw new Error('Browser performance run environment is missing its run id.');
  }
  const paths = performanceRunPathsForId(repositoryRoot, runId);
  const expected = performanceRunEnvironment(paths);
  for (const [key, value] of Object.entries(expected)) {
    const provided = environment[key];
    const matches =
      key === PERFORMANCE_RUN_ENVIRONMENT_KEYS.runId
        ? provided === value
        : provided !== undefined && sameResolvedPath(provided, value);
    if (!matches) {
      throw new Error('Browser performance run environment has an absent or out-of-root path.');
    }
  }
  return paths;
}

export const PERFORMANCE_REPORT_SCHEMA_VERSION = 'airspace-browser-performance.v3' as const;
export const PERFORMANCE_REPORT_MAX_BYTES = 64 * 1024;
export const PERFORMANCE_PROJECT_NAMES = Object.freeze([
  'performance-desktop',
  'performance-mobile',
] as const);
export const PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT = Object.freeze({
  'performance-desktop': Object.freeze({
    deviceProfile: 'Desktop Chrome' as const,
    defaultBrowserType: 'chromium' as const,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Safari/537.36',
    viewport: Object.freeze({ width: 1280, height: 720 }),
    screen: Object.freeze({ width: 1920, height: 1080 }),
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  }),
  'performance-mobile': Object.freeze({
    deviceProfile: 'Pixel 5' as const,
    defaultBrowserType: 'chromium' as const,
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36',
    viewport: Object.freeze({ width: 393, height: 727 }),
    screen: Object.freeze({ width: 393, height: 851 }),
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
  }),
});
export const PERFORMANCE_INTERACTION_NAMES = Object.freeze([
  'search',
  'select',
  'sort',
  'close',
  'scroll',
] as const);

export const PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT = Object.freeze({
  schemaVersion: 'airspace-performance-environment-eligibility.v1' as const,
  browserEngine: 'chromium' as const,
  numericBrowserBuildRequired: true,
  webGlContextRequired: true,
  rendererClassRequired: true,
  browserConcurrencyBucketRequired: true,
  supportedHostArchitectures: Object.freeze(['x64', 'arm64'] as const),
  playwrightWorkers: 1,
  playwrightRetries: 0,
  cpuThrottleRate: 1,
  networkThrottle: 'none' as const,
});

export type PerformanceRendererClass =
  'hardware-accelerated' | 'software' | 'virtualized' | 'unknown';

export type PerformanceConcurrencyBucket = '1-2' | '3-4' | '5-8' | '9-16' | '17-32' | '33+';

export interface PerformanceBrowserRuntimeIdentity {
  readonly browserEngine: 'chromium';
  readonly browserVersion: string;
  readonly browserBuild: string;
  readonly browserConcurrencyBucket: PerformanceConcurrencyBucket;
  readonly webGl: {
    readonly context: 'webgl2' | 'webgl' | 'unavailable';
    readonly rendererClass: PerformanceRendererClass;
  };
}

const PERFORMANCE_CONCURRENCY_BUCKETS = new Set<PerformanceConcurrencyBucket>([
  '1-2',
  '3-4',
  '5-8',
  '9-16',
  '17-32',
  '33+',
]);
const PERFORMANCE_WEBGL_CONTEXTS = new Set<PerformanceBrowserRuntimeIdentity['webGl']['context']>([
  'webgl2',
  'webgl',
  'unavailable',
]);
const PERFORMANCE_RENDERER_CLASSES = new Set<PerformanceRendererClass>([
  'hardware-accelerated',
  'software',
  'virtualized',
  'unknown',
]);

function exactRecordKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function parsePerformanceBrowserRuntimeIdentity(
  value: unknown,
): PerformanceBrowserRuntimeIdentity | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactRecordKeys(value as Record<string, unknown>, [
      'browserEngine',
      'browserVersion',
      'browserBuild',
      'browserConcurrencyBucket',
      'webGl',
    ])
  ) {
    return undefined;
  }
  const identity = value as Record<string, unknown>;
  if (
    identity.browserEngine !== 'chromium' ||
    typeof identity.browserVersion !== 'string' ||
    !/^\d+(?:\.\d+){1,4}$/u.test(identity.browserVersion) ||
    typeof identity.browserBuild !== 'string' ||
    !/^(?:HeadlessChrome|Chrome)\/\d+(?:\.\d+){1,4}$/u.test(identity.browserBuild) ||
    typeof identity.browserConcurrencyBucket !== 'string' ||
    !PERFORMANCE_CONCURRENCY_BUCKETS.has(
      identity.browserConcurrencyBucket as PerformanceConcurrencyBucket,
    ) ||
    typeof identity.webGl !== 'object' ||
    identity.webGl === null ||
    Array.isArray(identity.webGl) ||
    !exactRecordKeys(identity.webGl as Record<string, unknown>, ['context', 'rendererClass'])
  ) {
    return undefined;
  }
  const webGl = identity.webGl as Record<string, unknown>;
  if (
    typeof webGl.context !== 'string' ||
    !PERFORMANCE_WEBGL_CONTEXTS.has(
      webGl.context as PerformanceBrowserRuntimeIdentity['webGl']['context'],
    ) ||
    typeof webGl.rendererClass !== 'string' ||
    !PERFORMANCE_RENDERER_CLASSES.has(webGl.rendererClass as PerformanceRendererClass)
  ) {
    return undefined;
  }
  return value as PerformanceBrowserRuntimeIdentity;
}

export function performanceBrowserRuntimeIdentityIsEligible(
  value: unknown,
): value is PerformanceBrowserRuntimeIdentity {
  const identity = parsePerformanceBrowserRuntimeIdentity(value);
  return (
    identity !== undefined &&
    identity.webGl.context !== 'unavailable' &&
    identity.webGl.rendererClass !== 'unknown'
  );
}

export interface PerformanceConfiguredProject {
  readonly name: string;
  readonly retries: number;
  readonly use: {
    readonly defaultBrowserType?: unknown;
    readonly userAgent?: unknown;
    readonly viewport?: unknown;
    readonly screen?: unknown;
    readonly deviceScaleFactor?: unknown;
    readonly isMobile?: unknown;
    readonly hasTouch?: unknown;
  };
}

function sameDimension(
  value: unknown,
  expected: Readonly<{ width: number; height: number }>,
): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).width === expected.width &&
    (value as Record<string, unknown>).height === expected.height
  );
}

export function performanceProjectDescriptorMatches(
  project: PerformanceConfiguredProject,
): boolean {
  if (
    !PERFORMANCE_PROJECT_NAMES.includes(project.name as (typeof PERFORMANCE_PROJECT_NAMES)[number])
  ) {
    return false;
  }
  const expected =
    PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT[
      project.name as keyof typeof PERFORMANCE_PROJECT_DESCRIPTOR_CONTRACT
    ];
  return (
    project.use.defaultBrowserType === expected.defaultBrowserType &&
    project.use.userAgent === expected.userAgent &&
    sameDimension(project.use.viewport, expected.viewport) &&
    sameDimension(project.use.screen, expected.screen) &&
    project.use.deviceScaleFactor === expected.deviceScaleFactor &&
    project.use.isMobile === expected.isMobile &&
    project.use.hasTouch === expected.hasTouch
  );
}

export function performanceProjectConfigurationFailureCodes(
  projects: readonly PerformanceConfiguredProject[],
): string[] {
  const projectNames = projects.map((project) => project.name).sort();
  const failureCodes: string[] = [];
  if (JSON.stringify(projectNames) !== JSON.stringify([...PERFORMANCE_PROJECT_NAMES].sort())) {
    failureCodes.push('PLAYWRIGHT_PROJECT_SET_MISMATCH');
  }
  if (projects.some((project) => !performanceProjectDescriptorMatches(project))) {
    failureCodes.push('PLAYWRIGHT_PROJECT_DESCRIPTOR_MISMATCH');
  }
  if (
    projects.some(
      (project) =>
        project.retries !== PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT.playwrightRetries,
    )
  ) {
    failureCodes.push('PLAYWRIGHT_RETRY_COUNT_MISMATCH');
  }
  return failureCodes;
}

export function performanceResultProjectFailureCodes(
  actualProject: PerformanceConfiguredProject | undefined,
  evidenceProject: unknown,
): string[] {
  if (actualProject === undefined) return ['PLAYWRIGHT_RESULT_PROJECT_MISSING'];
  const failureCodes: string[] = [];
  if (
    !PERFORMANCE_PROJECT_NAMES.includes(
      actualProject.name as (typeof PERFORMANCE_PROJECT_NAMES)[number],
    ) ||
    evidenceProject !== actualProject.name
  ) {
    failureCodes.push('PLAYWRIGHT_RESULT_PROJECT_MISMATCH');
  }
  if (!performanceProjectDescriptorMatches(actualProject)) {
    failureCodes.push('PLAYWRIGHT_RESULT_DESCRIPTOR_MISMATCH');
  }
  if (actualProject.retries !== PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT.playwrightRetries) {
    failureCodes.push('PLAYWRIGHT_RESULT_RETRY_CONFIGURATION_MISMATCH');
  }
  return failureCodes;
}

const RUNNER_IMAGE_OS_VALUES = new Set([
  'ubuntu20',
  'ubuntu22',
  'ubuntu24',
  'win19',
  'win22',
  'macos13',
  'macos14',
  'macos15',
  'macos15-arm64',
  'macos26',
]);
const RUNNER_OS_VALUES = new Set(['Linux', 'Windows', 'macOS']);
const RUNNER_ARCHITECTURE_VALUES = new Set(['X64', 'ARM64']);
const RUNNER_ENVIRONMENT_VALUES = new Set(['github-hosted', 'self-hosted']);

function allowlistedRunnerValue(
  value: string | undefined,
  allowlist: ReadonlySet<string>,
): string | null {
  return value !== undefined && allowlist.has(value) ? value : null;
}

export function privacySafePerformanceRunnerMetadata(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return {
    provider:
      environment.GITHUB_ACTIONS === 'true'
        ? ('github-actions' as const)
        : environment.CI === 'true'
          ? ('other-ci' as const)
          : ('local' as const),
    ci: environment.CI === 'true',
    imageOs: allowlistedRunnerValue(environment.ImageOS, RUNNER_IMAGE_OS_VALUES),
    runnerOs: allowlistedRunnerValue(environment.RUNNER_OS, RUNNER_OS_VALUES),
    runnerArchitecture: allowlistedRunnerValue(environment.RUNNER_ARCH, RUNNER_ARCHITECTURE_VALUES),
    runnerEnvironment: allowlistedRunnerValue(
      environment.RUNNER_ENVIRONMENT,
      RUNNER_ENVIRONMENT_VALUES,
    ),
  };
}

export type PerformanceInteractionName = (typeof PERFORMANCE_INTERACTION_NAMES)[number];

export type MaximumPerformanceFailureStage =
  | 'open-harness'
  | 'prepare-history'
  | 'age-tick'
  | 'maximum-paint'
  | 'interaction-search'
  | 'interaction-select'
  | 'interaction-sort'
  | 'interaction-close'
  | 'interaction-scroll'
  | 'aggregate-ui-audit'
  | 'aggregate-privacy-audit'
  | 'aggregate-resource-audit'
  | 'aggregate-limits-audit'
  | 'budget-audit';

const MAXIMUM_FAILURE_CODES = Object.freeze({
  'open-harness': 'MAXIMUM_OPEN_HARNESS_FAILED',
  'prepare-history': 'MAXIMUM_PREPARE_HISTORY_FAILED',
  'age-tick': 'MAXIMUM_AGE_TICK_FAILED',
  'maximum-paint': 'MAXIMUM_PAINT_FAILED',
  'interaction-search': 'MAXIMUM_SEARCH_FAILED',
  'interaction-select': 'MAXIMUM_SELECT_FAILED',
  'interaction-sort': 'MAXIMUM_SORT_FAILED',
  'interaction-close': 'MAXIMUM_CLOSE_FAILED',
  'interaction-scroll': 'MAXIMUM_SCROLL_FAILED',
  'aggregate-ui-audit': 'MAXIMUM_UI_AUDIT_FAILED',
  'aggregate-privacy-audit': 'MAXIMUM_PRIVACY_AUDIT_FAILED',
  'aggregate-resource-audit': 'MAXIMUM_RESOURCE_AUDIT_FAILED',
  'aggregate-limits-audit': 'MAXIMUM_LIMITS_AUDIT_FAILED',
  'budget-audit': 'MAXIMUM_BUDGET_AUDIT_FAILED',
} satisfies Record<MaximumPerformanceFailureStage, string>);

export type MaximumPerformanceFailureEvidence = ReturnType<
  typeof createMaximumPerformanceFailureEvidence
>;

export function createMaximumPerformanceFailureEvidence(
  project: string,
  stage: MaximumPerformanceFailureStage,
  interactionSamplesMs: Readonly<Record<PerformanceInteractionName, readonly number[]>>,
) {
  return {
    schemaVersion: 'airspace-performance-case-failure.v1' as const,
    case: 'maximum-2000' as const,
    project,
    performanceProfileId: RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId,
    failure: {
      stage,
      code: MAXIMUM_FAILURE_CODES[stage],
    },
    availableSamples: {
      interactionIterations: RUNTIME_POLICY_LIMITS.browser.performance.interactionIterations,
      interactionSamplesMs,
    },
    privacy: {
      syntheticOnly: true,
      errorMessageRetained: false,
    },
  };
}

export function parseMaximumPerformanceFailureEvidence(
  value: unknown,
): MaximumPerformanceFailureEvidence | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const exactKeys = (record: Record<string, unknown>, expected: readonly string[]) =>
    JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort());
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'case',
      'project',
      'performanceProfileId',
      'failure',
      'availableSamples',
      'privacy',
    ]) ||
    receipt.schemaVersion !== 'airspace-performance-case-failure.v1' ||
    receipt.case !== 'maximum-2000' ||
    !PERFORMANCE_PROJECT_NAMES.includes(
      receipt.project as (typeof PERFORMANCE_PROJECT_NAMES)[number],
    ) ||
    receipt.performanceProfileId !==
      RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId ||
    typeof receipt.failure !== 'object' ||
    receipt.failure === null ||
    Array.isArray(receipt.failure) ||
    typeof receipt.availableSamples !== 'object' ||
    receipt.availableSamples === null ||
    Array.isArray(receipt.availableSamples) ||
    typeof receipt.privacy !== 'object' ||
    receipt.privacy === null ||
    Array.isArray(receipt.privacy)
  ) {
    return undefined;
  }
  const failure = receipt.failure as Record<string, unknown>;
  const available = receipt.availableSamples as Record<string, unknown>;
  const privacy = receipt.privacy as Record<string, unknown>;
  const stage = failure.stage as MaximumPerformanceFailureStage;
  const samples = available.interactionSamplesMs;
  if (
    !exactKeys(failure, ['stage', 'code']) ||
    !Object.hasOwn(MAXIMUM_FAILURE_CODES, stage) ||
    failure.code !== MAXIMUM_FAILURE_CODES[stage] ||
    !exactKeys(available, ['interactionIterations', 'interactionSamplesMs']) ||
    available.interactionIterations !==
      RUNTIME_POLICY_LIMITS.browser.performance.interactionIterations ||
    typeof samples !== 'object' ||
    samples === null ||
    Array.isArray(samples) ||
    !exactKeys(samples as Record<string, unknown>, PERFORMANCE_INTERACTION_NAMES) ||
    !PERFORMANCE_INTERACTION_NAMES.every((name) => {
      const values = (samples as Record<string, unknown>)[name];
      return (
        Array.isArray(values) &&
        values.length <= RUNTIME_POLICY_LIMITS.browser.performance.interactionIterations &&
        values.every(
          (sample) =>
            typeof sample === 'number' &&
            Number.isFinite(sample) &&
            sample >= 0 &&
            sample <= 30_000,
        )
      );
    }) ||
    !exactKeys(privacy, ['syntheticOnly', 'errorMessageRetained']) ||
    privacy.syntheticOnly !== true ||
    privacy.errorMessageRetained !== false
  ) {
    return undefined;
  }
  return value as MaximumPerformanceFailureEvidence;
}

export type PerformanceFailureStage =
  'aggregate-serialization' | 'outer-output-audit' | 'runner-execution';

export type PerformanceFailureCode =
  | 'AGGREGATE_SERIALIZATION_FAILED'
  | 'AGGREGATE_EXCEEDS_64_KIB'
  | 'AGGREGATE_OUTPUT_REJECTED'
  | 'RUNNER_EXECUTION_FAILED';

export function createCompactPerformanceFailureReceipt(
  stage: PerformanceFailureStage,
  code: PerformanceFailureCode,
  completedAt = new Date().toISOString(),
) {
  return {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    performanceProfileId: RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId,
    receiptType: 'compact-failure' as const,
    result: 'fail' as const,
    completedAt,
    failure: {
      schemaVersion: 'airspace-browser-performance-failure.v1' as const,
      stage,
      code,
    },
    privacy: {
      rawSamplesRetained: false,
      detailedFailureRetained: false,
    },
  };
}

export interface PerformanceServerIdentity {
  readonly schemaVersion: 'airspace-performance-server.v1';
  readonly source: {
    readonly head: string;
    readonly dirty: boolean;
    readonly contentSha256: string;
  };
  readonly optimizedClient: {
    readonly schemaVersion: 'sha256-file-inventory.v1';
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sha256: string;
  };
  readonly map: {
    readonly id: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sha256: string;
  };
  readonly policy: {
    readonly limits: RuntimePolicyLimits;
    readonly limitsSha256: string;
  };
}

export interface ExpectedPerformanceMapIdentity {
  readonly id: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export function parsePerformanceMapIdentity(
  value: unknown,
  expected: ExpectedPerformanceMapIdentity,
): PerformanceServerIdentity['map'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const map = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(map).sort()) !==
      JSON.stringify(['id', 'fileCount', 'totalBytes', 'sha256'].sort()) ||
    typeof expected.id !== 'string' ||
    expected.id.length < 1 ||
    !Number.isSafeInteger(expected.fileCount) ||
    expected.fileCount < 0 ||
    !Number.isSafeInteger(expected.totalBytes) ||
    expected.totalBytes < 0 ||
    map.id !== expected.id ||
    !Number.isSafeInteger(map.fileCount) ||
    (map.fileCount as number) < 0 ||
    map.fileCount !== expected.fileCount ||
    !Number.isSafeInteger(map.totalBytes) ||
    (map.totalBytes as number) < 0 ||
    map.totalBytes !== expected.totalBytes ||
    typeof map.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(map.sha256)
  ) {
    return undefined;
  }
  return map as unknown as PerformanceServerIdentity['map'];
}

export interface PerformanceIdentityCapture {
  readonly schemaVersion: 'airspace-performance-identity-capture.v2';
  readonly source: PerformanceServerIdentity['source'];
  readonly optimizedClient: PerformanceServerIdentity['optimizedClient'];
  readonly map: PerformanceServerIdentity['map'];
}
