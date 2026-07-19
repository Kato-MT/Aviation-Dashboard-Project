import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { format } from 'prettier';

import temporalArtifactJson from '../../models/temporal_fault_model_v2.json';
import { runCampaign } from '../../src/campaign/runner';
import {
  CAMPAIGN_SCHEMA_VERSION,
  type BuiltCampaignScenario,
  type CampaignDetection,
  type CampaignEvaluation,
  type CampaignResult,
  type CampaignSpec,
} from '../../src/campaign/types';
import { APPLICATION_VERSION } from '../../src/core/constants';
import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  createInvestigationModelProjector,
  INVESTIGATION_MODEL_PROJECTION_ID,
  INVESTIGATION_MODEL_PROJECTION_VERSION,
  INVESTIGATION_MODEL_WINDOW_LENGTH,
} from '../../src/investigation/modelProjection';
import { scoreTemporalFaultModel } from '../../src/ml/temporalModel';
import type {
  TemporalModelScore,
  TemporalSample as TemporalModelSample,
} from '../../src/ml/temporalTypes';
import { DECLARED_TEMPORAL_FAULTS, generateTemporalScenario } from '../../src/temporal/generator';
import type { TemporalFaultId, TemporalScenario } from '../../src/temporal/types';

export const TEMPORAL_BENCHMARK_SCHEMA_VERSION = 'temporal-benchmark.v1' as const;
export const TEMPORAL_BENCHMARK_EVIDENCE_KIND = 'node-proxy' as const;

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const BENCHMARK_STARTED_AT = '2026-07-17T12:00:00.000Z';
const INFERENCE_SEED = 22_201;
const INVESTIGATION_SEED = 22_202;
const CAMPAIGN_SEED_BASE = 32_001;
const TEMPORAL_ARTIFACT_PATH = 'models/temporal_fault_model_v2.json';
const TEMPORAL_MODEL_ROLE = 'integrated-production-advisory' as const;

export type TemporalBenchmarkOperation =
  'temporal-model-inference' | 'temporal-investigation' | 'temporal-campaign';

export interface TemporalBenchmarkConfiguration {
  readonly warmupIterations: number;
  readonly measuredRepetitions: number;
  readonly inferenceSampleCounts: readonly number[];
  readonly investigationSampleCounts: readonly number[];
  readonly campaignSeedCounts: readonly number[];
  readonly campaignScenarioIds: readonly (TemporalFaultId | 'nominal')[];
}

export interface TemporalBenchmarkEnvironment {
  readonly runtime: typeof TEMPORAL_BENCHMARK_EVIDENCE_KIND;
  readonly node: string;
  readonly v8: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly logicalCpuCount: number;
  readonly cpuModel: string;
  readonly ci: boolean;
}

export interface TemporalBenchmarkStatistics {
  readonly durationsMs: readonly number[];
  readonly meanDurationMs: number;
  readonly minimumDurationMs: number;
  readonly maximumDurationMs: number;
  readonly medianDurationMs: number;
  readonly p95DurationMs: number;
  readonly throughputPerSecond: number;
  readonly maximumObservedHeapBytes: number;
}

export interface TemporalBenchmarkResult extends TemporalBenchmarkStatistics {
  readonly benchmarkId: string;
  readonly operation: TemporalBenchmarkOperation;
  readonly workUnits: number;
  readonly workUnitLabel: 'model windows' | 'telemetry samples' | 'campaign cases';
  readonly warmupIterations: number;
  readonly measuredRepetitions: number;
  readonly inputSha256: string;
  readonly configurationSha256: string;
  readonly outputSha256: string;
  readonly outputDigestStable: true;
  readonly outputSummary: Record<string, unknown>;
}

export interface TemporalBenchmarkDocument {
  readonly schemaVersion: typeof TEMPORAL_BENCHMARK_SCHEMA_VERSION;
  readonly evidenceKind: typeof TEMPORAL_BENCHMARK_EVIDENCE_KIND;
  readonly recordedAt: string;
  readonly syntheticDataOnly: true;
  readonly dataClassification: 'SYNTHETIC_UNCLASSIFIED';
  readonly reproducibility: {
    readonly applicationVersion: string;
    readonly sourceRevision: string;
    readonly startedAt: string;
    readonly inferenceSeed: number;
    readonly investigationSeed: number;
    readonly campaignSeedBase: number;
    readonly model: {
      readonly role: typeof TEMPORAL_MODEL_ROLE;
      readonly modelVersion: string;
      readonly artifactVersion: string;
      readonly modelType: string;
      readonly artifactPath: typeof TEMPORAL_ARTIFACT_PATH;
      readonly artifactSha256: string;
      readonly projection: {
        readonly id: typeof INVESTIGATION_MODEL_PROJECTION_ID;
        readonly version: typeof INVESTIGATION_MODEL_PROJECTION_VERSION;
      };
      readonly authority: 'deterministic-rules';
    };
    readonly modelWindowLength: number;
    readonly configuration: TemporalBenchmarkConfiguration;
  };
  readonly environment: TemporalBenchmarkEnvironment;
  readonly results: readonly TemporalBenchmarkResult[];
  readonly limitations: readonly string[];
}

export interface TemporalBenchmarkRuntime {
  readonly now: () => number;
  readonly heapUsed: () => number;
  readonly recordedAt: string;
  readonly sourceRevision: string;
  readonly environment: TemporalBenchmarkEnvironment;
}

export interface RunTemporalBenchmarkOptions {
  readonly configuration?: TemporalBenchmarkConfiguration;
  readonly runtime?: TemporalBenchmarkRuntime;
}

interface MeasurementDefinition<T> {
  readonly benchmarkId: string;
  readonly operation: TemporalBenchmarkOperation;
  readonly workUnits: number;
  readonly workUnitLabel: TemporalBenchmarkResult['workUnitLabel'];
  readonly input: unknown;
  readonly configuration: unknown;
  readonly execute: () => T | Promise<T>;
  readonly summarize: (value: T) => Record<string, unknown>;
}

export const DEFAULT_TEMPORAL_BENCHMARK_CONFIGURATION: TemporalBenchmarkConfiguration = {
  warmupIterations: 1,
  measuredRepetitions: 3,
  inferenceSampleCounts: [180, 1_000, 10_000],
  investigationSampleCounts: [180, 1_000, 10_000],
  campaignSeedCounts: [1, 3],
  campaignScenarioIds: ['nominal', ...DECLARED_TEMPORAL_FAULTS.map(({ id }) => id)],
};

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[rank]!;
}

function scoreScenario(scenario: TemporalScenario): TemporalModelScore[] {
  const project = createInvestigationModelProjector(scenario);
  const samples: TemporalModelSample[] = [];
  for (const sample of scenario.samples) {
    samples.push(project(sample).modelSample);
  }
  const scores: TemporalModelScore[] = [];
  for (let end = INVESTIGATION_MODEL_WINDOW_LENGTH; end <= samples.length; end += 1) {
    scores.push(
      scoreTemporalFaultModel(
        temporalArtifactJson,
        samples.slice(end - INVESTIGATION_MODEL_WINDOW_LENGTH, end),
        true,
      ),
    );
  }
  return scores;
}

function summarizeScores(scores: readonly TemporalModelScore[]): Record<string, unknown> {
  const labelCounts: Record<string, number> = {};
  let anomalous = 0;
  let abstained = 0;
  const scoreIdentity = scores.map((score) => {
    labelCounts[score.predictedLabel] = (labelCounts[score.predictedLabel] ?? 0) + 1;
    if (score.anomalous) anomalous += 1;
    if (score.abstained) abstained += 1;
    return {
      predictedLabel: score.predictedLabel,
      nearestLabel: score.nearestLabel,
      relativeScore: score.relativeScore,
      distance: score.distance,
      anomalyMargin: score.anomalyMargin,
      abstained: score.abstained,
      anomalous: score.anomalous,
    };
  });
  return {
    modelVersion: scores[0]?.modelVersion ?? temporalArtifactJson.modelVersion,
    modelRole: TEMPORAL_MODEL_ROLE,
    authority: 'deterministic-rules',
    scoreCount: scores.length,
    anomalousCount: anomalous,
    abstainedCount: abstained,
    labelCounts,
    scoreIdentitySha256: sha256(scoreIdentity),
  };
}

function summarizeInvestigation(
  investigation: ReturnType<typeof analyzeTemporalScenario>,
): Record<string, unknown> {
  return {
    modelVersion:
      investigation.points.find(({ model }) => model.score !== null)?.model.score?.modelVersion ??
      temporalArtifactJson.modelVersion,
    modelRole: TEMPORAL_MODEL_ROLE,
    authority: 'deterministic-rules',
    pointCount: investigation.points.length,
    indicationCount: investigation.indications.length,
    phaseTransitionCount: investigation.phaseTransitions.length,
    deterministicDetectionIndex: investigation.detection.deterministicIndex,
    modelDetectionIndex: investigation.detection.modelIndex,
    analysisIdentitySha256: sha256({
      points: investigation.points.map((point) => ({
        sampleIndex: point.sampleIndex,
        phase: point.phase,
        estimated: point.fusion.estimated,
        indicationIds: point.indications.map(({ indicationId }) => indicationId),
        predictedLabel: point.model.score?.predictedLabel ?? null,
        relativeScore: point.model.score?.relativeScore ?? null,
      })),
      detection: investigation.detection,
      phaseTransitions: investigation.phaseTransitions,
    }),
  };
}

function campaignSpec(
  seedCount: number,
  scenarioIds: readonly (TemporalFaultId | 'nominal')[],
): CampaignSpec {
  const seeds = Array.from({ length: seedCount }, (_, index) => CAMPAIGN_SEED_BASE + index);
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: `temporal-node-proxy-${scenarioIds.length * seedCount}`,
    createdAt: BENCHMARK_STARTED_AT,
    profiles: [{ profileId: 'generic-fixed-wing', profileVersion: '1.0.0' }],
    scenarios: scenarioIds.map((scenarioId) => ({
      scenarioId,
      label: `Synthetic ${scenarioId} benchmark scenario`,
      phase: 'full-mission',
      expectedDetections: [],
      negativeRuleIds: [],
      syntheticDurationMs: 179_000,
    })),
    seeds,
    bootstrap: { iterations: 32, confidenceLevel: 0.95, seed: 42_202 },
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      purpose: 'Node-side temporal campaign performance proxy',
    },
  };
}

function expectedModelLabel(scenarioId: TemporalScenario['scenarioId']): string {
  return scenarioId === 'lag' ? 'sensor-lag' : scenarioId;
}

function campaignEvaluation(scenario: TemporalScenario): CampaignEvaluation {
  const investigation = analyzeTemporalScenario(scenario, { modelEnabled: true });
  const startedAtMs = Date.parse(scenario.startedAt);
  const detections = new Map<string, CampaignDetection>();
  for (const indication of investigation.indications) {
    if (!detections.has(indication.ruleId)) {
      detections.set(indication.ruleId, {
        ruleId: indication.ruleId,
        detectedAtMs: indication.timestampMs - startedAtMs,
        details: {
          authority: 'deterministic-rules',
          evidenceSource: 'observed-telemetry-only',
        },
      });
    }
  }
  const expectedLabel = expectedModelLabel(scenario.scenarioId);
  return {
    detections: [...detections.values()],
    calibration: investigation.points.flatMap(({ model }) => {
      const score = model.score;
      if (score === null) return [];
      const abstained = score.abstained || !score.activation.active;
      return [
        {
          confidence: score.relativeScore,
          correct: !abstained && score.predictedLabel === expectedLabel,
          abstained,
        },
      ];
    }),
    syntheticDurationMs: (scenario.samples.length - 1) * scenario.cadenceMs,
  };
}

async function executeCampaign(spec: CampaignSpec): Promise<CampaignResult> {
  return runCampaign<TemporalScenario>(spec, {
    buildScenario: (context): BuiltCampaignScenario<TemporalScenario> => ({
      input: generateTemporalScenario({
        seed: context.seed,
        scenarioId: context.scenario.scenarioId as TemporalFaultId | 'nominal',
        sampleCount: 180,
        cadenceMs: 1_000,
        startedAt: spec.createdAt,
      }),
      expectedDetections: context.scenario.expectedDetections,
      negativeRuleIds: context.scenario.negativeRuleIds,
      syntheticDurationMs: context.scenario.syntheticDurationMs,
    }),
    evaluateScenario: ({ input }) => campaignEvaluation(input),
  });
}

function summarizeCampaign(result: CampaignResult): Record<string, unknown> {
  return {
    modelVersion: temporalArtifactJson.modelVersion,
    modelRole: TEMPORAL_MODEL_ROLE,
    authority: 'deterministic-rules',
    runId: result.runId,
    status: result.status,
    plannedCases: result.summary.plannedCases,
    completedCases: result.summary.completedCases,
    failedCases: result.summary.failedCases,
    detectionCount: result.cases.reduce((sum, item) => sum + item.detections.length, 0),
    calibrationObservationCount: result.cases.reduce(
      (sum, item) => sum + item.calibration.length,
      0,
    ),
    replaySpecSha256: result.replayManifest.specSha256,
    campaignIdentitySha256: sha256({
      status: result.status,
      replayManifest: result.replayManifest,
      cases: result.cases.map((item) => ({
        caseId: item.caseId,
        status: item.status,
        detections: item.detections,
        calibration: item.calibration,
      })),
      metrics: result.metrics,
    }),
  };
}

function defaultEnvironment(): TemporalBenchmarkEnvironment {
  return {
    runtime: TEMPORAL_BENCHMARK_EVIDENCE_KIND,
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    logicalCpuCount: cpus().length,
    cpuModel: (cpus()[0]?.model ?? 'unknown').trim(),
    ci: process.env.CI === 'true',
  };
}

function recordedAt(): string {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined) return new Date().toISOString();
  const epochSeconds = Number(sourceDateEpoch);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) {
    throw new Error('SOURCE_DATE_EPOCH must be a nonnegative finite number of seconds.');
  }
  return new Date(epochSeconds * 1_000).toISOString();
}

function defaultRuntime(): TemporalBenchmarkRuntime {
  return {
    now: () => performance.now(),
    heapUsed: () => process.memoryUsage().heapUsed,
    recordedAt: recordedAt(),
    sourceRevision: process.env.GITHUB_SHA ?? process.env.SOURCE_REVISION ?? 'working-tree',
    environment: defaultEnvironment(),
  };
}

function assertPositiveInteger(value: number, name: string, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
}

export function assertTemporalBenchmarkConfiguration(
  configuration: TemporalBenchmarkConfiguration,
): void {
  assertPositiveInteger(configuration.measuredRepetitions, 'measuredRepetitions');
  assertPositiveInteger(configuration.warmupIterations, 'warmupIterations', 0);
  for (const sampleCount of configuration.inferenceSampleCounts) {
    assertPositiveInteger(
      sampleCount,
      'inference sample count',
      Math.max(INVESTIGATION_MODEL_WINDOW_LENGTH, 60),
    );
  }
  for (const sampleCount of configuration.investigationSampleCounts) {
    assertPositiveInteger(sampleCount, 'investigation sample count', 60);
  }
  for (const seedCount of configuration.campaignSeedCounts) {
    assertPositiveInteger(seedCount, 'campaign seed count');
  }
  if (configuration.campaignScenarioIds.length === 0) {
    throw new Error('campaignScenarioIds must contain at least one declared scenario.');
  }
  const declared = new Set<TemporalFaultId | 'nominal'>([
    'nominal',
    ...DECLARED_TEMPORAL_FAULTS.map(({ id }) => id),
  ]);
  for (const scenarioId of configuration.campaignScenarioIds) {
    if (!declared.has(scenarioId)) {
      throw new Error(`Unknown temporal benchmark scenario '${scenarioId}'.`);
    }
  }
}

async function measure<T>(
  definition: MeasurementDefinition<T>,
  configuration: TemporalBenchmarkConfiguration,
  runtime: TemporalBenchmarkRuntime,
): Promise<TemporalBenchmarkResult> {
  for (let index = 0; index < configuration.warmupIterations; index += 1) {
    await definition.execute();
  }

  const durations: number[] = [];
  const outputDigests: string[] = [];
  let outputSummary: Record<string, unknown> | null = null;
  let maximumObservedHeapBytes = runtime.heapUsed();
  for (let index = 0; index < configuration.measuredRepetitions; index += 1) {
    maximumObservedHeapBytes = Math.max(maximumObservedHeapBytes, runtime.heapUsed());
    const started = runtime.now();
    const output = await definition.execute();
    const duration = runtime.now() - started;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`Benchmark ${definition.benchmarkId} produced a non-positive duration.`);
    }
    durations.push(round(duration));
    maximumObservedHeapBytes = Math.max(maximumObservedHeapBytes, runtime.heapUsed());
    outputSummary = definition.summarize(output);
    outputDigests.push(sha256(outputSummary));
  }
  const distinctDigests = new Set(outputDigests);
  if (distinctDigests.size !== 1 || outputSummary === null) {
    throw new Error(`Benchmark ${definition.benchmarkId} produced nondeterministic output.`);
  }

  const meanDurationMs = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  return {
    benchmarkId: definition.benchmarkId,
    operation: definition.operation,
    workUnits: definition.workUnits,
    workUnitLabel: definition.workUnitLabel,
    warmupIterations: configuration.warmupIterations,
    measuredRepetitions: configuration.measuredRepetitions,
    durationsMs: durations,
    meanDurationMs: round(meanDurationMs),
    minimumDurationMs: Math.min(...durations),
    maximumDurationMs: Math.max(...durations),
    medianDurationMs: round(percentile(durations, 0.5)),
    p95DurationMs: round(percentile(durations, 0.95)),
    throughputPerSecond: round(definition.workUnits / (meanDurationMs / 1_000)),
    maximumObservedHeapBytes,
    inputSha256: sha256(definition.input),
    configurationSha256: sha256(definition.configuration),
    outputSha256: outputDigests[0]!,
    outputDigestStable: true,
    outputSummary,
  };
}

export async function runTemporalBenchmark(
  options: RunTemporalBenchmarkOptions = {},
): Promise<TemporalBenchmarkDocument> {
  const configuration = options.configuration ?? DEFAULT_TEMPORAL_BENCHMARK_CONFIGURATION;
  const runtime = options.runtime ?? defaultRuntime();
  assertTemporalBenchmarkConfiguration(configuration);
  const results: TemporalBenchmarkResult[] = [];
  const temporalArtifactBytes = await readFile(resolve(repositoryRoot, TEMPORAL_ARTIFACT_PATH));
  const temporalArtifactSha256 = createHash('sha256').update(temporalArtifactBytes).digest('hex');

  for (const sampleCount of configuration.inferenceSampleCounts) {
    const scenario = generateTemporalScenario({
      seed: INFERENCE_SEED,
      scenarioId: 'simultaneous-faults',
      sampleCount,
      cadenceMs: 1_000,
      startedAt: BENCHMARK_STARTED_AT,
    });
    const workUnits = sampleCount - INVESTIGATION_MODEL_WINDOW_LENGTH + 1;
    results.push(
      await measure(
        {
          benchmarkId: `temporal-model-inference-${sampleCount}`,
          operation: 'temporal-model-inference',
          workUnits,
          workUnitLabel: 'model windows',
          input: scenario,
          configuration: {
            sampleCount,
            seed: INFERENCE_SEED,
            scenarioId: scenario.scenarioId,
            modelWindowLength: INVESTIGATION_MODEL_WINDOW_LENGTH,
            modelVersion: temporalArtifactJson.modelVersion,
            modelRole: TEMPORAL_MODEL_ROLE,
            artifactSha256: temporalArtifactSha256,
            projection: {
              id: INVESTIGATION_MODEL_PROJECTION_ID,
              version: INVESTIGATION_MODEL_PROJECTION_VERSION,
            },
          },
          execute: () => scoreScenario(scenario),
          summarize: summarizeScores,
        },
        configuration,
        runtime,
      ),
    );
  }

  for (const sampleCount of configuration.investigationSampleCounts) {
    const scenario = generateTemporalScenario({
      seed: INVESTIGATION_SEED,
      scenarioId: 'simultaneous-faults',
      sampleCount,
      cadenceMs: 1_000,
      startedAt: BENCHMARK_STARTED_AT,
    });
    results.push(
      await measure(
        {
          benchmarkId: `temporal-investigation-${sampleCount}`,
          operation: 'temporal-investigation',
          workUnits: sampleCount,
          workUnitLabel: 'telemetry samples',
          input: scenario,
          configuration: {
            sampleCount,
            seed: INVESTIGATION_SEED,
            scenarioId: scenario.scenarioId,
            modelEnabled: true,
            modelVersion: temporalArtifactJson.modelVersion,
            modelRole: TEMPORAL_MODEL_ROLE,
            artifactSha256: temporalArtifactSha256,
            projection: {
              id: INVESTIGATION_MODEL_PROJECTION_ID,
              version: INVESTIGATION_MODEL_PROJECTION_VERSION,
            },
          },
          execute: () => analyzeTemporalScenario(scenario, { modelEnabled: true }),
          summarize: summarizeInvestigation,
        },
        configuration,
        runtime,
      ),
    );
  }

  for (const seedCount of configuration.campaignSeedCounts) {
    const spec = campaignSpec(seedCount, configuration.campaignScenarioIds);
    const caseCount = seedCount * configuration.campaignScenarioIds.length;
    results.push(
      await measure(
        {
          benchmarkId: `temporal-campaign-${caseCount}`,
          operation: 'temporal-campaign',
          workUnits: caseCount,
          workUnitLabel: 'campaign cases',
          input: spec,
          configuration: {
            seedCount,
            caseCount,
            scenarioIds: configuration.campaignScenarioIds,
            samplesPerCase: 180,
            bootstrap: spec.bootstrap,
            modelVersion: temporalArtifactJson.modelVersion,
            modelRole: TEMPORAL_MODEL_ROLE,
            artifactSha256: temporalArtifactSha256,
            projection: {
              id: INVESTIGATION_MODEL_PROJECTION_ID,
              version: INVESTIGATION_MODEL_PROJECTION_VERSION,
            },
          },
          execute: () => executeCampaign(spec),
          summarize: summarizeCampaign,
        },
        configuration,
        runtime,
      ),
    );
  }

  const document: TemporalBenchmarkDocument = {
    schemaVersion: TEMPORAL_BENCHMARK_SCHEMA_VERSION,
    evidenceKind: TEMPORAL_BENCHMARK_EVIDENCE_KIND,
    recordedAt: runtime.recordedAt,
    syntheticDataOnly: true,
    dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    reproducibility: {
      applicationVersion: APPLICATION_VERSION,
      sourceRevision: runtime.sourceRevision,
      startedAt: BENCHMARK_STARTED_AT,
      inferenceSeed: INFERENCE_SEED,
      investigationSeed: INVESTIGATION_SEED,
      campaignSeedBase: CAMPAIGN_SEED_BASE,
      model: {
        role: TEMPORAL_MODEL_ROLE,
        modelVersion: temporalArtifactJson.modelVersion,
        artifactVersion: temporalArtifactJson.artifactVersion,
        modelType: temporalArtifactJson.modelType,
        artifactPath: TEMPORAL_ARTIFACT_PATH,
        artifactSha256: temporalArtifactSha256,
        projection: {
          id: INVESTIGATION_MODEL_PROJECTION_ID,
          version: INVESTIGATION_MODEL_PROJECTION_VERSION,
        },
        authority: 'deterministic-rules',
      },
      modelWindowLength: INVESTIGATION_MODEL_WINDOW_LENGTH,
      configuration,
    },
    environment: runtime.environment,
    results,
    limitations: [
      'These are local Node.js proxy measurements, not browser rendering or interaction latency.',
      'Results depend on hardware, operating system, Node.js version, and background load.',
      'All inputs are generated synthetic and unclassified demonstration data.',
      'Campaign timing includes scenario generation, investigation, model advisory scoring, and campaign aggregation.',
      'maximumObservedHeapBytes is the absolute Node.js heap sampled at measurement boundaries, not incremental allocation or a guaranteed peak.',
      'No timing threshold is a release gate; deterministic output identity and completed execution are the correctness invariants.',
    ],
  };
  assertTemporalBenchmarkDocument(document);
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function assertTemporalBenchmarkDocument(
  value: unknown,
): asserts value is TemporalBenchmarkDocument {
  if (!isRecord(value) || value.schemaVersion !== TEMPORAL_BENCHMARK_SCHEMA_VERSION) {
    throw new Error('Temporal benchmark schemaVersion is invalid.');
  }
  if (
    value.evidenceKind !== TEMPORAL_BENCHMARK_EVIDENCE_KIND ||
    value.syntheticDataOnly !== true ||
    value.dataClassification !== 'SYNTHETIC_UNCLASSIFIED'
  ) {
    throw new Error('Temporal benchmark provenance labels are invalid.');
  }
  if (!isRecord(value.environment) || value.environment.runtime !== 'node-proxy') {
    throw new Error('Temporal benchmark environment must identify the Node proxy runtime.');
  }
  if (!isRecord(value.reproducibility) || !isRecord(value.reproducibility.configuration)) {
    throw new Error('Temporal benchmark reproducibility metadata is missing.');
  }
  if (
    !isRecord(value.reproducibility.model) ||
    value.reproducibility.model.role !== TEMPORAL_MODEL_ROLE ||
    value.reproducibility.model.modelVersion !== temporalArtifactJson.modelVersion ||
    value.reproducibility.model.artifactVersion !== temporalArtifactJson.artifactVersion ||
    value.reproducibility.model.modelType !== temporalArtifactJson.modelType ||
    value.reproducibility.model.artifactPath !== TEMPORAL_ARTIFACT_PATH ||
    !isSha256(value.reproducibility.model.artifactSha256) ||
    !isRecord(value.reproducibility.model.projection) ||
    value.reproducibility.model.projection.id !== INVESTIGATION_MODEL_PROJECTION_ID ||
    value.reproducibility.model.projection.version !== INVESTIGATION_MODEL_PROJECTION_VERSION ||
    value.reproducibility.model.authority !== 'deterministic-rules'
  ) {
    throw new Error('Temporal benchmark integrated model identity is invalid.');
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    throw new Error('Temporal benchmark results must be a non-empty array.');
  }
  const ids = new Set<string>();
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.benchmarkId !== 'string') {
      throw new Error('Temporal benchmark result identity is invalid.');
    }
    if (ids.has(result.benchmarkId)) {
      throw new Error(`Temporal benchmark ID '${result.benchmarkId}' is duplicated.`);
    }
    ids.add(result.benchmarkId);
    if (
      !Array.isArray(result.durationsMs) ||
      result.durationsMs.length !== result.measuredRepetitions ||
      result.durationsMs.some(
        (duration) => typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0,
      ) ||
      typeof result.meanDurationMs !== 'number' ||
      result.meanDurationMs <= 0 ||
      typeof result.throughputPerSecond !== 'number' ||
      result.throughputPerSecond <= 0
    ) {
      throw new Error(`Temporal benchmark '${result.benchmarkId}' timing fields are invalid.`);
    }
    if (
      result.outputDigestStable !== true ||
      !isSha256(result.inputSha256) ||
      !isSha256(result.configurationSha256) ||
      !isSha256(result.outputSha256)
    ) {
      throw new Error(`Temporal benchmark '${result.benchmarkId}' identity fields are invalid.`);
    }
  }
}

function markdownEscape(value: unknown): string {
  return String(value).replaceAll('|', '\\|');
}

export function temporalBenchmarkMarkdown(document: TemporalBenchmarkDocument): string {
  assertTemporalBenchmarkDocument(document);
  const evidenceStatus = document.environment.ci
    ? `This file records **Node.js proxy evidence** generated in CI for source revision \`${document.reproducibility.sourceRevision}\`.`
    : 'This file records locally measured **Node.js proxy evidence**. Rerun it on the exact release commit before presenting the measurements as release evidence.';
  const resultRows = document.results
    .map(
      (result) =>
        `| ${markdownEscape(result.operation)} | ${result.workUnits.toLocaleString('en-US')} ${result.workUnitLabel} | ${result.meanDurationMs.toFixed(3)} | ${result.minimumDurationMs.toFixed(3)} | ${result.maximumDurationMs.toFixed(3)} | ${result.throughputPerSecond.toLocaleString('en-US')} |`,
    )
    .join('\n');
  const identityRows = document.results
    .map(
      (result) =>
        `| ${markdownEscape(result.benchmarkId)} | \`${result.inputSha256}\` | \`${result.configurationSha256}\` | \`${result.outputSha256}\` |`,
    )
    .join('\n');
  return `# Temporal performance benchmark\n\n## Evidence status\n\n${evidenceStatus} It does not measure browser rendering, worker startup, network latency, or user interaction latency. All inputs are generated synthetic and unclassified demonstration data.\n\nMachine-readable evidence: [\`benchmark/temporal-latest.json\`](../benchmark/temporal-latest.json)\n\nRun:\n\n\`\`\`powershell\npnpm benchmark:temporal\n\`\`\`\n\n## Reproducibility\n\n- Application version: \`${document.reproducibility.applicationVersion}\`\n- Source revision: \`${document.reproducibility.sourceRevision}\`\n- Integrated temporal advisory model: \`${document.reproducibility.model.modelVersion}\`\n- Model role: \`${document.reproducibility.model.role}\`\n- Artifact: \`${document.reproducibility.model.artifactPath}\`\n- Artifact SHA-256: \`${document.reproducibility.model.artifactSha256}\`\n- Production projection: \`${document.reproducibility.model.projection.id}@${document.reproducibility.model.projection.version}\`\n- Authority: \`${document.reproducibility.model.authority}\`\n- Window length: ${document.reproducibility.modelWindowLength} samples\n- Warmups: ${document.reproducibility.configuration.warmupIterations}\n- Measured repetitions: ${document.reproducibility.configuration.measuredRepetitions}\n- Fixed inference seed: ${document.reproducibility.inferenceSeed}\n- Fixed investigation seed: ${document.reproducibility.investigationSeed}\n- Fixed campaign seed base: ${document.reproducibility.campaignSeedBase}\n\n## Recorded environment\n\n| Field | Value |\n| --- | --- |\n| Recorded at | \`${document.recordedAt}\` |\n| Runtime | \`${document.environment.runtime}\` |\n| Node | \`${document.environment.node}\` |\n| V8 | \`${document.environment.v8}\` |\n| Platform | \`${document.environment.platform} ${document.environment.release}\` |\n| Architecture | \`${document.environment.architecture}\` |\n| CPU | ${markdownEscape(document.environment.cpuModel)} |\n| Logical CPUs | ${document.environment.logicalCpuCount} |\n| CI flag | \`${document.environment.ci}\` |\n\n## Measured results\n\nTiming values are descriptive, not pass or fail gates. Output hashes must remain stable across measured repetitions.\n\n| Operation | Work | Mean ms | Minimum ms | Maximum ms | Units/second |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${resultRows}\n\n## Reproducibility identities\n\n| Benchmark | Input SHA-256 | Configuration SHA-256 | Output SHA-256 |\n| --- | --- | --- | --- |\n${identityRows}\n\n## Limitations\n\n${document.limitations.map((limitation) => `- ${limitation}`).join('\n')}\n`;
}

function flagValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const outputPath = resolve(flagValue('--output', 'benchmark/temporal-latest.json'));
  const markdownPath = resolve(flagValue('--markdown', 'docs/benchmarks-temporal.md'));
  const document = await runTemporalBenchmark();
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  const json = await format(JSON.stringify(document), { parser: 'json', printWidth: 100 });
  const markdown = await format(temporalBenchmarkMarkdown(document), {
    parser: 'markdown',
    printWidth: 100,
  });
  await writeFile(outputPath, json, 'utf8');
  await writeFile(markdownPath, markdown, 'utf8');
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
