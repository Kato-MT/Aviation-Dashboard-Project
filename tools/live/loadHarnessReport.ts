import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';

export const LOAD_HARNESS_SCHEMA_VERSION = 'airspace-load-harness.v1' as const;

export const LOAD_HARNESS_PROFILES = ['smoke', 'maximum', 'soak'] as const;

export const ACK_TIMER_EARLY_TOLERANCE_MS = 2;

export type LoadHarnessProfile = (typeof LOAD_HARNESS_PROFILES)[number];

export interface LoadHarnessScenario {
  profile: LoadHarnessProfile;
  durationMs: number;
  recordsPerSnapshot: number;
  offeredViewers: number;
  admittedViewers: typeof RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers;
  stalledViewerIndex: number;
  ackDelaysMs: readonly [0, 25, 100, 500];
  regionId: 'atlanta';
  pingProbeIntervalMs: number;
  memorySampleIntervalMs: number;
}

export interface LoadHarnessCli {
  scenario: LoadHarnessScenario;
  artifactInput?:
    { mode: 'artifact-root'; path: string } | { mode: 'retained-candidate'; path: string };
  outputPath?: string;
  help: boolean;
}

export interface SampleSummary {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface AckReceiptTiming {
  clientIndex: number;
  deliveryId: string;
  configuredDelayMs: number;
  receivedMonotonicMs: number;
  timerFiredMonotonicMs: number;
  callbackMonotonicMs: number;
}

export interface AttemptAccounting {
  offered: number;
  admitted: number;
  classifiedRejected: number;
  failed: number;
}

export interface HardGate {
  id: string;
  passed: boolean;
  detail: string;
  category: 'harness-integrity' | 'workerd-correctness';
}

export interface ProviderCadenceAssessment {
  valid: boolean;
  gapsMs: readonly number[];
  minimumGapMs: number | null;
  maximumGapMs: number | null;
  minimumAllowedGapMs: number;
  maximumAllowedGapMs: number;
}

export interface TimedWorkerdRssSample {
  atMs: number;
  scheduledAtMs: number;
  completedAtMs: number;
  pollDurationMs: number;
  rssBytes: number | null;
  pids: readonly number[] | null;
}

export interface SoakMemoryPlateauAssessment {
  eligible: boolean;
  passed: boolean;
  expectedSamples: number;
  observedSamples: number;
  completeness: number;
  missedSamples: number;
  invalidSampleCount: number;
  stableProcessIdentity: boolean;
  firstSampleAtMs: number | null;
  lastSampleAtMs: number | null;
  startBoundaryCovered: boolean;
  endBoundaryCovered: boolean;
  duplicateTimestampCount: number;
  duplicateScheduledTimestampCount: number;
  maximumGapMs: number | null;
  maximumAllowedGapMs: number;
  maximumPollDurationMs: number | null;
  maximumAllowedPollDurationMs: number;
  maximumScheduleLatenessMs: number | null;
  earlyMedianBytes: number | null;
  lateMedianBytes: number | null;
  tailGrowthBytes: number | null;
  tailGrowthAllowanceBytes: number | null;
  theilSenBytesPerMinute: number | null;
  maximumSlopeBytesPerMinute: number;
}

const SOAK_WARMUP_MS = 10 * 60_000;
const SOAK_WINDOW_MS = 5 * 60_000;
const SOAK_SLOPE_WINDOW_MS = 20 * 60_000;
const MINIMUM_TAIL_GROWTH_ALLOWANCE_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_SOAK_SLOPE_BYTES_PER_MINUTE = 0.5 * 1_024 * 1_024;
const MAXIMUM_GAP_INTERVALS = 2;
const MAXIMUM_GAP_SLACK_MS = 250;
const POLL_TIMING_TOLERANCE_MS = 2;
const RESPONSIVE_RECORDS = RUNTIME_POLICY_LIMITS.history.maximumAircraft;
const MAXIMUM_RECORDS = RUNTIME_POLICY_LIMITS.protocol.maximumAircraft;
const MAXIMUM_VIEWERS = RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers;
const OFFERED_VIEWERS = MAXIMUM_VIEWERS + 1;

const PROFILE_DEFAULTS: Record<LoadHarnessProfile, { durationMs: number; records: number }> = {
  smoke: { durationMs: 15_000, records: RESPONSIVE_RECORDS },
  maximum: { durationMs: 30_000, records: MAXIMUM_RECORDS },
  soak: { durationMs: 30 * 60_000, records: RESPONSIVE_RECORDS },
};

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new Error(`${option} requires a value.`);
  }
  return value.trim();
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

function profileName(value: string): LoadHarnessProfile {
  if (!LOAD_HARNESS_PROFILES.includes(value as LoadHarnessProfile)) {
    throw new Error(`--profile must be one of: ${LOAD_HARNESS_PROFILES.join(', ')}.`);
  }
  return value as LoadHarnessProfile;
}

export function parseLoadHarnessCli(argv: readonly string[]): LoadHarnessCli {
  let profile: LoadHarnessProfile = 'smoke';
  let durationSeconds: number | undefined;
  let records: number | undefined;
  let pingProbeIntervalMs = 2_000;
  let memorySampleIntervalMs = 5_000;
  let artifactInput: LoadHarnessCli['artifactInput'];
  let outputPath: string | undefined;
  let help = false;

  function selectArtifactInput(
    mode: NonNullable<LoadHarnessCli['artifactInput']>['mode'],
    path: string,
  ): void {
    if (artifactInput !== undefined) {
      throw new Error('Exactly one --artifact-root or --candidate-directory must be supplied.');
    }
    artifactInput = { mode, path };
  }

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    switch (option) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--profile':
        profile = profileName(requiredValue(argv, index, option));
        index += 1;
        break;
      case '--duration-seconds':
        durationSeconds = positiveInteger(requiredValue(argv, index, option), option);
        index += 1;
        break;
      case '--records':
        records = positiveInteger(requiredValue(argv, index, option), option);
        index += 1;
        break;
      case '--ping-probe-ms':
        pingProbeIntervalMs = positiveInteger(requiredValue(argv, index, option), option);
        index += 1;
        break;
      case '--memory-sample-ms':
        memorySampleIntervalMs = positiveInteger(requiredValue(argv, index, option), option);
        index += 1;
        break;
      case '--artifact-root':
        selectArtifactInput('artifact-root', requiredValue(argv, index, option));
        index += 1;
        break;
      case '--candidate-directory':
        selectArtifactInput('retained-candidate', requiredValue(argv, index, option));
        index += 1;
        break;
      case '--output':
        outputPath = requiredValue(argv, index, option);
        index += 1;
        break;
      default:
        throw new Error(`Unknown load-harness option: ${option}`);
    }
  }

  const defaults = PROFILE_DEFAULTS[profile];
  const durationMs = (durationSeconds ?? defaults.durationMs / 1_000) * 1_000;
  const recordsPerSnapshot = records ?? defaults.records;
  if (durationMs < 10_000) {
    throw new Error('Measured profiles must run for at least 10 real seconds.');
  }
  if (profile === 'soak' && durationMs < 30 * 60_000) {
    throw new Error('The soak profile must run for at least 30 real minutes.');
  }
  if (recordsPerSnapshot > MAXIMUM_RECORDS) {
    throw new Error(
      `--records cannot exceed the ${MAXIMUM_RECORDS.toLocaleString('en-US')}-record protocol limit.`,
    );
  }
  if (profile === 'smoke' && recordsPerSnapshot !== RESPONSIVE_RECORDS) {
    throw new Error(
      `The smoke profile requires exactly ${RESPONSIVE_RECORDS.toLocaleString('en-US')} synthetic records.`,
    );
  }
  if (profile === 'maximum' && recordsPerSnapshot !== MAXIMUM_RECORDS) {
    throw new Error(
      `The maximum profile requires exactly ${MAXIMUM_RECORDS.toLocaleString('en-US')} synthetic records.`,
    );
  }
  if (pingProbeIntervalMs < RUNTIME_POLICY_LIMITS.delivery.minimumPingIntervalMs) {
    throw new Error(
      `--ping-probe-ms must respect the ${RUNTIME_POLICY_LIMITS.delivery.minimumPingIntervalMs} ms production ping interval.`,
    );
  }
  if (memorySampleIntervalMs < 1_000) {
    throw new Error('--memory-sample-ms must be at least 1,000 ms.');
  }
  if (!help && artifactInput === undefined) {
    throw new Error('Exactly one --artifact-root or --candidate-directory must be supplied.');
  }

  return {
    scenario: {
      profile,
      durationMs,
      recordsPerSnapshot,
      offeredViewers: OFFERED_VIEWERS,
      admittedViewers: MAXIMUM_VIEWERS,
      stalledViewerIndex: MAXIMUM_VIEWERS - 1,
      ackDelaysMs: [0, 25, 100, 500],
      regionId: 'atlanta',
      pingProbeIntervalMs,
      memorySampleIntervalMs,
    },
    ...(artifactInput === undefined ? {} : { artifactInput }),
    ...(outputPath === undefined ? {} : { outputPath }),
    help,
  };
}

export function percentile(samples: readonly number[], requestedPercentile: number): number | null {
  if (samples.length === 0) return null;
  if (
    !Number.isFinite(requestedPercentile) ||
    requestedPercentile < 0 ||
    requestedPercentile > 100
  ) {
    throw new Error('Percentile must be finite and within [0, 100].');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = (requestedPercentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('Measured samples must all be finite.');
  }
  if (samples.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  return {
    count: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

export function assessProviderCadence(
  offsetsMs: readonly number[],
  expectedIntervalMs: number,
  earlyToleranceMs: number,
  lateToleranceMs: number,
): ProviderCadenceAssessment {
  const minimumAllowedGapMs = expectedIntervalMs - earlyToleranceMs;
  const maximumAllowedGapMs = expectedIntervalMs + lateToleranceMs;
  const inputsValid =
    Number.isFinite(expectedIntervalMs) &&
    expectedIntervalMs > 0 &&
    Number.isFinite(earlyToleranceMs) &&
    earlyToleranceMs >= 0 &&
    earlyToleranceMs < expectedIntervalMs &&
    Number.isFinite(lateToleranceMs) &&
    lateToleranceMs >= 0 &&
    offsetsMs.every((offsetMs) => Number.isFinite(offsetMs) && offsetMs >= 0);
  const gapsMs = offsetsMs.slice(1).map((offsetMs, index) => offsetMs - offsetsMs[index]!);
  const minimumGapMs = gapsMs.length === 0 ? null : Math.min(...gapsMs);
  const maximumGapMs = gapsMs.length === 0 ? null : Math.max(...gapsMs);
  return {
    valid:
      inputsValid &&
      gapsMs.every((gapMs) => gapMs >= minimumAllowedGapMs && gapMs <= maximumAllowedGapMs),
    gapsMs,
    minimumGapMs,
    maximumGapMs,
    minimumAllowedGapMs,
    maximumAllowedGapMs,
  };
}

export function median(samples: readonly number[]): number | null {
  return percentile(samples, 50);
}

export function theilSenBytesPerMinute(
  samples: readonly { atMs: number; rssBytes: number }[],
): number | null {
  const slopes: number[] = [];
  for (let leftIndex = 0; leftIndex < samples.length; leftIndex += 1) {
    const left = samples[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < samples.length; rightIndex += 1) {
      const right = samples[rightIndex]!;
      const elapsedMs = right.atMs - left.atMs;
      if (elapsedMs <= 0) continue;
      slopes.push(((right.rssBytes - left.rssBytes) / elapsedMs) * 60_000);
    }
  }
  return median(slopes);
}

export function assessSoakMemoryPlateau(
  samples: readonly TimedWorkerdRssSample[],
  durationMs: number,
  sampleIntervalMs: number,
): SoakMemoryPlateauAssessment {
  const eligible =
    Number.isFinite(durationMs) &&
    durationMs >= 30 * 60_000 &&
    Number.isFinite(sampleIntervalMs) &&
    sampleIntervalMs >= 1_000;
  const expectedSamples = eligible ? Math.ceil(durationMs / sampleIntervalMs) + 1 : 0;
  const usable = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.atMs) &&
        sample.atMs >= 0 &&
        sample.atMs <= durationMs + sampleIntervalMs &&
        Number.isFinite(sample.scheduledAtMs) &&
        sample.scheduledAtMs >= 0 &&
        sample.scheduledAtMs <= durationMs &&
        Number.isFinite(sample.completedAtMs) &&
        sample.completedAtMs >= sample.atMs &&
        sample.completedAtMs <= durationMs + sampleIntervalMs &&
        Number.isFinite(sample.pollDurationMs) &&
        sample.pollDurationMs >= 0 &&
        Math.abs(sample.completedAtMs - sample.atMs - sample.pollDurationMs) <=
          POLL_TIMING_TOLERANCE_MS &&
        sample.atMs + POLL_TIMING_TOLERANCE_MS >= sample.scheduledAtMs &&
        sample.rssBytes !== null &&
        Number.isFinite(sample.rssBytes) &&
        sample.rssBytes > 0 &&
        sample.pids !== null &&
        sample.pids.length > 0 &&
        sample.pids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
    )
    .map((sample) => ({
      atMs: sample.atMs,
      scheduledAtMs: sample.scheduledAtMs,
      completedAtMs: sample.completedAtMs,
      pollDurationMs: sample.pollDurationMs,
      rssBytes: sample.rssBytes!,
      pids: [...sample.pids!].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.atMs - right.atMs);
  const observedSamples = usable.length;
  const completeness = expectedSamples === 0 ? 0 : Math.min(1, observedSamples / expectedSamples);
  const missedSamples = Math.max(0, expectedSamples - observedSamples);
  const invalidSampleCount = samples.length - observedSamples;
  const firstPids = usable[0]?.pids;
  const stableProcessIdentity =
    firstPids !== undefined &&
    usable.every(
      (sample) =>
        sample.pids.length === firstPids.length &&
        sample.pids.every((pid, index) => pid === firstPids[index]),
    );
  const firstSampleAtMs = usable[0]?.atMs ?? null;
  const lastSampleAtMs = usable.at(-1)?.atMs ?? null;
  const startBoundaryCovered = firstSampleAtMs !== null && firstSampleAtMs <= sampleIntervalMs;
  const endBoundaryCovered =
    lastSampleAtMs !== null &&
    lastSampleAtMs >= durationMs - sampleIntervalMs &&
    lastSampleAtMs <= durationMs + sampleIntervalMs;
  const finiteStartTimestamps = samples
    .map((sample) => sample.atMs)
    .filter((atMs) => Number.isFinite(atMs));
  const duplicateTimestampCount =
    finiteStartTimestamps.length - new Set(finiteStartTimestamps).size;
  const finiteScheduledTimestamps = samples
    .map((sample) => sample.scheduledAtMs)
    .filter((scheduledAtMs) => Number.isFinite(scheduledAtMs));
  const duplicateScheduledTimestampCount =
    finiteScheduledTimestamps.length - new Set(finiteScheduledTimestamps).size;
  const gaps = usable.slice(1).map((sample, index) => sample.atMs - usable[index]!.atMs);
  const maximumGapMs = gaps.length === 0 ? null : Math.max(...gaps);
  const maximumAllowedGapMs = sampleIntervalMs * MAXIMUM_GAP_INTERVALS + MAXIMUM_GAP_SLACK_MS;
  const maximumPollDurationMs =
    usable.length === 0 ? null : Math.max(...usable.map((sample) => sample.pollDurationMs));
  const maximumAllowedPollDurationMs = sampleIntervalMs;
  const maximumScheduleLatenessMs =
    usable.length === 0
      ? null
      : Math.max(...usable.map((sample) => sample.atMs - sample.scheduledAtMs));
  const early = usable
    .filter(
      (sample) => sample.atMs >= SOAK_WARMUP_MS && sample.atMs < SOAK_WARMUP_MS + SOAK_WINDOW_MS,
    )
    .map((sample) => sample.rssBytes);
  const late = usable
    .filter(
      (sample) =>
        sample.atMs >= durationMs - SOAK_WINDOW_MS && sample.atMs <= durationMs + sampleIntervalMs,
    )
    .map((sample) => sample.rssBytes);
  const earlyMedianBytes = median(early);
  const lateMedianBytes = median(late);
  const tailGrowthBytes =
    earlyMedianBytes === null || lateMedianBytes === null
      ? null
      : lateMedianBytes - earlyMedianBytes;
  const tailGrowthAllowanceBytes =
    earlyMedianBytes === null
      ? null
      : Math.max(MINIMUM_TAIL_GROWTH_ALLOWANCE_BYTES, earlyMedianBytes * 0.1);
  const slopeSamples = usable
    .filter((sample) => sample.atMs >= Math.max(SOAK_WARMUP_MS, durationMs - SOAK_SLOPE_WINDOW_MS))
    .map(({ atMs, rssBytes }) => ({ atMs, rssBytes }));
  const slope = theilSenBytesPerMinute(slopeSamples);
  const passed =
    eligible &&
    completeness >= 0.99 &&
    invalidSampleCount === 0 &&
    stableProcessIdentity &&
    startBoundaryCovered &&
    endBoundaryCovered &&
    duplicateTimestampCount === 0 &&
    duplicateScheduledTimestampCount === 0 &&
    maximumGapMs !== null &&
    maximumGapMs <= maximumAllowedGapMs &&
    maximumPollDurationMs !== null &&
    maximumPollDurationMs <= maximumAllowedPollDurationMs &&
    maximumScheduleLatenessMs !== null &&
    maximumScheduleLatenessMs <= sampleIntervalMs &&
    tailGrowthBytes !== null &&
    tailGrowthAllowanceBytes !== null &&
    tailGrowthBytes <= tailGrowthAllowanceBytes &&
    slope !== null &&
    slope <= MAXIMUM_SOAK_SLOPE_BYTES_PER_MINUTE;
  return {
    eligible,
    passed,
    expectedSamples,
    observedSamples,
    completeness,
    missedSamples,
    invalidSampleCount,
    stableProcessIdentity,
    firstSampleAtMs,
    lastSampleAtMs,
    startBoundaryCovered,
    endBoundaryCovered,
    duplicateTimestampCount,
    duplicateScheduledTimestampCount,
    maximumGapMs,
    maximumAllowedGapMs,
    maximumPollDurationMs,
    maximumAllowedPollDurationMs,
    maximumScheduleLatenessMs,
    earlyMedianBytes,
    lateMedianBytes,
    tailGrowthBytes,
    tailGrowthAllowanceBytes,
    theilSenBytesPerMinute: slope,
    maximumSlopeBytesPerMinute: MAXIMUM_SOAK_SLOPE_BYTES_PER_MINUTE,
  };
}

export function validateAckReceiptTiming(sample: AckReceiptTiming): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(sample.clientIndex) || sample.clientIndex < 0) {
    errors.push('clientIndex must be a non-negative safe integer.');
  }
  if (sample.deliveryId.length === 0) errors.push('deliveryId must be non-empty.');
  for (const [field, value] of [
    ['configuredDelayMs', sample.configuredDelayMs],
    ['receivedMonotonicMs', sample.receivedMonotonicMs],
    ['timerFiredMonotonicMs', sample.timerFiredMonotonicMs],
    ['callbackMonotonicMs', sample.callbackMonotonicMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0)
      errors.push(`${field} must be finite and non-negative.`);
  }
  if (sample.timerFiredMonotonicMs < sample.receivedMonotonicMs) {
    errors.push('The ACK timer cannot fire before frame receipt.');
  }
  if (sample.callbackMonotonicMs < sample.timerFiredMonotonicMs) {
    errors.push('The ACK send callback cannot precede the ACK timer.');
  }
  const earliestTimer = sample.receivedMonotonicMs + sample.configuredDelayMs;
  if (sample.timerFiredMonotonicMs + ACK_TIMER_EARLY_TOLERANCE_MS < earliestTimer) {
    errors.push('The ACK timer fired before its configured delay elapsed.');
  }
  return errors;
}

export function attemptAccountingIsComplete(attempts: AttemptAccounting): boolean {
  return (
    Object.values(attempts).every((value) => Number.isSafeInteger(value) && value >= 0) &&
    attempts.offered === attempts.admitted + attempts.classifiedRejected + attempts.failed
  );
}

export function measuredOutcome(
  gates: readonly HardGate[],
  generatorHealthy: boolean,
): 'passed' | 'failed' | 'inconclusive' {
  if (gates.some((gate) => gate.category === 'harness-integrity' && !gate.passed)) {
    return 'failed';
  }
  if (!generatorHealthy) return 'inconclusive';
  return gates.every((gate) => gate.passed) ? 'passed' : 'failed';
}

export const LOAD_HARNESS_HELP = `Usage: pnpm tsx tools/live/loadHarness.ts (--artifact-root PATH | --candidate-directory PATH) [options]

Options:
  --artifact-root PATH          Explicit raw mock-staging build root
  --candidate-directory PATH   Verified clean-source retained candidate root
  --profile smoke|maximum|soak  Measured scenario (default: smoke)
  --duration-seconds N          Real wall duration; soak cannot be below 1800
  --records N                   Synthetic records; smoke=${RESPONSIVE_RECORDS}, maximum=${MAXIMUM_RECORDS}
  --ping-probe-ms N             Ordered application ping interval (default: 2000)
  --memory-sample-ms N          Memory sampling interval (default: 5000)
  --output PATH                 Also write the final JSON report to PATH
  --help                        Show this text
`;
