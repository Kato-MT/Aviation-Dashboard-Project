import {
  analyzeTemporalScenario,
  covarianceScenarioContext,
  type AnalyzeTemporalScenarioOptions,
  type TemporalScenarioInvestigation,
} from '../../investigation';
import {
  modelRegistryEntryKey,
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
} from '../../model-registry';
import { DETERMINISTIC_AUTHORITY, type ModelRegistryEntryKey } from '../../model-registry/types';
import type { ModelActivationPurpose } from '../../model-registry/types';
import {
  DECLARED_TEMPORAL_FAULTS,
  generateTemporalScenario,
  MAX_TEMPORAL_SEED,
  type GenerateTemporalScenarioOptions,
} from '../../temporal/generator';
import type { MissionPhase, TemporalScenario } from '../../temporal/types';
import {
  evaluateInvestigationComparison,
  validateInvestigationSeries,
  type InvestigationComparisonCompatibility,
  type InvestigationComparisonIdentity,
  type InvestigationComparisonWaveform,
  type InvestigationFaultMarker,
  type InvestigationPhaseSegment,
  type InvestigationSeries as ChartInvestigationSeries,
} from '../../ui/investigationCharts';
import {
  projectTemporalV2Compatibility,
  verifyBundledModelEvidence,
  type BundledModelVerificationEvidence,
  type BundledModelVerificationSet,
  type EvidenceVerificationState,
  type ModelConfigurationCompatibilityEvidence,
  type QualityGateVerificationState,
} from './configuration';

export const INVESTIGATION_CADENCE_MS = 1_000 as const;
export const MIN_INVESTIGATION_SAMPLE_COUNT = 60 as const;
export const MAX_INVESTIGATION_SAMPLE_COUNT = 2_000 as const;

export const INVESTIGATION_DEFAULT_CONTROLS = Object.freeze({
  scenarioId: 'gradual-drift',
  seed: '3101',
  sampleCount: '180',
}) satisfies Readonly<InvestigationControlInput>;

const DECLARED_SCENARIO_IDS = new Set<TemporalScenario['scenarioId']>([
  'nominal',
  ...DECLARED_TEMPORAL_FAULTS.map(({ id }) => id),
]);

export interface InvestigationControlInput {
  readonly scenarioId: string;
  readonly seed: string | number;
  readonly sampleCount: string | number;
}

export interface InvestigationRunConfiguration {
  readonly scenarioId: TemporalScenario['scenarioId'];
  readonly seed: number;
  readonly sampleCount: number;
  readonly cadenceMs: typeof INVESTIGATION_CADENCE_MS;
}

export type InvestigationModelIntent = 'enabled' | 'disabled';

export interface InvestigationModelIntents {
  readonly temporalModel: InvestigationModelIntent;
  readonly robustCovariance: InvestigationModelIntent;
}

export const INVESTIGATION_DEFAULT_MODEL_INTENTS = Object.freeze({
  temporalModel: 'disabled',
  robustCovariance: 'disabled',
}) satisfies Readonly<InvestigationModelIntents>;

export interface InvestigationModelReason {
  readonly code: string;
  readonly detail: string;
  readonly channels: readonly string[];
}

export interface InvestigationModelActivationEvidence {
  readonly key: ModelRegistryEntryKey;
  readonly contextLabel: string;
  readonly activationPurpose: ModelActivationPurpose;
  readonly userSelection: InvestigationModelIntent;
  readonly expectedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly observedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly identityVerification: {
    readonly artifact: EvidenceVerificationState;
    readonly configuration: EvidenceVerificationState;
  };
  readonly qualityGate: {
    readonly state: QualityGateVerificationState;
    readonly storedPassed: boolean | null;
    readonly recomputedPassed: boolean | null;
  };
  readonly supported: boolean;
  readonly eligible: boolean;
  readonly active: boolean;
  readonly authority: typeof DETERMINISTIC_AUTHORITY;
  readonly reasons: readonly InvestigationModelReason[];
}

export interface InvestigationModelEvidence {
  readonly temporalModel: InvestigationModelActivationEvidence;
  readonly robustCovariance: InvestigationModelActivationEvidence;
}

/**
 * Display-only projection. Expected values and lifecycle markers are verification metadata and are
 * never passed into deterministic rules or advisory model scoring.
 */
export interface PreparedInvestigationChartSeries extends ChartInvestigationSeries {
  readonly expectedAltitude: readonly number[];
  readonly estimatedAltitude: readonly number[];
  readonly expectedVerticalRate: readonly number[];
  readonly observedVerticalRate: readonly (number | null)[];
  readonly predictedVerticalRate: readonly number[];
  readonly estimatedVerticalRate: readonly number[];
  readonly lowerVerticalRateUncertainty: readonly number[];
  readonly upperVerticalRateUncertainty: readonly number[];
}

export interface InvestigationSettledSnapshot {
  readonly configuration: InvestigationRunConfiguration;
  /** Intent and activation are captured at analysis time so later UI changes cannot relabel evidence. */
  readonly modelIntents: InvestigationModelIntents;
  readonly modelEvidence: InvestigationModelEvidence;
  readonly scenario: TemporalScenario;
  readonly analysis: TemporalScenarioInvestigation;
  readonly chartSeries: PreparedInvestigationChartSeries;
  readonly comparisonIdentity: InvestigationComparisonIdentity;
  readonly defaultSelectedIndex: number;
}

export type InvestigationRunner = (
  configuration: InvestigationRunConfiguration,
  modelIntents: InvestigationModelIntents,
) => Promise<InvestigationSettledSnapshot>;

export interface InvestigationRunnerDependencies {
  readonly verifyBundledModels?: (() => Promise<BundledModelVerificationSet>) | undefined;
  readonly generateScenario?:
    ((options: GenerateTemporalScenarioOptions) => TemporalScenario) | undefined;
  readonly analyzeScenario?:
    | ((
        scenario: TemporalScenario,
        options: AnalyzeTemporalScenarioOptions,
      ) => TemporalScenarioInvestigation)
    | undefined;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableCopy<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function parseIntegerControl(value: string | number, label: string): number {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an integer.`);
    value = Number(normalized);
  }
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}

export function validateInvestigationControls(
  input: Readonly<InvestigationControlInput>,
): Readonly<InvestigationRunConfiguration> {
  if (!DECLARED_SCENARIO_IDS.has(input.scenarioId as TemporalScenario['scenarioId'])) {
    throw new Error(`Unknown Investigation scenario '${input.scenarioId}'.`);
  }
  const seed = parseIntegerControl(input.seed, 'Investigation seed');
  if (seed < 1 || seed > MAX_TEMPORAL_SEED) {
    throw new Error(`Investigation seed must be between 1 and ${MAX_TEMPORAL_SEED}.`);
  }
  const sampleCount = parseIntegerControl(input.sampleCount, 'Investigation sample count');
  if (
    sampleCount < MIN_INVESTIGATION_SAMPLE_COUNT ||
    sampleCount > MAX_INVESTIGATION_SAMPLE_COUNT
  ) {
    throw new Error(
      `Investigation sample count must be between ${MIN_INVESTIGATION_SAMPLE_COUNT} and ${MAX_INVESTIGATION_SAMPLE_COUNT}.`,
    );
  }
  return deepFreeze({
    scenarioId: input.scenarioId as TemporalScenario['scenarioId'],
    seed,
    sampleCount,
    cadenceMs: INVESTIGATION_CADENCE_MS,
  });
}

function assertModelIntent(
  value: string,
  label: string,
): asserts value is InvestigationModelIntent {
  if (value !== 'enabled' && value !== 'disabled') {
    throw new Error(`${label} must be enabled or disabled.`);
  }
}

function validateModelIntents(
  input: Readonly<InvestigationModelIntents>,
): Readonly<InvestigationModelIntents> {
  assertModelIntent(input.temporalModel, 'Temporal-model intent');
  assertModelIntent(input.robustCovariance, 'Robust-covariance intent');
  return deepFreeze({
    temporalModel: input.temporalModel,
    robustCovariance: input.robustCovariance,
  });
}

function meanFinite(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function phaseLabel(phase: MissionPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function phaseSegments(
  investigation: Readonly<TemporalScenarioInvestigation>,
): InvestigationPhaseSegment[] {
  const segments: InvestigationPhaseSegment[] = [];
  for (const point of investigation.points) {
    const previous = segments.at(-1);
    if (previous?.phase === point.phase) {
      previous.endIndex = point.sampleIndex;
    } else {
      segments.push({
        phase: point.phase,
        label: phaseLabel(point.phase),
        startIndex: point.sampleIndex,
        endIndex: point.sampleIndex,
      });
    }
  }
  return segments;
}

function faultMarkers(
  scenario: Readonly<TemporalScenario>,
  investigation: Readonly<TemporalScenarioInvestigation>,
): InvestigationFaultMarker[] {
  const timeline = scenario.faultTimeline;
  if (timeline === null) return [];
  return [
    {
      faultId: timeline.faultId,
      label:
        DECLARED_TEMPORAL_FAULTS.find(({ id }) => id === timeline.faultId)?.label ??
        timeline.faultId,
      onsetIndex: timeline.onsetIndex,
      endIndex: timeline.activeEndIndex,
      recoveryIndex: timeline.recoveryEndIndex,
      ...(investigation.detection.deterministicIndex === null
        ? {}
        : { detectionIndex: investigation.detection.deterministicIndex }),
    },
  ];
}

function requiredValues(
  values: readonly { readonly value: number | null }[],
  label: string,
): number[] {
  return values.map(({ value }, index) => {
    if (value === null || !Number.isFinite(value)) {
      throw new Error(`${label}[${index}] must contain finite evidence.`);
    }
    return value;
  });
}

function optionalValues(values: readonly { readonly value: number | null }[]): (number | null)[] {
  return values.map(({ value }) => value);
}

export function prepareInvestigationChartSeries(
  scenario: Readonly<TemporalScenario>,
  investigation: Readonly<TemporalScenarioInvestigation>,
): Readonly<PreparedInvestigationChartSeries> {
  if (scenario.samples.length !== investigation.points.length) {
    throw new Error('Investigation scenario and analysis lengths must match exactly.');
  }
  const prepared: PreparedInvestigationChartSeries = {
    sampleIndices: investigation.points.map(({ sampleIndex }) => sampleIndex),
    timestamps: investigation.points.map(({ timestamp }) => timestamp),
    expectedAltitude: requiredValues(investigation.series.expectedAltitude, 'expectedAltitude'),
    observedAltitude: optionalValues(investigation.series.observedAltitude),
    predictedAltitude: requiredValues(investigation.series.predictedAltitude, 'predictedAltitude'),
    estimatedAltitude: requiredValues(investigation.series.estimatedAltitude, 'estimatedAltitude'),
    lowerUncertainty: requiredValues(investigation.series.altitude95Lower, 'altitude95Lower'),
    upperUncertainty: requiredValues(investigation.series.altitude95Upper, 'altitude95Upper'),
    expectedVerticalRate: requiredValues(
      investigation.series.expectedVerticalRate,
      'expectedVerticalRate',
    ),
    observedVerticalRate: optionalValues(investigation.series.observedVerticalRate),
    predictedVerticalRate: requiredValues(
      investigation.series.predictedVerticalRate,
      'predictedVerticalRate',
    ),
    estimatedVerticalRate: requiredValues(
      investigation.series.estimatedVerticalRate,
      'estimatedVerticalRate',
    ),
    lowerVerticalRateUncertainty: requiredValues(
      investigation.series.verticalRate95Lower,
      'verticalRate95Lower',
    ),
    upperVerticalRateUncertainty: requiredValues(
      investigation.series.verticalRate95Upper,
      'verticalRate95Upper',
    ),
    observedAirspeed: scenario.samples.map(({ measurements }) =>
      meanFinite([measurements.indicatedAirspeed, measurements.gpsGroundSpeed]),
    ),
    observedFuel: scenario.samples.map(({ measurements }) => measurements.fuelQuantity),
    residualValues: investigation.points.map(
      ({ maximumAbsoluteNormalizedResidual }) => maximumAbsoluteNormalizedResidual,
    ),
    phaseSegments: phaseSegments(investigation),
    faultMarkers: faultMarkers(scenario, investigation),
  };
  validateInvestigationSeries(prepared);
  return deepFreeze(prepared);
}

function verificationReasons(
  bundled: Readonly<BundledModelVerificationEvidence>,
): InvestigationModelReason[] {
  const reasons: InvestigationModelReason[] = [];
  for (const [kind, evidence] of [
    ['ARTIFACT', bundled.artifact],
    ['CONFIGURATION', bundled.configuration],
  ] as const) {
    if (evidence.state !== 'verified') {
      reasons.push({
        code: `${kind}_IDENTITY_${evidence.state.toUpperCase()}`,
        detail: evidence.detail,
        channels: [],
      });
    }
  }
  if (bundled.qualityGate.state !== 'passed') {
    reasons.push({
      code: `QUALITY_GATE_${bundled.qualityGate.state.toUpperCase()}`,
      detail: bundled.qualityGate.detail,
      channels: [],
    });
  }
  if (bundled.activationPurpose !== 'integrated-advisory') {
    reasons.push({
      code: 'RESEARCH_EVIDENCE_ONLY',
      detail: 'This exact model version is research evidence only and cannot activate.',
      channels: [],
    });
  }
  return reasons;
}

function activationEvidence(
  bundled: Readonly<BundledModelVerificationEvidence>,
  contextLabel: string,
  intent: InvestigationModelIntent,
  contextualSupported: boolean,
  contextualReasons: readonly InvestigationModelReason[],
): InvestigationModelActivationEvidence {
  const reasons = [...verificationReasons(bundled), ...contextualReasons];
  const identitiesVerified =
    bundled.artifact.state === 'verified' && bundled.configuration.state === 'verified';
  const supported = identitiesVerified && contextualSupported;
  const eligible =
    supported &&
    bundled.qualityGate.state === 'passed' &&
    bundled.activationPurpose === 'integrated-advisory';
  return {
    key: bundled.key,
    contextLabel,
    activationPurpose: bundled.activationPurpose,
    userSelection: intent,
    expectedIdentities: {
      artifactSha256: bundled.artifact.expectedSha256,
      configurationSha256: bundled.configuration.expectedSha256,
    },
    observedIdentities: {
      artifactSha256: bundled.artifact.actualSha256,
      configurationSha256: bundled.configuration.actualSha256,
    },
    identityVerification: {
      artifact: bundled.artifact.state,
      configuration: bundled.configuration.state,
    },
    qualityGate: {
      state: bundled.qualityGate.state,
      storedPassed: bundled.qualityGate.storedPassed,
      recomputedPassed: bundled.qualityGate.recomputedPassed,
    },
    supported,
    eligible,
    active: eligible && intent === 'enabled',
    authority: DETERMINISTIC_AUTHORITY,
    reasons,
  };
}

function temporalEvidence(
  bundled: Readonly<BundledModelVerificationEvidence>,
  intent: InvestigationModelIntent,
  compatibility: Readonly<ModelConfigurationCompatibilityEvidence>,
): InvestigationModelActivationEvidence {
  const contextualReasons = compatibility.reasons
    .filter(
      ({ code }) =>
        !code.startsWith('ARTIFACT_IDENTITY_') &&
        !code.startsWith('CONFIGURATION_IDENTITY_') &&
        !code.startsWith('QUALITY_GATE_'),
    )
    .map((reason) => ({
      code: reason.code,
      detail: reason.detail,
      channels: 'channel' in reason && reason.channel !== undefined ? [reason.channel] : [],
    }));
  return activationEvidence(
    bundled,
    compatibility.contextLabel,
    intent,
    compatibility.supported,
    contextualReasons,
  );
}

function robustEvidence(
  scenario: Readonly<TemporalScenario>,
  bundled: Readonly<BundledModelVerificationEvidence>,
  intent: InvestigationModelIntent,
): InvestigationModelActivationEvidence {
  const context = covarianceScenarioContext(scenario as TemporalScenario, intent === 'enabled');
  const reasons = context.reasons.map((reason) => ({
    code: reason.code,
    detail: reason.detail,
    channels: [...reason.channels],
  }));
  return activationEvidence(
    bundled,
    'Fixed-wing Investigation covariance projection',
    intent,
    reasons.length === 0,
    reasons,
  );
}

export function investigationComparisonIdentity(
  snapshot: Readonly<InvestigationSettledSnapshot>,
): Readonly<InvestigationComparisonIdentity> {
  return deepFreeze({
    profileId: snapshot.scenario.profileId,
    cadenceMs: snapshot.scenario.cadenceMs,
    sampleCount: snapshot.scenario.samples.length,
    sampleIndices: [...snapshot.chartSeries.sampleIndices],
  });
}

export function investigationComparisonWaveform(
  snapshot: Readonly<InvestigationSettledSnapshot>,
): Readonly<InvestigationComparisonWaveform> {
  return deepFreeze({
    sampleIndices: [...snapshot.chartSeries.sampleIndices],
    observedAltitude: [...snapshot.chartSeries.observedAltitude],
    predictedAltitude: [...snapshot.chartSeries.predictedAltitude],
  });
}

export function compareInvestigationSnapshots(
  baseline: Readonly<InvestigationSettledSnapshot>,
  candidate: Readonly<InvestigationSettledSnapshot>,
): InvestigationComparisonCompatibility {
  return evaluateInvestigationComparison(
    investigationComparisonIdentity(baseline),
    investigationComparisonIdentity(candidate),
  );
}

export function createInvestigationRunner(
  dependencies: Readonly<InvestigationRunnerDependencies> = {},
): InvestigationRunner {
  const verifyModels = dependencies.verifyBundledModels ?? verifyBundledModelEvidence;
  const generateScenario = dependencies.generateScenario ?? generateTemporalScenario;
  const analyzeScenario = dependencies.analyzeScenario ?? analyzeTemporalScenario;

  return async (configuration, modelIntents) => {
    const validatedConfiguration = validateInvestigationControls(configuration);
    if (configuration.cadenceMs !== INVESTIGATION_CADENCE_MS) {
      throw new Error(`Investigation cadence must remain ${INVESTIGATION_CADENCE_MS} ms.`);
    }
    const capturedIntents = validateModelIntents(modelIntents);
    const bundled = await verifyModels();
    const scenario = generateScenario({
      scenarioId: validatedConfiguration.scenarioId,
      seed: validatedConfiguration.seed,
      sampleCount: validatedConfiguration.sampleCount,
      cadenceMs: validatedConfiguration.cadenceMs,
    });
    const temporalCompatibility = projectTemporalV2Compatibility(
      bundled.temporalV2,
      capturedIntents.temporalModel,
    );
    const temporalModel = temporalEvidence(
      bundled.temporalV2,
      capturedIntents.temporalModel,
      temporalCompatibility,
    );
    const robustCovariance = robustEvidence(
      scenario,
      bundled.robustCovariance,
      capturedIntents.robustCovariance,
    );
    const analysis = analyzeScenario(scenario, {
      modelEnabled: temporalModel.active,
      covarianceModelEnabled: robustCovariance.active,
    });
    const chartSeries = prepareInvestigationChartSeries(scenario, analysis);
    const snapshot = {
      configuration: validatedConfiguration,
      modelIntents: capturedIntents,
      modelEvidence: { temporalModel, robustCovariance },
      scenario,
      analysis,
      chartSeries,
      comparisonIdentity: {
        profileId: scenario.profileId,
        cadenceMs: scenario.cadenceMs,
        sampleCount: scenario.samples.length,
        sampleIndices: [...chartSeries.sampleIndices],
      },
      defaultSelectedIndex: scenario.faultTimeline?.onsetIndex ?? 0,
    } satisfies InvestigationSettledSnapshot;
    return immutableCopy(snapshot) as InvestigationSettledSnapshot;
  };
}

export async function runInvestigation(
  configuration: InvestigationRunConfiguration,
  modelIntents: InvestigationModelIntents,
  dependencies: Readonly<InvestigationRunnerDependencies> = {},
): Promise<InvestigationSettledSnapshot> {
  return createInvestigationRunner(dependencies)(configuration, modelIntents);
}

export const defaultInvestigationRunner: InvestigationRunner = createInvestigationRunner();

export const INVESTIGATION_MODEL_KEYS = Object.freeze({
  temporalModel: modelRegistryEntryKey(temporalFaultRegistryEntry),
  robustCovariance: modelRegistryEntryKey(robustCovarianceRegistryEntry),
});
