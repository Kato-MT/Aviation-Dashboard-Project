import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';

import reportSchema from '../../schemas/investigation-report.v1.schema.json';
import {
  buildInvestigationReport,
  serializeInvestigationReport,
  type BuildInvestigationReportInput,
} from '../../src/export';
import {
  createInvestigationRunner,
  type InvestigationSettledSnapshot,
} from '../../src/features/lab/investigation';
import { verifyBundledModelEvidence } from '../../src/features/lab/configuration';

const buildIdentity = {
  applicationVersion: '3.0.0-react-shell',
  releaseSha: 'unreleased-investigation-test',
  releaseStatus: 'unreleased' as const,
  buildTarget: 'react-lab-test',
};

const generatedAt = '2026-08-29T12:00:00.000Z';
let enabledSnapshot: InvestigationSettledSnapshot;
let nominalSnapshot: InvestigationSettledSnapshot;

beforeAll(async () => {
  const verified = await verifyBundledModelEvidence();
  const runner = createInvestigationRunner({ verifyBundledModels: async () => verified });
  enabledSnapshot = await runner(
    { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 180, cadenceMs: 1_000 },
    { temporalModel: 'enabled', robustCovariance: 'enabled' },
  );
  nominalSnapshot = await runner(
    { scenarioId: 'nominal', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
    { temporalModel: 'disabled', robustCovariance: 'disabled' },
  );
});

function input(
  snapshot: InvestigationSettledSnapshot = enabledSnapshot,
): BuildInvestigationReportInput {
  return { buildIdentity, snapshot, generatedAt };
}

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(reportSchema);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((child) => collectKeys(child, keys));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function expectSnapshotInvariantRejected(
  mutate: (snapshot: DeepMutable<InvestigationSettledSnapshot>) => void,
  expectedMessage: string,
  source: InvestigationSettledSnapshot = enabledSnapshot,
): void {
  const forged = structuredClone(source) as unknown as DeepMutable<InvestigationSettledSnapshot>;
  mutate(forged);
  const forgedInput = input(forged as unknown as InvestigationSettledSnapshot);
  expect(() => buildInvestigationReport(forgedInput)).toThrow(expectedMessage);
  expect(() => serializeInvestigationReport(forgedInput)).toThrow(expectedMessage);
}

describe('Investigation report v1 contract', () => {
  it('validates under strict draft 2020-12 JSON Schema with every object closed', () => {
    const validate = validator();
    const report = buildInvestigationReport(input());
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);

    const rootExtra = structuredClone(report) as unknown as Record<string, unknown>;
    rootExtra.extra = true;
    expect(validate(rootExtra)).toBe(false);
    expect(validate.errors?.some(({ keyword }) => keyword === 'additionalProperties')).toBe(true);

    const nestedExtra = structuredClone(report) as unknown as {
      models: { temporalModel: Record<string, unknown> };
    };
    nestedExtra.models.temporalModel.extra = true;
    expect(validate(nestedExtra)).toBe(false);
    expect(validate.errors?.some(({ keyword }) => keyword === 'additionalProperties')).toBe(true);
  });

  it('records separate build identities, synthetic boundary, and exact reproduction tuple', () => {
    const report = buildInvestigationReport(input());
    expect(report).toMatchObject({
      reportSchemaVersion: 'investigation-report.v1',
      generatedAt,
      buildIdentities: {
        reactShell: buildIdentity,
        deterministicEngine: {
          applicationVersion: '2.2.0',
          authority: 'deterministic-rules',
        },
      },
      dataBoundary: {
        synthetic: true,
        dataClassification: 'SYNTHETIC_UNCLASSIFIED',
        generatorSchemaVersion: 'temporal-synthetic.v1',
        generatorKind: 'bundled-fixed-wing-scenario-generator',
        profile: { id: 'generic-fixed-wing', version: '1.0.0' },
      },
      scenarioReproduction: {
        scenarioId: 'gradual-drift',
        seed: 3101,
        sampleCount: 180,
        cadenceMs: 1_000,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(report.verificationOnlyLifecycle).toEqual({
      faultId: 'gradual-drift',
      onsetIndex: enabledSnapshot.scenario.faultTimeline?.onsetIndex,
      activeEndIndex: enabledSnapshot.scenario.faultTimeline?.activeEndIndex,
      recoveryEndIndex: enabledSnapshot.scenario.faultTimeline?.recoveryEndIndex,
    });
    expect(buildInvestigationReport(input(nominalSnapshot)).verificationOnlyLifecycle).toBeNull();
  });

  it('fails closed when configuration or analysis reproduction identities are stale', () => {
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.configuration.scenarioId = 'nominal';
    }, 'configuration scenarioId does not match scenario');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.configuration.seed += 1;
    }, 'configuration seed does not match scenario');
    expectSnapshotInvariantRejected((snapshot) => {
      (snapshot.configuration as { cadenceMs: number }).cadenceMs = 2_000;
    }, 'configuration cadence does not match the fixed scenario cadence');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.configuration.sampleCount -= 1;
    }, 'configuration sampleCount does not match scenario samples');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.scenario.seed += 1;
    }, 'analysis reproduction identity does not match scenario');
  });

  it('fails closed on mismatched sample, point, series, and chart counts or alignment', () => {
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.points.pop();
    }, 'analysis point count does not match scenario samples');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.series.observedAltitude.pop();
    }, 'analysis series observedAltitude count does not match scenario samples');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.chartSeries.predictedAltitude.pop();
    }, 'chart predictedAltitude count does not match scenario samples');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.chartSeries.sampleIndices[5] = 99;
    }, 'chart alignment does not match scenario at position 5');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.series.estimatedAltitude[10]!.value = -999;
    }, 'chart estimatedAltitude does not match analysis series at position 10');
  });

  it('fails closed on stale phase, timeline, lifecycle-marker, or selection claims', () => {
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.phaseTransitions[0]!.sampleIndex += 1;
    }, 'phase transition is misaligned at point');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.chartSeries.phaseSegments[0]!.endIndex += 1;
    }, 'chart phase segments do not match analysis');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.scenario.faultTimeline!.durationSamples += 1;
    }, 'fault timeline bounds or lifecycle counts are inconsistent');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.markers[0]!.sampleIndex += 1;
    }, 'analysis lifecycle marker onset is misaligned');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.chartSeries.faultMarkers[0]!.onsetIndex += 1;
    }, 'chart lifecycle marker does not match scenario and analysis');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.defaultSelectedIndex += 1;
    }, 'default selected index does not match lifecycle onset');
  });

  it('fails closed on stale indications, detectors, detections, or hypotheses', () => {
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.indications.pop();
    }, 'analysis indication collection is stale');
    expectSnapshotInvariantRejected((snapshot) => {
      const indicatingPoint = snapshot.analysis.points.find(
        (point) => point.indications.length > 0,
      )!;
      indicatingPoint.detectorEvidence.deterministicRules.indicationCount += 1;
    }, 'deterministic detector evidence is stale');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.points[0]!.detectorEvidence.fourWayAgreement.nominalSignals += 1;
    }, 'four-way detector agreement is inconsistent at point 0');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.detectionIndex =
        snapshot.analysis.detectionIndex === null ? 0 : snapshot.analysis.detectionIndex + 1;
    }, 'analysis detection aliases are inconsistent');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.analysis.hypothesisScores[0]!.score += 0.01;
    }, 'analysis hypothesis gradual-drift is stale');
  });

  it('fails closed on mismatched model intent, activation, and comparison alignment', () => {
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.modelIntents.temporalModel = 'disabled';
    }, 'temporal-model evidence does not match the captured model intent');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.modelEvidence.robustCovariance.active = false;
    }, 'robust-covariance active state is inconsistent with eligibility and intent');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.comparisonIdentity.profileId = 'stale-profile';
    }, 'comparison identity is not exactly aligned with the settled waveform');
    expectSnapshotInvariantRejected((snapshot) => {
      snapshot.comparisonIdentity.sampleIndices[8] = 99;
    }, 'comparison identity is not exactly aligned with the settled waveform');
  });

  it('preserves exact activation-time model identity, gate, intent, and authority evidence', () => {
    const report = buildInvestigationReport(input());
    for (const model of [report.models.temporalModel, report.models.robustCovariance]) {
      expect(model).toMatchObject({
        activationPurpose: 'integrated-advisory',
        userSelection: 'enabled',
        identityVerification: { artifact: 'verified', configuration: 'verified' },
        qualityGate: { state: 'passed', storedPassed: true, recomputedPassed: true },
        supported: true,
        eligible: true,
        active: true,
        authority: 'deterministic-rules',
        reasons: [],
      });
      expect(model.expectedIdentities.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.expectedIdentities).toEqual(model.observedIdentities);
    }
  });

  it('rejects internally inconsistent active and research-only model evidence', () => {
    const validate = validator();
    const inconsistentActive = structuredClone(buildInvestigationReport(input())) as unknown as {
      models: { temporalModel: { userSelection: string } };
    };
    inconsistentActive.models.temporalModel.userSelection = 'disabled';
    expect(validate(inconsistentActive)).toBe(false);

    const researchActive = structuredClone(buildInvestigationReport(input())) as unknown as {
      models: { temporalModel: { activationPurpose: string } };
    };
    researchActive.models.temporalModel.activationPurpose = 'research-evidence-only';
    expect(validate(researchActive)).toBe(false);
  });

  it('exports compact four-way aggregates whose decision counts cover every evaluated point', () => {
    const report = buildInvestigationReport(input());
    const aggregate = report.results.detectorAggregates;
    expect(aggregate.evaluatedCount).toBe(180);
    expect(aggregate.completeCount).toBeGreaterThan(0);
    expect(
      aggregate.agreement.unanimousIndicate +
        aggregate.agreement.unanimousNominal +
        aggregate.agreement.mixed,
    ).toBe(aggregate.evaluatedCount);
    for (const counts of Object.values(aggregate.decisions)) {
      expect(counts.indicate + counts.nominal + counts.unavailable).toBe(aggregate.evaluatedCount);
    }
    expect(report.results.rankedHypotheses).toHaveLength(10);
    expect(report.results.authority).toBe('deterministic-rules');
    expect(report.results.indicationCount).toBe(enabledSnapshot.analysis.indications.length);
  });

  it('enforces an explicit all-false export policy and excludes raw or per-point keys recursively', () => {
    const report = buildInvestigationReport(input());
    expect(Object.values(report.exportPolicy)).toEqual(Array(9).fill(false));
    const keys = collectKeys(report);
    for (const forbidden of [
      'sourceData',
      'sources',
      'samples',
      'points',
      'series',
      'measurements',
      'truth',
      'faultLabels',
      'activeGroundTruthLabels',
      'browserState',
      'endpoint',
      'endpoints',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('does not copy sentinel values planted in source, point, series, browser, or endpoint state', () => {
    const forged = structuredClone(enabledSnapshot) as unknown as Record<string, unknown>;
    const scenario = forged.scenario as {
      samples: Array<{ sourceId: string; measurements: Record<string, unknown>; truth: unknown }>;
    };
    const analysis = forged.analysis as {
      points: Array<Record<string, unknown>>;
      series: Record<string, unknown>;
    };
    scenario.samples[0]!.sourceId = 'SOURCE_SENTINEL_DO_NOT_EXPORT';
    scenario.samples[0]!.measurements.secret = 'MEASUREMENT_SENTINEL_DO_NOT_EXPORT';
    scenario.samples[0]!.truth = 'TRUTH_SENTINEL_DO_NOT_EXPORT';
    analysis.points[0]!.browserState = 'BROWSER_SENTINEL_DO_NOT_EXPORT';
    analysis.series.endpoint = 'ENDPOINT_SENTINEL_DO_NOT_EXPORT';
    forged.sourceData = 'RAW_SENTINEL_DO_NOT_EXPORT';
    forged.endpoint = 'ROOT_ENDPOINT_SENTINEL_DO_NOT_EXPORT';

    const serialized = serializeInvestigationReport(
      input(forged as unknown as InvestigationSettledSnapshot),
    );
    for (const sentinel of [
      'SOURCE_SENTINEL_DO_NOT_EXPORT',
      'MEASUREMENT_SENTINEL_DO_NOT_EXPORT',
      'TRUTH_SENTINEL_DO_NOT_EXPORT',
      'BROWSER_SENTINEL_DO_NOT_EXPORT',
      'ENDPOINT_SENTINEL_DO_NOT_EXPORT',
      'RAW_SENTINEL_DO_NOT_EXPORT',
      'ROOT_ENDPOINT_SENTINEL_DO_NOT_EXPORT',
    ]) {
      expect(serialized, sentinel).not.toContain(sentinel);
    }
  });

  it('serializes deterministically for fixed input and does not retain mutable input references', () => {
    const mutableBuild = { ...buildIdentity };
    const mutableSnapshot = structuredClone(
      enabledSnapshot,
    ) as unknown as InvestigationSettledSnapshot;
    const reportInput = { buildIdentity: mutableBuild, snapshot: mutableSnapshot, generatedAt };
    const first = serializeInvestigationReport(reportInput);
    const second = serializeInvestigationReport(reportInput);
    expect(first).toBe(second);

    const report = buildInvestigationReport(reportInput);
    mutableBuild.applicationVersion = 'mutated-build';
    (
      mutableSnapshot.modelEvidence.temporalModel.reasons as Array<{
        code: string;
        detail: string;
        channels: string[];
      }>
    ).push({
      code: 'MUTATED',
      detail: 'mutated after report build',
      channels: [],
    });
    (mutableSnapshot.analysis.indications as unknown[]).length = 0;
    expect(report.buildIdentities.reactShell.applicationVersion).toBe('3.0.0-react-shell');
    expect(report.models.temporalModel.reasons).toEqual([]);
    expect(report.results.indicationCount).toBe(enabledSnapshot.analysis.indications.length);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.results.detectorAggregates.decisions)).toBe(true);
  });

  it('rejects invalid timestamps, bounds, policy changes, and extra nested report fields', () => {
    expect(() => buildInvestigationReport({ ...input(), generatedAt: 'not-a-time' })).toThrow(
      'valid timestamp',
    );
    const validate = validator();
    const report = structuredClone(buildInvestigationReport(input())) as unknown as {
      scenarioReproduction: { seed: number; sampleCount: number };
      exportPolicy: { samplesIncluded: boolean };
      results: { detectorAggregates: { evaluatedCount: number } };
    };
    report.scenarioReproduction.seed = 0;
    report.scenarioReproduction.sampleCount = 2_001;
    report.results.detectorAggregates.evaluatedCount = 2_001;
    report.exportPolicy.samplesIncluded = true;
    expect(validate(report)).toBe(false);
    const keywords = validate.errors?.map(({ keyword }) => keyword) ?? [];
    expect(keywords).toContain('minimum');
    expect(keywords).toContain('maximum');
    expect(keywords).toContain('const');
  });
});
