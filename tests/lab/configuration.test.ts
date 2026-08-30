import { beforeAll, describe, expect, it } from 'vitest';
import baselineCsv from '../../data/flight.csv?raw';
import configurationManifest from '../../models/model_configuration_manifest_v1.json';
import robustArtifact from '../../models/robust_covariance_v1.json';
import temporalV2Artifact from '../../models/temporal_fault_model_v2.json';
import { legacyCsvAdapter, versionedJsonAdapter } from '../../src/adapters';
import {
  compareSha256Evidence,
  pendingBundledModelVerification,
  projectActiveRunConfiguration,
  projectModelRegistryDescriptors,
  projectProfileConfiguration,
  projectRobustCovarianceCompatibility,
  projectTemporalV2Compatibility,
  ruleCondition,
  verifyBundledModelEvidence,
  type BundledModelVerificationSet,
} from '../../src/features/lab/configuration';
import {
  findRegistryEntry,
  modelRegistry,
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
  temporalFaultResearchRegistryEntry,
} from '../../src/model-registry';
import {
  genericFixedWingProfile,
  genericRotaryWingProfile,
  includedBaselineProfile,
} from '../../src/profiles';
import { generateSyntheticDocument } from '../../src/ui/generate';

let verified: BundledModelVerificationSet;

beforeAll(async () => {
  verified = await verifyBundledModelEvidence();
});

async function includedRun() {
  return legacyCsvAdapter.parse(baselineCsv, {
    profileId: includedBaselineProfile.id,
    profileVersion: includedBaselineProfile.version,
  });
}

async function fixedWingRun(sampleCount = 8) {
  return versionedJsonAdapter.parse(
    generateSyntheticDocument(genericFixedWingProfile, sampleCount),
    {
      profileId: genericFixedWingProfile.id,
      profileVersion: genericFixedWingProfile.version,
    },
  );
}

function reasonCodes(value: { reasons: readonly { code: string }[] }) {
  return value.reasons.map(({ code }) => code);
}

describe('Configuration registry and runtime identity evidence', () => {
  it('declares immutable activation purposes and exact versioned keys for every descriptor', () => {
    const descriptors = projectModelRegistryDescriptors();
    expect(descriptors.map(({ key, activationPurpose }) => [key, activationPurpose])).toEqual([
      ['generic-fixed-wing.robust-covariance@1.0.0', 'integrated-advisory'],
      ['generic-fixed-wing.temporal-fault@2.0.0', 'integrated-advisory'],
      ['generic-fixed-wing.temporal-fault@1.0.0', 'research-evidence-only'],
    ]);
    expect(descriptors[0]).toMatchObject({
      defaultUserSelection: 'disabled',
      authority: 'deterministic-rules',
      evidence: {
        training: { path: 'models/robust_covariance_v1.json', jsonPointer: '/training' },
      },
    });
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.compatibility.requiredChannels)).toBe(true);
    expect(robustCovarianceRegistryEntry.activationPurpose).toBe('integrated-advisory');
    expect(temporalFaultRegistryEntry.activationPurpose).toBe('integrated-advisory');
    expect(temporalFaultResearchRegistryEntry.activationPurpose).toBe('research-evidence-only');
  });

  it('requires an exact version and never silently selects the other temporal model', () => {
    expect(findRegistryEntry(modelRegistry, 'generic-fixed-wing.temporal-fault', '1.0.0')).toBe(
      temporalFaultResearchRegistryEntry,
    );
    expect(findRegistryEntry(modelRegistry, 'generic-fixed-wing.temporal-fault', '2.0.0')).toBe(
      temporalFaultRegistryEntry,
    );
    expect(
      findRegistryEntry(modelRegistry, 'generic-fixed-wing.temporal-fault', '3.0.0'),
    ).toBeUndefined();
  });

  it('starts with explicit pending identity and quality evidence', () => {
    const pending = pendingBundledModelVerification();
    expect(pending.robustCovariance).toMatchObject({
      artifact: { state: 'pending', actualSha256: null },
      configuration: { state: 'pending', actualSha256: null },
      qualityGate: { state: 'pending', recomputedPassed: null },
    });
    expect(pending.temporalV2).toMatchObject({
      artifact: { state: 'pending' },
      configuration: { state: 'pending' },
      qualityGate: { state: 'pending' },
    });
    expect(Object.isFrozen(pending.temporalV2)).toBe(true);
  });

  it('recomputes both bundled artifact and canonical-configuration identities and quality gates', () => {
    for (const evidence of [verified.robustCovariance, verified.temporalV2]) {
      expect(evidence.artifact).toMatchObject({ state: 'verified' });
      expect(evidence.artifact.actualSha256).toBe(evidence.artifact.expectedSha256);
      expect(evidence.configuration).toMatchObject({ state: 'verified' });
      expect(evidence.configuration.actualSha256).toBe(evidence.configuration.expectedSha256);
      expect(evidence.qualityGate).toMatchObject({
        state: 'passed',
        storedPassed: true,
        recomputedPassed: true,
      });
    }
    expect(verified.temporalV2.declaredConfigurationSha256).toBe(
      temporalFaultRegistryEntry.identities.configurationSha256,
    );
  });

  it('keeps pending, verified, mismatch, and unavailable SHA states distinct', () => {
    expect(compareSha256Evidence('a'.repeat(64)).state).toBe('pending');
    expect(compareSha256Evidence('a'.repeat(64), 'A'.repeat(64)).state).toBe('verified');
    expect(compareSha256Evidence('a'.repeat(64), 'b'.repeat(64)).state).toBe('mismatch');
    expect(compareSha256Evidence(null, 'b'.repeat(64)).state).toBe('unavailable');
    expect(
      compareSha256Evidence('a'.repeat(64), undefined, 'Web Crypto unavailable'),
    ).toMatchObject({ state: 'unavailable', detail: 'Web Crypto unavailable' });
  });

  it('reports altered artifact bytes and canonical configuration bytes as mismatches', async () => {
    const manifest = structuredClone(configurationManifest);
    const temporal = manifest.entries.find(
      (entry) =>
        entry.registryEntryId === temporalFaultRegistryEntry.registryEntryId &&
        entry.modelVersion === '2.0.0',
    )!;
    temporal.canonicalJson += ' ';
    const result = await verifyBundledModelEvidence({
      robustArtifactRaw: JSON.stringify(robustArtifact),
      manifest,
    });
    expect(result.robustCovariance.artifact.state).toBe('mismatch');
    expect(result.temporalV2.configuration.state).toBe('mismatch');
  });

  it('does not treat hashing failure, missing configuration, or artifact declarations as proof', async () => {
    const unavailable = await verifyBundledModelEvidence({
      hash: async () => {
        throw new Error('controlled hash failure');
      },
    });
    expect(unavailable.robustCovariance.artifact).toMatchObject({
      state: 'unavailable',
      detail: 'controlled hash failure',
    });
    expect(unavailable.temporalV2.configuration.state).toBe('unavailable');

    const missing = await verifyBundledModelEvidence({ manifest: { entries: [] } });
    expect(missing.robustCovariance.configuration.state).toBe('unavailable');
    expect(missing.temporalV2.configuration.state).toBe('unavailable');

    const alteredTemporal = structuredClone(temporalV2Artifact) as unknown as {
      training: { configurationSha256: string };
    };
    alteredTemporal.training.configurationSha256 = '0'.repeat(64);
    const declaredMismatch = await verifyBundledModelEvidence({
      temporalArtifact: alteredTemporal,
    });
    expect(declaredMismatch.temporalV2.configuration.state).toBe('mismatch');
  });

  it('distinguishes recomputed failed and unavailable quality gates from stored pass flags', async () => {
    const failedRobust = structuredClone(robustArtifact) as unknown as {
      evaluation: { metrics: { f1: number } };
      qualityGate: { passed: boolean };
    };
    failedRobust.evaluation.metrics.f1 = 0;
    failedRobust.qualityGate.passed = true;
    const failedTemporal = structuredClone(temporalV2Artifact) as unknown as {
      qualityGate: { passed: boolean };
    };
    failedTemporal.qualityGate.passed = false;
    const failed = await verifyBundledModelEvidence({
      robustArtifact: failedRobust,
      temporalArtifact: failedTemporal,
    });
    expect(failed.robustCovariance.qualityGate).toMatchObject({
      state: 'failed',
      storedPassed: true,
      recomputedPassed: false,
    });
    expect(failed.temporalV2.qualityGate).toMatchObject({
      state: 'failed',
      storedPassed: false,
      recomputedPassed: false,
    });

    const unavailable = await verifyBundledModelEvidence({
      robustArtifact: {},
      temporalArtifact: {},
    });
    expect(unavailable.robustCovariance.qualityGate.state).toBe('unavailable');
    expect(unavailable.temporalV2.qualityGate.state).toBe('unavailable');
  });
});

describe('Configuration profile, rule, adapter, and run provenance', () => {
  it('formats every deterministic rule kind without UI-owned threshold logic', () => {
    const conditions = Object.fromEntries(
      includedBaselineProfile.rules.map((rule) => [rule.kind, ruleCondition(rule)]),
    );
    expect(conditions).toMatchObject({
      threshold: 'speed > 520',
      range: '0 <= fuel <= 100',
      rate: '|delta fuel| <= 1/s',
      'decrease-rate': 'decrease fuel <= 0.2/s',
      'window-decrease': 'decrease altitude <= 900 in 20s',
      frozen: 'fuel changes within 30s',
    });
  });

  it('projects complete immutable profile, channel, rule, and limit evidence', () => {
    const profile = projectProfileConfiguration(includedBaselineProfile);
    expect(profile).toMatchObject({
      key: 'included-baseline@1.0.0',
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      limits: {
        expectedCadenceMs: 10_000,
        cadenceToleranceMs: 1_000,
        staleAfterMs: 30_000,
        sequencePolicy: 'optional',
      },
    });
    expect(profile.channels.map(({ channel }) => channel)).toEqual(['altitude', 'fuel', 'speed']);
    expect(profile.rules).toHaveLength(12);
    expect(profile.rules.find(({ id }) => id === 'baseline.rapid-descent')).toMatchObject({
      severity: 'error',
      condition: 'decrease altitude <= 900 in 20s',
      parameters: { maximumDecrease: 900, windowMs: 20_000, toleranceMs: 0 },
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.rules[0]?.parameters)).toBe(true);
  });

  it('distinguishes empty provenance from exact legacy field and unit mappings', async () => {
    expect(projectActiveRunConfiguration(undefined, includedBaselineProfile)).toMatchObject({
      state: 'empty',
      selectedAnalysisProfile: { id: 'included-baseline', version: '1.0.0' },
      acceptedRecords: 0,
    });
    const run = await includedRun();
    const evidence = projectActiveRunConfiguration(run, includedBaselineProfile);
    expect(evidence).toMatchObject({
      state: 'available',
      adapter: { id: 'legacy-csv', version: '2.0.0' },
      profileRelationship: 'match',
      datasetSha256: 'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
      acceptedRecords: 85,
      quarantinedRecords: 0,
    });
    expect(evidence.fieldMappings).toEqual([
      { canonicalField: 'timestamp', sourceField: 'timestamp', origin: 'adapter-default' },
      { canonicalField: 'altitude', sourceField: 'altitude_ft', origin: 'adapter-default' },
      { canonicalField: 'speed', sourceField: 'speed_kts', origin: 'adapter-default' },
      { canonicalField: 'fuel', sourceField: 'fuel_pct', origin: 'adapter-default' },
    ]);
    expect(evidence.unitMappings).toEqual([
      { canonicalChannel: 'altitude', unit: 'ft', origin: 'adapter-default' },
      { canonicalChannel: 'speed', unit: 'kts', origin: 'adapter-default' },
      { canonicalChannel: 'fuel', unit: '%', origin: 'adapter-default' },
    ]);
  });

  it('keeps canonical JSON, source-declared units, and selected analysis profile separate', async () => {
    const run = await fixedWingRun();
    const evidence = projectActiveRunConfiguration(run, genericRotaryWingProfile);
    expect(evidence.profileRelationship).toBe('mismatch');
    expect(evidence.declaredProfile).toEqual({ id: 'generic-fixed-wing', version: '1.0.0' });
    expect(evidence.selectedAnalysisProfile).toEqual({
      id: 'generic-rotary-wing',
      version: '1.0.0',
    });
    expect(evidence.unitMappings).toEqual([]);
    expect(evidence.fieldMappings).toContainEqual({
      canonicalField: 'measurements',
      sourceField: 'measurements',
      origin: 'canonical-json',
    });
    expect(evidence.sourceUnits[0]?.declaredUnits).toMatchObject({
      airspeed: 'kts',
      altitude: 'ft',
      vibration: 'g',
    });
  });
});

describe('Configuration model compatibility projections', () => {
  it('fails closed for the included baseline while preserving disabled user state', async () => {
    const result = projectRobustCovarianceCompatibility(
      await includedRun(),
      includedBaselineProfile,
      verified.robustCovariance,
      'disabled',
    );
    expect(result).toMatchObject({
      userSelection: 'disabled',
      supported: false,
      eligible: false,
      active: false,
      authority: 'deterministic-rules',
    });
    expect(reasonCodes(result)).toContain('PROFILE_ID_MISMATCH');
    expect(reasonCodes(result)).toContain('MISSING_CHANNEL');
    expect(result.observed.cadenceMs).toBe(10_000);
  });

  it('supports the actual generated fixed-wing run but activates only after explicit selection', async () => {
    const run = await fixedWingRun();
    const disabled = projectRobustCovarianceCompatibility(
      run,
      genericFixedWingProfile,
      verified.robustCovariance,
      'disabled',
    );
    expect(disabled).toMatchObject({
      supported: true,
      eligible: true,
      active: false,
      userSelection: 'disabled',
      observed: { cadenceMs: 1_000, windowLength: 1 },
    });
    expect(disabled.observed.channelUnits).toEqual({
      airspeed: 'kts',
      altitude: 'ft',
      verticalRate: 'ft/min',
      fuel: '%',
      vibration: 'g',
    });
    const enabled = projectRobustCovarianceCompatibility(
      run,
      genericFixedWingProfile,
      verified.robustCovariance,
      'enabled',
    );
    expect(enabled).toMatchObject({ supported: true, eligible: true, active: true });
  });

  it('rejects multi-source unit and cadence conflicts without choosing the first source', async () => {
    const document = JSON.parse(generateSyntheticDocument(genericFixedWingProfile, 4)) as {
      sources: Array<{ sourceId: string; label: string; units: Record<string, string> }>;
      samples: Array<{
        sourceId: string;
        sequence: number;
        timestamp: string;
        measurements: Record<string, number>;
        units: Record<string, string>;
        qualityFlags: string[];
      }>;
    };
    const origin = Date.parse(document.samples[0]!.timestamp);
    const secondUnits = { ...document.sources[0]!.units, airspeed: 'mph' };
    document.sources.push({
      sourceId: 'second-source',
      label: 'Second source',
      units: secondUnits,
    });
    document.samples.push(
      ...document.samples.slice(0, 4).map((sample, index) => ({
        ...sample,
        sourceId: 'second-source',
        sequence: index,
        timestamp: new Date(origin + index * 2_000).toISOString(),
        units: secondUnits,
      })),
    );
    const run = await versionedJsonAdapter.parse(document);
    const result = projectRobustCovarianceCompatibility(
      run,
      genericFixedWingProfile,
      verified.robustCovariance,
      'enabled',
    );
    expect(result).toMatchObject({ supported: false, eligible: false, active: false });
    expect(reasonCodes(result)).toContain('SOURCE_UNIT_CONFLICT');
    expect(reasonCodes(result)).toContain('SOURCE_CADENCE_CONFLICT');
    expect(result.observed.channelUnits.airspeed).toBeUndefined();
    expect(result.observed.cadenceMs).toBeNull();
    expect(result.observed.sourceCadenceMs).toEqual({
      'demo-generic-fixed-wing': 1_000,
      'second-source': 2_000,
    });
  });

  it('keeps compatibility, eligibility, and activation independent for identity and gate states', async () => {
    const run = await fixedWingRun();
    const mismatchEvidence = {
      ...verified.robustCovariance,
      artifact: compareSha256Evidence(
        robustCovarianceRegistryEntry.identities.artifactSha256,
        '0'.repeat(64),
      ),
    };
    const mismatch = projectRobustCovarianceCompatibility(
      run,
      genericFixedWingProfile,
      mismatchEvidence,
      'enabled',
    );
    expect(mismatch).toMatchObject({ supported: false, eligible: false, active: false });
    expect(reasonCodes(mismatch)).toContain('ARTIFACT_IDENTITY_MISMATCH');
    expect(
      reasonCodes(mismatch).filter((code) => code === 'ARTIFACT_IDENTITY_MISMATCH'),
    ).toHaveLength(1);

    const failedGateEvidence = {
      ...verified.robustCovariance,
      qualityGate: {
        state: 'failed' as const,
        storedPassed: true,
        recomputedPassed: false,
        detail: 'controlled failed gate',
      },
    };
    const failedGate = projectRobustCovarianceCompatibility(
      run,
      genericFixedWingProfile,
      failedGateEvidence,
      'enabled',
    );
    expect(failedGate).toMatchObject({ supported: true, eligible: false, active: false });
    expect(reasonCodes(failedGate)).toContain('QUALITY_GATE_FAILED');
  });

  it('evaluates temporal v2 against its fixed Investigation context and exact runtime evidence', () => {
    const disabled = projectTemporalV2Compatibility(verified.temporalV2, 'disabled');
    expect(disabled).toMatchObject({
      key: 'generic-fixed-wing.temporal-fault@2.0.0',
      contextLabel: 'Fixed-wing Investigation generator and projection',
      userSelection: 'disabled',
      supported: true,
      eligible: true,
      active: false,
      observed: {
        schemaVersion: 'telemetry.v1',
        profile: { id: 'generic-fixed-wing', version: '1.0.0' },
        cadenceMs: 1_000,
        windowLength: 40,
      },
    });
    expect(projectTemporalV2Compatibility(verified.temporalV2, 'enabled').active).toBe(true);

    const pending = projectTemporalV2Compatibility(
      pendingBundledModelVerification().temporalV2,
      'enabled',
    );
    expect(pending).toMatchObject({ supported: false, eligible: false, active: false });
    expect(reasonCodes(pending)).toContain('ARTIFACT_IDENTITY_PENDING');
    expect(reasonCodes(pending)).not.toContain('ARTIFACT_IDENTITY_MISMATCH');
    expect(reasonCodes(pending)).not.toContain('CONFIGURATION_IDENTITY_MISMATCH');
    expect(
      reasonCodes(projectTemporalV2Compatibility(verified.temporalV2, 'enabled', {})),
    ).toContain('ARTIFACT_PARSE_FAILED');
  });
});
