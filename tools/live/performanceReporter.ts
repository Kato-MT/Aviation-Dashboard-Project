import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { runtimePolicyCanonicalJson } from '../../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import {
  createCompactPerformanceFailureReceipt,
  parseMaximumPerformanceFailureEvidence,
  parsePerformanceBrowserRuntimeIdentity,
  parsePerformanceMapIdentity,
  PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT,
  PERFORMANCE_PROJECT_NAMES,
  PERFORMANCE_REPORT_MAX_BYTES,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  performanceProjectConfigurationFailureCodes,
  performanceResultProjectFailureCodes,
  privacySafePerformanceRunnerMetadata,
  requirePerformanceRunPaths,
  type ExpectedPerformanceMapIdentity,
  type MaximumPerformanceFailureEvidence,
  type PerformanceBrowserRuntimeIdentity,
  type PerformanceConcurrencyBucket,
  type PerformanceIdentityCapture,
  type PerformanceServerIdentity,
} from './performanceContract';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PERFORMANCE_RUN_PATHS = requirePerformanceRunPaths(REPOSITORY_ROOT, process.env);
const MAP_MANIFEST_PATH = join(REPOSITORY_ROOT, 'maps', 'manifest.json');
const IDENTITY_HELPER = fileURLToPath(new URL('./capturePerformanceIdentity.ts', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const SERVER_IDENTITY_PATH = PERFORMANCE_RUN_PATHS.serverIdentity;
const OUTPUT_PATH = PERFORMANCE_RUN_PATHS.stagedReport;
const PERFORMANCE_TEST_FILE = join(REPOSITORY_ROOT, 'tests', 'live-browser', 'performance.spec.ts');
const PROJECTS = PERFORMANCE_PROJECT_NAMES;
const CASES = ['paint-500', 'maximum-2000'] as const;
const CASE_BY_EXACT_TITLE = new Map<string, (typeof CASES)[number]>([
  [
    '500-aircraft validated snapshots reach the stable linked render barrier within the p95 budget',
    'paint-500',
  ],
  [
    'near-limit 2,000-record maximum preserves bounded history and complete keyboard workflows',
    'maximum-2000',
  ],
]);
const INTERACTIONS = ['search', 'select', 'sort', 'close', 'scroll'] as const;
const EXPECTED_PROJECTS = new Set<string>(PROJECTS);
const EXPECTED_CASES = new Set<string>(CASES);
const PERFORMANCE_LIMITS = RUNTIME_POLICY_LIMITS.browser.performance;
const PAINT_SAMPLES_PER_BLOCK = PERFORMANCE_LIMITS.paintIterations / PERFORMANCE_LIMITS.paintBlocks;
const MAXIMUM_P95_OUTLIERS =
  PERFORMANCE_LIMITS.paintIterations - Math.ceil(PERFORMANCE_LIMITS.paintIterations * 0.95);
const MAXIMUM_INTERACTION_P95_OUTLIERS =
  PERFORMANCE_LIMITS.interactionIterations -
  Math.ceil(PERFORMANCE_LIMITS.interactionIterations * 0.95);
const MAXIMUM_ANNOTATION_BYTES = 64 * 1024;

export function performanceReporterOutputPath(): string {
  return OUTPUT_PATH;
}

type ProjectName = (typeof PROJECTS)[number];
type InteractionName = (typeof INTERACTIONS)[number];

export interface PerformanceTestInventoryEntry {
  readonly id: string;
  readonly project: ProjectName;
  readonly case: (typeof CASES)[number];
  readonly title: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly repeatEachIndex: 0;
  readonly retries: 0;
}

export function performanceTestInventoryEntryFor(
  test: TestCase,
): PerformanceTestInventoryEntry | undefined {
  const project = test.parent.project();
  const projectNameValue = projectName(project?.name);
  const caseName = CASE_BY_EXACT_TITLE.get(test.title);
  const file = resolve(test.location.file);
  if (
    project === undefined ||
    projectNameValue === undefined ||
    caseName === undefined ||
    file !== PERFORMANCE_TEST_FILE ||
    !Number.isSafeInteger(test.location.line) ||
    test.location.line < 1 ||
    !Number.isSafeInteger(test.location.column) ||
    test.location.column < 1 ||
    test.repeatEachIndex !== 0 ||
    test.retries !== 0 ||
    performanceResultProjectFailureCodes(project, projectNameValue).length > 0
  ) {
    return undefined;
  }
  return {
    id: test.id,
    project: projectNameValue,
    case: caseName,
    title: test.title,
    file,
    line: test.location.line,
    column: test.location.column,
    repeatEachIndex: 0,
    retries: 0,
  };
}

export function performanceEvidenceMatchesTestInventory(
  inventory: PerformanceTestInventoryEntry,
  evidence: Readonly<{ project: unknown; case: unknown }>,
): boolean {
  return evidence.project === inventory.project && evidence.case === inventory.case;
}

function sameTestInventoryEntry(
  left: PerformanceTestInventoryEntry,
  right: PerformanceTestInventoryEntry,
): boolean {
  return (
    left.id === right.id &&
    left.project === right.project &&
    left.case === right.case &&
    left.title === right.title &&
    left.file === right.file &&
    left.line === right.line &&
    left.column === right.column &&
    left.repeatEachIndex === right.repeatEachIndex &&
    left.retries === right.retries
  );
}

interface PaintNetworkEvidence {
  readonly coldNavigationResponseBodyBytes: number;
  readonly coldScriptResponseBodyBytes: number;
  readonly coldStyleResponseBodyBytes: number;
  readonly coldFontResponseBodyBytes: number;
  readonly coldMapResponseBodyBytes: number;
  readonly coldOtherResponseBodyBytes: number;
  readonly coldTotalResponseBodyBytes: number;
  readonly coldResponseBodyLimitBytes: number;
  readonly responseCount: number;
  readonly unmeasuredResponseCount: number;
}

interface MaximumNetworkEvidence {
  readonly resourceResponseBodyBytes: number;
  readonly navigationResponseBodyBytes: number;
  readonly totalResponseBodyBytes: number;
  readonly responseBodyLimitBytes: number;
  readonly responseCount: number;
  readonly unmeasuredResponseCount: number;
}

interface EnvironmentControlEvidence {
  readonly metric: 'two-animation-frame-scheduling-delay';
  readonly samplesPerBlock: number;
  readonly blocksMs: readonly (readonly number[])[];
  readonly comparisonEligible: false;
  readonly baselineRunCount: 0;
}

interface PaintEvidence {
  readonly schemaVersion: 'airspace-performance-case.v3';
  readonly case: 'paint-500';
  readonly project: ProjectName;
  readonly performanceProfileId: typeof PERFORMANCE_LIMITS.performanceProfileId;
  readonly paintWarmups: number;
  readonly paintIterations: number;
  readonly paintBlocks: number;
  readonly paintSamplesPerBlock: number;
  readonly paintP95LimitMs: number;
  readonly paintDurationSamplesMs: readonly number[];
  readonly domStableDurationSamplesMs: readonly number[];
  readonly mapStableDurationSamplesMs: readonly number[];
  readonly validationDurationSamplesMs: readonly number[];
  readonly wireByteSamples: readonly number[];
  readonly environmentControl: EnvironmentControlEvidence;
  readonly runtimeIdentity: PerformanceBrowserRuntimeIdentity;
  readonly network: PaintNetworkEvidence;
}

interface MaximumEvidence {
  readonly schemaVersion: 'airspace-performance-case.v3';
  readonly case: 'maximum-2000';
  readonly project: ProjectName;
  readonly performanceProfileId: typeof PERFORMANCE_LIMITS.performanceProfileId;
  readonly preparation: {
    readonly qualityReceipts: number;
    readonly qualityEventsGenerated: number;
    readonly qualityEventsRetained: number;
    readonly qualityTailWindowVerified: boolean;
    readonly historyReceipts: number;
    readonly totalReceipts: number;
    readonly durationMs: number;
  };
  readonly maximumPaint: {
    readonly durationMs: number;
    readonly domStableDurationMs: number;
    readonly mapStableDurationMs: number;
    readonly validationDurationMs: number;
    readonly wireBytes: number;
    readonly wireLimitBytes: number;
    readonly maximumHistorySamples: number;
    readonly minimumHistorySamples: number;
    readonly historiesAtMaximum: number;
  };
  readonly interactionWarmups: number;
  readonly interactionIterations: number;
  readonly interactionP95LimitMs: number;
  readonly interactionSamplesMs: Readonly<Record<InteractionName, readonly number[]>>;
  readonly ageTick: {
    readonly durationMs: number;
    readonly limitMs: number;
    readonly jsHeapDeltaBytes: number;
    readonly jsHeapGrowthLimitBytes: number;
    readonly historiesMapPreserved: boolean;
    readonly trailsMapPreserved: boolean;
    readonly historyObjectsPreserved: boolean;
    readonly sampleArraysPreserved: boolean;
    readonly historyAircraft: number;
    readonly historySamples: number;
  };
  readonly browserJsHeapBytes: number;
  readonly browserJsHeapLimitBytes: number;
  readonly network: MaximumNetworkEvidence;
  readonly runtimeIdentity: PerformanceBrowserRuntimeIdentity;
}

type PerformanceEvidence = PaintEvidence | MaximumEvidence;

interface SampleStatistics {
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
  readonly overBudgetSamples: number;
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

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function sampleArray(
  value: unknown,
  expectedLength: number,
  minimum = 0,
  maximum = 30_000,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === expectedLength &&
    value.every((sample) => boundedNumber(sample, minimum, maximum))
  );
}

function interactionSampleRecord(value: unknown): value is Record<InteractionName, number[]> {
  return (
    isRecord(value) &&
    exactKeys(value, INTERACTIONS) &&
    INTERACTIONS.every((name) => sampleArray(value[name], PERFORMANCE_LIMITS.interactionIterations))
  );
}

function projectName(value: unknown): ProjectName | undefined {
  return typeof value === 'string' && EXPECTED_PROJECTS.has(value)
    ? (value as ProjectName)
    : undefined;
}

function paintP95Limit(project: ProjectName): number {
  return project === 'performance-desktop'
    ? PERFORMANCE_LIMITS.paintP95Ms.desktop
    : PERFORMANCE_LIMITS.paintP95Ms.mobile;
}

function interactionP95Limit(project: ProjectName): number {
  return project === 'performance-desktop'
    ? PERFORMANCE_LIMITS.interactionP95Ms.desktop
    : PERFORMANCE_LIMITS.interactionP95Ms.mobile;
}

function ageTickLimit(project: ProjectName): number {
  return project === 'performance-desktop'
    ? PERFORMANCE_LIMITS.ageTickLimitMs.desktop
    : PERFORMANCE_LIMITS.ageTickLimitMs.mobile;
}

function parseEnvironmentControl(value: unknown): EnvironmentControlEvidence | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'metric',
      'samplesPerBlock',
      'blocksMs',
      'comparisonEligible',
      'baselineRunCount',
    ]) ||
    value.metric !== 'two-animation-frame-scheduling-delay' ||
    !boundedInteger(value.samplesPerBlock, 1, 100) ||
    !Array.isArray(value.blocksMs) ||
    value.blocksMs.length !== PERFORMANCE_LIMITS.paintBlocks + 1 ||
    !value.blocksMs.every((block) =>
      sampleArray(block, value.samplesPerBlock as number, 0, 30_000),
    ) ||
    value.comparisonEligible !== false ||
    value.baselineRunCount !== 0
  ) {
    return undefined;
  }
  return value as unknown as EnvironmentControlEvidence;
}

function parsePaintNetwork(value: unknown): PaintNetworkEvidence | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'coldNavigationResponseBodyBytes',
      'coldScriptResponseBodyBytes',
      'coldStyleResponseBodyBytes',
      'coldFontResponseBodyBytes',
      'coldMapResponseBodyBytes',
      'coldOtherResponseBodyBytes',
      'coldTotalResponseBodyBytes',
      'coldResponseBodyLimitBytes',
      'responseCount',
      'unmeasuredResponseCount',
    ]) ||
    value.coldResponseBodyLimitBytes !== PERFORMANCE_LIMITS.responseBodyBytes ||
    !boundedNumber(
      value.coldNavigationResponseBodyBytes,
      1,
      PERFORMANCE_LIMITS.responseBodyBytes,
    ) ||
    !boundedNumber(value.coldScriptResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.coldStyleResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.coldFontResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.coldMapResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.coldOtherResponseBodyBytes, 0, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.responseCount, 1, 100_000) ||
    value.unmeasuredResponseCount !== 0
  ) {
    return undefined;
  }
  const total =
    (value.coldNavigationResponseBodyBytes as number) +
    (value.coldScriptResponseBodyBytes as number) +
    (value.coldStyleResponseBodyBytes as number) +
    (value.coldFontResponseBodyBytes as number) +
    (value.coldMapResponseBodyBytes as number) +
    (value.coldOtherResponseBodyBytes as number);
  if (
    value.coldTotalResponseBodyBytes !== total ||
    total > (value.coldResponseBodyLimitBytes as number)
  ) {
    return undefined;
  }
  return value as unknown as PaintNetworkEvidence;
}

function parseMaximumNetwork(value: unknown): MaximumNetworkEvidence | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'resourceResponseBodyBytes',
      'navigationResponseBodyBytes',
      'totalResponseBodyBytes',
      'responseBodyLimitBytes',
      'responseCount',
      'unmeasuredResponseCount',
    ]) ||
    value.responseBodyLimitBytes !== PERFORMANCE_LIMITS.responseBodyBytes ||
    !boundedNumber(value.resourceResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.navigationResponseBodyBytes, 1, PERFORMANCE_LIMITS.responseBodyBytes) ||
    !boundedNumber(value.responseCount, 1, 100_000) ||
    value.unmeasuredResponseCount !== 0 ||
    value.totalResponseBodyBytes !==
      (value.resourceResponseBodyBytes as number) + (value.navigationResponseBodyBytes as number) ||
    (value.totalResponseBodyBytes as number) > (value.responseBodyLimitBytes as number)
  ) {
    return undefined;
  }
  return value as unknown as MaximumNetworkEvidence;
}

function parsePaintEvidence(value: Record<string, unknown>): PaintEvidence | undefined {
  const project = projectName(value.project);
  const runtimeIdentity = parsePerformanceBrowserRuntimeIdentity(value.runtimeIdentity);
  const environmentControl = parseEnvironmentControl(value.environmentControl);
  const network = parsePaintNetwork(value.network);
  if (
    !exactKeys(value, [
      'schemaVersion',
      'case',
      'project',
      'performanceProfileId',
      'paintWarmups',
      'paintIterations',
      'paintBlocks',
      'paintSamplesPerBlock',
      'paintP95LimitMs',
      'paintDurationSamplesMs',
      'domStableDurationSamplesMs',
      'mapStableDurationSamplesMs',
      'validationDurationSamplesMs',
      'wireByteSamples',
      'environmentControl',
      'runtimeIdentity',
      'network',
    ]) ||
    value.schemaVersion !== 'airspace-performance-case.v3' ||
    value.case !== 'paint-500' ||
    project === undefined ||
    value.performanceProfileId !== PERFORMANCE_LIMITS.performanceProfileId ||
    value.paintWarmups !== PERFORMANCE_LIMITS.paintWarmups ||
    value.paintIterations !== PERFORMANCE_LIMITS.paintIterations ||
    value.paintBlocks !== PERFORMANCE_LIMITS.paintBlocks ||
    value.paintSamplesPerBlock !== PAINT_SAMPLES_PER_BLOCK ||
    value.paintP95LimitMs !== paintP95Limit(project) ||
    !sampleArray(value.paintDurationSamplesMs, PERFORMANCE_LIMITS.paintIterations) ||
    !sampleArray(value.domStableDurationSamplesMs, PERFORMANCE_LIMITS.paintIterations) ||
    !sampleArray(value.mapStableDurationSamplesMs, PERFORMANCE_LIMITS.paintIterations) ||
    !sampleArray(
      value.validationDurationSamplesMs,
      PERFORMANCE_LIMITS.paintIterations,
      0,
      60_000,
    ) ||
    !sampleArray(
      value.wireByteSamples,
      PERFORMANCE_LIMITS.paintIterations,
      1,
      MAX_LIVE_MESSAGE_BYTES,
    ) ||
    runtimeIdentity === undefined ||
    environmentControl === undefined ||
    network === undefined
  ) {
    return undefined;
  }
  const paints = value.paintDurationSamplesMs;
  const dom = value.domStableDurationSamplesMs;
  const map = value.mapStableDurationSamplesMs;
  if (
    paints.some(
      (duration, index) =>
        (dom[index] as number) > duration || (map[index] as number) > duration + 1,
    )
  ) {
    return undefined;
  }
  return value as unknown as PaintEvidence;
}

function parseMaximumEvidence(value: Record<string, unknown>): MaximumEvidence | undefined {
  const project = projectName(value.project);
  const runtimeIdentity = parsePerformanceBrowserRuntimeIdentity(value.runtimeIdentity);
  const network = parseMaximumNetwork(value.network);
  if (
    !exactKeys(value, [
      'schemaVersion',
      'case',
      'project',
      'performanceProfileId',
      'preparation',
      'maximumPaint',
      'interactionWarmups',
      'interactionIterations',
      'interactionP95LimitMs',
      'interactionSamplesMs',
      'ageTick',
      'browserJsHeapBytes',
      'browserJsHeapLimitBytes',
      'network',
      'runtimeIdentity',
    ]) ||
    value.schemaVersion !== 'airspace-performance-case.v3' ||
    value.case !== 'maximum-2000' ||
    project === undefined ||
    value.performanceProfileId !== PERFORMANCE_LIMITS.performanceProfileId ||
    value.interactionWarmups !== PERFORMANCE_LIMITS.interactionWarmups ||
    value.interactionIterations !== PERFORMANCE_LIMITS.interactionIterations ||
    value.interactionP95LimitMs !== interactionP95Limit(project) ||
    !isRecord(value.preparation) ||
    !exactKeys(value.preparation, [
      'qualityReceipts',
      'qualityEventsGenerated',
      'qualityEventsRetained',
      'qualityTailWindowVerified',
      'historyReceipts',
      'totalReceipts',
      'durationMs',
    ]) ||
    value.preparation.qualityReceipts !== 100 ||
    value.preparation.qualityEventsGenerated !== 250 ||
    value.preparation.qualityEventsRetained !==
      RUNTIME_POLICY_LIMITS.history.maximumQualityEvents ||
    value.preparation.qualityTailWindowVerified !== true ||
    value.preparation.historyReceipts !== RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    value.preparation.totalReceipts !==
      100 + RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    !boundedNumber(value.preparation.durationMs, 0, 120_000) ||
    !isRecord(value.maximumPaint) ||
    !exactKeys(value.maximumPaint, [
      'durationMs',
      'domStableDurationMs',
      'mapStableDurationMs',
      'validationDurationMs',
      'wireBytes',
      'wireLimitBytes',
      'maximumHistorySamples',
      'minimumHistorySamples',
      'historiesAtMaximum',
    ]) ||
    !boundedNumber(value.maximumPaint.durationMs, 0, 30_000) ||
    !boundedNumber(
      value.maximumPaint.domStableDurationMs,
      0,
      value.maximumPaint.durationMs as number,
    ) ||
    !boundedNumber(
      value.maximumPaint.mapStableDurationMs,
      0,
      (value.maximumPaint.durationMs as number) + 1,
    ) ||
    !boundedNumber(value.maximumPaint.validationDurationMs, 0, 60_000) ||
    value.maximumPaint.wireLimitBytes !== MAX_LIVE_MESSAGE_BYTES ||
    !boundedNumber(
      value.maximumPaint.wireBytes,
      Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.95),
      MAX_LIVE_MESSAGE_BYTES,
    ) ||
    value.maximumPaint.maximumHistorySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    value.maximumPaint.minimumHistorySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    value.maximumPaint.historiesAtMaximum !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
    !interactionSampleRecord(value.interactionSamplesMs) ||
    !isRecord(value.ageTick) ||
    !exactKeys(value.ageTick, [
      'durationMs',
      'limitMs',
      'jsHeapDeltaBytes',
      'jsHeapGrowthLimitBytes',
      'historiesMapPreserved',
      'trailsMapPreserved',
      'historyObjectsPreserved',
      'sampleArraysPreserved',
      'historyAircraft',
      'historySamples',
    ]) ||
    value.ageTick.limitMs !== ageTickLimit(project) ||
    !boundedNumber(value.ageTick.durationMs, 0, value.ageTick.limitMs as number) ||
    value.ageTick.jsHeapGrowthLimitBytes !== PERFORMANCE_LIMITS.ageTickJsHeapGrowthBytes ||
    !boundedNumber(
      value.ageTick.jsHeapDeltaBytes,
      -PERFORMANCE_LIMITS.browserJsHeapBytes,
      PERFORMANCE_LIMITS.ageTickJsHeapGrowthBytes,
    ) ||
    value.ageTick.historiesMapPreserved !== true ||
    value.ageTick.trailsMapPreserved !== true ||
    value.ageTick.historyObjectsPreserved !== true ||
    value.ageTick.sampleArraysPreserved !== true ||
    value.ageTick.historyAircraft !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
    value.ageTick.historySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumAircraft *
        RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    value.browserJsHeapLimitBytes !== PERFORMANCE_LIMITS.browserJsHeapBytes ||
    !boundedNumber(value.browserJsHeapBytes, 1, PERFORMANCE_LIMITS.browserJsHeapBytes) ||
    runtimeIdentity === undefined ||
    network === undefined
  ) {
    return undefined;
  }
  return value as unknown as MaximumEvidence;
}

function parseEvidence(description: string | undefined): PerformanceEvidence | undefined {
  if (
    description === undefined ||
    Buffer.byteLength(description, 'utf8') > MAXIMUM_ANNOTATION_BYTES
  ) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(description) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.case !== 'string' || !EXPECTED_CASES.has(value.case)) {
    return undefined;
  }
  return value.case === 'paint-500' ? parsePaintEvidence(value) : parseMaximumEvidence(value);
}

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1]!;
}

function statistics(values: readonly number[], limitMs: number): SampleStatistics {
  return {
    minimumMs: Math.min(...values),
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maximumMs: Math.max(...values),
    overBudgetSamples: values.filter((sample) => sample > limitMs).length,
  };
}

function diagnosticStatistics(values: readonly number[]) {
  return {
    minimumMs: Math.min(...values),
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maximumMs: Math.max(...values),
  };
}

function buildControlReport(evidence: EnvironmentControlEvidence, productBudgetPassed: boolean) {
  const positions = [
    'before-product-block-1',
    'between-product-blocks-1-and-2',
    'between-product-blocks-2-and-3',
    'after-product-block-3',
  ] as const;
  return {
    metric: evidence.metric,
    diagnosticOnly: true,
    comparisonEligible: false,
    baselineRunCount: 0,
    failureClass: productBudgetPassed
      ? 'not-applicable-product-pass'
      : 'unclassified-no-control-baseline',
    samplesPerBlock: evidence.samplesPerBlock,
    blocks: evidence.blocksMs.map((samplesMs, index) => ({
      block: index + 1,
      position: positions[index],
      samplesMs,
      statistics: diagnosticStatistics(samplesMs),
    })),
  };
}

function buildPaintReport(evidence: PaintEvidence, runtimeIdentityId: string) {
  const aggregate = statistics(evidence.paintDurationSamplesMs, evidence.paintP95LimitMs);
  const budgetPassed =
    aggregate.p95Ms <= evidence.paintP95LimitMs &&
    aggregate.overBudgetSamples <= MAXIMUM_P95_OUTLIERS;
  const blocks = Array.from({ length: evidence.paintBlocks }, (_, index) => {
    const offset = index * evidence.paintSamplesPerBlock;
    const samplesMs = evidence.paintDurationSamplesMs.slice(
      offset,
      offset + evidence.paintSamplesPerBlock,
    );
    const blockStatistics = statistics(samplesMs, evidence.paintP95LimitMs);
    return {
      block: index + 1,
      sampleStartIndex: offset,
      sampleCount: evidence.paintSamplesPerBlock,
      p50Ms: blockStatistics.p50Ms,
      p95Ms: blockStatistics.p95Ms,
      maximumMs: blockStatistics.maximumMs,
      outlierCount: blockStatistics.overBudgetSamples,
    };
  });
  return {
    case: evidence.case,
    project: evidence.project,
    performanceProfileId: evidence.performanceProfileId,
    paintWarmups: evidence.paintWarmups,
    paintIterations: evidence.paintIterations,
    paintBlocks: evidence.paintBlocks,
    paintSamplesPerBlock: evidence.paintSamplesPerBlock,
    paintP95LimitMs: evidence.paintP95LimitMs,
    rawSamples: {
      paintDurationMs: evidence.paintDurationSamplesMs,
      domStableDurationMs: evidence.domStableDurationSamplesMs,
      mapStableDurationMs: evidence.mapStableDurationSamplesMs,
      validationDurationMs: evidence.validationDurationSamplesMs,
      wireBytes: evidence.wireByteSamples,
    },
    statistics: {
      ...aggregate,
      domStableP95Ms: nearestRank(evidence.domStableDurationSamplesMs, 0.95),
      mapStableP95Ms: nearestRank(evidence.mapStableDurationSamplesMs, 0.95),
      validationP95Ms: nearestRank(evidence.validationDurationSamplesMs, 0.95),
      minimumWireBytes: Math.min(...evidence.wireByteSamples),
      maximumWireBytes: Math.max(...evidence.wireByteSamples),
    },
    blocks,
    environmentControl: buildControlReport(evidence.environmentControl, budgetPassed),
    runtimeIdentityId,
    network: evidence.network,
    budgetPassed,
  };
}

function buildMaximumReport(evidence: MaximumEvidence, runtimeIdentityId: string) {
  const interactions = {} as Record<
    InteractionName,
    {
      samplesMs: readonly number[];
      minimumMs: number;
      p50Ms: number;
      p95Ms: number;
      maximumMs: number;
      overBudgetSamples: number;
      budgetPassed: boolean;
    }
  >;
  const interactionP95Ms = {} as Record<InteractionName, number>;
  for (const name of INTERACTIONS) {
    const samplesMs = evidence.interactionSamplesMs[name];
    const summary = statistics(samplesMs, evidence.interactionP95LimitMs);
    const budgetPassed =
      summary.p95Ms <= evidence.interactionP95LimitMs &&
      summary.overBudgetSamples <= MAXIMUM_INTERACTION_P95_OUTLIERS;
    interactions[name] = { samplesMs, ...summary, budgetPassed };
    interactionP95Ms[name] = summary.p95Ms;
  }
  const budgetPassed = INTERACTIONS.every((name) => interactions[name].budgetPassed);
  return {
    case: evidence.case,
    project: evidence.project,
    performanceProfileId: evidence.performanceProfileId,
    preparation: evidence.preparation,
    maximumPaint: evidence.maximumPaint,
    interactionWarmups: evidence.interactionWarmups,
    interactionIterations: evidence.interactionIterations,
    interactionP95LimitMs: evidence.interactionP95LimitMs,
    interactionP95Ms,
    interactions,
    maximumInteractionMs: Math.max(
      ...INTERACTIONS.flatMap((name) => evidence.interactionSamplesMs[name]),
    ),
    ageTick: evidence.ageTick,
    browserJsHeapBytes: evidence.browserJsHeapBytes,
    browserJsHeapLimitBytes: evidence.browserJsHeapLimitBytes,
    network: evidence.network,
    runtimeIdentityId,
    budgetPassed,
  };
}

async function loadExpectedMapIdentity(): Promise<ExpectedPerformanceMapIdentity> {
  const manifest = JSON.parse(await readFile(MAP_MANIFEST_PATH, 'utf8')) as unknown;
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 'map-assets.v1' ||
    typeof manifest.id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(manifest.id) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    (manifest.totalBytes as number) < 0 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length < 1
  ) {
    throw new Error('Performance map manifest contract is invalid.');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const asset of manifest.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.path !== 'string' ||
      asset.path.length < 1 ||
      paths.has(asset.path) ||
      !Number.isSafeInteger(asset.bytes) ||
      (asset.bytes as number) < 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new Error('Performance map manifest asset contract is invalid.');
    }
    paths.add(asset.path);
    totalBytes += asset.bytes as number;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error('Performance map manifest byte total is invalid.');
    }
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error('Performance map manifest byte total does not match its assets.');
  }
  return {
    id: manifest.id,
    fileCount: manifest.assets.length,
    totalBytes,
  };
}

export function parsePerformanceServerIdentity(
  value: unknown,
  expectedMap: ExpectedPerformanceMapIdentity,
): PerformanceServerIdentity | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient', 'map', 'policy']) ||
    value.schemaVersion !== 'airspace-performance-server.v1'
  ) {
    return undefined;
  }
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
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(source.head) ||
    typeof source.dirty !== 'boolean' ||
    typeof source.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(source.contentSha256) ||
    client.schemaVersion !== 'sha256-file-inventory.v1' ||
    !Number.isSafeInteger(client.fileCount) ||
    (client.fileCount as number) < 0 ||
    !Number.isSafeInteger(client.totalBytes) ||
    (client.totalBytes as number) < 0 ||
    typeof client.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(client.sha256) ||
    parsePerformanceMapIdentity(map, expectedMap) === undefined ||
    policy.limitsSha256 !== expectedLimitsSha256 ||
    runtimePolicyCanonicalJson(policy.limits) !== runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS)
  ) {
    return undefined;
  }
  return value as unknown as PerformanceServerIdentity;
}

export function parsePerformanceIdentityCapture(
  value: unknown,
  expectedMap: ExpectedPerformanceMapIdentity,
): PerformanceIdentityCapture | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient', 'map']) ||
    value.schemaVersion !== 'airspace-performance-identity-capture.v2' ||
    !isRecord(value.source) ||
    !isRecord(value.optimizedClient) ||
    !isRecord(value.map) ||
    !exactKeys(value.source, ['head', 'dirty', 'contentSha256']) ||
    !exactKeys(value.optimizedClient, ['schemaVersion', 'fileCount', 'totalBytes', 'sha256']) ||
    !exactKeys(value.map, ['id', 'fileCount', 'totalBytes', 'sha256']) ||
    typeof value.source.head !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.source.head) ||
    typeof value.source.dirty !== 'boolean' ||
    typeof value.source.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.source.contentSha256) ||
    value.optimizedClient.schemaVersion !== 'sha256-file-inventory.v1' ||
    !Number.isSafeInteger(value.optimizedClient.fileCount) ||
    (value.optimizedClient.fileCount as number) < 0 ||
    !Number.isSafeInteger(value.optimizedClient.totalBytes) ||
    (value.optimizedClient.totalBytes as number) < 0 ||
    typeof value.optimizedClient.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.optimizedClient.sha256) ||
    parsePerformanceMapIdentity(value.map, expectedMap) === undefined
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
  const [{ stdout, stderr }, expectedMap] = await Promise.all([
    execFileAsync(process.execPath, [TSX_CLI, IDENTITY_HELPER], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }),
    loadExpectedMapIdentity(),
  ]);
  if (stderr.trim().length > 0 || stdout.length > 64 * 1024) {
    throw new Error('Performance identity helper emitted an invalid response.');
  }
  const capture = parsePerformanceIdentityCapture(JSON.parse(stdout) as unknown, expectedMap);
  if (capture === undefined) {
    throw new Error('Performance identity helper returned an invalid receipt.');
  }
  return capture;
}

const execFileAsync = promisify(execFile);

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

function sameMapIdentity(
  left: PerformanceServerIdentity['map'],
  right: PerformanceServerIdentity['map'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function concurrencyBucket(value: number): PerformanceConcurrencyBucket {
  if (value <= 2) return '1-2';
  if (value <= 4) return '3-4';
  if (value <= 8) return '5-8';
  if (value <= 16) return '9-16';
  if (value <= 32) return '17-32';
  return '33+';
}

function memoryBucket(
  bytes: number,
): '<8 GiB' | '8-15 GiB' | '16-31 GiB' | '32-63 GiB' | '64+ GiB' {
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes < 8) return '<8 GiB';
  if (gibibytes < 16) return '8-15 GiB';
  if (gibibytes < 32) return '16-31 GiB';
  if (gibibytes < 64) return '32-63 GiB';
  return '64+ GiB';
}

function assessEnvironmentEligibility(
  identities: readonly PerformanceBrowserRuntimeIdentity[],
  hostArchitecture: string,
  logicalCpuCount: number,
  memoryBytes: number,
  configurationFailureCodes: readonly string[],
  projectRuntimeIdentityIds: ReadonlyMap<ProjectName, string>,
) {
  const failureCodes: string[] = [...configurationFailureCodes];
  if (
    !PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT.supportedHostArchitectures.includes(
      hostArchitecture as 'x64' | 'arm64',
    )
  ) {
    failureCodes.push('HOST_ARCHITECTURE_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(logicalCpuCount) || logicalCpuCount < 1) {
    failureCodes.push('HOST_CPU_BUCKET_UNAVAILABLE');
  }
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    failureCodes.push('HOST_MEMORY_BUCKET_UNAVAILABLE');
  }
  if (identities.length === 0) failureCodes.push('BROWSER_IDENTITY_MISSING');
  if (
    projectRuntimeIdentityIds.size !== PROJECTS.length ||
    PROJECTS.some((project) => !projectRuntimeIdentityIds.has(project))
  ) {
    failureCodes.push('PROJECT_BROWSER_IDENTITY_MISSING');
  }
  for (const identity of identities) {
    if (identity.browserEngine !== PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT.browserEngine) {
      failureCodes.push('BROWSER_ENGINE_INELIGIBLE');
    }
    if (identity.browserBuild.split('/')[1] !== identity.browserVersion) {
      failureCodes.push('BROWSER_BUILD_MISMATCH');
    }
    if (identity.webGl.context === 'unavailable') {
      failureCodes.push('WEBGL_CONTEXT_UNAVAILABLE');
    }
    if (identity.webGl.rendererClass === 'unknown') {
      failureCodes.push('RENDERER_CLASS_UNAVAILABLE');
    }
  }
  return {
    contract: PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT,
    eligible: failureCodes.length === 0,
    failureCodes: [...new Set(failureCodes)].sort(),
  };
}

export default class AggregatePerformanceReporter implements Reporter {
  private readonly records: Array<
    ReturnType<typeof buildPaintReport> | ReturnType<typeof buildMaximumReport>
  > = [];
  private readonly failedInteractionMeasurements: Array<ReturnType<typeof buildMaximumReport>> = [];
  private readonly failedPaintMeasurements: Array<ReturnType<typeof buildPaintReport>> = [];
  private readonly failedCaseReceipts: MaximumPerformanceFailureEvidence[] = [];
  private readonly runtimeIdentities = new Map<
    string,
    { readonly id: string; readonly identity: PerformanceBrowserRuntimeIdentity }
  >();
  private readonly runtimeIdentityByProject = new Map<ProjectName, string>();
  private readonly testInventory = new Map<string, PerformanceTestInventoryEntry>();
  private failureCount = 0;
  private policyViolationCount = 0;
  private readonly configurationFailureCodes: string[] = [];
  private identityBefore?: Promise<PerformanceIdentityCapture>;

  onBegin(config: FullConfig, suite: Suite): void {
    if (config.workers !== PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT.playwrightWorkers) {
      this.configurationFailureCodes.push('PLAYWRIGHT_WORKER_COUNT_MISMATCH');
    }
    this.configurationFailureCodes.push(
      ...performanceProjectConfigurationFailureCodes(config.projects),
    );
    const discoveredTestKeys = new Set<string>();
    for (const test of suite.allTests()) {
      const identity = performanceTestInventoryEntryFor(test);
      if (identity === undefined || this.testInventory.has(identity.id)) {
        this.configurationFailureCodes.push('PLAYWRIGHT_TEST_INVENTORY_MISMATCH');
        continue;
      }
      this.testInventory.set(identity.id, identity);
      discoveredTestKeys.add(`${identity.project}:${identity.case}`);
    }
    if (
      this.testInventory.size !== PROJECTS.length * CASES.length ||
      discoveredTestKeys.size !== PROJECTS.length * CASES.length ||
      PROJECTS.some((project) =>
        CASES.some((caseName) => !discoveredTestKeys.has(`${project}:${caseName}`)),
      )
    ) {
      this.configurationFailureCodes.push('PLAYWRIGHT_TEST_INVENTORY_MISMATCH');
    }
    if (
      !isRecord(config.metadata) ||
      JSON.stringify(config.metadata.performanceEnvironmentEligibility) !==
        JSON.stringify(PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT)
    ) {
      this.configurationFailureCodes.push('PERFORMANCE_ENVIRONMENT_CONTRACT_MISMATCH');
    }
    const identityBefore = capturePerformanceIdentity();
    void identityBefore.catch(() => undefined);
    this.identityBefore = identityBefore;
  }

  private registerRuntimeIdentity(identity: PerformanceBrowserRuntimeIdentity): string {
    const key = JSON.stringify(identity);
    const existing = this.runtimeIdentities.get(key);
    if (existing !== undefined) return existing.id;
    const id = `runtime-${this.runtimeIdentities.size + 1}`;
    this.runtimeIdentities.set(key, { id, identity });
    return id;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const annotations = result.annotations.filter(
      (annotation) => annotation.type === 'performance-evidence',
    );
    if (result.status !== 'passed') this.failureCount += 1;
    const actualIdentity = performanceTestInventoryEntryFor(test);
    const inventoriedIdentity = this.testInventory.get(test.id);
    if (
      actualIdentity === undefined ||
      inventoriedIdentity === undefined ||
      !sameTestInventoryEntry(actualIdentity, inventoriedIdentity) ||
      result.retry !== 0
    ) {
      this.policyViolationCount += 1;
      return;
    }
    const actualProject = test.parent.project();
    if (annotations.length !== 1) {
      this.policyViolationCount += 1;
      return;
    }
    const description = annotations[0]?.description;
    const evidence = parseEvidence(description);
    if (evidence === undefined) {
      let failureReceipt: MaximumPerformanceFailureEvidence | undefined;
      try {
        failureReceipt = parseMaximumPerformanceFailureEvidence(
          description === undefined ||
            Buffer.byteLength(description, 'utf8') > MAXIMUM_ANNOTATION_BYTES
            ? undefined
            : (JSON.parse(description) as unknown),
        );
      } catch {
        failureReceipt = undefined;
      }
      if (
        result.status !== 'passed' &&
        failureReceipt !== undefined &&
        actualIdentity.case === 'maximum-2000' &&
        performanceResultProjectFailureCodes(actualProject, failureReceipt.project).length === 0
      ) {
        this.failedCaseReceipts.push(failureReceipt);
        return;
      }
      this.policyViolationCount += 1;
      return;
    }
    if (
      !performanceEvidenceMatchesTestInventory(actualIdentity, evidence) ||
      performanceResultProjectFailureCodes(actualProject, evidence.project).length > 0
    ) {
      this.policyViolationCount += 1;
      return;
    }
    const runtimeIdentityId = this.registerRuntimeIdentity(evidence.runtimeIdentity);
    const previousRuntimeIdentityId = this.runtimeIdentityByProject.get(actualIdentity.project);
    if (
      previousRuntimeIdentityId !== undefined &&
      previousRuntimeIdentityId !== runtimeIdentityId
    ) {
      this.policyViolationCount += 1;
    } else {
      this.runtimeIdentityByProject.set(actualIdentity.project, runtimeIdentityId);
    }
    const report =
      evidence.case === 'paint-500'
        ? buildPaintReport(evidence, runtimeIdentityId)
        : buildMaximumReport(evidence, runtimeIdentityId);
    if (result.status === 'passed') {
      if (!report.budgetPassed) {
        this.policyViolationCount += 1;
        return;
      }
      this.records.push(report);
    } else if (report.case === 'paint-500') {
      this.failedPaintMeasurements.push(report);
    } else {
      this.failedInteractionMeasurements.push(report);
    }
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] }> {
    let identityViolationCount = 0;
    let identityBefore: PerformanceIdentityCapture | undefined;
    let server: PerformanceServerIdentity | undefined;
    try {
      identityBefore = await this.identityBefore;
      const parsed = JSON.parse(await readFile(SERVER_IDENTITY_PATH, 'utf8')) as unknown;
      server = parsePerformanceServerIdentity(parsed, await loadExpectedMapIdentity());
      const identityAfter = await capturePerformanceIdentity();
      if (
        !identityBefore ||
        !server ||
        !sameCapture(identityBefore, identityAfter) ||
        !sameClientIdentity(server.optimizedClient, identityBefore.optimizedClient) ||
        !sameMapIdentity(server.map, identityBefore.map) ||
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
      PROJECTS.every((project) => CASES.every((caseName) => keys.has(`${project}:${caseName}`)));
    const hostCpus = cpus();
    const hostMemoryBytes = totalmem();
    const runtimeIdentityEntries = [...this.runtimeIdentities.values()].sort((left, right) =>
      left.id.localeCompare(right.id, 'en'),
    );
    const environmentEligibility = assessEnvironmentEligibility(
      runtimeIdentityEntries.map((entry) => entry.identity),
      process.arch,
      hostCpus.length,
      hostMemoryBytes,
      this.configurationFailureCodes,
      this.runtimeIdentityByProject,
    );
    const environmentViolationCount = environmentEligibility.eligible ? 0 : 1;
    let passed =
      result.status === 'passed' &&
      this.failureCount === 0 &&
      this.policyViolationCount === 0 &&
      identityViolationCount === 0 &&
      environmentViolationCount === 0 &&
      complete;
    const report = {
      schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
      performanceProfileId: PERFORMANCE_LIMITS.performanceProfileId,
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
        logicalCpuBucket: concurrencyBucket(hostCpus.length),
        memoryBucket: memoryBucket(hostMemoryBytes),
        runner: privacySafePerformanceRunnerMetadata(process.env),
        runtimeIdentities: runtimeIdentityEntries,
        projectRuntimeIdentityIds: Object.fromEntries(
          [...this.runtimeIdentityByProject.entries()].sort(([left], [right]) =>
            left.localeCompare(right, 'en'),
          ),
        ),
        eligibility: environmentEligibility,
        projects: [...PROJECTS],
        retainedCandidate: false,
        selectedByteEvidence: false,
        releaseGate: 'R3-local-only',
        softwareRenderingForcedByHarness: false,
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
        performanceProfileId: PERFORMANCE_LIMITS.performanceProfileId,
        timerStart: 'after successful Live wire serialization and protocol validation',
        timerEnd:
          'after React DOM two-frame stabilization and matching MapLibre idle plus a subsequent animation-frame callback; browser paint presentation is inferred, not directly observed',
        paintWarmups: PERFORMANCE_LIMITS.paintWarmups,
        paintMeasuredIterations: PERFORMANCE_LIMITS.paintIterations,
        paintBlocks: PERFORMANCE_LIMITS.paintBlocks,
        paintSamplesPerBlock: PAINT_SAMPLES_PER_BLOCK,
        paintP95Ms: PERFORMANCE_LIMITS.paintP95Ms,
        interactionWarmups: PERFORMANCE_LIMITS.interactionWarmups,
        interactionIterations: PERFORMANCE_LIMITS.interactionIterations,
        interactionP95Ms: PERFORMANCE_LIMITS.interactionP95Ms,
        paintState:
          'warm map and application, with deterministic coordinate and track movement on every sequential validated snapshot',
        maximumState: `warm map, 100 quality-queue receipts, ${RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft} clean history receipts, then one near-limit maximum paint`,
        environmentControl:
          'ten raw two-animation-frame scheduling-delay samples before, between and after the three paint blocks; diagnostic baseline collection only, with no normalization or pass conversion',
        environmentControlComparisonEligible: false,
        environmentControlBaselineRuns: 0,
        heapMetric:
          'Chromium performance.memory.usedJSHeapSize with precise-memory-info; JavaScript heap only, not total browser or platform memory',
        networkMetric:
          'Playwright BrowserContext response events summed by response Content-Length; aggregate response-body bytes only, including worker responses and excluding header overhead',
        ageTickMetric:
          'time-only Live session update followed by a committed React two-frame presentation; history collection, history object, and sample-array identities must be preserved',
        maximumInteractionWorkflow:
          'each named keyboard task has two untimed warmups and twenty measured samples from an equivalent restored starting state followed by a shared two-animation-frame presentation barrier; nearest-rank p95 must be at most 1,000 ms with no more than one over-budget sample, while maximum is diagnostic only',
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
        environmentViolations: environmentViolationCount,
        playwrightRetries: 0,
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
        left.project.localeCompare(right.project, 'en'),
      ),
      failedPaintMeasurements: this.failedPaintMeasurements.sort((left, right) =>
        left.project.localeCompare(right.project, 'en'),
      ),
      failedCaseReceipts: this.failedCaseReceipts.sort((left, right) =>
        left.project.localeCompare(right.project, 'en'),
      ),
    };
    let serializedReport: string;
    let compactFailure = false;
    try {
      serializedReport = `${JSON.stringify(report, null, 2)}\n`;
      if (Buffer.byteLength(serializedReport, 'utf8') > PERFORMANCE_REPORT_MAX_BYTES) {
        compactFailure = true;
        serializedReport = `${JSON.stringify(
          createCompactPerformanceFailureReceipt(
            'aggregate-serialization',
            'AGGREGATE_EXCEEDS_64_KIB',
          ),
          null,
          2,
        )}\n`;
      }
    } catch {
      compactFailure = true;
      serializedReport = `${JSON.stringify(
        createCompactPerformanceFailureReceipt(
          'aggregate-serialization',
          'AGGREGATE_SERIALIZATION_FAILED',
        ),
        null,
        2,
      )}\n`;
    }
    if (compactFailure) passed = false;
    const output = resolve(OUTPUT_PATH);
    const stagedDifference = relative(PERFORMANCE_RUN_PATHS.stagedDirectory, output);
    if (
      output !== PERFORMANCE_RUN_PATHS.stagedReport ||
      stagedDifference.length === 0 ||
      stagedDifference === '..' ||
      stagedDifference.startsWith(`..${sep}`) ||
      stagedDifference.startsWith('/') ||
      output === join(REPOSITORY_ROOT, 'test-results', 'live-performance', 'report.json')
    ) {
      throw new Error('Browser performance reporter may write only its run-local staged report.');
    }
    const stagedDirectoryStatus = await lstat(dirname(output));
    if (!stagedDirectoryStatus.isDirectory() || stagedDirectoryStatus.isSymbolicLink()) {
      throw new Error('Browser performance staged-report directory has an unsafe identity.');
    }
    const temporary = `${output}.${randomUUID()}.tmp`;
    await writeFile(temporary, serializedReport, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, output);
    process.stdout.write(
      `Browser performance aggregate ${passed ? 'passed' : 'failed'}; ${this.records.length}/4 bounded case receipts${compactFailure ? '; compact failure receipt retained' : ''}.\n`,
    );
    return { status: passed ? result.status : 'failed' };
  }

  printsToStdio(): boolean {
    return true;
  }
}
