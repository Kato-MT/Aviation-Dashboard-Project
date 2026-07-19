import learnedBaselineArtifactJson from '../../models/robust_covariance_v1.json';
import { TELEMETRY_SCHEMA_VERSION } from '../core/types';
import {
  modelPassesQualityGate,
  parseLearnedBaselineArtifact,
  scoreLearnedBaseline,
} from '../ml/learnedBaseline';
import type { TemporalModelScore } from '../ml/temporalTypes';
import { evaluateModelCompatibility } from '../model-registry/compatibility';
import { robustCovarianceRegistryEntry } from '../model-registry/registry';
import { TEMPORAL_DATA_CLASSIFICATION, TEMPORAL_SCHEMA_VERSION } from '../temporal/types';
import type { TemporalMeasurements, TemporalScenario } from '../temporal/types';
import type {
  InvestigationCovarianceAdvisoryState,
  InvestigationCovarianceCompatibilityReason,
  InvestigationDeterministicRuleState,
  InvestigationFourWayAgreement,
  InvestigationFusionPoint,
  InvestigationIndication,
  InvestigationKalmanInnovationState,
  InvestigationPointEvidence,
  InvestigationSignalDecision,
  InvestigationTemporalAdvisoryState,
} from './types';

const AUTHORITY = 'deterministic-rules' as const;
const KALMAN_INNOVATION_THRESHOLD = 3 as const;
const TOP_RESIDUAL_LIMIT = 3;
const FIXED_WING_PROFILE_VERSION = '1.0.0';

const learnedBaselineArtifact = parseLearnedBaselineArtifact(learnedBaselineArtifactJson);

export const INVESTIGATION_COVARIANCE_CHANNEL_MAPPING = Object.freeze({
  airspeed: {
    unit: 'kts',
    sourceSensors: ['indicatedAirspeed', 'gpsGroundSpeed'],
    transform: 'finite mean of available redundant sensors',
  },
  altitude: {
    unit: 'ft',
    sourceSensors: ['barometricAltitude', 'gpsAltitude'],
    transform: 'Kalman fused estimate when at least one altitude observation is available',
  },
  verticalRate: {
    unit: 'ft/min',
    sourceSensors: ['inertialVerticalRate', 'barometricVerticalRate'],
    transform: 'Kalman fused estimate when at least one vertical-rate observation is available',
  },
  fuel: {
    unit: '%',
    sourceSensors: ['fuelQuantity'],
    transform: 'direct finite observation',
  },
  vibration: {
    unit: 'g',
    sourceSensors: ['vibration'],
    transform: 'direct finite observation',
  },
} as const);

interface CovarianceScenarioContext {
  readonly enabled: boolean;
  readonly reasons: readonly InvestigationCovarianceCompatibilityReason[];
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteMean(values: readonly (number | null | undefined)[]): number | null {
  const available = values.filter(finite);
  return available.length === 0
    ? null
    : available.reduce((sum, value) => sum + value, 0) / available.length;
}

function compatibilityReason(
  code: string,
  detail: string,
  channels: readonly string[] = [],
): InvestigationCovarianceCompatibilityReason {
  return { code, detail, channels };
}

export function covarianceScenarioContext(
  scenario: TemporalScenario,
  enabled: boolean,
): CovarianceScenarioContext {
  const sourceReasons: InvestigationCovarianceCompatibilityReason[] = [];
  if (scenario.schemaVersion !== TEMPORAL_SCHEMA_VERSION) {
    sourceReasons.push(
      compatibilityReason(
        'SOURCE_SCHEMA_MISMATCH',
        `Expected ${TEMPORAL_SCHEMA_VERSION} synthetic source data before telemetry normalization; received ${String(scenario.schemaVersion)}.`,
      ),
    );
  }
  if (scenario.profileId !== 'generic-fixed-wing') {
    sourceReasons.push(
      compatibilityReason(
        'PROFILE_ID_MISMATCH',
        `Covariance mapping supports generic-fixed-wing only; received ${String(scenario.profileId)}.`,
      ),
    );
  }
  if (scenario.synthetic !== true || scenario.dataClassification !== TEMPORAL_DATA_CLASSIFICATION) {
    sourceReasons.push(
      compatibilityReason(
        'SOURCE_CLASSIFICATION_MISMATCH',
        'Covariance Investigation scoring supports declared synthetic, unclassified scenarios only.',
      ),
    );
  }
  if (scenario.samples.some((sample) => sample.sourceId !== 'synthetic-fixed-wing-1')) {
    sourceReasons.push(
      compatibilityReason(
        'SOURCE_ID_MISMATCH',
        'Covariance Investigation mapping supports synthetic-fixed-wing-1 samples only.',
      ),
    );
  }

  const compatibility = evaluateModelCompatibility(robustCovarianceRegistryEntry, {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    profile: { id: 'generic-fixed-wing', version: FIXED_WING_PROFILE_VERSION },
    channelUnits: Object.fromEntries(
      Object.entries(INVESTIGATION_COVARIANCE_CHANNEL_MAPPING).map(([channel, mapping]) => [
        channel,
        mapping.unit,
      ]),
    ),
    cadenceMs: scenario.cadenceMs,
    windowLength: 1,
    artifactSha256: robustCovarianceRegistryEntry.identities.artifactSha256!,
    configurationSha256: robustCovarianceRegistryEntry.identities.configurationSha256!,
    userSelection: enabled ? 'enabled' : 'disabled',
    qualityGatePassed: modelPassesQualityGate(learnedBaselineArtifact),
  });
  const registryReasons = compatibility.reasons.map((reason) =>
    compatibilityReason(
      reason.code,
      reason.detail,
      reason.channel === undefined ? [] : [reason.channel],
    ),
  );
  return { enabled, reasons: [...sourceReasons, ...registryReasons] };
}

function covarianceMeasurements(
  measurements: TemporalMeasurements,
  fusion: InvestigationFusionPoint,
): Readonly<Record<string, number | null>> {
  return {
    airspeed: finiteMean([measurements.indicatedAirspeed, measurements.gpsGroundSpeed]),
    altitude: fusion.observed.altitude === null ? null : fusion.estimated.altitude,
    verticalRate: fusion.observed.verticalRate === null ? null : fusion.estimated.verticalRate,
    fuel: finite(measurements.fuelQuantity) ? measurements.fuelQuantity : null,
    vibration: finite(measurements.vibration) ? measurements.vibration : null,
  };
}

export function covarianceAdvisoryState(
  measurements: TemporalMeasurements,
  fusion: InvestigationFusionPoint,
  context: CovarianceScenarioContext,
): InvestigationCovarianceAdvisoryState {
  const mapped = covarianceMeasurements(measurements, fusion);
  const missingChannels = Object.entries(mapped)
    .filter(([, value]) => !finite(value))
    .map(([channel]) => channel);
  const reasons = [
    ...context.reasons,
    ...(missingChannels.length === 0
      ? []
      : [
          compatibilityReason(
            'MISSING_MODEL_INPUT',
            `Finite covariance inputs are unavailable for: ${missingChannels.join(', ')}.`,
            missingChannels,
          ),
        ]),
  ];
  if (reasons.length > 0) {
    return {
      authority: AUTHORITY,
      role: 'advisory',
      registryEntryId: 'generic-fixed-wing.robust-covariance',
      state: 'unsupported',
      decision: 'not-available',
      supported: false,
      active: false,
      score: null,
      threshold: learnedBaselineArtifact.scoreThreshold,
      unsupportedReason: reasons.map(({ detail }) => detail).join(' '),
      compatibilityReasons: reasons,
    };
  }

  const score = scoreLearnedBaseline(learnedBaselineArtifact, mapped, context.enabled);
  const state = !score.qualityGatePassed
    ? 'ineligible'
    : !score.active
      ? 'disabled'
      : score.anomalous
        ? 'indicate'
        : 'nominal';
  const decision: InvestigationSignalDecision =
    state === 'indicate' || state === 'nominal' ? state : 'not-available';
  return {
    authority: AUTHORITY,
    role: 'advisory',
    registryEntryId: 'generic-fixed-wing.robust-covariance',
    state,
    decision,
    supported: true,
    active: score.active,
    score,
    threshold: learnedBaselineArtifact.scoreThreshold,
    unsupportedReason: null,
    compatibilityReasons: [],
  };
}

export function deterministicRuleState(
  indications: readonly InvestigationIndication[],
): InvestigationDeterministicRuleState {
  return {
    authority: AUTHORITY,
    role: 'authoritative',
    state: indications.length > 0 ? 'indicate' : 'nominal',
    indicationCount: indications.length,
    ruleIds: [...new Set(indications.map(({ ruleId }) => ruleId))].sort(),
  };
}

export function kalmanInnovationState(
  fusion: InvestigationFusionPoint,
): InvestigationKalmanInnovationState {
  const topResidualSensorChannels = [...fusion.evidence.innovations]
    .sort(
      (left, right) =>
        Math.abs(right.normalizedInnovation) - Math.abs(left.normalizedInnovation) ||
        left.sensorId.localeCompare(right.sensorId),
    )
    .slice(0, TOP_RESIDUAL_LIMIT)
    .map((innovation) => ({
      sensorId: innovation.sensorId,
      normalizedInnovation: innovation.normalizedInnovation,
      absoluteNormalizedInnovation: Math.abs(innovation.normalizedInnovation),
      innovation: innovation.innovation,
      observedValue: innovation.observedValue,
      predictedValue: innovation.predictedValue,
    }));
  if (topResidualSensorChannels.length === 0) {
    return {
      authority: AUTHORITY,
      role: 'supporting-evidence',
      state: 'unsupported',
      decision: 'not-available',
      threshold: KALMAN_INNOVATION_THRESHOLD,
      maximumAbsoluteNormalizedInnovation: null,
      topResidualSensorChannels: [],
      missingSensors: [...fusion.missingSensors],
      unsupportedReason: 'No finite altitude or vertical-rate observations were available.',
    };
  }
  const maximum = topResidualSensorChannels[0]!.absoluteNormalizedInnovation;
  const state = maximum > KALMAN_INNOVATION_THRESHOLD ? 'indicate' : 'nominal';
  return {
    authority: AUTHORITY,
    role: 'supporting-evidence',
    state,
    decision: state,
    threshold: KALMAN_INNOVATION_THRESHOLD,
    maximumAbsoluteNormalizedInnovation: maximum,
    topResidualSensorChannels,
    missingSensors: [...fusion.missingSensors],
    unsupportedReason: null,
  };
}

export function temporalAdvisoryState(
  warmupRemaining: number,
  score: TemporalModelScore | null,
): InvestigationTemporalAdvisoryState {
  let state: InvestigationTemporalAdvisoryState['state'];
  if (score === null) state = 'warming-up';
  else if (score.activation.inactiveReason === 'quality-gate-failed') state = 'ineligible';
  else if (!score.activation.active) state = 'disabled';
  else if (score.abstained) state = 'abstained';
  else state = score.anomalous ? 'indicate' : 'nominal';
  return {
    authority: AUTHORITY,
    role: 'advisory',
    state,
    decision: state === 'indicate' || state === 'nominal' ? state : 'not-available',
    warmupRemaining,
    score,
  };
}

export function fourWayAgreement(
  deterministicRules: InvestigationDeterministicRuleState,
  covarianceAdvisory: InvestigationCovarianceAdvisoryState,
  kalmanInnovation: InvestigationKalmanInnovationState,
  temporalAdvisory: InvestigationTemporalAdvisoryState,
): InvestigationFourWayAgreement {
  const decisions = {
    deterministicRules: deterministicRules.state,
    covarianceAdvisory: covarianceAdvisory.decision,
    kalmanInnovation: kalmanInnovation.decision,
    temporalAdvisory: temporalAdvisory.decision,
  } as const;
  const comparable = Object.values(decisions).filter(
    (decision): decision is 'indicate' | 'nominal' => decision !== 'not-available',
  );
  const indicatingSignals = comparable.filter((decision) => decision === 'indicate').length;
  const nominalSignals = comparable.length - indicatingSignals;
  const unavailableSignals: InvestigationFourWayAgreement['unavailableSignals'] = [
    ...(covarianceAdvisory.decision === 'not-available' ? (['covariance-advisory'] as const) : []),
    ...(kalmanInnovation.decision === 'not-available' ? (['kalman-innovation'] as const) : []),
    ...(temporalAdvisory.decision === 'not-available' ? (['temporal-advisory'] as const) : []),
  ];
  return {
    authority: AUTHORITY,
    authoritativeDecision: deterministicRules.state,
    state:
      indicatingSignals === comparable.length
        ? 'unanimous-indicate'
        : nominalSignals === comparable.length
          ? 'unanimous-nominal'
          : 'mixed',
    complete: unavailableSignals.length === 0,
    decisions,
    indicatingSignals,
    nominalSignals,
    unavailableSignals,
  };
}

export function investigationPointEvidence(
  measurements: TemporalMeasurements,
  fusion: InvestigationFusionPoint,
  indications: readonly InvestigationIndication[],
  warmupRemaining: number,
  temporalScore: TemporalModelScore | null,
  covarianceContext: CovarianceScenarioContext,
): InvestigationPointEvidence {
  const deterministicRules = deterministicRuleState(indications);
  const covarianceAdvisory = covarianceAdvisoryState(measurements, fusion, covarianceContext);
  const kalmanInnovation = kalmanInnovationState(fusion);
  const temporalAdvisory = temporalAdvisoryState(warmupRemaining, temporalScore);
  return {
    deterministicRules,
    covarianceAdvisory,
    kalmanInnovation,
    temporalAdvisory,
    fourWayAgreement: fourWayAgreement(
      deterministicRules,
      covarianceAdvisory,
      kalmanInnovation,
      temporalAdvisory,
    ),
  };
}
