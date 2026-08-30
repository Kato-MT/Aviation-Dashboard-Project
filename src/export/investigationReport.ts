import { APPLICATION_VERSION } from '../core/constants';
import type { EvidenceBuildIdentity } from '../evidence/types';
import type {
  InvestigationModelActivationEvidence,
  InvestigationSettledSnapshot,
} from '../features/lab/investigation';
import { DETERMINISTIC_AUTHORITY } from '../model-registry/types';
import type { ModelActivationPurpose } from '../model-registry/types';
import type { TemporalFaultId } from '../temporal/types';

const INVESTIGATION_FAULT_IDS = [
  'gradual-drift',
  'noise-growth',
  'oscillation',
  'lag',
  'intermittent-dropout',
  'stuck-value',
  'gain-error',
  'fuel-leak',
  'cross-sensor-decoupling',
  'simultaneous-faults',
] as const satisfies readonly TemporalFaultId[];

const INVESTIGATION_SCENARIO_IDS = new Set<string>(['nominal', ...INVESTIGATION_FAULT_IDS]);

const ANALYSIS_SERIES_KEYS = [
  'expectedAltitude',
  'observedAltitude',
  'predictedAltitude',
  'estimatedAltitude',
  'altitude95Lower',
  'altitude95Upper',
  'expectedVerticalRate',
  'observedVerticalRate',
  'predictedVerticalRate',
  'estimatedVerticalRate',
  'verticalRate95Lower',
  'verticalRate95Upper',
] as const;

const CHART_ARRAY_KEYS = [
  'sampleIndices',
  'timestamps',
  'expectedAltitude',
  'observedAltitude',
  'predictedAltitude',
  'estimatedAltitude',
  'lowerUncertainty',
  'upperUncertainty',
  'expectedVerticalRate',
  'observedVerticalRate',
  'predictedVerticalRate',
  'estimatedVerticalRate',
  'lowerVerticalRateUncertainty',
  'upperVerticalRateUncertainty',
  'observedAirspeed',
  'observedFuel',
  'residualValues',
] as const;

const CHART_ANALYSIS_SERIES_BINDINGS = [
  ['expectedAltitude', 'expectedAltitude'],
  ['observedAltitude', 'observedAltitude'],
  ['predictedAltitude', 'predictedAltitude'],
  ['estimatedAltitude', 'estimatedAltitude'],
  ['lowerUncertainty', 'altitude95Lower'],
  ['upperUncertainty', 'altitude95Upper'],
  ['expectedVerticalRate', 'expectedVerticalRate'],
  ['observedVerticalRate', 'observedVerticalRate'],
  ['predictedVerticalRate', 'predictedVerticalRate'],
  ['estimatedVerticalRate', 'estimatedVerticalRate'],
  ['lowerVerticalRateUncertainty', 'verticalRate95Lower'],
  ['upperVerticalRateUncertainty', 'verticalRate95Upper'],
] as const;

export interface BuildInvestigationReportInput {
  readonly buildIdentity: Readonly<EvidenceBuildIdentity>;
  readonly snapshot: Readonly<InvestigationSettledSnapshot>;
  readonly generatedAt?: string | undefined;
}

export interface InvestigationReportModelEvidence {
  readonly key: string;
  readonly context: string;
  readonly activationPurpose: ModelActivationPurpose;
  readonly userSelection: 'enabled' | 'disabled';
  readonly expectedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly observedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly identityVerification: {
    readonly artifact: 'pending' | 'verified' | 'mismatch' | 'unavailable';
    readonly configuration: 'pending' | 'verified' | 'mismatch' | 'unavailable';
  };
  readonly qualityGate: {
    readonly state: 'pending' | 'passed' | 'failed' | 'unavailable';
    readonly storedPassed: boolean | null;
    readonly recomputedPassed: boolean | null;
  };
  readonly supported: boolean;
  readonly eligible: boolean;
  readonly active: boolean;
  readonly authority: typeof DETERMINISTIC_AUTHORITY;
  readonly reasons: readonly {
    readonly code: string;
    readonly detail: string;
    readonly channels: readonly string[];
  }[];
}

export interface InvestigationReportDecisionCounts {
  readonly indicate: number;
  readonly nominal: number;
  readonly unavailable: number;
}

export interface InvestigationReportV1 {
  readonly reportSchemaVersion: 'investigation-report.v1';
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
    readonly generatorSchemaVersion: 'temporal-synthetic.v1';
    readonly generatorKind: 'bundled-fixed-wing-scenario-generator';
    readonly profile: {
      readonly id: 'generic-fixed-wing';
      readonly version: '1.0.0';
    };
  };
  readonly scenarioReproduction: {
    readonly scenarioId: InvestigationSettledSnapshot['configuration']['scenarioId'];
    readonly seed: number;
    readonly sampleCount: number;
    readonly cadenceMs: 1_000;
    readonly startedAt: string;
  };
  /** Synthetic fault lifecycle is verification metadata, never production detector input. */
  readonly verificationOnlyLifecycle: {
    readonly faultId: TemporalFaultId;
    readonly onsetIndex: number;
    readonly activeEndIndex: number;
    readonly recoveryEndIndex: number;
  } | null;
  readonly models: {
    readonly temporalModel: InvestigationReportModelEvidence;
    readonly robustCovariance: InvestigationReportModelEvidence;
  };
  readonly results: {
    readonly authority: typeof DETERMINISTIC_AUTHORITY;
    readonly phaseTransitionCount: number;
    readonly indicationCount: number;
    readonly distinctRuleIds: readonly string[];
    readonly detection: {
      readonly deterministicIndex: number | null;
      readonly deterministicDelaySamples: number | null;
      readonly deterministicDelayMs: number | null;
      readonly modelIndex: number | null;
      readonly modelDelaySamples: number | null;
      readonly modelDelayMs: number | null;
    };
    readonly rankedHypotheses: readonly {
      readonly hypothesisType: string;
      readonly indicationCount: number;
      readonly firstIndicationIndex: number | null;
      readonly score: number;
    }[];
    readonly detectorAggregates: {
      readonly evaluatedCount: number;
      readonly completeCount: number;
      readonly agreement: {
        readonly unanimousIndicate: number;
        readonly unanimousNominal: number;
        readonly mixed: number;
      };
      readonly decisions: {
        readonly deterministicRules: InvestigationReportDecisionCounts;
        readonly covarianceAdvisory: InvestigationReportDecisionCounts;
        readonly kalmanInnovation: InvestigationReportDecisionCounts;
        readonly temporalAdvisory: InvestigationReportDecisionCounts;
      };
    };
  };
  readonly exportPolicy: {
    readonly sourceDataIncluded: false;
    readonly samplesIncluded: false;
    readonly pointsIncluded: false;
    readonly seriesIncluded: false;
    readonly measurementsIncluded: false;
    readonly truthIncluded: false;
    readonly perSampleLabelsIncluded: false;
    readonly browserStateIncluded: false;
    readonly endpointsIncluded: false;
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validTimestamp(value: string, label: string): string {
  if (value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return value;
}

function requireSnapshotInvariant(condition: unknown, detail: string): asserts condition {
  if (!condition) {
    throw new Error(`Investigation report snapshot invariant failed: ${detail}.`);
  }
}

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && semanticEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameScalarArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  );
}

function phaseLabel(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function validateModelEvidence(
  label: string,
  intent: 'enabled' | 'disabled',
  evidence: Readonly<InvestigationModelActivationEvidence>,
): void {
  requireSnapshotInvariant(
    evidence.userSelection === intent,
    `${label} evidence does not match the captured model intent`,
  );
  requireSnapshotInvariant(
    evidence.authority === DETERMINISTIC_AUTHORITY,
    `${label} evidence changes deterministic authority`,
  );
  const expectedEligible =
    evidence.supported &&
    evidence.qualityGate.state === 'passed' &&
    evidence.activationPurpose === 'integrated-advisory';
  requireSnapshotInvariant(
    evidence.eligible === expectedEligible,
    `${label} eligibility is inconsistent with support, gate, or activation purpose`,
  );
  requireSnapshotInvariant(
    evidence.active === (expectedEligible && intent === 'enabled'),
    `${label} active state is inconsistent with eligibility and intent`,
  );
  for (const identity of ['artifact', 'configuration'] as const) {
    if (evidence.identityVerification[identity] !== 'verified') continue;
    const expectedKey = identity === 'artifact' ? 'artifactSha256' : 'configurationSha256';
    const expected = evidence.expectedIdentities[expectedKey];
    const observed = evidence.observedIdentities[expectedKey];
    requireSnapshotInvariant(
      expected !== null && observed === expected,
      `${label} ${identity} verification does not match its identity values`,
    );
  }
}

function validateReproductionIdentity(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const { configuration, scenario, analysis } = snapshot;
  requireSnapshotInvariant(
    INVESTIGATION_SCENARIO_IDS.has(configuration.scenarioId),
    'configuration scenarioId is not declared',
  );
  requireSnapshotInvariant(
    configuration.scenarioId === scenario.scenarioId,
    'configuration scenarioId does not match scenario',
  );
  requireSnapshotInvariant(
    Number.isInteger(configuration.seed) &&
      configuration.seed >= 1 &&
      configuration.seed <= 2_147_483_647,
    'configuration seed is outside the declared integer range',
  );
  requireSnapshotInvariant(
    configuration.seed === scenario.seed,
    'configuration seed does not match scenario',
  );
  requireSnapshotInvariant(
    configuration.cadenceMs === 1_000 && scenario.cadenceMs === configuration.cadenceMs,
    'configuration cadence does not match the fixed scenario cadence',
  );
  requireSnapshotInvariant(
    Number.isInteger(configuration.sampleCount) &&
      configuration.sampleCount >= 60 &&
      configuration.sampleCount <= 2_000,
    'configuration sampleCount is outside the declared integer range',
  );
  requireSnapshotInvariant(
    configuration.sampleCount === scenario.samples.length,
    'configuration sampleCount does not match scenario samples',
  );
  requireSnapshotInvariant(
    scenario.schemaVersion === 'temporal-synthetic.v1' &&
      scenario.profileId === 'generic-fixed-wing' &&
      scenario.synthetic === true &&
      scenario.dataClassification === 'SYNTHETIC_UNCLASSIFIED',
    'scenario data-boundary identity is inconsistent',
  );
  requireSnapshotInvariant(
    scenario.startedAt.trim() !== '' && Number.isFinite(Date.parse(scenario.startedAt)),
    'scenario startedAt is not a valid timestamp',
  );
  requireSnapshotInvariant(
    analysis.scenario.scenarioId === scenario.scenarioId &&
      analysis.scenario.seed === scenario.seed &&
      analysis.scenario.cadenceMs === scenario.cadenceMs &&
      analysis.scenario.startedAt === scenario.startedAt &&
      analysis.scenario.synthetic === scenario.synthetic &&
      analysis.scenario.dataClassification === scenario.dataClassification,
    'analysis reproduction identity does not match scenario',
  );
  requireSnapshotInvariant(
    snapshot.modelIntents.temporalModel === 'enabled' ||
      snapshot.modelIntents.temporalModel === 'disabled',
    'temporal-model intent is invalid',
  );
  requireSnapshotInvariant(
    snapshot.modelIntents.robustCovariance === 'enabled' ||
      snapshot.modelIntents.robustCovariance === 'disabled',
    'robust-covariance intent is invalid',
  );
  validateModelEvidence(
    'temporal-model',
    snapshot.modelIntents.temporalModel,
    snapshot.modelEvidence.temporalModel,
  );
  validateModelEvidence(
    'robust-covariance',
    snapshot.modelIntents.robustCovariance,
    snapshot.modelEvidence.robustCovariance,
  );
}

function validateAlignedEvidence(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const { scenario, analysis, chartSeries } = snapshot;
  const sampleCount = scenario.samples.length;
  requireSnapshotInvariant(
    analysis.points.length === sampleCount,
    'analysis point count does not match scenario samples',
  );
  for (const key of ANALYSIS_SERIES_KEYS) {
    requireSnapshotInvariant(
      analysis.series[key].length === sampleCount,
      `analysis series ${key} count does not match scenario samples`,
    );
  }
  for (const key of CHART_ARRAY_KEYS) {
    requireSnapshotInvariant(
      chartSeries[key].length === sampleCount,
      `chart ${key} count does not match scenario samples`,
    );
  }

  const startedAtMs = Date.parse(scenario.startedAt);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = scenario.samples[index]!;
    const point = analysis.points[index]!;
    const expectedTimestampMs = startedAtMs + index * scenario.cadenceMs;
    requireSnapshotInvariant(
      sample.sampleIndex === index,
      `scenario sample index is stale at position ${index}`,
    );
    requireSnapshotInvariant(
      sample.timestampMs === expectedTimestampMs &&
        Date.parse(sample.timestamp) === sample.timestampMs,
      `scenario sample timestamp is stale at position ${index}`,
    );
    requireSnapshotInvariant(
      point.sampleIndex === sample.sampleIndex,
      `analysis point index does not match scenario at position ${index}`,
    );
    requireSnapshotInvariant(
      point.timestampMs === sample.timestampMs && point.timestamp === sample.timestamp,
      `analysis point timestamp does not match scenario at position ${index}`,
    );
    requireSnapshotInvariant(
      chartSeries.sampleIndices[index] === sample.sampleIndex &&
        chartSeries.timestamps[index] === sample.timestamp,
      `chart alignment does not match scenario at position ${index}`,
    );

    for (const key of ANALYSIS_SERIES_KEYS) {
      const seriesPoint = analysis.series[key][index]!;
      requireSnapshotInvariant(
        seriesPoint.sampleIndex === point.sampleIndex &&
          seriesPoint.timestampMs === point.timestampMs,
        `analysis series ${key} is misaligned at position ${index}`,
      );
      requireSnapshotInvariant(
        seriesPoint.value === null ||
          (typeof seriesPoint.value === 'number' && Number.isFinite(seriesPoint.value)),
        `analysis series ${key} is not finite at position ${index}`,
      );
    }

    for (const [chartKey, analysisKey] of CHART_ANALYSIS_SERIES_BINDINGS) {
      requireSnapshotInvariant(
        Object.is(chartSeries[chartKey][index], analysis.series[analysisKey][index]!.value),
        `chart ${chartKey} does not match analysis series at position ${index}`,
      );
    }
    requireSnapshotInvariant(
      Object.is(analysis.series.observedAltitude[index]!.value, point.fusion.observed.altitude) &&
        Object.is(
          analysis.series.predictedAltitude[index]!.value,
          point.fusion.predicted.altitude,
        ) &&
        Object.is(
          analysis.series.estimatedAltitude[index]!.value,
          point.fusion.estimated.altitude,
        ) &&
        Object.is(analysis.series.altitude95Lower[index]!.value, point.fusion.altitude95[0]) &&
        Object.is(analysis.series.altitude95Upper[index]!.value, point.fusion.altitude95[1]) &&
        Object.is(
          analysis.series.observedVerticalRate[index]!.value,
          point.fusion.observed.verticalRate,
        ) &&
        Object.is(
          analysis.series.predictedVerticalRate[index]!.value,
          point.fusion.predicted.verticalRate,
        ) &&
        Object.is(
          analysis.series.estimatedVerticalRate[index]!.value,
          point.fusion.estimated.verticalRate,
        ) &&
        Object.is(
          analysis.series.verticalRate95Lower[index]!.value,
          point.fusion.verticalRate95[0],
        ) &&
        Object.is(
          analysis.series.verticalRate95Upper[index]!.value,
          point.fusion.verticalRate95[1],
        ),
      `analysis fusion projection is stale at position ${index}`,
    );
    requireSnapshotInvariant(
      Object.is(chartSeries.residualValues[index], point.maximumAbsoluteNormalizedResidual),
      `chart residual does not match analysis at position ${index}`,
    );
  }
}

function validatePhases(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const { analysis, chartSeries } = snapshot;
  const expectedTransitions: Array<(typeof analysis.phaseTransitions)[number]> = [];
  const expectedSegments: Array<{
    phase: (typeof analysis.points)[number]['phase'];
    label: string;
    startIndex: number;
    endIndex: number;
  }> = [];
  for (const point of analysis.points) {
    requireSnapshotInvariant(
      point.phaseEvaluation.phase === point.phase,
      `phase evaluation does not match point ${point.sampleIndex}`,
    );
    const transition = point.phaseEvaluation.transitionEvidence;
    requireSnapshotInvariant(
      point.phaseEvaluation.transitioned === (transition !== undefined),
      `phase transition flag is inconsistent at point ${point.sampleIndex}`,
    );
    if (transition !== undefined) {
      requireSnapshotInvariant(
        transition.sampleIndex === point.sampleIndex &&
          transition.timestampMs === point.timestampMs,
        `phase transition is misaligned at point ${point.sampleIndex}`,
      );
      expectedTransitions.push(transition);
    }
    const previous = expectedSegments.at(-1);
    if (previous?.phase === point.phase) previous.endIndex = point.sampleIndex;
    else {
      expectedSegments.push({
        phase: point.phase,
        label: phaseLabel(point.phase),
        startIndex: point.sampleIndex,
        endIndex: point.sampleIndex,
      });
    }
  }
  requireSnapshotInvariant(
    semanticEqual(analysis.phaseTransitions, expectedTransitions),
    'analysis phase-transition collection is stale',
  );
  requireSnapshotInvariant(
    semanticEqual(chartSeries.phaseSegments, expectedSegments),
    'chart phase segments do not match analysis',
  );
}

function validateLifecycleAndMarkers(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const { scenario, analysis, chartSeries } = snapshot;
  const timeline = scenario.faultTimeline;
  const isNominal = scenario.scenarioId === 'nominal';
  requireSnapshotInvariant(
    isNominal === (timeline === null),
    'scenario fault timeline does not match scenarioId',
  );
  const expectedDefaultIndex = timeline?.onsetIndex ?? 0;
  requireSnapshotInvariant(
    snapshot.defaultSelectedIndex === expectedDefaultIndex,
    'default selected index does not match lifecycle onset',
  );
  if (timeline === null) {
    requireSnapshotInvariant(
      analysis.markers.length === 0 && chartSeries.faultMarkers.length === 0,
      'nominal scenario contains fault markers',
    );
    return;
  }

  const sampleCount = scenario.samples.length;
  requireSnapshotInvariant(
    timeline.faultId === scenario.scenarioId && INVESTIGATION_FAULT_IDS.includes(timeline.faultId),
    'fault timeline identity does not match scenario',
  );
  requireSnapshotInvariant(
    Number.isInteger(timeline.onsetIndex) &&
      Number.isInteger(timeline.durationSamples) &&
      Number.isInteger(timeline.recoverySamples) &&
      timeline.onsetIndex >= 0 &&
      timeline.durationSamples >= 1 &&
      timeline.recoverySamples >= 1 &&
      timeline.activeEndIndex === timeline.onsetIndex + timeline.durationSamples - 1 &&
      timeline.recoveryEndIndex === timeline.activeEndIndex + timeline.recoverySamples &&
      timeline.recoveryEndIndex < sampleCount,
    'fault timeline bounds or lifecycle counts are inconsistent',
  );

  const expectedMarkerKinds = ['onset', 'active-end', 'recovery-end'] as const;
  const expectedMarkerIndices = [
    timeline.onsetIndex,
    timeline.activeEndIndex,
    timeline.recoveryEndIndex,
  ] as const;
  requireSnapshotInvariant(
    analysis.markers.length === expectedMarkerKinds.length,
    'analysis lifecycle marker count is inconsistent',
  );
  for (let index = 0; index < expectedMarkerKinds.length; index += 1) {
    const marker = analysis.markers[index]!;
    const expectedIndex = expectedMarkerIndices[index]!;
    requireSnapshotInvariant(
      marker.kind === expectedMarkerKinds[index] &&
        marker.sampleIndex === expectedIndex &&
        marker.timestampMs === scenario.samples[expectedIndex]!.timestampMs,
      `analysis lifecycle marker ${expectedMarkerKinds[index]} is misaligned`,
    );
    requireSnapshotInvariant(
      marker.label.trim() !== '',
      'analysis lifecycle marker label is blank',
    );
  }
  requireSnapshotInvariant(
    analysis.markers.every(({ label }) => label === analysis.markers[0]!.label),
    'analysis lifecycle marker labels disagree',
  );

  requireSnapshotInvariant(
    chartSeries.faultMarkers.length === 1,
    'chart lifecycle marker count is inconsistent',
  );
  const chartMarker = chartSeries.faultMarkers[0]!;
  requireSnapshotInvariant(
    chartMarker.faultId === timeline.faultId &&
      chartMarker.label === analysis.markers[0]!.label &&
      chartMarker.onsetIndex === timeline.onsetIndex &&
      chartMarker.endIndex === timeline.activeEndIndex &&
      chartMarker.recoveryIndex === timeline.recoveryEndIndex &&
      (chartMarker.detectionIndex ?? null) === analysis.detection.deterministicIndex,
    'chart lifecycle marker does not match scenario and analysis',
  );
}

function expectedSignalDecision(state: string): 'indicate' | 'nominal' | 'not-available' {
  return state === 'indicate' || state === 'nominal' ? state : 'not-available';
}

function validatePointDetectors(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  for (const point of snapshot.analysis.points) {
    const evidence = point.detectorEvidence;
    const deterministicState = point.indications.length > 0 ? 'indicate' : 'nominal';
    const ruleIds = [...new Set(point.indications.map(({ ruleId }) => ruleId))].sort();
    requireSnapshotInvariant(
      evidence.deterministicRules.authority === DETERMINISTIC_AUTHORITY &&
        evidence.deterministicRules.state === deterministicState &&
        evidence.deterministicRules.indicationCount === point.indications.length &&
        sameScalarArray(evidence.deterministicRules.ruleIds, ruleIds),
      `deterministic detector evidence is stale at point ${point.sampleIndex}`,
    );

    const covariance = evidence.covarianceAdvisory;
    requireSnapshotInvariant(
      covariance.authority === DETERMINISTIC_AUTHORITY &&
        covariance.decision === expectedSignalDecision(covariance.state),
      `covariance detector decision is inconsistent at point ${point.sampleIndex}`,
    );
    if (covariance.supported) {
      requireSnapshotInvariant(
        covariance.score !== null &&
          covariance.active === covariance.score.active &&
          covariance.active === snapshot.modelEvidence.robustCovariance.active,
        `covariance detector activation is stale at point ${point.sampleIndex}`,
      );
      const expectedState = !covariance.score.qualityGatePassed
        ? 'ineligible'
        : !covariance.score.active
          ? 'disabled'
          : covariance.score.anomalous
            ? 'indicate'
            : 'nominal';
      requireSnapshotInvariant(
        covariance.state === expectedState,
        `covariance detector state is stale at point ${point.sampleIndex}`,
      );
    } else {
      requireSnapshotInvariant(
        covariance.state === 'unsupported' &&
          covariance.score === null &&
          covariance.active === false,
        `unsupported covariance detector is inconsistent at point ${point.sampleIndex}`,
      );
    }

    const kalman = evidence.kalmanInnovation;
    requireSnapshotInvariant(
      kalman.authority === DETERMINISTIC_AUTHORITY &&
        kalman.decision === expectedSignalDecision(kalman.state),
      `Kalman detector decision is inconsistent at point ${point.sampleIndex}`,
    );

    const temporal = evidence.temporalAdvisory;
    requireSnapshotInvariant(
      temporal.authority === DETERMINISTIC_AUTHORITY &&
        temporal.warmupRemaining === point.model.warmupRemaining &&
        semanticEqual(temporal.score, point.model.score) &&
        temporal.decision === expectedSignalDecision(temporal.state),
      `temporal detector evidence is stale at point ${point.sampleIndex}`,
    );
    let expectedTemporalState: typeof temporal.state;
    if (point.model.score === null) expectedTemporalState = 'warming-up';
    else if (point.model.score.activation.inactiveReason === 'quality-gate-failed') {
      expectedTemporalState = 'ineligible';
    } else if (!point.model.score.activation.active) expectedTemporalState = 'disabled';
    else if (point.model.score.abstained) expectedTemporalState = 'abstained';
    else expectedTemporalState = point.model.score.anomalous ? 'indicate' : 'nominal';
    requireSnapshotInvariant(
      temporal.state === expectedTemporalState,
      `temporal detector state is stale at point ${point.sampleIndex}`,
    );
    if (point.model.score !== null) {
      requireSnapshotInvariant(
        point.model.score.activation.active === snapshot.modelEvidence.temporalModel.active &&
          point.model.score.activation.userSelection ===
            (snapshot.modelEvidence.temporalModel.active ? 'enabled' : 'disabled'),
        `temporal detector activation is stale at point ${point.sampleIndex}`,
      );
    }

    const decisions = {
      deterministicRules: evidence.deterministicRules.state,
      covarianceAdvisory: covariance.decision,
      kalmanInnovation: kalman.decision,
      temporalAdvisory: temporal.decision,
    } as const;
    const comparable = Object.values(decisions).filter(
      (decision): decision is 'indicate' | 'nominal' => decision !== 'not-available',
    );
    const indicatingSignals = comparable.filter((decision) => decision === 'indicate').length;
    const nominalSignals = comparable.length - indicatingSignals;
    const unavailableSignals = [
      ...(covariance.decision === 'not-available' ? (['covariance-advisory'] as const) : []),
      ...(kalman.decision === 'not-available' ? (['kalman-innovation'] as const) : []),
      ...(temporal.decision === 'not-available' ? (['temporal-advisory'] as const) : []),
    ];
    const agreementState =
      indicatingSignals === comparable.length
        ? 'unanimous-indicate'
        : nominalSignals === comparable.length
          ? 'unanimous-nominal'
          : 'mixed';
    const fourWay = evidence.fourWayAgreement;
    requireSnapshotInvariant(
      fourWay.authority === DETERMINISTIC_AUTHORITY &&
        fourWay.authoritativeDecision === deterministicState &&
        semanticEqual(fourWay.decisions, decisions) &&
        fourWay.indicatingSignals === indicatingSignals &&
        fourWay.nominalSignals === nominalSignals &&
        sameScalarArray(fourWay.unavailableSignals, unavailableSignals) &&
        fourWay.complete === (unavailableSignals.length === 0) &&
        fourWay.state === agreementState,
      `four-way detector agreement is inconsistent at point ${point.sampleIndex}`,
    );

    const authoritativeIndication = point.indications.length > 0;
    const advisoryModelIndication = point.model.score?.anomalous === true;
    const agreementStateLegacy = authoritativeIndication
      ? advisoryModelIndication
        ? 'both-indicate'
        : 'rules-only'
      : advisoryModelIndication
        ? 'model-only'
        : 'both-nominal';
    requireSnapshotInvariant(
      point.agreement.authority === DETERMINISTIC_AUTHORITY &&
        point.agreement.authoritativeIndication === authoritativeIndication &&
        point.agreement.advisoryModelIndication === advisoryModelIndication &&
        point.agreement.state === agreementStateLegacy,
      `point detector agreement is inconsistent at point ${point.sampleIndex}`,
    );
  }
}

function validateDerivedAnalysis(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const { analysis, scenario } = snapshot;
  const flattenedIndications = analysis.points.flatMap((point) => point.indications);
  for (const point of analysis.points) {
    for (const indication of point.indications) {
      requireSnapshotInvariant(
        indication.sampleIndex === point.sampleIndex &&
          indication.timestampMs === point.timestampMs,
        `indication is misaligned at point ${point.sampleIndex}`,
      );
    }
  }
  requireSnapshotInvariant(
    semanticEqual(analysis.indications, flattenedIndications),
    'analysis indication collection is stale',
  );
  requireSnapshotInvariant(
    new Set(analysis.indications.map(({ indicationId }) => indicationId)).size ===
      analysis.indications.length,
    'analysis indication identities are not unique',
  );

  const onsetIndex = scenario.faultTimeline?.onsetIndex ?? 0;
  const deterministicIndex =
    analysis.points.find((point) => point.sampleIndex >= onsetIndex && point.indications.length > 0)
      ?.sampleIndex ?? null;
  const modelIndex =
    analysis.points.find(
      (point) => point.sampleIndex >= onsetIndex && point.model.score?.anomalous === true,
    )?.sampleIndex ?? null;
  const expectedDelay = (index: number | null): { samples: number | null; ms: number | null } =>
    index === null || scenario.faultTimeline === null
      ? { samples: null, ms: null }
      : { samples: index - onsetIndex, ms: (index - onsetIndex) * scenario.cadenceMs };
  const deterministicDelay = expectedDelay(deterministicIndex);
  const modelDelay = expectedDelay(modelIndex);
  requireSnapshotInvariant(
    analysis.detection.deterministicIndex === deterministicIndex &&
      analysis.detection.deterministicDelaySamples === deterministicDelay.samples &&
      analysis.detection.deterministicDelayMs === deterministicDelay.ms &&
      analysis.detection.modelIndex === modelIndex &&
      analysis.detection.modelDelaySamples === modelDelay.samples &&
      analysis.detection.modelDelayMs === modelDelay.ms,
    'analysis detection summary is stale',
  );
  requireSnapshotInvariant(
    analysis.detectionIndex === analysis.detection.deterministicIndex &&
      analysis.detectionDelaySamples === analysis.detection.deterministicDelaySamples &&
      analysis.modelDetectionIndex === analysis.detection.modelIndex,
    'analysis detection aliases are inconsistent',
  );

  requireSnapshotInvariant(
    analysis.hypothesisScores.length === 10 &&
      new Set(analysis.hypothesisScores.map(({ hypothesisType }) => hypothesisType)).size === 10,
    'analysis hypothesis coverage is incomplete',
  );
  for (const hypothesis of analysis.hypothesisScores) {
    const supporting = analysis.indications.filter((entry) =>
      entry.hypothesisTypes.includes(hypothesis.hypothesisType),
    );
    requireSnapshotInvariant(
      hypothesis.indicationCount === supporting.length &&
        hypothesis.firstIndicationIndex === (supporting[0]?.sampleIndex ?? null) &&
        hypothesis.score === supporting.length / scenario.samples.length,
      `analysis hypothesis ${hypothesis.hypothesisType} is stale`,
    );
  }
}

function validateComparisonIdentity(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  const expectedIndices = snapshot.scenario.samples.map(({ sampleIndex }) => sampleIndex);
  requireSnapshotInvariant(
    snapshot.comparisonIdentity.profileId === snapshot.scenario.profileId &&
      snapshot.comparisonIdentity.cadenceMs === snapshot.scenario.cadenceMs &&
      snapshot.comparisonIdentity.sampleCount === snapshot.scenario.samples.length &&
      sameScalarArray(snapshot.comparisonIdentity.sampleIndices, expectedIndices) &&
      sameScalarArray(
        snapshot.comparisonIdentity.sampleIndices,
        snapshot.chartSeries.sampleIndices,
      ),
    'comparison identity is not exactly aligned with the settled waveform',
  );
}

function validateInvestigationSnapshot(snapshot: Readonly<InvestigationSettledSnapshot>): void {
  validateReproductionIdentity(snapshot);
  validateAlignedEvidence(snapshot);
  validatePhases(snapshot);
  validateDerivedAnalysis(snapshot);
  validatePointDetectors(snapshot);
  validateLifecycleAndMarkers(snapshot);
  validateComparisonIdentity(snapshot);
}

function projectModel(
  input: Readonly<InvestigationModelActivationEvidence>,
): InvestigationReportModelEvidence {
  return {
    key: input.key,
    context: input.contextLabel,
    activationPurpose: input.activationPurpose,
    userSelection: input.userSelection,
    expectedIdentities: {
      artifactSha256: input.expectedIdentities.artifactSha256,
      configurationSha256: input.expectedIdentities.configurationSha256,
    },
    observedIdentities: {
      artifactSha256: input.observedIdentities.artifactSha256,
      configurationSha256: input.observedIdentities.configurationSha256,
    },
    identityVerification: {
      artifact: input.identityVerification.artifact,
      configuration: input.identityVerification.configuration,
    },
    qualityGate: {
      state: input.qualityGate.state,
      storedPassed: input.qualityGate.storedPassed,
      recomputedPassed: input.qualityGate.recomputedPassed,
    },
    supported: input.supported,
    eligible: input.eligible,
    active: input.active,
    authority: DETERMINISTIC_AUTHORITY,
    reasons: input.reasons
      .map((reason) => ({
        code: reason.code,
        detail: reason.detail,
        channels: [...reason.channels].sort(),
      }))
      .sort(
        (left, right) =>
          left.code.localeCompare(right.code) ||
          left.detail.localeCompare(right.detail) ||
          left.channels.join('\0').localeCompare(right.channels.join('\0')),
      ),
  };
}

function emptyDecisionCounts(): InvestigationReportDecisionCounts {
  return { indicate: 0, nominal: 0, unavailable: 0 };
}

function incrementDecision(
  counts: InvestigationReportDecisionCounts,
  decision: 'indicate' | 'nominal' | 'not-available',
): void {
  const mutable = counts as {
    indicate: number;
    nominal: number;
    unavailable: number;
  };
  if (decision === 'not-available') mutable.unavailable += 1;
  else mutable[decision] += 1;
}

function detectorAggregates(
  snapshot: Readonly<InvestigationSettledSnapshot>,
): InvestigationReportV1['results']['detectorAggregates'] {
  const agreement = { unanimousIndicate: 0, unanimousNominal: 0, mixed: 0 };
  const decisions = {
    deterministicRules: emptyDecisionCounts(),
    covarianceAdvisory: emptyDecisionCounts(),
    kalmanInnovation: emptyDecisionCounts(),
    temporalAdvisory: emptyDecisionCounts(),
  };
  let completeCount = 0;
  for (const point of snapshot.analysis.points) {
    const evidence = point.detectorEvidence;
    if (evidence.fourWayAgreement.complete) completeCount += 1;
    if (evidence.fourWayAgreement.state === 'unanimous-indicate') agreement.unanimousIndicate += 1;
    else if (evidence.fourWayAgreement.state === 'unanimous-nominal') {
      agreement.unanimousNominal += 1;
    } else agreement.mixed += 1;
    incrementDecision(decisions.deterministicRules, evidence.deterministicRules.state);
    incrementDecision(decisions.covarianceAdvisory, evidence.covarianceAdvisory.decision);
    incrementDecision(decisions.kalmanInnovation, evidence.kalmanInnovation.decision);
    incrementDecision(decisions.temporalAdvisory, evidence.temporalAdvisory.decision);
  }
  return {
    evaluatedCount: snapshot.analysis.points.length,
    completeCount,
    agreement,
    decisions,
  };
}

export function buildInvestigationReport(
  input: Readonly<BuildInvestigationReportInput>,
): Readonly<InvestigationReportV1> {
  const snapshot = input.snapshot;
  validateInvestigationSnapshot(snapshot);
  const generatedAt = validTimestamp(
    input.generatedAt ?? new Date().toISOString(),
    'Investigation report generatedAt',
  );
  const startedAt = validTimestamp(snapshot.scenario.startedAt, 'Investigation scenario startedAt');
  const lifecycle = snapshot.scenario.faultTimeline;
  const report: InvestigationReportV1 = {
    reportSchemaVersion: 'investigation-report.v1',
    generatedAt,
    buildIdentities: {
      reactShell: {
        applicationVersion: input.buildIdentity.applicationVersion,
        releaseSha: input.buildIdentity.releaseSha,
        releaseStatus: input.buildIdentity.releaseStatus,
        buildTarget: input.buildIdentity.buildTarget,
      },
      deterministicEngine: {
        applicationVersion: APPLICATION_VERSION,
        authority: DETERMINISTIC_AUTHORITY,
      },
    },
    dataBoundary: {
      synthetic: true,
      dataClassification: snapshot.scenario.dataClassification,
      generatorSchemaVersion: snapshot.scenario.schemaVersion,
      generatorKind: 'bundled-fixed-wing-scenario-generator',
      profile: { id: snapshot.scenario.profileId, version: '1.0.0' },
    },
    scenarioReproduction: {
      scenarioId: snapshot.configuration.scenarioId,
      seed: snapshot.configuration.seed,
      sampleCount: snapshot.configuration.sampleCount,
      cadenceMs: snapshot.configuration.cadenceMs,
      startedAt,
    },
    verificationOnlyLifecycle:
      lifecycle === null
        ? null
        : {
            faultId: lifecycle.faultId,
            onsetIndex: lifecycle.onsetIndex,
            activeEndIndex: lifecycle.activeEndIndex,
            recoveryEndIndex: lifecycle.recoveryEndIndex,
          },
    models: {
      temporalModel: projectModel(snapshot.modelEvidence.temporalModel),
      robustCovariance: projectModel(snapshot.modelEvidence.robustCovariance),
    },
    results: {
      authority: DETERMINISTIC_AUTHORITY,
      phaseTransitionCount: snapshot.analysis.phaseTransitions.length,
      indicationCount: snapshot.analysis.indications.length,
      distinctRuleIds: [
        ...new Set(snapshot.analysis.indications.map(({ ruleId }) => ruleId)),
      ].sort(),
      detection: {
        deterministicIndex: snapshot.analysis.detection.deterministicIndex,
        deterministicDelaySamples: snapshot.analysis.detection.deterministicDelaySamples,
        deterministicDelayMs: snapshot.analysis.detection.deterministicDelayMs,
        modelIndex: snapshot.analysis.detection.modelIndex,
        modelDelaySamples: snapshot.analysis.detection.modelDelaySamples,
        modelDelayMs: snapshot.analysis.detection.modelDelayMs,
      },
      rankedHypotheses: snapshot.analysis.hypothesisScores
        .map((hypothesis) => ({
          hypothesisType: hypothesis.hypothesisType,
          indicationCount: hypothesis.indicationCount,
          firstIndicationIndex: hypothesis.firstIndicationIndex,
          score: hypothesis.score,
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.hypothesisType.localeCompare(right.hypothesisType),
        ),
      detectorAggregates: detectorAggregates(snapshot),
    },
    exportPolicy: {
      sourceDataIncluded: false,
      samplesIncluded: false,
      pointsIncluded: false,
      seriesIncluded: false,
      measurementsIncluded: false,
      truthIncluded: false,
      perSampleLabelsIncluded: false,
      browserStateIncluded: false,
      endpointsIncluded: false,
    },
  };
  return deepFreeze(report);
}

export function serializeInvestigationReport(
  input: Readonly<BuildInvestigationReportInput>,
): string {
  return JSON.stringify(buildInvestigationReport(input), null, 2);
}
