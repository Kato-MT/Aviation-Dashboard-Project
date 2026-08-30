import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { runtimePolicyCanonicalJson } from '../../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { PERFORMANCE_CLIENT_OUTDIR } from '../../vite.performance.config';
import { assertEvidenceOutputPlacement } from './evidenceOutputPolicy';
import type { PerformanceIdentityCapture, PerformanceServerIdentity } from './performanceContract';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const IDENTITY_HELPER = fileURLToPath(new URL('./capturePerformanceIdentity.ts', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const execFileAsync = promisify(execFile);
const SERVER_IDENTITY_PATH = join(
  REPOSITORY_ROOT,
  '.tmp-tests',
  `performance-server-identity-${process.env.LIVE_TEST_PORT ?? '4174'}.json`,
);
const OUTPUT_PATH = join(REPOSITORY_ROOT, 'test-results', 'live-performance', 'report.json');
const EXPECTED_PROJECTS = new Set(['performance-desktop', 'performance-mobile']);
const EXPECTED_CASES = new Set(['paint-500', 'maximum-2000']);
const PERFORMANCE_LIMITS = RUNTIME_POLICY_LIMITS.browser.performance;

type AggregateRecord = Record<string, string | number | boolean>;

interface FailedInteractionMeasurement {
  readonly case: 'maximum-2000';
  readonly project: string;
  readonly searchInteractionMs: number;
  readonly selectInteractionMs: number;
  readonly sortInteractionMs: number;
  readonly closeInteractionMs: number;
  readonly scrollInteractionMs: number;
  readonly maximumInteractionMs: number;
  readonly interactionLimitMs: 1_000;
}

interface FailedPaintMeasurement {
  readonly case: 'paint-500';
  readonly project: string;
  readonly samples: 30;
  readonly warmups: 5;
  readonly p95Ms: number;
  readonly limitMs: number;
  readonly validationP95Ms: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function boundedNumber(value: unknown, minimum = 0, maximum = 1_000_000_000): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseRecord(description: string | undefined): AggregateRecord | undefined {
  if (description === undefined || description.length > 4_096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(description) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.case !== 'string' || typeof value.project !== 'string') {
    return undefined;
  }
  if (!EXPECTED_CASES.has(value.case) || !EXPECTED_PROJECTS.has(value.project)) return undefined;
  const common = ['case', 'project'];
  if (value.case === 'paint-500') {
    const keys = [
      ...common,
      'samples',
      'warmups',
      'p95Ms',
      'limitMs',
      'validationP95Ms',
      'minimumWireBytes',
      'maximumWireBytes',
      'browserVersion',
      'coldNavigationResponseBodyBytes',
      'coldScriptResponseBodyBytes',
      'coldStyleResponseBodyBytes',
      'coldFontResponseBodyBytes',
      'coldMapResponseBodyBytes',
      'coldOtherResponseBodyBytes',
      'coldTotalResponseBodyBytes',
      'coldResponseBodyLimitBytes',
      'networkResponseCount',
      'unmeasuredNetworkResponseCount',
    ];
    if (!exactKeys(value, keys)) return undefined;
    const expectedLimit =
      value.project === 'performance-desktop'
        ? PERFORMANCE_LIMITS.paintP95Ms.desktop
        : PERFORMANCE_LIMITS.paintP95Ms.mobile;
    const coldBodyTotal =
      (value.coldNavigationResponseBodyBytes as number) +
      (value.coldScriptResponseBodyBytes as number) +
      (value.coldStyleResponseBodyBytes as number) +
      (value.coldFontResponseBodyBytes as number) +
      (value.coldMapResponseBodyBytes as number) +
      (value.coldOtherResponseBodyBytes as number);
    if (
      value.samples !== PERFORMANCE_LIMITS.paintIterations ||
      value.warmups !== PERFORMANCE_LIMITS.paintWarmups ||
      value.limitMs !== expectedLimit ||
      !boundedNumber(value.p95Ms, 0, expectedLimit) ||
      !boundedNumber(value.validationP95Ms, 0, 60_000) ||
      !boundedNumber(value.minimumWireBytes, 1, MAX_LIVE_MESSAGE_BYTES) ||
      !boundedNumber(
        value.maximumWireBytes,
        value.minimumWireBytes as number,
        MAX_LIVE_MESSAGE_BYTES,
      ) ||
      typeof value.browserVersion !== 'string' ||
      !/^\d+(?:\.\d+){1,4}$/u.test(value.browserVersion) ||
      value.coldResponseBodyLimitBytes !== PERFORMANCE_LIMITS.responseBodyBytes ||
      !boundedNumber(value.networkResponseCount, 1, 100_000) ||
      value.unmeasuredNetworkResponseCount !== 0 ||
      !boundedNumber(
        value.coldNavigationResponseBodyBytes,
        1,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      !boundedNumber(
        value.coldScriptResponseBodyBytes,
        1,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      !boundedNumber(
        value.coldStyleResponseBodyBytes,
        1,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      !boundedNumber(
        value.coldFontResponseBodyBytes,
        1,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      !boundedNumber(
        value.coldMapResponseBodyBytes,
        1,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      !boundedNumber(
        value.coldOtherResponseBodyBytes,
        0,
        value.coldResponseBodyLimitBytes as number,
      ) ||
      value.coldTotalResponseBodyBytes !== coldBodyTotal ||
      coldBodyTotal > (value.coldResponseBodyLimitBytes as number)
    ) {
      return undefined;
    }
  } else {
    const keys = [
      ...common,
      'qualityPreparationReceipts',
      'qualityEventsGenerated',
      'qualityEventsRetained',
      'qualityTailWindowVerified',
      'historyPreparationReceipts',
      'totalPreparationReceipts',
      'preparationDurationMs',
      'stablePaintMs',
      'validationMs',
      'wireBytes',
      'wireLimitBytes',
      'maximumHistorySamples',
      'minimumHistorySamples',
      'historiesAtMaximum',
      'interactionSamples',
      'searchInteractionMs',
      'selectInteractionMs',
      'sortInteractionMs',
      'closeInteractionMs',
      'scrollInteractionMs',
      'maximumInteractionMs',
      'interactionLimitMs',
      'ageTickDurationMs',
      'ageTickLimitMs',
      'ageTickJsHeapDeltaBytes',
      'ageTickJsHeapGrowthLimitBytes',
      'ageTickHistoriesMapPreserved',
      'ageTickTrailsMapPreserved',
      'ageTickHistoryObjectsPreserved',
      'ageTickSampleArraysPreserved',
      'ageTickHistoryAircraft',
      'ageTickHistorySamples',
      'browserJsHeapBytes',
      'browserJsHeapLimitBytes',
      'resourceResponseBodyBytes',
      'navigationResponseBodyBytes',
      'totalResponseBodyBytes',
      'responseBodyLimitBytes',
      'networkResponseCount',
      'unmeasuredNetworkResponseCount',
      'browserVersion',
    ];
    if (!exactKeys(value, keys)) return undefined;
    const interactionLimit =
      value.project === 'performance-desktop'
        ? PERFORMANCE_LIMITS.interactionLimitMs.desktop
        : PERFORMANCE_LIMITS.interactionLimitMs.mobile;
    const ageTickLimit =
      value.project === 'performance-desktop'
        ? PERFORMANCE_LIMITS.ageTickLimitMs.desktop
        : PERFORMANCE_LIMITS.ageTickLimitMs.mobile;
    const interactionDurations = [
      value.searchInteractionMs,
      value.selectInteractionMs,
      value.sortInteractionMs,
      value.closeInteractionMs,
      value.scrollInteractionMs,
    ];
    if (
      value.qualityPreparationReceipts !== 100 ||
      value.qualityEventsGenerated !== 250 ||
      value.qualityEventsRetained !== RUNTIME_POLICY_LIMITS.history.maximumQualityEvents ||
      value.qualityTailWindowVerified !== true ||
      value.historyPreparationReceipts !== 120 ||
      value.totalPreparationReceipts !== 220 ||
      value.minimumHistorySamples !== RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
      value.maximumHistorySamples !== RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
      value.historiesAtMaximum !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
      value.interactionSamples !== 5 ||
      value.interactionLimitMs !== interactionLimit ||
      value.ageTickLimitMs !== ageTickLimit ||
      value.ageTickJsHeapGrowthLimitBytes !== PERFORMANCE_LIMITS.ageTickJsHeapGrowthBytes ||
      value.ageTickHistoriesMapPreserved !== true ||
      value.ageTickTrailsMapPreserved !== true ||
      value.ageTickHistoryObjectsPreserved !== true ||
      value.ageTickSampleArraysPreserved !== true ||
      value.ageTickHistoryAircraft !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
      value.ageTickHistorySamples !==
        RUNTIME_POLICY_LIMITS.history.maximumAircraft *
          RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
      value.wireLimitBytes !== MAX_LIVE_MESSAGE_BYTES ||
      value.browserJsHeapLimitBytes !== PERFORMANCE_LIMITS.browserJsHeapBytes ||
      value.responseBodyLimitBytes !== PERFORMANCE_LIMITS.responseBodyBytes ||
      !boundedNumber(value.networkResponseCount, 1, 100_000) ||
      value.unmeasuredNetworkResponseCount !== 0 ||
      !boundedNumber(value.preparationDurationMs, 0, 120_000) ||
      !boundedNumber(value.stablePaintMs, 0, 30_000) ||
      !boundedNumber(value.validationMs, 0, 60_000) ||
      !boundedNumber(
        value.wireBytes,
        Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.95),
        MAX_LIVE_MESSAGE_BYTES,
      ) ||
      interactionDurations.some((duration) => !boundedNumber(duration, 0, interactionLimit)) ||
      !boundedNumber(value.maximumInteractionMs, 0, interactionLimit) ||
      value.maximumInteractionMs !== Math.max(...(interactionDurations as number[])) ||
      !boundedNumber(value.ageTickDurationMs, 0, ageTickLimit) ||
      !boundedNumber(
        value.ageTickJsHeapDeltaBytes,
        -PERFORMANCE_LIMITS.browserJsHeapBytes,
        value.ageTickJsHeapGrowthLimitBytes as number,
      ) ||
      !boundedNumber(value.browserJsHeapBytes, 1, value.browserJsHeapLimitBytes as number) ||
      !boundedNumber(value.resourceResponseBodyBytes, 1, value.responseBodyLimitBytes as number) ||
      !boundedNumber(
        value.navigationResponseBodyBytes,
        1,
        value.responseBodyLimitBytes as number,
      ) ||
      value.totalResponseBodyBytes !==
        (value.resourceResponseBodyBytes as number) +
          (value.navigationResponseBodyBytes as number) ||
      (value.totalResponseBodyBytes as number) > (value.responseBodyLimitBytes as number) ||
      typeof value.browserVersion !== 'string' ||
      !/^\d+(?:\.\d+){1,4}$/u.test(value.browserVersion)
    ) {
      return undefined;
    }
  }
  return value as AggregateRecord;
}

function parseFailedInteractionMeasurement(
  description: string | undefined,
): FailedInteractionMeasurement | undefined {
  if (description === undefined || description.length > 4_096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(description) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.case !== 'maximum-2000' ||
    typeof value.project !== 'string' ||
    !EXPECTED_PROJECTS.has(value.project)
  ) {
    return undefined;
  }
  const interactionLimit =
    value.project === 'performance-desktop'
      ? PERFORMANCE_LIMITS.interactionLimitMs.desktop
      : PERFORMANCE_LIMITS.interactionLimitMs.mobile;
  if (value.interactionLimitMs !== interactionLimit) return undefined;
  const durations = [
    value.searchInteractionMs,
    value.selectInteractionMs,
    value.sortInteractionMs,
    value.closeInteractionMs,
    value.scrollInteractionMs,
  ];
  if (
    durations.some((duration) => !boundedNumber(duration, 0, 30_000)) ||
    !boundedNumber(value.maximumInteractionMs, 0, 30_000) ||
    value.maximumInteractionMs !== Math.max(...(durations as number[]))
  ) {
    return undefined;
  }
  return {
    case: 'maximum-2000',
    project: value.project,
    searchInteractionMs: value.searchInteractionMs as number,
    selectInteractionMs: value.selectInteractionMs as number,
    sortInteractionMs: value.sortInteractionMs as number,
    closeInteractionMs: value.closeInteractionMs as number,
    scrollInteractionMs: value.scrollInteractionMs as number,
    maximumInteractionMs: value.maximumInteractionMs,
    interactionLimitMs: interactionLimit,
  };
}

function parseFailedPaintMeasurement(
  description: string | undefined,
): FailedPaintMeasurement | undefined {
  if (description === undefined || description.length > 4_096) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(description) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.case !== 'paint-500' ||
    typeof value.project !== 'string' ||
    !EXPECTED_PROJECTS.has(value.project) ||
    value.samples !== PERFORMANCE_LIMITS.paintIterations ||
    value.warmups !== PERFORMANCE_LIMITS.paintWarmups
  ) {
    return undefined;
  }
  const expectedLimit =
    value.project === 'performance-desktop'
      ? PERFORMANCE_LIMITS.paintP95Ms.desktop
      : PERFORMANCE_LIMITS.paintP95Ms.mobile;
  if (
    value.limitMs !== expectedLimit ||
    !boundedNumber(value.p95Ms, 0, 30_000) ||
    !boundedNumber(value.validationP95Ms, 0, 60_000)
  ) {
    return undefined;
  }
  return {
    case: 'paint-500',
    project: value.project,
    samples: PERFORMANCE_LIMITS.paintIterations,
    warmups: PERFORMANCE_LIMITS.paintWarmups,
    p95Ms: value.p95Ms,
    limitMs: expectedLimit,
    validationP95Ms: value.validationP95Ms,
  };
}

function serverIdentity(value: unknown): PerformanceServerIdentity | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient', 'map', 'policy']) ||
    value.schemaVersion !== 'airspace-performance-server.v1'
  )
    return undefined;
  const source = value.source;
  const client = value.optimizedClient;
  const map = value.map;
  const policy = value.policy;
  if (!isRecord(source) || !isRecord(client) || !isRecord(map) || !isRecord(policy)) {
    return undefined;
  }
  const expectedLimitsSha256 = createHash('sha256')
    .update(runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS))
    .digest('hex');
  if (
    !exactKeys(source, ['head', 'dirty', 'contentSha256']) ||
    !exactKeys(client, ['schemaVersion', 'fileCount', 'totalBytes', 'sha256']) ||
    !exactKeys(map, ['id', 'fileCount', 'totalBytes', 'sha256']) ||
    !exactKeys(policy, ['limits', 'limitsSha256']) ||
    typeof source.head !== 'string' ||
    typeof source.dirty !== 'boolean' ||
    typeof source.contentSha256 !== 'string' ||
    client.schemaVersion !== 'sha256-file-inventory.v1' ||
    !Number.isSafeInteger(client.fileCount) ||
    !Number.isSafeInteger(client.totalBytes) ||
    typeof client.sha256 !== 'string' ||
    typeof map.id !== 'string' ||
    !Number.isSafeInteger(map.fileCount) ||
    !Number.isSafeInteger(map.totalBytes) ||
    typeof map.sha256 !== 'string' ||
    policy.limitsSha256 !== expectedLimitsSha256 ||
    runtimePolicyCanonicalJson(policy.limits) !== runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS)
  ) {
    return undefined;
  }
  return value as unknown as PerformanceServerIdentity;
}

function identityCapture(value: unknown): PerformanceIdentityCapture | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient']) ||
    value.schemaVersion !== 'airspace-performance-identity-capture.v1' ||
    !isRecord(value.source) ||
    !isRecord(value.optimizedClient) ||
    !exactKeys(value.source, ['head', 'dirty', 'contentSha256']) ||
    !exactKeys(value.optimizedClient, ['schemaVersion', 'fileCount', 'totalBytes', 'sha256']) ||
    typeof value.source.head !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.source.head) ||
    typeof value.source.dirty !== 'boolean' ||
    typeof value.source.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.source.contentSha256) ||
    value.optimizedClient.schemaVersion !== 'sha256-file-inventory.v1' ||
    !Number.isSafeInteger(value.optimizedClient.fileCount) ||
    !Number.isSafeInteger(value.optimizedClient.totalBytes) ||
    typeof value.optimizedClient.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.optimizedClient.sha256)
  ) {
    return undefined;
  }
  return value as unknown as PerformanceIdentityCapture;
}

async function capturePerformanceIdentity(): Promise<PerformanceIdentityCapture> {
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  for (const key of Object.keys(environment)) {
    if (/^VITE_/iu.test(key)) delete environment[key];
  }
  const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_CLI, IDENTITY_HELPER], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (stderr.trim().length > 0 || stdout.length > 64 * 1024) {
    throw new Error('Performance identity helper emitted an invalid response.');
  }
  const capture = identityCapture(JSON.parse(stdout) as unknown);
  if (capture === undefined)
    throw new Error('Performance identity helper returned an invalid receipt.');
  return capture;
}

function reducedSourceMatches(
  server: PerformanceServerIdentity,
  source: PerformanceIdentityCapture['source'],
): boolean {
  return (
    server.source.head === source.head &&
    server.source.dirty === source.dirty &&
    server.source.contentSha256 === source.contentSha256
  );
}

function sameCapture(left: PerformanceIdentityCapture, right: PerformanceIdentityCapture): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameClientIdentity(
  left: PerformanceServerIdentity['optimizedClient'],
  right: PerformanceServerIdentity['optimizedClient'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default class AggregatePerformanceReporter implements Reporter {
  private readonly records: AggregateRecord[] = [];
  private readonly failedInteractionMeasurements: FailedInteractionMeasurement[] = [];
  private readonly failedPaintMeasurements: FailedPaintMeasurement[] = [];
  private failureCount = 0;
  private policyViolationCount = 0;
  private identityBefore?: Promise<PerformanceIdentityCapture>;

  onBegin(): void {
    this.identityBefore = capturePerformanceIdentity();
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    const annotations = result.annotations.filter(
      (annotation) => annotation.type === 'performance-evidence',
    );
    if (result.status !== 'passed') {
      this.failureCount += 1;
      if (annotations.length === 1) {
        const description = annotations[0]?.description;
        const interaction = parseFailedInteractionMeasurement(description);
        const paint = parseFailedPaintMeasurement(description);
        if (interaction) this.failedInteractionMeasurements.push(interaction);
        if (paint) this.failedPaintMeasurements.push(paint);
      }
      return;
    }
    if (annotations.length !== 1) {
      this.policyViolationCount += 1;
      return;
    }
    const record = parseRecord(annotations[0]?.description);
    if (!record) {
      this.policyViolationCount += 1;
      return;
    }
    this.records.push(record);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] }> {
    let identityViolationCount = 0;
    let identityBefore: PerformanceIdentityCapture | undefined;
    let server: PerformanceServerIdentity | undefined;
    try {
      identityBefore = await this.identityBefore;
      const parsed = JSON.parse(await readFile(SERVER_IDENTITY_PATH, 'utf8')) as unknown;
      server = serverIdentity(parsed);
      const identityAfter = await capturePerformanceIdentity();
      if (
        !identityBefore ||
        !server ||
        !sameCapture(identityBefore, identityAfter) ||
        !sameClientIdentity(server.optimizedClient, identityBefore.optimizedClient) ||
        !reducedSourceMatches(server, identityBefore.source)
      ) {
        identityViolationCount += 1;
      }
    } catch {
      identityViolationCount += 1;
    }
    const keys = new Set(this.records.map((record) => `${record.project}:${record.case}`));
    const complete =
      this.records.length === 4 &&
      keys.size === 4 &&
      [...EXPECTED_PROJECTS].every((project) =>
        [...EXPECTED_CASES].every((caseName) => keys.has(`${project}:${caseName}`)),
      );
    const passed =
      result.status === 'passed' &&
      this.failureCount === 0 &&
      this.policyViolationCount === 0 &&
      identityViolationCount === 0 &&
      complete;
    const report = {
      schemaVersion: 'airspace-browser-performance.v1',
      result: passed ? 'pass' : 'fail',
      completedAt: new Date().toISOString(),
      source: server?.source ?? null,
      optimizedClient: server?.optimizedClient ?? null,
      map: server?.map ?? null,
      policy: server?.policy ?? null,
      environment: {
        runtime: 'local-optimized-source-harness',
        buildMode: 'performance',
        nodeEnvironment: 'production',
        inheritedViteVariables: 'rejected',
        nodeVersion: process.versions.node,
        operatingSystem: process.platform,
        architecture: process.arch,
        cpuModel: (cpus()[0]?.model ?? 'unknown').slice(0, 128),
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        projects: [...EXPECTED_PROJECTS].sort(),
        retainedCandidate: false,
        selectedByteEvidence: false,
        releaseGate: 'R3-local-only',
        projectProfiles: {
          'performance-desktop': {
            emulation: 'Playwright Desktop Chrome profile',
            physicalDevice: false,
            cpuThrottleRate: 1,
            networkThrottle: 'none',
          },
          'performance-mobile': {
            emulation: 'Playwright Pixel 5 viewport and user-agent profile',
            physicalDevice: false,
            cpuThrottleRate: 1,
            networkThrottle: 'none',
          },
        },
      },
      measurement: {
        timerStart: 'after successful Live wire serialization and protocol validation',
        timerEnd:
          'after React DOM two-frame stabilization and matching MapLibre idle plus one presented animation frame',
        paintWarmups: PERFORMANCE_LIMITS.paintWarmups,
        paintMeasuredIterations: PERFORMANCE_LIMITS.paintIterations,
        paintState: 'warm map, warm application, sequential validated snapshots',
        maximumState: `warm map, 100 quality-queue receipts, ${RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft} clean history receipts, then one near-limit maximum paint`,
        heapMetric:
          'Chromium performance.memory.usedJSHeapSize with precise-memory-info; JavaScript heap only, not total browser or platform memory',
        networkMetric:
          'Playwright BrowserContext response events summed by response Content-Length; aggregate response-body bytes only, including worker responses and excluding header overhead',
        ageTickMetric:
          'time-only Live session update followed by a committed React two-frame presentation; history collection, history object, and sample-array identities must be preserved',
        ageTickFixture:
          'the 500-entry reference audit fixture is prepared before timing; updateTime, identity checks, state publication, React commit, and two presentation frames are included',
        maximumInteractionWorkflow:
          'the 1,000 ms 2,000-record workflow ceiling applies to each named keyboard task; search begins before the first of six real key events and ends after the final one-row commit, including automation and host overhead',
      },
      dataset: {
        id: 'synthetic-browser-performance-v1',
        paintAircraft: RUNTIME_POLICY_LIMITS.history.maximumAircraft,
        maximumAircraft: RUNTIME_POLICY_LIMITS.protocol.maximumAircraft,
        historyWarmReceipts: RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft,
        qualityWarmReceipts: 100,
        maximumWireFraction: 0.96,
      },
      execution: {
        expectedCases: 4,
        completedCases: this.records.length,
        failedCases: this.failureCount,
        policyViolations: this.policyViolationCount,
        identityViolations: identityViolationCount,
      },
      privacy: {
        syntheticOnly: true,
        externalOriginsPermitted: 0,
        tracesRetained: false,
        screenshotsRetained: false,
        videosRetained: false,
        detailedFailureOutputRetained: false,
      },
      cases: this.records.sort((left, right) =>
        `${left.project}:${left.case}`.localeCompare(`${right.project}:${right.case}`, 'en'),
      ),
      failedInteractionMeasurements: this.failedInteractionMeasurements.sort((left, right) =>
        `${left.project}:${left.case}`.localeCompare(`${right.project}:${right.case}`, 'en'),
      ),
      failedPaintMeasurements: this.failedPaintMeasurements.sort((left, right) =>
        `${left.project}:${left.case}`.localeCompare(`${right.project}:${right.case}`, 'en'),
      ),
    };
    const output = await assertEvidenceOutputPlacement({
      repositoryRoot: REPOSITORY_ROOT,
      outputPath: OUTPUT_PATH,
      label: 'Browser performance aggregate report',
      allowedRepositoryRoots: ['test-results/live-performance'],
      protectedPaths: [
        PERFORMANCE_CLIENT_OUTDIR,
        join(REPOSITORY_ROOT, 'dist-live'),
        join(REPOSITORY_ROOT, 'dist-mock-staging'),
      ],
    });
    await mkdir(dirname(output), { recursive: true });
    await assertEvidenceOutputPlacement({
      repositoryRoot: REPOSITORY_ROOT,
      outputPath: output,
      label: 'Browser performance aggregate report',
      allowedRepositoryRoots: ['test-results/live-performance'],
      protectedPaths: [PERFORMANCE_CLIENT_OUTDIR],
    });
    const temporary = `${output}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, output);
    process.stdout.write(
      `Browser performance aggregate ${passed ? 'passed' : 'failed'}; ${this.records.length}/4 bounded case receipts.\n`,
    );
    return { status: passed ? result.status : 'failed' };
  }

  printsToStdio(): boolean {
    return true;
  }
}
