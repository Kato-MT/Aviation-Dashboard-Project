import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OPERATOR_PROCEDURE_DEFINITIONS } from '../../tools/live/verifyRunbooks';
import {
  RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
  RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION,
  RunbookRehearsalError,
  canonicalRunbookRehearsalJson,
  compileRunbookRehearsalBindings,
  readRunbookRehearsalReceipt,
  runSyntheticRunbookRehearsal,
  verifyRunbookRehearsalReceipt,
  type RunbookRehearsalExpectedBindingsV1,
  type RunbookRehearsalRequestV1,
} from '../../tools/live/rehearseRunbooks';

const SOURCE_HEAD = 'a'.repeat(40);
const SOURCE_CONTENT_SHA256 = 'b'.repeat(64);
const ARTIFACT_SHA256 = 'c'.repeat(64);
const temporaryRoots: string[] = [];

function request(
  branch?: Readonly<{
    procedureId: (typeof OPERATOR_PROCEDURE_DEFINITIONS)[number]['procedureId'];
    result: 'stopped' | 'rolled-back' | 'recovered';
  }>,
): RunbookRehearsalRequestV1 {
  return {
    schemaVersion: RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION,
    evidenceClass: RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
    checkedAt: '2026-08-30T12:00:00.000Z',
    source: {
      schemaVersion: 'synthetic-source-build-identity.v1',
      head: SOURCE_HEAD,
      contentSha256: SOURCE_CONTENT_SHA256,
    },
    release: {
      applicationVersion: '3.0.0-test',
      releaseSha: SOURCE_HEAD,
      releaseStatus: 'unreleased',
      buildTarget: 'mock-staging',
    },
    syntheticArtifact: {
      schemaVersion: 'synthetic-artifact-identity.v1',
      kind: 'synthetic-source-built-artifact',
      fileCount: 17,
      totalBytes: 8192,
      sha256: ARTIFACT_SHA256,
    },
    outcomes: OPERATOR_PROCEDURE_DEFINITIONS.map(({ procedureId }) => ({
      procedureId,
      result: branch?.procedureId === procedureId ? branch.result : 'verified',
    })),
  };
}

async function temporaryOutput(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fdw-runbook-rehearsal-'));
  temporaryRoots.push(root);
  return join(root, name);
}

async function expectation(
  value: RunbookRehearsalRequestV1,
  finalResult: RunbookRehearsalExpectedBindingsV1['finalResult'],
): Promise<RunbookRehearsalExpectedBindingsV1> {
  return {
    bindings: await compileRunbookRehearsalBindings(value),
    finalResult,
  };
}

function mutableClone<T>(value: T): T {
  return structuredClone(value);
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a mutable object in the test fixture.');
  }
  return value as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('R3-06 synthetic runbook rehearsal gate', () => {
  it('writes one deterministic canonical verified receipt bound to current aggregate policy', async () => {
    const selected = request();
    const expected = await expectation(selected, 'verified');
    const firstPath = await temporaryOutput('verified-one.json');
    const secondPath = await temporaryOutput('verified-two.json');

    const first = await runSyntheticRunbookRehearsal({ request: selected, outputPath: firstPath });
    const second = await runSyntheticRunbookRehearsal({
      request: selected,
      outputPath: secondPath,
    });

    expect(first).toEqual(second);
    expect(first.bindings).toEqual(expected.bindings);
    expect(first.summary).toEqual({
      procedureCount: 8,
      verifiedCount: 8,
      stoppedCount: 0,
      rolledBackCount: 0,
      recoveredCount: 0,
      finalResult: 'verified',
    });
    expect(first.bindings.compiledPolicy.limits.history.maximumQualityEvents).toBe(200);
    expect(first.executionBoundary).toEqual({
      syntheticOnly: true,
      localOnly: true,
      networkRequests: 0,
      providerActions: 0,
      cloudActions: 0,
      deploymentActions: 0,
      runtimeMutations: 0,
      productionActions: 0,
    });
    expect(await readFile(firstPath, 'utf8')).toBe(canonicalRunbookRehearsalJson(first));
    await expect(readRunbookRehearsalReceipt(firstPath, expected)).resolves.toEqual(first);
  });

  it('records the bounded stopped branch without rollback or ready-state claims', async () => {
    const selected = request({ procedureId: 'provider-term-hold', result: 'stopped' });
    const outputPath = await temporaryOutput('stopped.json');
    const receipt = await runSyntheticRunbookRehearsal({ request: selected, outputPath });
    const outcome = receipt.procedureOutcomes[0];

    expect(receipt.summary).toMatchObject({
      verifiedCount: 7,
      stoppedCount: 1,
      finalResult: 'stopped',
    });
    expect(outcome).toMatchObject({
      procedureId: 'provider-term-hold',
      result: 'stopped',
      rehearsedRollbackActionIds: [],
    });
    expect(outcome?.rehearsedActionIds).toHaveLength(1);
    expect(outcome?.stopConditionIds).toEqual(['stop-on-incomplete-terms-evidence']);
  });

  it('records only the rollback procedure as rolled back with approved rollback actions', async () => {
    const selected = request({ procedureId: 'rollback', result: 'rolled-back' });
    const outputPath = await temporaryOutput('rolled-back.json');
    const receipt = await runSyntheticRunbookRehearsal({ request: selected, outputPath });
    const outcome = receipt.procedureOutcomes.find(({ procedureId }) => procedureId === 'rollback');

    expect(receipt.summary).toMatchObject({
      verifiedCount: 7,
      rolledBackCount: 1,
      finalResult: 'rolled-back',
    });
    expect(outcome?.rehearsedRollbackActionIds.length).toBeGreaterThan(0);
    expect(outcome?.stopConditionIds).toEqual(['stop-on-rollback-identity-mismatch']);
    expect(receipt.bindings.approvedRollback.manifest).toMatchObject({
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('records only the recovery procedure as recovered on its ready condition', async () => {
    const selected = request({ procedureId: 'recovery', result: 'recovered' });
    const outputPath = await temporaryOutput('recovered.json');
    const receipt = await runSyntheticRunbookRehearsal({ request: selected, outputPath });
    const outcome = receipt.procedureOutcomes.find(({ procedureId }) => procedureId === 'recovery');

    expect(receipt.summary).toMatchObject({
      verifiedCount: 7,
      recoveredCount: 1,
      finalResult: 'recovered',
    });
    expect(outcome?.stopConditionIds).toEqual(['receipt-on-available-recovery']);
    expect(outcome?.rehearsedRollbackActionIds).toEqual([]);
  });

  it('rejects mutated identities, procedure actions, aggregate results, and unknown payload fields', async () => {
    const selected = request();
    const expected = await expectation(selected, 'verified');
    const outputPath = await temporaryOutput('mutation-source.json');
    const receipt = await runSyntheticRunbookRehearsal({ request: selected, outputPath });

    const identityForgery = mutableClone(receipt);
    asMutableRecord(identityForgery.bindings.syntheticArtifact).sha256 = 'd'.repeat(64);
    await expect(verifyRunbookRehearsalReceipt(identityForgery, expected)).rejects.toMatchObject({
      code: 'BINDING_MISMATCH',
    });

    const actionForgery = mutableClone(receipt);
    const actionIds = actionForgery.procedureOutcomes[0]?.rehearsedActionIds as string[];
    actionIds.splice(0, 1, 'forged-action');
    await expect(verifyRunbookRehearsalReceipt(actionForgery, expected)).rejects.toMatchObject({
      code: 'PROCEDURE_MISMATCH',
    });

    const resultForgery = mutableClone(receipt);
    asMutableRecord(resultForgery.procedureOutcomes[0]).result = 'stopped';
    await expect(verifyRunbookRehearsalReceipt(resultForgery, expected)).rejects.toBeInstanceOf(
      RunbookRehearsalError,
    );

    const payloadForgery = mutableClone(receipt) as unknown as Record<string, unknown>;
    payloadForgery.position = { latitude: 32, longitude: -81 };
    await expect(verifyRunbookRehearsalReceipt(payloadForgery, expected)).rejects.toMatchObject({
      code: 'INVALID_RECEIPT',
    });
  });

  it('rejects malformed branch requests and source-release mismatches', async () => {
    const invalidBranch = mutableClone(request());
    asMutableRecord(invalidBranch.outcomes[0]).result = 'rolled-back';
    await expect(
      runSyntheticRunbookRehearsal({
        request: invalidBranch,
        outputPath: await temporaryOutput('invalid-branch.json'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const mismatchedSource = mutableClone(request());
    asMutableRecord(mismatchedSource.release).releaseSha = 'd'.repeat(40);
    await expect(
      runSyntheticRunbookRehearsal({
        request: mismatchedSource,
        outputPath: await temporaryOutput('source-mismatch.json'),
      }),
    ).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });

    const unknownField = mutableClone(request()) as unknown as Record<string, unknown>;
    unknownField.rawTelemetry = [{ aircraft: 'forbidden' }];
    await expect(
      runSyntheticRunbookRehearsal({
        request: unknownField,
        outputPath: await temporaryOutput('unknown-request-field.json'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses overwrite and rejects a noncanonical retained receipt', async () => {
    const selected = request();
    const expected = await expectation(selected, 'verified');
    const occupied = await temporaryOutput('occupied.json');
    await writeFile(occupied, 'preserve-me\n', 'utf8');
    await expect(
      runSyntheticRunbookRehearsal({ request: selected, outputPath: occupied }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(readFile(occupied, 'utf8')).resolves.toBe('preserve-me\n');

    const noncanonical = await temporaryOutput('noncanonical.json');
    const receipt = await runSyntheticRunbookRehearsal({
      request: selected,
      outputPath: noncanonical,
    });
    await writeFile(noncanonical, JSON.stringify(receipt), 'utf8');
    await expect(readRunbookRehearsalReceipt(noncanonical, expected)).rejects.toBeInstanceOf(Error);
  });
});
