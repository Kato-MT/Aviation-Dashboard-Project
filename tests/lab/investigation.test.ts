import { beforeAll, describe, expect, it } from 'vitest';

import {
  INVESTIGATION_DEFAULT_CONTROLS,
  INVESTIGATION_DEFAULT_MODEL_INTENTS,
  compareInvestigationSnapshots,
  createInvestigationRunner,
  investigationComparisonIdentity,
  investigationComparisonWaveform,
  prepareInvestigationChartSeries,
  validateInvestigationControls,
  type InvestigationModelIntents,
  type InvestigationRunConfiguration,
  type InvestigationSettledSnapshot,
} from '../../src/features/lab/investigation';
import {
  verifyBundledModelEvidence,
  type BundledModelVerificationSet,
} from '../../src/features/lab/configuration';
import {
  analyzeTemporalScenario,
  type AnalyzeTemporalScenarioOptions,
} from '../../src/investigation';
import { DECLARED_TEMPORAL_FAULTS, generateTemporalScenario } from '../../src/temporal/generator';
import type { TemporalScenario } from '../../src/temporal/types';

let verified: BundledModelVerificationSet;

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

beforeAll(async () => {
  verified = await verifyBundledModelEvidence();
});

function runnerWith(models: BundledModelVerificationSet = verified) {
  return createInvestigationRunner({ verifyBundledModels: async () => models });
}

function configuration(
  overrides: Partial<InvestigationRunConfiguration> = {},
): InvestigationRunConfiguration {
  return {
    scenarioId: 'gradual-drift',
    seed: 3101,
    sampleCount: 180,
    cadenceMs: 1_000,
    ...overrides,
  };
}

function enabledIntents(): InvestigationModelIntents {
  return { temporalModel: 'enabled', robustCovariance: 'enabled' };
}

function expectRecursivelyFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectRecursivelyFrozen(child);
}

describe('React Lab Investigation controls', () => {
  it('declares the reviewed reproduction defaults and fixed cadence', () => {
    expect(INVESTIGATION_DEFAULT_CONTROLS).toEqual({
      scenarioId: 'gradual-drift',
      seed: '3101',
      sampleCount: '180',
    });
    expect(validateInvestigationControls(INVESTIGATION_DEFAULT_CONTROLS)).toEqual({
      scenarioId: 'gradual-drift',
      seed: 3101,
      sampleCount: 180,
      cadenceMs: 1_000,
    });
    expect(INVESTIGATION_DEFAULT_MODEL_INTENTS).toEqual({
      temporalModel: 'disabled',
      robustCovariance: 'disabled',
    });
  });

  it.each(['nominal', ...DECLARED_TEMPORAL_FAULTS.map(({ id }) => id)])(
    'accepts declared scenario %s',
    (scenarioId) => {
      expect(
        validateInvestigationControls({ scenarioId, seed: '1', sampleCount: '60' }).scenarioId,
      ).toBe(scenarioId);
    },
  );

  it.each([
    [{ scenarioId: 'unknown', seed: '1', sampleCount: '60' }, 'Unknown Investigation scenario'],
    [{ scenarioId: 'nominal', seed: '', sampleCount: '60' }, 'seed must be an integer'],
    [{ scenarioId: 'nominal', seed: '1.5', sampleCount: '60' }, 'seed must be an integer'],
    [{ scenarioId: 'nominal', seed: 0, sampleCount: 60 }, 'seed must be between'],
    [{ scenarioId: 'nominal', seed: 2_147_483_648, sampleCount: 60 }, 'seed must be between'],
    [{ scenarioId: 'nominal', seed: 1, sampleCount: '59' }, 'sample count must be between'],
    [{ scenarioId: 'nominal', seed: 1, sampleCount: 2_001 }, 'sample count must be between'],
    [{ scenarioId: 'nominal', seed: 1, sampleCount: '60.5' }, 'sample count must be an integer'],
  ] as const)('rejects invalid controls %#', (input, message) => {
    expect(() => validateInvestigationControls(input)).toThrow(message);
  });
});

describe('React Lab Investigation prepared evidence', () => {
  it('projects aligned expected, observed, predicted, estimated, phase, and lifecycle evidence', () => {
    const scenario = generateTemporalScenario({
      scenarioId: 'fuel-leak',
      seed: 41,
      sampleCount: 100,
      cadenceMs: 1_000,
    });
    const analysis = analyzeTemporalScenario(scenario, {
      modelEnabled: false,
      covarianceModelEnabled: false,
    });
    const prepared = prepareInvestigationChartSeries(scenario, analysis);
    const aligned = [
      prepared.timestamps,
      prepared.expectedAltitude,
      prepared.observedAltitude,
      prepared.predictedAltitude,
      prepared.estimatedAltitude,
      prepared.lowerUncertainty,
      prepared.upperUncertainty,
      prepared.expectedVerticalRate,
      prepared.observedVerticalRate,
      prepared.predictedVerticalRate,
      prepared.estimatedVerticalRate,
      prepared.lowerVerticalRateUncertainty,
      prepared.upperVerticalRateUncertainty,
      prepared.observedAirspeed,
      prepared.observedFuel,
      prepared.residualValues,
    ];
    expect(prepared.sampleIndices).toHaveLength(100);
    expect(aligned.every((values) => values.length === 100)).toBe(true);
    expect(prepared.expectedAltitude).toEqual(
      analysis.series.expectedAltitude.map(({ value }) => value),
    );
    expect(prepared.predictedAltitude).toEqual(
      analysis.points.map(({ fusion }) => fusion.predicted.altitude),
    );
    expect(prepared.estimatedAltitude).toEqual(
      analysis.points.map(({ fusion }) => fusion.estimated.altitude),
    );
    expect(prepared.phaseSegments[0]?.startIndex).toBe(0);
    expect(prepared.phaseSegments.at(-1)?.endIndex).toBe(99);
    expect(prepared.faultMarkers).toEqual([
      expect.objectContaining({
        faultId: 'fuel-leak',
        onsetIndex: scenario.faultTimeline?.onsetIndex,
        endIndex: scenario.faultTimeline?.activeEndIndex,
        recoveryIndex: scenario.faultTimeline?.recoveryEndIndex,
      }),
    ]);
    expectRecursivelyFrozen(prepared);
  });

  it('rejects mismatched scenario and analysis lengths instead of silently aligning', () => {
    const scenario = generateTemporalScenario({ scenarioId: 'nominal', seed: 5, sampleCount: 60 });
    const longer = generateTemporalScenario({ scenarioId: 'nominal', seed: 5, sampleCount: 61 });
    const analysis = analyzeTemporalScenario(longer, { modelEnabled: false });
    expect(() => prepareInvestigationChartSeries(scenario, analysis)).toThrow(
      'lengths must match exactly',
    );
  });
});

describe('React Lab Investigation runner', () => {
  it('is deterministic for the same reproduction tuple and captured model intents', async () => {
    const run = runnerWith();
    const first = await run(configuration(), enabledIntents());
    const second = await run(configuration(), enabledIntents());
    expect(first).toEqual(second);
    expect(first.scenario.samples).toEqual(second.scenario.samples);
    expect(first.analysis).toEqual(second.analysis);
    expect(first.defaultSelectedIndex).toBe(first.scenario.faultTimeline?.onsetIndex);
  });

  it('keeps both advisory models disabled by default while retaining verified eligibility', async () => {
    const snapshot = await runnerWith()(
      configuration({ scenarioId: 'nominal' }),
      INVESTIGATION_DEFAULT_MODEL_INTENTS,
    );
    expect(snapshot.modelEvidence.temporalModel).toMatchObject({
      userSelection: 'disabled',
      supported: true,
      eligible: true,
      active: false,
      authority: 'deterministic-rules',
    });
    expect(snapshot.modelEvidence.robustCovariance).toMatchObject({
      userSelection: 'disabled',
      supported: true,
      eligible: true,
      active: false,
      authority: 'deterministic-rules',
    });
    expect(
      snapshot.analysis.points
        .slice(39)
        .every(({ model }) => model.score?.activation.active === false),
    ).toBe(true);
    expect(
      snapshot.analysis.points.every(
        ({ detectorEvidence }) => detectorEvidence.covarianceAdvisory.state === 'disabled',
      ),
    ).toBe(true);
  });

  it('activates only exact verified, eligible, explicitly enabled model versions', async () => {
    const snapshot = await runnerWith()(configuration({ scenarioId: 'nominal' }), enabledIntents());
    for (const model of [
      snapshot.modelEvidence.temporalModel,
      snapshot.modelEvidence.robustCovariance,
    ]) {
      expect(model).toMatchObject({
        activationPurpose: 'integrated-advisory',
        userSelection: 'enabled',
        supported: true,
        eligible: true,
        active: true,
        identityVerification: { artifact: 'verified', configuration: 'verified' },
        qualityGate: { state: 'passed', recomputedPassed: true },
      });
      expect(model.reasons).toEqual([]);
    }
    expect(snapshot.analysis.points.slice(39).some(({ model }) => model.score !== null)).toBe(true);
    expect(
      snapshot.analysis.points.some(
        ({ detectorEvidence }) => detectorEvidence.covarianceAdvisory.active,
      ),
    ).toBe(true);
  });

  it.each([
    ['mismatch', 'ARTIFACT_IDENTITY_MISMATCH'],
    ['unavailable', 'ARTIFACT_IDENTITY_UNAVAILABLE'],
  ] as const)('fails closed when model artifact identity is %s', async (state, reasonCode) => {
    const altered = structuredClone(verified) as Mutable<BundledModelVerificationSet>;
    for (const model of [altered.temporalV2, altered.robustCovariance]) {
      model.artifact.state = state;
      model.artifact.actualSha256 = state === 'mismatch' ? '0'.repeat(64) : null;
      model.artifact.detail = `controlled ${state}`;
    }
    const snapshot = await runnerWith(altered)(configuration(), enabledIntents());
    for (const model of [
      snapshot.modelEvidence.temporalModel,
      snapshot.modelEvidence.robustCovariance,
    ]) {
      expect(model).toMatchObject({ supported: false, eligible: false, active: false });
      expect(model.reasons.map(({ code }) => code)).toContain(reasonCode);
    }
    expect(
      snapshot.analysis.points
        .slice(39)
        .every(({ model }) => model.score?.activation.active === false),
    ).toBe(true);
  });

  it('fails closed on recomputed quality-gate failure even when the stored flag says pass', async () => {
    const altered = structuredClone(verified) as Mutable<BundledModelVerificationSet>;
    for (const model of [altered.temporalV2, altered.robustCovariance]) {
      model.qualityGate.state = 'failed';
      model.qualityGate.storedPassed = true;
      model.qualityGate.recomputedPassed = false;
      model.qualityGate.detail = 'controlled recomputed failure';
    }
    const snapshot = await runnerWith(altered)(configuration(), enabledIntents());
    expect(snapshot.modelEvidence.temporalModel).toMatchObject({
      supported: true,
      active: false,
      eligible: false,
    });
    expect(snapshot.modelEvidence.robustCovariance).toMatchObject({
      supported: true,
      active: false,
      eligible: false,
    });
    expect(snapshot.modelEvidence.temporalModel.reasons.map(({ code }) => code)).toContain(
      'QUALITY_GATE_FAILED',
    );
  });

  it('preserves a research-only activation purpose and never relabels it as eligible', async () => {
    const altered = structuredClone(verified) as Mutable<BundledModelVerificationSet>;
    altered.temporalV2.activationPurpose = 'research-evidence-only';
    const snapshot = await runnerWith(altered)(configuration(), enabledIntents());
    expect(snapshot.modelEvidence.temporalModel).toMatchObject({
      activationPurpose: 'research-evidence-only',
      supported: true,
      eligible: false,
      active: false,
    });
    expect(snapshot.modelEvidence.temporalModel.reasons.map(({ code }) => code)).toContain(
      'RESEARCH_EVIDENCE_ONLY',
    );
  });

  it('uses the Investigation scenario covariance gate, independently of any loaded Lab run', async () => {
    let capturedOptions: AnalyzeTemporalScenarioOptions | undefined;
    const runner = createInvestigationRunner({
      verifyBundledModels: async () => verified,
      generateScenario: (options) => {
        const scenario = generateTemporalScenario(options);
        (scenario as { profileId: string }).profileId = 'controlled-incompatible-profile';
        return scenario;
      },
      analyzeScenario: (scenario, options) => {
        capturedOptions = options;
        return analyzeTemporalScenario(scenario, options);
      },
    });
    const snapshot = await runner(configuration(), enabledIntents());
    expect(snapshot.modelEvidence.temporalModel.active).toBe(true);
    expect(snapshot.modelEvidence.robustCovariance).toMatchObject({
      supported: false,
      eligible: false,
      active: false,
    });
    expect(snapshot.modelEvidence.robustCovariance.reasons.map(({ code }) => code)).toContain(
      'PROFILE_ID_MISMATCH',
    );
    expect(capturedOptions).toEqual({ modelEnabled: true, covarianceModelEnabled: false });
  });

  it('returns a deep immutable snapshot with complete four-way detector structures', async () => {
    const snapshot = await runnerWith()(configuration({ scenarioId: 'nominal' }), enabledIntents());
    expectRecursivelyFrozen(snapshot);
    expect(snapshot.analysis.points).toHaveLength(180);
    for (const point of snapshot.analysis.points) {
      expect(point.detectorEvidence).toEqual(
        expect.objectContaining({
          deterministicRules: expect.objectContaining({ role: 'authoritative' }),
          covarianceAdvisory: expect.objectContaining({ role: 'advisory' }),
          kalmanInnovation: expect.objectContaining({ role: 'supporting-evidence' }),
          temporalAdvisory: expect.objectContaining({ role: 'advisory' }),
          fourWayAgreement: expect.objectContaining({ authority: 'deterministic-rules' }),
        }),
      );
    }
    expect(
      snapshot.analysis.points
        .slice(39)
        .every(({ detectorEvidence }) =>
          ['unanimous-indicate', 'unanimous-nominal', 'mixed'].includes(
            detectorEvidence.fourWayAgreement.state,
          ),
        ),
    ).toBe(true);
  });

  it('captures inputs before its first await and breaks references to injected outputs', async () => {
    const mutableConfiguration = configuration() as Mutable<InvestigationRunConfiguration>;
    const mutableIntents = enabledIntents() as Mutable<InvestigationModelIntents>;
    let releaseVerification: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let injectedScenario: TemporalScenario | undefined;
    const runner = createInvestigationRunner({
      verifyBundledModels: async () => {
        await gate;
        return verified;
      },
      generateScenario: (options) => {
        injectedScenario = generateTemporalScenario(options);
        return injectedScenario;
      },
    });
    const pending = runner(mutableConfiguration, mutableIntents);
    mutableConfiguration.seed = 999;
    mutableIntents.temporalModel = 'disabled';
    releaseVerification?.();
    const snapshot = await pending;
    expect(snapshot.configuration.seed).toBe(3101);
    expect(snapshot.modelIntents.temporalModel).toBe('enabled');
    const retainedTimestamp = snapshot.scenario.samples[0]?.timestamp;
    injectedScenario!.samples[0]!.timestamp = '2099-01-01T00:00:00.000Z';
    expect(snapshot.scenario.samples[0]?.timestamp).toBe(retainedTimestamp);
  });

  it('rejects a non-contract cadence even when a caller bypasses control validation', async () => {
    await expect(
      runnerWith()(configuration({ cadenceMs: 500 as 1_000 }), enabledIntents()),
    ).rejects.toThrow('cadence must remain 1000 ms');
  });
});

describe('React Lab Investigation comparison contract', () => {
  it('captures strict identity and waveform copies without resampling', async () => {
    const snapshot = await runnerWith()(configuration(), enabledIntents());
    expect(investigationComparisonIdentity(snapshot)).toEqual(snapshot.comparisonIdentity);
    expect(investigationComparisonWaveform(snapshot)).toEqual({
      sampleIndices: snapshot.chartSeries.sampleIndices,
      observedAltitude: snapshot.chartSeries.observedAltitude,
      predictedAltitude: snapshot.chartSeries.predictedAltitude,
    });
  });

  it('accepts exact profile, cadence, count, and indices while rejecting each mismatch', async () => {
    const run = runnerWith();
    const baseline = await run(configuration({ seed: 3101 }), enabledIntents());
    const compatible = await run(
      configuration({ scenarioId: 'oscillation', seed: 3102 }),
      enabledIntents(),
    );
    expect(compareInvestigationSnapshots(baseline, compatible)).toEqual({
      compatible: true,
      mismatches: [],
      reasons: [],
    });

    const countMismatch = await run(configuration({ sampleCount: 181 }), enabledIntents());
    expect(compareInvestigationSnapshots(baseline, countMismatch)).toMatchObject({
      compatible: false,
      mismatches: ['sample-count'],
    });

    const altered = structuredClone(compatible) as InvestigationSettledSnapshot;
    (altered.scenario as { profileId: string }).profileId = 'generic-rotary-wing';
    (altered.scenario as { cadenceMs: number }).cadenceMs = 500;
    altered.chartSeries.sampleIndices = altered.chartSeries.sampleIndices.map((index) => index + 1);
    expect(compareInvestigationSnapshots(baseline, altered)).toMatchObject({
      compatible: false,
      mismatches: ['profile', 'cadence', 'sample-indices'],
    });
  });
});
