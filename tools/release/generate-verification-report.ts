import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { legacyCsvAdapter } from '../../src/adapters';
import { APPLICATION_VERSION, analyzeTelemetryRun, countFindingsByRule } from '../../src/core';
import { includedBaselineProfile } from '../../src/profiles';
import {
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
  temporalFaultResearchRegistryEntry,
  type ModelRegistryEntry,
} from '../../src/model-registry';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const generatedAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
  : new Date().toISOString();
const fixedAnalysisTime = '2026-07-17T00:00:00.000Z';
const expectedDatasetHash = 'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700';
const includeExpandedEvidence = /^2\.(?:1|2)\./.test(APPLICATION_VERSION);
const includeTemporalEvidence = /^2\.2\./.test(APPLICATION_VERSION);
const exactTagReleaseContext =
  process.env.CI === 'true' &&
  process.env.GITHUB_REF_TYPE === 'tag' &&
  typeof process.env.GITHUB_SHA === 'string' &&
  process.env.GITHUB_SHA.length > 0;

interface TraceabilityMapping {
  requirements: string[];
  tests: string[];
}

interface CoverageSummary {
  total: {
    branches: { pct: number };
    functions: { pct: number };
    lines: { pct: number };
    statements: { pct: number };
  };
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), 'utf8')) as T;
}

function repositoryPath(relativePath: string): string {
  const absolutePath = resolve(repositoryRoot, relativePath);
  const pathWithinRepository = relative(repositoryRoot, absolutePath);
  if (pathWithinRepository.startsWith('..') || isAbsolute(pathWithinRepository)) {
    throw new Error(`Evidence path escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current = document;
  for (const encodedComponent of pointer.slice(1).split('/')) {
    const component = encodedComponent.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || !(component in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[component];
  }
  return current;
}

interface RegistryEvidenceCheck {
  registryEntryId: string;
  modelVersion: string;
  valid: boolean;
  checkedReferences: Array<{ path: string; jsonPointer: string; split: string }>;
  modelCardPath: string;
  qualityGateJsonPointer: string;
  errors: string[];
}

interface TemporalEvaluationExtensionCheck {
  valid: boolean;
  errors: string[];
  persistenceBaselinePresent: boolean;
  generalizationChallengePresent: boolean;
  challengePerformanceGated: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFiniteMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    'truePositives',
    'falsePositives',
    'trueNegatives',
    'falseNegatives',
    'precision',
    'recall',
    'f1',
    'falsePositiveRate',
  ].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function sameValues(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function finiteMetric(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integratedTemporalEligibility(evaluationDocument: unknown) {
  const document = isRecord(evaluationDocument) ? evaluationDocument : {};
  const evaluation = isRecord(document.evaluation) ? document.evaluation : {};
  const selectedWindowMetrics = isRecord(evaluation.selectedWindowMetrics)
    ? evaluation.selectedWindowMetrics
    : undefined;
  const episodeMetrics = isRecord(evaluation.episodeMetrics)
    ? evaluation.episodeMetrics
    : undefined;
  const qualityGate = isRecord(document.qualityGate) ? document.qualityGate : {};
  const byFault = isRecord(evaluation.byFault) ? evaluation.byFault : {};
  const classificationRecalls = Object.values(byFault).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const recall = finiteMetric(entry, 'classificationRecall');
    return recall === undefined ? [] : [recall];
  });
  const evaluationUnit =
    typeof evaluation.evaluationUnit === 'string'
      ? evaluation.evaluationUnit
      : 'selected causal rolling-window observation';
  const metricScope = selectedWindowMetrics
    ? 'selected-window'
    : /full[-\s]?stream/i.test(evaluationUnit)
      ? 'full-stream'
      : 'episode';
  const metrics = selectedWindowMetrics ?? episodeMetrics ?? {};
  const declaredMinimumF1 = selectedWindowMetrics
    ? (finiteMetric(qualityGate, 'minimumSelectedWindowF1') ?? 0)
    : (finiteMetric(qualityGate, 'minimumEpisodeF1') ?? 0);
  const declaredMaximumFalsePositiveRate = selectedWindowMetrics
    ? (finiteMetric(qualityGate, 'maximumSelectedWindowFalsePositiveRate') ?? 1)
    : (finiteMetric(qualityGate, 'maximumFalsePositiveRate') ?? 1);
  const declaredMinimumClassificationMacroF1 =
    finiteMetric(qualityGate, 'minimumClassificationMacroF1') ?? 0;
  const declaredMinimumPerFaultRecall =
    finiteMetric(qualityGate, 'minimumPerFaultClassificationRecall') ?? 0;
  const declaredMinimumAnswered = finiteMetric(qualityGate, 'minimumAnsweredObservations') ?? 1;
  const declaredMaximumAbstention = finiteMetric(qualityGate, 'maximumAbstentionRate') ?? 1;
  const thresholds = {
    minimumF1: Math.max(selectedWindowMetrics ? 0.85 : 0.8, declaredMinimumF1),
    maximumFalsePositiveRate: Math.min(0.05, declaredMaximumFalsePositiveRate),
    minimumClassificationMacroF1: Math.max(0.65, declaredMinimumClassificationMacroF1),
    minimumPerFaultClassificationRecall: Math.max(0.65, declaredMinimumPerFaultRecall),
    minimumAnsweredObservations: Math.max(1, declaredMinimumAnswered),
    maximumAbstentionRate: declaredMaximumAbstention,
  };
  const observed = {
    f1: finiteMetric(metrics, 'f1'),
    falsePositiveRate: finiteMetric(metrics, 'falsePositiveRate'),
    classificationMacroF1: finiteMetric(evaluation, 'classificationMacroF1'),
    minimumPerFaultClassificationRecall:
      classificationRecalls.length === Object.keys(byFault).length &&
      classificationRecalls.length > 0
        ? Math.min(...classificationRecalls)
        : undefined,
    answeredObservations: finiteMetric(evaluation, 'answeredObservations'),
    abstentionRate: finiteMetric(evaluation, 'abstentionRate'),
  };
  const passed =
    qualityGate.passed === true &&
    observed.f1 !== undefined &&
    observed.f1 >= thresholds.minimumF1 &&
    observed.falsePositiveRate !== undefined &&
    observed.falsePositiveRate <= thresholds.maximumFalsePositiveRate &&
    observed.classificationMacroF1 !== undefined &&
    observed.classificationMacroF1 >= thresholds.minimumClassificationMacroF1 &&
    observed.minimumPerFaultClassificationRecall !== undefined &&
    observed.minimumPerFaultClassificationRecall >=
      thresholds.minimumPerFaultClassificationRecall &&
    observed.answeredObservations !== undefined &&
    observed.answeredObservations >= thresholds.minimumAnsweredObservations &&
    observed.abstentionRate !== undefined &&
    observed.abstentionRate <= thresholds.maximumAbstentionRate;
  return {
    passed,
    metricScope,
    evaluationUnit,
    declaredArtifactGatePassed: qualityGate.passed === true,
    thresholds,
    observed,
  };
}

function validateTemporalEvaluationExtensions(
  evaluationDocument: unknown,
  artifactDocument: unknown,
  artifactSha256: string | undefined,
): TemporalEvaluationExtensionCheck {
  const errors: string[] = [];
  const evaluation = isRecord(evaluationDocument) ? evaluationDocument : {};
  const baselineComparison = isRecord(evaluation.baselineComparison)
    ? evaluation.baselineComparison
    : {};
  const baselinePopulation = isRecord(baselineComparison.evaluationPopulation)
    ? baselineComparison.evaluationPopulation
    : {};
  const baselineSystems = isRecord(baselineComparison.systems) ? baselineComparison.systems : {};
  const persistence = isRecord(baselineSystems.persistencePredictionBaseline)
    ? baselineSystems.persistencePredictionBaseline
    : undefined;
  const challenge = isRecord(evaluation.postHocGeneralizationChallenge)
    ? evaluation.postHocGeneralizationChallenge
    : undefined;

  if (baselineComparison.schemaVersion !== 'temporal-baseline-comparison.v1') {
    errors.push('baselineComparison schemaVersion is invalid.');
  }
  if (
    baselinePopulation.episodes !== 440 ||
    !sameValues(
      baselinePopulation.seeds,
      Array.from({ length: 40 }, (_, index) => 3_101 + index),
    )
  ) {
    errors.push('baselineComparison population does not match the declared 440 held-out episodes.');
  }
  if (
    persistence === undefined ||
    persistence.status !== 'evaluated' ||
    persistence.eligibleEpisodes !== 440 ||
    !isRecord(persistence.parameters) ||
    persistence.parameters.prediction !== 'value[t] = value[t-1]' ||
    !hasFiniteMetrics(persistence.metrics)
  ) {
    errors.push('persistencePredictionBaseline evidence is incomplete or inconsistent.');
  }

  const artifact = isRecord(artifactDocument) ? artifactDocument : {};
  const artifactTraining = isRecord(artifact.training) ? artifact.training : {};
  const artifactChannels = Array.isArray(artifact.channels) ? artifact.channels : [];
  const frozenInference =
    challenge && isRecord(challenge.frozenInference) ? challenge.frozenInference : {};
  const seedPartition =
    challenge && isRecord(challenge.seedPartition) ? challenge.seedPartition : {};
  const releaseGate = challenge && isRecord(challenge.releaseGate) ? challenge.releaseGate : {};
  const dimensions = challenge && isRecord(challenge.dimensions) ? challenge.dimensions : {};
  const unseenMagnitude = isRecord(dimensions.unseenMagnitude) ? dimensions.unseenMagnitude : {};
  const activeDuration = isRecord(dimensions.activeDurationAndOnsetPhase)
    ? dimensions.activeDurationAndOnsetPhase
    : {};
  const novelCombinations = isRecord(dimensions.novelFaultCombinations)
    ? dimensions.novelFaultCombinations
    : {};

  if (
    challenge === undefined ||
    challenge.schemaVersion !== 'temporal-generalization-challenge.v1' ||
    challenge.status !== 'post-hoc-non-gating' ||
    releaseGate.included !== false
  ) {
    errors.push('postHocGeneralizationChallenge boundary or non-gating status is invalid.');
  }
  if (
    seedPartition.disjointFromTraining !== true ||
    seedPartition.disjointFromCalibration !== true ||
    seedPartition.disjointFromPrimaryHeldOut !== true
  ) {
    errors.push('postHocGeneralizationChallenge seed partition is not declared disjoint.');
  }
  if (
    frozenInference.fitOrCalibrationOnChallenge !== false ||
    frozenInference.artifactSha256 !== artifactSha256 ||
    frozenInference.configurationSha256 !== artifactTraining.configurationSha256 ||
    !sameValues(frozenInference.inferenceInputs, artifactChannels)
  ) {
    errors.push('postHocGeneralizationChallenge did not use the frozen registered inference path.');
  }

  const dimensionChecks: Array<[Record<string, unknown>, number, number]> = [
    [unseenMagnitude, 2, 210],
    [activeDuration, 4, 410],
    [novelCombinations, 5, 60],
  ];
  for (const [dimension, expectedConfigurations, expectedEpisodes] of dimensionChecks) {
    const population =
      isRecord(dimension.results) && isRecord(dimension.results.population)
        ? dimension.results.population
        : {};
    if (
      !Array.isArray(dimension.configurations) ||
      dimension.configurations.length !== expectedConfigurations ||
      population.totalEpisodes !== expectedEpisodes
    ) {
      errors.push('postHocGeneralizationChallenge dimension population is incomplete.');
    }
  }
  const magnitudes = Array.isArray(unseenMagnitude.configurations)
    ? unseenMagnitude.configurations.map((configuration) =>
        isRecord(configuration) ? configuration.magnitude : undefined,
      )
    : [];
  if (!sameValues(magnitudes, [0.45, 1.6])) {
    errors.push('postHocGeneralizationChallenge magnitude configurations are invalid.');
  }
  const onsetAndDuration = Array.isArray(activeDuration.configurations)
    ? activeDuration.configurations.map((configuration) =>
        isRecord(configuration)
          ? [configuration.onsetSample, configuration.activeDurationSamples]
          : undefined,
      )
    : [];
  if (
    !sameValues(onsetAndDuration, [
      [3, 7],
      [17, 6],
      [28, 7],
      [30, 10],
    ])
  ) {
    errors.push('postHocGeneralizationChallenge onset and duration configurations are invalid.');
  }
  const novelIds = Array.isArray(novelCombinations.configurations)
    ? novelCombinations.configurations.map((configuration) =>
        isRecord(configuration) ? configuration.challengeId : undefined,
      )
    : [];
  if (
    !sameValues(novelIds, [
      'drift-plus-noise',
      'oscillation-plus-fuel-leak',
      'lag-plus-gain',
      'dropout-plus-decoupling',
      'stuck-plus-fuel-leak',
    ])
  ) {
    errors.push('postHocGeneralizationChallenge novel combinations are invalid.');
  }

  return {
    valid: errors.length === 0,
    errors,
    persistenceBaselinePresent: persistence !== undefined,
    generalizationChallengePresent: challenge !== undefined,
    challengePerformanceGated: false,
  };
}

async function validateRegistryEvidence(
  entry: Readonly<ModelRegistryEntry>,
): Promise<RegistryEvidenceCheck> {
  const errors: string[] = [];
  const references = [
    entry.evidence.training,
    entry.evidence.calibration,
    entry.evidence.evaluation,
  ];
  const expectedSplits = ['training', 'calibration', 'held-out-evaluation'] as const;
  const loadedDocuments = new Map<string, unknown>();

  for (const [index, reference] of references.entries()) {
    if (reference.split !== expectedSplits[index]) {
      errors.push(`${reference.path}${reference.jsonPointer} has split '${reference.split}'.`);
    }
    if (reference.seedSummary.trim() === '') {
      errors.push(`${reference.path}${reference.jsonPointer} has no seed summary.`);
    }
    try {
      let document = loadedDocuments.get(reference.path);
      if (document === undefined) {
        document = JSON.parse(await readFile(repositoryPath(reference.path), 'utf8')) as unknown;
        loadedDocuments.set(reference.path, document);
      }
      if (resolveJsonPointer(document, reference.jsonPointer) === undefined) {
        errors.push(`${reference.path} does not contain ${reference.jsonPointer}.`);
      }
    } catch (error) {
      errors.push(`${reference.path} could not be read: ${String(error)}.`);
    }
  }

  try {
    const modelCard = await readFile(repositoryPath(entry.evidence.modelCardPath), 'utf8');
    if (modelCard.trim() === '') errors.push(`${entry.evidence.modelCardPath} is empty.`);
  } catch (error) {
    errors.push(`${entry.evidence.modelCardPath} could not be read: ${String(error)}.`);
  }

  const evaluationDocument = loadedDocuments.get(entry.evidence.evaluation.path);
  if (resolveJsonPointer(evaluationDocument, entry.evidence.qualityGateJsonPointer) === undefined) {
    errors.push(
      `${entry.evidence.evaluation.path} does not contain ${entry.evidence.qualityGateJsonPointer}.`,
    );
  }

  return {
    registryEntryId: entry.registryEntryId,
    modelVersion: entry.modelVersion,
    valid: errors.length === 0,
    checkedReferences: references.map(({ path, jsonPointer, split }) => ({
      path,
      jsonPointer,
      split,
    })),
    modelCardPath: entry.evidence.modelCardPath,
    qualityGateJsonPointer: entry.evidence.qualityGateJsonPointer,
    errors,
  };
}

function requireGate(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Release evidence gate failed: ${message}`);
  }
}

const csv = await readFile(resolve(repositoryRoot, 'data', 'flight.csv'), 'utf8');
const run = await legacyCsvAdapter.parse(csv, {
  runId: 'included-baseline-release-evidence',
  createdAt: fixedAnalysisTime,
  profileId: includedBaselineProfile.id,
  profileVersion: includedBaselineProfile.version,
});
const analysis = analyzeTelemetryRun(run, includedBaselineProfile, {
  generatedAt: fixedAnalysisTime,
});
const findingDistribution = countFindingsByRule(analysis.findings);
const coverage = await readJson<CoverageSummary>('coverage/coverage-summary.json');
const benchmark = await readJson<Record<string, unknown>>('benchmark/latest.json');
const modelEvaluation = await readJson<Record<string, unknown>>('models/evaluation_v1.json');
const temporalResearchEvaluation = includeTemporalEvidence
  ? await readJson<Record<string, unknown>>('models/temporal_evaluation_v1.json')
  : undefined;
const temporalIntegratedEvaluation = includeTemporalEvidence
  ? await readJson<Record<string, unknown>>('models/temporal_evaluation_v2.json')
  : undefined;
const temporalBenchmark = includeTemporalEvidence
  ? await readJson<Record<string, unknown>>('benchmark/temporal-latest.json')
  : undefined;
const temporalCampaign = includeTemporalEvidence
  ? await readJson<Record<string, unknown>>('artifacts/temporal-campaign-report.json')
  : undefined;
const temporalCampaignArtifactHash = includeTemporalEvidence
  ? createHash('sha256')
      .update(await readFile(resolve(repositoryRoot, 'artifacts', 'temporal-campaign-report.json')))
      .digest('hex')
  : undefined;
const modelConfigurationManifest = includeTemporalEvidence
  ? await readJson<{
      schemaVersion: string;
      entries: Array<{
        registryEntryId: string;
        modelVersion: string;
        canonicalJson: string;
        sha256: string;
      }>;
    }>('models/model_configuration_manifest_v1.json')
  : undefined;
const traceability = await readJson<{
  schemaVersion: string;
  mappings: TraceabilityMapping[];
}>('requirements/traceability.json');

const requirementIds = [
  ...new Set(traceability.mappings.flatMap((mapping) => mapping.requirements)),
];
const testIds = [...new Set(traceability.mappings.flatMap((mapping) => mapping.tests))];
const expectedSourceRevision = process.env.GITHUB_SHA ?? process.env.SOURCE_REVISION;
const benchmarkReproducibility = benchmark.reproducibility as
  { applicationVersion?: string; sourceRevision?: string } | undefined;
const temporalBenchmarkReproducibility = temporalBenchmark?.reproducibility as
  | {
      applicationVersion?: string;
      sourceRevision?: string;
      model?: {
        role?: string;
        modelVersion?: string;
        artifactPath?: string;
        artifactSha256?: string;
        authority?: string;
      };
    }
  | undefined;
const temporalCampaignSpec = temporalCampaign?.spec as
  { metadata?: { synthetic?: boolean; dataClassification?: string } } | undefined;
const robustRegistryEvidence = includeExpandedEvidence
  ? await validateRegistryEvidence(robustCovarianceRegistryEntry)
  : undefined;
const temporalResearchRegistryEvidence = includeTemporalEvidence
  ? await validateRegistryEvidence(temporalFaultResearchRegistryEntry)
  : undefined;
const temporalIntegratedRegistryEvidence = includeTemporalEvidence
  ? await validateRegistryEvidence(temporalFaultRegistryEntry)
  : undefined;
const modelGate =
  (modelEvaluation.qualityGate as { passed?: boolean } | undefined)?.passed === true;
const temporalResearchGate =
  (temporalResearchEvaluation?.qualityGate as { passed?: boolean } | undefined)?.passed === true;
const temporalIntegratedGate =
  (temporalIntegratedEvaluation?.qualityGate as { passed?: boolean } | undefined)?.passed === true;
const temporalIntegratedEligibility = integratedTemporalEligibility(temporalIntegratedEvaluation);
const temporalResearchArtifactBytes = includeTemporalEvidence
  ? await readFile(resolve(repositoryRoot, 'models', 'temporal_fault_model_v1.json'))
  : undefined;
const temporalIntegratedArtifactBytes = includeTemporalEvidence
  ? await readFile(resolve(repositoryRoot, 'models', 'temporal_fault_model_v2.json'))
  : undefined;
const temporalResearchArtifactDocument = temporalResearchArtifactBytes
  ? (JSON.parse(temporalResearchArtifactBytes.toString('utf8')) as unknown)
  : undefined;
const temporalResearchArtifactHash = temporalResearchArtifactBytes
  ? createHash('sha256').update(temporalResearchArtifactBytes).digest('hex')
  : undefined;
const temporalIntegratedArtifactHash = temporalIntegratedArtifactBytes
  ? createHash('sha256').update(temporalIntegratedArtifactBytes).digest('hex')
  : undefined;
const temporalEvaluationExtensions = includeTemporalEvidence
  ? validateTemporalEvaluationExtensions(
      temporalResearchEvaluation,
      temporalResearchArtifactDocument,
      temporalResearchArtifactHash,
    )
  : undefined;
const temporalResearchConfiguration = modelConfigurationManifest?.entries.find(
  ({ registryEntryId, modelVersion }) =>
    registryEntryId === temporalFaultResearchRegistryEntry.registryEntryId &&
    modelVersion === temporalFaultResearchRegistryEntry.modelVersion,
);
const temporalIntegratedConfiguration = modelConfigurationManifest?.entries.find(
  ({ registryEntryId, modelVersion }) =>
    registryEntryId === temporalFaultRegistryEntry.registryEntryId &&
    modelVersion === temporalFaultRegistryEntry.modelVersion,
);
const temporalResearchConfigurationHash = temporalResearchConfiguration
  ? createHash('sha256').update(temporalResearchConfiguration.canonicalJson).digest('hex')
  : undefined;
const temporalIntegratedConfigurationHash = temporalIntegratedConfiguration
  ? createHash('sha256').update(temporalIntegratedConfiguration.canonicalJson).digest('hex')
  : undefined;
const temporalCampaignSummary = temporalCampaign?.summary as
  { plannedCases?: number; completedCases?: number; failedCases?: number } | undefined;

const gates = {
  datasetHash: run.provenance.datasetSha256 === expectedDatasetHash,
  acceptedRecords: run.samples.length === 85,
  quarantinedRecords: run.quarantinedRows.length === 0,
  fatalValidation: run.fatal === false,
  findingTotal: analysis.findings.length === 9,
  overspeed: findingDistribution['baseline.overspeed'] === 5,
  rapidDescent: findingDistribution['baseline.rapid-descent'] === 3,
  fuelChange: findingDistribution['baseline.fuel-change'] === 1,
  branchCoverage: coverage.total.branches.pct >= 90,
  ...(includeExpandedEvidence
    ? {
        modelQuality: modelGate,
        modelEvidenceReferences: robustRegistryEvidence?.valid === true,
        benchmarkApplicationVersion:
          benchmarkReproducibility?.applicationVersion === APPLICATION_VERSION,
        benchmarkSourceRevision:
          expectedSourceRevision === undefined ||
          benchmarkReproducibility?.sourceRevision === expectedSourceRevision,
      }
    : {}),
  ...(includeTemporalEvidence
    ? {
        temporalResearchModelQuality: temporalResearchGate,
        temporalIntegratedDeclaredArtifactGate: temporalIntegratedGate,
        temporalIntegratedModelQuality: temporalIntegratedEligibility.passed,
        temporalResearchModelEvidenceReferences: temporalResearchRegistryEvidence?.valid === true,
        temporalIntegratedModelEvidenceReferences:
          temporalIntegratedRegistryEvidence?.valid === true,
        temporalResearchEvaluationExtensions: temporalEvaluationExtensions?.valid === true,
        temporalResearchArtifactIdentity:
          temporalResearchArtifactHash ===
          temporalFaultResearchRegistryEntry.identities.artifactSha256,
        temporalIntegratedArtifactIdentity:
          temporalIntegratedArtifactHash === temporalFaultRegistryEntry.identities.artifactSha256 &&
          temporalIntegratedArtifactHash ===
            (temporalIntegratedEvaluation?.artifactSha256 as string | undefined),
        temporalResearchConfigurationIdentity:
          temporalResearchConfigurationHash === temporalResearchConfiguration?.sha256 &&
          temporalResearchConfigurationHash ===
            temporalFaultResearchRegistryEntry.identities.configurationSha256,
        temporalIntegratedConfigurationIdentity:
          temporalIntegratedConfigurationHash === temporalIntegratedConfiguration?.sha256 &&
          temporalIntegratedConfigurationHash ===
            temporalFaultRegistryEntry.identities.configurationSha256,
        temporalCampaignComplete:
          temporalCampaign?.status === 'completed' &&
          (temporalCampaignSummary?.plannedCases ?? 0) > 0 &&
          temporalCampaignSummary?.completedCases === temporalCampaignSummary?.plannedCases &&
          temporalCampaignSummary?.failedCases === 0,
        temporalBenchmarkBoundary:
          temporalBenchmark?.schemaVersion === 'temporal-benchmark.v1' &&
          temporalBenchmark?.evidenceKind === 'node-proxy' &&
          temporalBenchmark?.syntheticDataOnly === true &&
          temporalBenchmark?.dataClassification === 'SYNTHETIC_UNCLASSIFIED',
        temporalBenchmarkApplicationVersion:
          temporalBenchmarkReproducibility?.applicationVersion === APPLICATION_VERSION,
        temporalBenchmarkSourceRevision:
          expectedSourceRevision === undefined ||
          temporalBenchmarkReproducibility?.sourceRevision === expectedSourceRevision,
        temporalBenchmarkIntegratedModel:
          temporalBenchmarkReproducibility?.model?.role === 'integrated-production-advisory' &&
          temporalBenchmarkReproducibility.model.modelVersion ===
            temporalFaultRegistryEntry.modelVersion &&
          temporalBenchmarkReproducibility.model.artifactPath ===
            'models/temporal_fault_model_v2.json' &&
          temporalBenchmarkReproducibility.model.artifactSha256 ===
            temporalIntegratedArtifactHash &&
          temporalBenchmarkReproducibility.model.authority === 'deterministic-rules',
        temporalCampaignBoundary:
          temporalCampaignSpec?.metadata?.synthetic === true &&
          temporalCampaignSpec.metadata.dataClassification === 'SYNTHETIC_UNCLASSIFIED',
      }
    : {}),
};

for (const [gate, passed] of Object.entries(gates)) {
  requireGate(passed, gate);
}

const report = {
  reportSchemaVersion: 'release-verification.v1',
  runId: run.runId,
  createdAt: generatedAt,
  status: exactTagReleaseContext ? 'pass' : 'candidate',
  dataBoundary:
    'All telemetry, profiles, thresholds, and injected scenarios are synthetic and unclassified.',
  applicationVersion: APPLICATION_VERSION,
  profileId: includedBaselineProfile.id,
  profileVersion: includedBaselineProfile.version,
  adapter: `${run.adapterId}@${run.adapterVersion}`,
  datasetHash: run.provenance.datasetSha256,
  provenance: {
    applicationVersion: APPLICATION_VERSION,
    sourceRevision: process.env.GITHUB_SHA ?? process.env.SOURCE_REVISION ?? 'working-tree',
    adapter: `${run.adapterId}@${run.adapterVersion}`,
    datasetHash: run.provenance.datasetSha256,
    profileId: includedBaselineProfile.id,
    profileVersion: includedBaselineProfile.version,
    generatedAt,
  },
  releaseContext: {
    exactTagReleaseContext,
    ci: process.env.CI === 'true',
    refType: process.env.GITHUB_REF_TYPE ?? 'local',
    note: exactTagReleaseContext
      ? 'Generated after the exact-tag workflow reached the verification-report step.'
      : 'Candidate component evidence only. This is not a CI, browser, accessibility, security, release, or deployment result.',
  },
  recordCounts: {
    total: run.provenance.totalRows,
    accepted: run.samples.length,
    quarantined: run.quarantinedRows.length,
    validationErrors: run.validationIssues.filter((issue) => issue.disposition === 'fatal').length,
  },
  validation: {
    fatal: run.fatal,
    issues: run.validationIssues,
  },
  sources: run.sources.map((source) => ({
    sourceId: source.sourceId,
    profileId: includedBaselineProfile.id,
    schemaVersion: run.schemaVersion,
    acceptedRecords: run.samples.filter((sample) => sample.sourceId === source.sourceId).length,
    droppedMessages: 0,
  })),
  findings: analysis.findings,
  comparison: {
    outcome: 'baseline-golden-regression',
    status: 'pass',
    expected: {
      acceptedRecords: 85,
      findingTotal: 9,
      distribution: {
        'baseline.overspeed': 5,
        'baseline.rapid-descent': 3,
        'baseline.fuel-change': 1,
      },
    },
    actual: {
      acceptedRecords: run.samples.length,
      findingTotal: analysis.findings.length,
      distribution: findingDistribution,
    },
  },
  coverage: coverage.total,
  ...(includeExpandedEvidence ? { benchmark, modelEvaluation } : {}),
  ...(includeTemporalEvidence
    ? {
        temporalEvidence: {
          benchmark: temporalBenchmark,
          campaign: temporalCampaign
            ? {
                schemaVersion: temporalCampaign.schemaVersion,
                artifactPath: 'artifacts/temporal-campaign-report.json',
                artifactSha256: temporalCampaignArtifactHash,
                runId: temporalCampaign.runId,
                campaignId: temporalCampaign.campaignId,
                createdAt: temporalCampaign.createdAt,
                status: temporalCampaign.status,
                replaySpecSha256: isRecord(temporalCampaign.replayManifest)
                  ? temporalCampaign.replayManifest.specSha256
                  : undefined,
                summary: temporalCampaign.summary,
                metrics: temporalCampaign.metrics,
                boundary: temporalCampaignSpec?.metadata,
                evidencePolicy: {
                  fullCampaignEmbedded: false,
                  note: 'The complete versioned campaign is published as a separate release artifact.',
                },
              }
            : undefined,
          authorityBoundary:
            'Both learned artifacts are advisory. Deterministic rules remain authoritative for verification status.',
          models: {
            research: {
              role: 'research-evidence-only',
              productionPath: false,
              authority: 'deterministic-rules',
              modelVersion: temporalFaultResearchRegistryEntry.modelVersion,
              artifactVersion: temporalFaultResearchRegistryEntry.artifact.artifactVersion,
              modelType: temporalFaultResearchRegistryEntry.artifact.modelType,
              artifactPath: 'models/temporal_fault_model_v1.json',
              artifactSha256: temporalResearchArtifactHash,
              configurationSha256: temporalResearchConfigurationHash,
              qualityGatePassed: temporalResearchGate,
              evaluation: temporalResearchEvaluation,
              registry: temporalFaultResearchRegistryEntry,
              registryEvidence: temporalResearchRegistryEvidence,
              evaluationExtensionIntegrity: temporalEvaluationExtensions,
            },
            integrated: {
              role: 'production-integrated-advisory',
              productionPath: true,
              authority: 'deterministic-rules',
              modelVersion: temporalFaultRegistryEntry.modelVersion,
              artifactVersion: temporalFaultRegistryEntry.artifact.artifactVersion,
              modelType: temporalFaultRegistryEntry.artifact.modelType,
              artifactPath: 'models/temporal_fault_model_v2.json',
              artifactSha256: temporalIntegratedArtifactHash,
              configurationSha256: temporalIntegratedConfigurationHash,
              qualityGatePassed: temporalIntegratedEligibility.passed,
              eligibility: temporalIntegratedEligibility,
              evaluation: temporalIntegratedEvaluation,
              registry: temporalFaultRegistryEntry,
              registryEvidence: temporalIntegratedRegistryEvidence,
            },
          },
        },
      }
    : {}),
  traceability: {
    schemaVersion: traceability.schemaVersion,
    requirementCount: requirementIds.length,
    declaredTestIdCount: testIds.length,
  },
  registryEvidence: {
    ...(robustRegistryEvidence ? { robustCovariance: robustRegistryEvidence } : {}),
    ...(temporalResearchRegistryEvidence
      ? { temporalFaultResearch: temporalResearchRegistryEvidence }
      : {}),
    ...(temporalIntegratedRegistryEvidence
      ? { temporalFaultIntegrated: temporalIntegratedRegistryEvidence }
      : {}),
  },
  requirementResults: [
    {
      requirementId: 'FDW-ING-003',
      status: 'pass',
      testIds: ['TC-CSV-001', 'TC-CSV-002'],
      evidence: 'Included dataset hash and 85 accepted records verified by the generated report.',
    },
    {
      requirementId: 'FDW-RUL-009',
      status: 'pass',
      testIds: ['TC-RULE-001', 'TC-RULE-002', 'TC-RULE-003', 'TC-RULE-004'],
      evidence: 'Exact 5 overspeed, 3 rapid-descent, and 1 fuel-change distribution verified.',
    },
    {
      requirementId: 'FDW-CM-004',
      status: 'pass',
      testIds: ['TC-CM-001'],
      evidence: `Extracted-core branch coverage is ${coverage.total.branches.pct} percent.`,
    },
    ...(includeExpandedEvidence
      ? [
          {
            requirementId: 'FDW-ML-005',
            status: modelGate ? 'pass' : 'fail',
            testIds: ['TC-ML-002', 'TC-ML-003'],
            evidence:
              'Committed held-out evaluation satisfies the declared F1 and false-positive gates.',
          },
        ]
      : []),
    ...(includeTemporalEvidence
      ? [
          {
            requirementId: 'FDW-REG-001',
            status:
              gates.temporalResearchArtifactIdentity &&
              gates.temporalIntegratedArtifactIdentity &&
              gates.temporalResearchConfigurationIdentity &&
              gates.temporalIntegratedConfigurationIdentity
                ? 'pass'
                : 'fail',
            testIds: ['TC-REG-001', 'TC-REG-007'],
            evidence:
              'The v1 research and v2 integrated temporal artifact bytes and canonical configurations each recompute to their version-specific registered SHA-256 identities.',
          },
          {
            requirementId: 'FDW-TML-004',
            status: gates.temporalIntegratedModelQuality ? 'pass' : 'fail',
            testIds: ['TC-TML-005', 'TC-TML-012'],
            evidence: `The v2 production-integrated advisory artifact is evaluated on ${temporalIntegratedEligibility.metricScope} evidence and must satisfy the FDW-TML-004 thresholds plus any stricter artifact-declared threshold. The v1 research artifact is reported separately and cannot satisfy this requirement.`,
          },
          {
            requirementId: 'FDW-CAM-005',
            status: gates.temporalCampaignComplete ? 'pass' : 'fail',
            testIds: ['TC-CAM-001', 'TC-CAM-006', 'TC-CAM-009'],
            evidence:
              'The release campaign completed its declared matrix with a versioned specification hash and ordered replay manifest.',
          },
        ]
      : []),
  ],
  releaseGates: gates,
  exportPolicy: {
    sourceDataIncluded: false,
    note: 'The verification report contains findings and provenance, not source telemetry samples.',
  },
};

const outputDirectory = resolve(repositoryRoot, 'artifacts');
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, 'verification-report.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`release-report: wrote verified evidence to ${outputPath}`);
