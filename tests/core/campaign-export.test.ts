import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';

import campaignReportSchema from '../../schemas/campaign-report.v1.schema.json';
import { runCampaign, type CampaignResult } from '../../src/campaign';
import {
  buildCampaignReport,
  serializeCampaignReport,
  type BuildCampaignReportInput,
} from '../../src/export';
import {
  prepareCampaignRun,
  settleCampaignResult,
  type CampaignSettledSnapshot,
  type PreparedCampaignRun,
} from '../../src/features/lab/campaign';

const buildIdentity = {
  applicationVersion: '3.0.0-react-shell',
  releaseSha: 'unreleased-campaign-test',
  releaseStatus: 'unreleased' as const,
  buildTarget: 'react-lab-test',
};
const createdAt = '2026-08-29T12:00:00.000Z';
const settledAt = '2026-08-29T12:05:00.000Z';
const generatedAt = '2026-08-29T12:06:00.000Z';
const errorSentinel = 'PRIVATE_ERROR_ENDPOINT_SENTINEL';
const detailsSentinel = 'PRIVATE_DETECTION_DETAILS_SENTINEL';
let prepared: Readonly<PreparedCampaignRun>;
let completedSnapshot: Readonly<CampaignSettledSnapshot>;
let failedSnapshot: Readonly<CampaignSettledSnapshot>;
let cancelledSnapshot: Readonly<CampaignSettledSnapshot>;
let sensitiveSnapshot: Readonly<CampaignSettledSnapshot>;

async function resultWith(
  evaluateScenario: Parameters<typeof runCampaign<null>>[1]['evaluateScenario'],
): Promise<CampaignResult> {
  return runCampaign(prepared.spec, {
    buildScenario: () => ({ input: null }),
    evaluateScenario,
  });
}

beforeAll(async () => {
  prepared = prepareCampaignRun({ seedsInput: '3101' }, createdAt);
  const completed = await resultWith(() => ({ detections: [], calibration: [] }));
  completedSnapshot = await settleCampaignResult(prepared, completed, settledAt);

  const failed = await runCampaign(prepared.spec, {
    buildScenario: (context) => {
      if (context.caseIndex === 2) {
        const error = new Error(errorSentinel);
        error.name = errorSentinel;
        throw error;
      }
      return { input: null };
    },
    evaluateScenario: () => ({ detections: [], calibration: [] }),
  });
  failedSnapshot = await settleCampaignResult(prepared, failed, settledAt);

  const controller = new AbortController();
  const cancelled = await runCampaign(
    prepared.spec,
    {
      buildScenario: () => ({ input: null }),
      evaluateScenario: (_scenario, context) => {
        if (context.caseIndex === 2) controller.abort();
        return { detections: [], calibration: [] };
      },
    },
    { signal: controller.signal },
  );
  cancelledSnapshot = await settleCampaignResult(prepared, cancelled, settledAt);

  const sensitive = await resultWith(() => ({
    detections: [
      {
        ruleId: 'unexpected.rule',
        detectedAtMs: 10,
        details: { endpoint: detailsSentinel, sourceData: detailsSentinel },
      },
    ],
    calibration: [{ confidence: 0.2, correct: false, abstained: false }],
  }));
  const sensitiveMutable = sensitive as CampaignResult & Record<string, unknown>;
  sensitiveMutable.endpoint = detailsSentinel;
  (sensitiveMutable.cases[0] as CampaignResult['cases'][number] & Record<string, unknown>).samples =
    detailsSentinel;
  sensitiveSnapshot = await settleCampaignResult(prepared, sensitiveMutable, settledAt);
});

function input(
  snapshot: Readonly<CampaignSettledSnapshot> = completedSnapshot,
): BuildCampaignReportInput {
  return { buildIdentity, snapshot, generatedAt };
}

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(campaignReportSchema);
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

function unclosedObjectSchemas(value: unknown, path = '$', results: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => unclosedObjectSchemas(child, `${path}[${index}]`, results));
  } else if (typeof value === 'object' && value !== null) {
    const schema = value as Record<string, unknown>;
    if (schema.type === 'object' && schema.additionalProperties !== false) results.push(path);
    for (const [key, child] of Object.entries(schema)) {
      unclosedObjectSchemas(child, `${path}.${key}`, results);
    }
  }
  return results;
}

describe('campaign-report.v1 export contract', () => {
  it('validates every terminal state under strict draft 2020-12 schema closure', async () => {
    expect(unclosedObjectSchemas(campaignReportSchema)).toEqual([]);
    const validate = validator();
    for (const snapshot of [completedSnapshot, failedSnapshot, cancelledSnapshot]) {
      const report = await buildCampaignReport(input(snapshot));
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    }

    const extraRoot = structuredClone(await buildCampaignReport(input())) as Record<
      string,
      unknown
    >;
    extraRoot.extra = true;
    expect(validate(extraRoot)).toBe(false);
    expect(validate.errors?.some(({ keyword }) => keyword === 'additionalProperties')).toBe(true);

    const extraNested = structuredClone(await buildCampaignReport(input())) as unknown as {
      reproduction: { matrix: Record<string, unknown> };
    };
    extraNested.reproduction.matrix.extra = true;
    expect(validate(extraNested)).toBe(false);
    expect(validate.errors?.some(({ keyword }) => keyword === 'additionalProperties')).toBe(true);
  });

  it('projects exact identity, data boundary, default reproduction, and terminal evidence', async () => {
    const report = await buildCampaignReport(input());
    expect(report).toMatchObject({
      reportSchemaVersion: 'campaign-report.v1',
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
        campaignSchemaVersion: 'campaign.v1',
        workerProtocolVersion: 'campaign-worker.v1',
        generatorKind: 'bundled-fixed-wing-temporal-campaign',
      },
      campaignIdentity: {
        campaignId: completedSnapshot.result.campaignId,
        runId: completedSnapshot.result.runId,
        createdAt,
        settledAt,
        specSha256: completedSnapshot.result.replayManifest.specSha256,
      },
      reproduction: {
        profile: { profileId: 'generic-fixed-wing', profileVersion: '1.0.0' },
        seeds: [3101],
        matrix: { scenarioCount: 31, seedCount: 1, plannedCases: 31 },
        generator: { sampleCount: 180, cadenceMs: 1_000, syntheticDurationMs: 179_000 },
        bootstrap: { iterations: 300, confidenceLevel: 0.95, seed: 22_072 },
      },
      terminal: {
        status: 'completed',
        summary: {
          plannedCases: 31,
          attemptedCases: 31,
          completedCases: 31,
          failedCases: 0,
          remainingCases: 0,
        },
      },
      decisionPolicy: {
        authority: 'deterministic-rules',
        temporalCalibrationRole: 'advisory-only',
        temporalArtifactIdentityBound: false,
        verificationLabelsAuthoritativeInputs: false,
      },
    });
    expect(report.reproduction.variations).toHaveLength(3);
    expect(report.metrics).toEqual(completedSnapshot.result.metrics);
  });

  it('retains bounded failed-only identity while excluding raw worker error text', async () => {
    const report = await buildCampaignReport(input(failedSnapshot));
    expect(report.terminal).toMatchObject({
      status: 'completed-with-errors',
      summary: { completedCases: 30, failedCases: 1, remainingCases: 0 },
    });
    expect(report.failedCaseSummaries).toHaveLength(1);
    expect(report.failedCaseSummaries[0]).toMatchObject({
      scenarioId: failedSnapshot.result.cases[2]!.scenarioId,
      phase: failedSnapshot.result.cases[2]!.phase,
      seed: 3101,
      error: {
        name: 'Error',
        message: 'Raw campaign error text is excluded from this privacy-minimized report.',
      },
    });
    expect(JSON.stringify(report)).not.toContain(errorSentinel);
  });

  it('preserves verified partial cancellation evidence without inventing completion', async () => {
    const report = await buildCampaignReport(input(cancelledSnapshot));
    expect(report.terminal).toEqual({
      status: 'cancelled',
      summary: {
        plannedCases: 31,
        attemptedCases: 2,
        completedCases: 2,
        failedCases: 0,
        remainingCases: 29,
      },
    });
    expect(report.failedCaseSummaries).toEqual([]);
    expect(report.metrics.scenarioCoverage).toHaveLength(31);
  });

  it('awaits structural and cryptographic result integrity before projection', async () => {
    const forgedDigest = structuredClone(completedSnapshot) as CampaignSettledSnapshot;
    forgedDigest.result.replayManifest.specSha256 = '0'.repeat(64);
    await expect(buildCampaignReport(input(forgedDigest))).rejects.toThrow(/digest/);

    const forgedSummary = structuredClone(completedSnapshot) as CampaignSettledSnapshot;
    forgedSummary.result.summary.completedCases = 0;
    await expect(buildCampaignReport(input(forgedSummary))).rejects.toThrow(
      /summary is inconsistent/,
    );

    const forgedConfiguration = structuredClone(completedSnapshot) as CampaignSettledSnapshot;
    (forgedConfiguration.configuration.matrix as { plannedCases: number }).plannedCases = 93;
    await expect(buildCampaignReport(input(forgedConfiguration))).rejects.toThrow(
      /captured configuration does not match/,
    );
  });

  it('exports full aggregate metrics and an explicit all-false privacy policy', async () => {
    const report = await buildCampaignReport(input(sensitiveSnapshot));
    expect(report.metrics).toEqual(sensitiveSnapshot.result.metrics);
    expect(Object.values(report.exportPolicy)).toEqual(Array(18).fill(false));
    expect(report.decisionPolicy.temporalArtifactIdentityBound).toBe(false);
  });

  it('recursively excludes case rows, raw evidence, browser state, storage, and endpoints', async () => {
    const report = await buildCampaignReport(input(sensitiveSnapshot));
    const serialized = JSON.stringify(report);
    const keys = collectKeys(report);
    for (const forbidden of [
      'sourceData',
      'samples',
      'points',
      'series',
      'measurements',
      'cases',
      'detections',
      'details',
      'sensorIds',
      'sampleIndices',
      'calibrationObservations',
      'replayManifest',
      'truth',
      'browserState',
      'storage',
      'endpoint',
      'endpoints',
      'artifactSha256',
      'configurationSha256',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(serialized).not.toContain(detailsSentinel);
    expect(serialized).not.toContain(errorSentinel);
  });

  it('serializes deterministically, freezes output, and captures inputs before awaiting integrity', async () => {
    const mutableSnapshot = structuredClone(completedSnapshot) as CampaignSettledSnapshot;
    const mutableBuildIdentity = { ...buildIdentity };
    const reportInput = {
      buildIdentity: mutableBuildIdentity,
      snapshot: mutableSnapshot,
      generatedAt,
    };
    const pending = buildCampaignReport(reportInput);
    mutableBuildIdentity.applicationVersion = 'mutated-build';
    mutableSnapshot.result.summary.completedCases = 0;
    (mutableSnapshot.configuration.seeds as number[])[0] = 999;
    const report = await pending;

    expect(report.buildIdentities.reactShell.applicationVersion).toBe('3.0.0-react-shell');
    expect(report.terminal.summary.completedCases).toBe(31);
    expect(report.reproduction.seeds).toEqual([3101]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.metrics.bootstrap.precision)).toBe(true);
    expect(await serializeCampaignReport(input())).toBe(await serializeCampaignReport(input()));
  });

  it('normalizes valid timestamps and rejects invalid timestamps and schema-bound forgeries', async () => {
    const report = await buildCampaignReport({ ...input(), generatedAt: '2026-08-29' });
    expect(report.generatedAt).toBe('2026-08-29T00:00:00.000Z');
    await expect(buildCampaignReport({ ...input(), generatedAt: 'not-a-time' })).rejects.toThrow(
      /valid timestamp/,
    );

    const validate = validator();
    const forged = structuredClone(report) as unknown as {
      reproduction: { seeds: number[] };
      metrics: { episodes: { precision: number } };
      exportPolicy: { samplesIncluded: boolean };
    };
    forged.reproduction.seeds[0] = 0;
    forged.metrics.episodes.precision = 2;
    forged.exportPolicy.samplesIncluded = true;
    expect(validate(forged)).toBe(false);
    const keywords = validate.errors?.map(({ keyword }) => keyword) ?? [];
    expect(keywords).toContain('minimum');
    expect(keywords).toContain('maximum');
    expect(keywords).toContain('const');
  });
});
