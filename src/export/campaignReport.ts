import { CAMPAIGN_WORKER_PROTOCOL_VERSION } from '../campaign/worker-protocol';
import type {
  CampaignBootstrapIntervals,
  CampaignGroupMetrics,
  CampaignMetrics,
  CalibrationStatistics,
  ConfusionMatrix,
  DistributionSummary,
  EpisodeMetrics,
  ScenarioCoverage,
} from '../campaign/types';
import { APPLICATION_VERSION } from '../core/constants';
import type { EvidenceBuildIdentity } from '../evidence/types';
import {
  verifyCampaignSettledSnapshot,
  type CampaignGeneratorConfiguration,
  type CampaignMatrixProjection,
  type CampaignSettledSnapshot,
  type CampaignVariationConfiguration,
} from '../features/lab/campaign';
import { DETERMINISTIC_AUTHORITY } from '../model-registry/types';

const MAX_FAILED_CASE_ERROR_NAME_LENGTH = 128;
const MAX_FAILED_CASE_ERROR_MESSAGE_LENGTH = 512;
const SAFE_FAILED_CASE_ERROR_NAMES = new Set([
  'AbortError',
  'Error',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
]);

export interface BuildCampaignReportInput {
  readonly buildIdentity: Readonly<EvidenceBuildIdentity>;
  readonly snapshot: Readonly<CampaignSettledSnapshot>;
  readonly generatedAt?: string | undefined;
}

export interface CampaignFailedCaseSummary {
  readonly caseId: string;
  readonly scenarioId: string;
  readonly phase: string;
  readonly seed: number;
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}

export interface CampaignReportV1 {
  readonly reportSchemaVersion: 'campaign-report.v1';
  readonly generatedAt: string;
  readonly buildIdentities: {
    readonly reactShell: EvidenceBuildIdentity;
    readonly deterministicEngine: {
      readonly applicationVersion: string;
      readonly authority: typeof DETERMINISTIC_AUTHORITY;
    };
  };
  readonly dataBoundary: {
    readonly synthetic: true;
    readonly dataClassification: 'SYNTHETIC_UNCLASSIFIED';
    readonly campaignSchemaVersion: 'campaign.v1';
    readonly workerProtocolVersion: typeof CAMPAIGN_WORKER_PROTOCOL_VERSION;
    readonly generatorKind: 'bundled-fixed-wing-temporal-campaign';
  };
  readonly campaignIdentity: {
    readonly campaignId: string;
    readonly runId: string;
    readonly createdAt: string;
    readonly settledAt: string;
    readonly specSha256: string;
  };
  readonly reproduction: {
    readonly profile: {
      readonly profileId: 'generic-fixed-wing';
      readonly profileVersion: '1.0.0';
    };
    readonly seeds: readonly number[];
    readonly matrix: CampaignMatrixProjection;
    readonly generator: CampaignGeneratorConfiguration;
    readonly variations: readonly CampaignVariationConfiguration[];
    readonly bootstrap: {
      readonly iterations: 300;
      readonly confidenceLevel: 0.95;
      readonly seed: 22_072;
    };
  };
  readonly terminal: {
    readonly status: 'completed' | 'completed-with-errors' | 'cancelled';
    readonly summary: {
      readonly plannedCases: number;
      readonly attemptedCases: number;
      readonly completedCases: number;
      readonly failedCases: number;
      readonly remainingCases: number;
    };
  };
  readonly metrics: CampaignMetrics;
  readonly failedCaseSummaries: readonly CampaignFailedCaseSummary[];
  readonly decisionPolicy: {
    readonly authority: typeof DETERMINISTIC_AUTHORITY;
    readonly temporalCalibrationRole: 'advisory-only';
    readonly temporalArtifactIdentityBound: false;
    readonly verificationLabelsAuthoritativeInputs: false;
  };
  readonly exportPolicy: {
    readonly sourceDataIncluded: false;
    readonly samplesIncluded: false;
    readonly pointsIncluded: false;
    readonly seriesIncluded: false;
    readonly measurementsIncluded: false;
    readonly successfulCaseRowsIncluded: false;
    readonly detectionsIncluded: false;
    readonly detectionDetailsIncluded: false;
    readonly sensorIdsIncluded: false;
    readonly sampleIndicesIncluded: false;
    readonly calibrationObservationsIncluded: false;
    readonly replayManifestCasesIncluded: false;
    readonly failedCaseRawErrorTextIncluded: false;
    readonly truthIncluded: false;
    readonly lifecycleRowsIncluded: false;
    readonly browserStateIncluded: false;
    readonly storageIncluded: false;
    readonly endpointsIncluded: false;
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validTimestamp(value: string, label: string): string {
  const timestampMs = Date.parse(value);
  if (value.trim() === '' || !Number.isFinite(timestampMs)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return new Date(timestampMs).toISOString();
}

function safeErrorName(value: string): string {
  return SAFE_FAILED_CASE_ERROR_NAMES.has(value) ? value : 'Error';
}

function truncate(value: string, maximumLength: number): string {
  return [...value].slice(0, maximumLength).join('');
}

function projectConfusion(input: Readonly<ConfusionMatrix>): ConfusionMatrix {
  return {
    truePositives: input.truePositives,
    falsePositives: input.falsePositives,
    trueNegatives: input.trueNegatives,
    falseNegatives: input.falseNegatives,
  };
}

function projectEpisodes(input: Readonly<EpisodeMetrics>): EpisodeMetrics {
  return { precision: input.precision, recall: input.recall, f1: input.f1 };
}

function projectGroup(input: Readonly<CampaignGroupMetrics>): CampaignGroupMetrics {
  return {
    groupId: input.groupId,
    completedCases: input.completedCases,
    confusion: projectConfusion(input.confusion),
    episodes: projectEpisodes(input.episodes),
  };
}

function projectCoverage(input: Readonly<ScenarioCoverage>): ScenarioCoverage {
  return {
    scenarioId: input.scenarioId,
    plannedCases: input.plannedCases,
    completedCases: input.completedCases,
    casesWithAllExpected: input.casesWithAllExpected,
    expectedEpisodes: input.expectedEpisodes,
    detectedExpectedEpisodes: input.detectedExpectedEpisodes,
    coverage: input.coverage,
  };
}

function projectDistribution(input: Readonly<DistributionSummary>): DistributionSummary {
  return {
    count: input.count,
    minimum: input.minimum,
    maximum: input.maximum,
    mean: input.mean,
    median: input.median,
    p95: input.p95,
  };
}

function projectCalibration(input: Readonly<CalibrationStatistics>): CalibrationStatistics {
  return {
    observations: input.observations,
    answered: input.answered,
    abstained: input.abstained,
    abstentionRate: input.abstentionRate,
    meanConfidence: input.meanConfidence,
    meanConfidenceCorrect: input.meanConfidenceCorrect,
    meanConfidenceIncorrect: input.meanConfidenceIncorrect,
    brierScore: input.brierScore,
    expectedCalibrationError: input.expectedCalibrationError,
  };
}

function projectBootstrap(input: Readonly<CampaignBootstrapIntervals>): CampaignBootstrapIntervals {
  const projectInterval = (
    interval: Readonly<CampaignBootstrapIntervals['precision']>,
  ): CampaignBootstrapIntervals['precision'] => ({
    estimate: interval.estimate,
    lower: interval.lower,
    upper: interval.upper,
    confidenceLevel: interval.confidenceLevel,
    iterations: interval.iterations,
  });
  return {
    precision: projectInterval(input.precision),
    recall: projectInterval(input.recall),
    f1: projectInterval(input.f1),
  };
}

function projectMetrics(input: Readonly<CampaignMetrics>): CampaignMetrics {
  return {
    confusion: projectConfusion(input.confusion),
    episodes: projectEpisodes(input.episodes),
    confusionByProfile: input.confusionByProfile.map(projectGroup),
    confusionByPhase: input.confusionByPhase.map(projectGroup),
    confusionByFault: input.confusionByFault.map(projectGroup),
    scenarioCoverage: input.scenarioCoverage.map(projectCoverage),
    falseAlarmsPerRun: input.falseAlarmsPerRun,
    falseAlarmsPerSyntheticHour: input.falseAlarmsPerSyntheticHour,
    syntheticHours: input.syntheticHours,
    timeToDetection: projectDistribution(input.timeToDetection),
    calibration: projectCalibration(input.calibration),
    bootstrap: projectBootstrap(input.bootstrap),
  };
}

function failedCaseSummaries(
  snapshot: Readonly<CampaignSettledSnapshot>,
): CampaignFailedCaseSummary[] {
  return snapshot.result.cases
    .filter((campaignCase) => campaignCase.status === 'failed')
    .map((campaignCase) => {
      if (campaignCase.error === undefined) {
        throw new Error(`Campaign failed case '${campaignCase.caseId}' has no error evidence.`);
      }
      return {
        caseId: campaignCase.caseId,
        scenarioId: campaignCase.scenarioId,
        phase: campaignCase.phase,
        seed: campaignCase.seed,
        error: {
          name: truncate(safeErrorName(campaignCase.error.name), MAX_FAILED_CASE_ERROR_NAME_LENGTH),
          message: truncate(
            'Raw campaign error text is excluded from this privacy-minimized report.',
            MAX_FAILED_CASE_ERROR_MESSAGE_LENGTH,
          ),
        },
      };
    });
}

export async function buildCampaignReport(
  input: Readonly<BuildCampaignReportInput>,
): Promise<Readonly<CampaignReportV1>> {
  const capturedSnapshot = structuredClone(input.snapshot) as CampaignSettledSnapshot;
  const capturedBuildIdentity = { ...input.buildIdentity };
  const generatedAt = validTimestamp(
    input.generatedAt ?? new Date().toISOString(),
    'Campaign report generatedAt',
  );
  await verifyCampaignSettledSnapshot(capturedSnapshot);
  const result = capturedSnapshot.result;
  const normalizedSettledAt = validTimestamp(
    capturedSnapshot.settledAt,
    'Campaign settlement time',
  );
  const summaries = failedCaseSummaries(capturedSnapshot);
  if (summaries.length !== result.summary.failedCases) {
    throw new Error('Campaign failed-case summaries do not match the terminal summary.');
  }

  const report: CampaignReportV1 = {
    reportSchemaVersion: 'campaign-report.v1',
    generatedAt,
    buildIdentities: {
      reactShell: capturedBuildIdentity,
      deterministicEngine: {
        applicationVersion: APPLICATION_VERSION,
        authority: DETERMINISTIC_AUTHORITY,
      },
    },
    dataBoundary: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      campaignSchemaVersion: 'campaign.v1',
      workerProtocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      generatorKind: 'bundled-fixed-wing-temporal-campaign',
    },
    campaignIdentity: {
      campaignId: result.campaignId,
      runId: result.runId,
      createdAt: result.createdAt,
      settledAt: normalizedSettledAt,
      specSha256: result.replayManifest.specSha256,
    },
    reproduction: {
      profile: { ...capturedSnapshot.configuration.profile },
      seeds: [...capturedSnapshot.configuration.seeds],
      matrix: { ...capturedSnapshot.configuration.matrix },
      generator: { ...capturedSnapshot.configuration.generator },
      variations: capturedSnapshot.configuration.variations.map((variation) => ({ ...variation })),
      bootstrap: {
        iterations: 300,
        confidenceLevel: 0.95,
        seed: 22_072,
      },
    },
    terminal: {
      status: result.status,
      summary: { ...result.summary },
    },
    metrics: projectMetrics(result.metrics),
    failedCaseSummaries: summaries,
    decisionPolicy: {
      authority: DETERMINISTIC_AUTHORITY,
      temporalCalibrationRole: 'advisory-only',
      temporalArtifactIdentityBound: false,
      verificationLabelsAuthoritativeInputs: false,
    },
    exportPolicy: {
      sourceDataIncluded: false,
      samplesIncluded: false,
      pointsIncluded: false,
      seriesIncluded: false,
      measurementsIncluded: false,
      successfulCaseRowsIncluded: false,
      detectionsIncluded: false,
      detectionDetailsIncluded: false,
      sensorIdsIncluded: false,
      sampleIndicesIncluded: false,
      calibrationObservationsIncluded: false,
      replayManifestCasesIncluded: false,
      failedCaseRawErrorTextIncluded: false,
      truthIncluded: false,
      lifecycleRowsIncluded: false,
      browserStateIncluded: false,
      storageIncluded: false,
      endpointsIncluded: false,
    },
  };
  return deepFreeze(report);
}

export async function serializeCampaignReport(
  input: Readonly<BuildCampaignReportInput>,
): Promise<string> {
  return JSON.stringify(await buildCampaignReport(input), null, 2);
}
