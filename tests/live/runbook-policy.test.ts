import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OPERATIONS_REASON_CODES } from '../../src/operations/contract';
import { RUNTIME_POLICY_REASON_CODES } from '../../src/live/runtimePolicy';
import {
  OPERATOR_PROCEDURE_DEFINITIONS,
  OPERATOR_RECEIPT_REQUIRED_FIELDS,
  OPERATOR_RECEIPT_RESULT_VALUES,
  OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION,
  parseOperatorProcedure,
  RunbookPolicyError,
  type OperatorProcedureId,
  type RunbookPolicyErrorCode,
  verifyRunbookBundle,
  verifyRunbookDirectory,
} from '../../tools/live/verifyRunbooks';

type MutableRecord = Record<string, unknown>;

const temporaryRoots: string[] = [];

function asRecord(value: unknown): MutableRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a mutable test record.');
  }
  return value as MutableRecord;
}

async function procedureValue(procedureId: OperatorProcedureId): Promise<MutableRecord> {
  const definition = OPERATOR_PROCEDURE_DEFINITIONS.find(
    (candidate) => candidate.procedureId === procedureId,
  );
  if (!definition) throw new Error(`Missing test procedure definition: ${procedureId}`);
  return JSON.parse(
    await readFile(resolve('docs', 'operations', definition.fileName), 'utf8'),
  ) as MutableRecord;
}

function clone(value: MutableRecord): MutableRecord {
  return structuredClone(value);
}

function action(value: MutableRecord, index = 0): MutableRecord {
  const actions = value.boundedActions;
  if (!Array.isArray(actions)) throw new Error('Expected boundedActions in test fixture.');
  return asRecord(actions[index]);
}

function policyFailure(
  value: MutableRecord,
  expectedCode: RunbookPolicyErrorCode,
  procedureId: OperatorProcedureId = 'provider-term-hold',
): RunbookPolicyError {
  try {
    parseOperatorProcedure(value, procedureId);
  } catch (error) {
    expect(error).toBeInstanceOf(RunbookPolicyError);
    expect((error as RunbookPolicyError).code).toBe(expectedCode);
    return error as RunbookPolicyError;
  }
  throw new Error('Expected runbook policy validation to fail.');
}

async function copiedRunbookDirectory(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'fdw-runbook-policy-'));
  temporaryRoots.push(temporaryRoot);
  const directory = join(temporaryRoot, 'operations');
  await cp(resolve('docs', 'operations'), directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('FDW-POL-007 operator procedure policy', () => {
  it('verifies the closed manifest of eight local documentation-only procedures and the package gate', async () => {
    const bundle = await verifyRunbookBundle();
    const procedures = bundle.procedures;
    expect(procedures.map(({ procedureId }) => procedureId)).toEqual(
      OPERATOR_PROCEDURE_DEFINITIONS.map(({ procedureId }) => procedureId),
    );
    expect(bundle.manifest).toMatchObject({
      schemaVersion: OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION,
      mode: 'closed-synthetic-rehearsal-only',
      privacy: 'aggregate-only-no-aircraft-request-client-or-event-data',
      procedureCount: 8,
    });
    expect(bundle.manifest.procedures).toEqual(bundle.procedureIdentities);
    expect(bundle.manifestIdentity).toMatchObject({
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    for (const procedure of procedures) {
      expect(procedure.documentationBoundary).toEqual({
        mode: 'local-documentation-only',
        executionClaim: 'none',
        runtimeControlPlane: 'forbidden',
      });
      expect(procedure.entryEvidence.length).toBeGreaterThanOrEqual(2);
      expect(procedure.boundedActions.length).toBeGreaterThanOrEqual(2);
      expect(procedure.stopConditions.length).toBeGreaterThanOrEqual(2);
      expect(procedure.rollbackActions.length).toBeGreaterThanOrEqual(1);
      expect(procedure.verificationReceipt).toEqual({
        schemaVersion: 'operator-verification-receipt.v1',
        status: 'template-only-not-executed',
        privacy: 'aggregate-only-no-aircraft-request-client-or-event-data',
        requiredFields: OPERATOR_RECEIPT_REQUIRED_FIELDS,
        resultValues: OPERATOR_RECEIPT_RESULT_VALUES,
      });
    }

    const packageDocument = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    expect(packageDocument.scripts?.['runbooks:verify']).toBe('tsx tools/live/verifyRunbooks.ts');
  });

  it('uses the exact stable runtime-policy and operations reason vocabularies', async () => {
    const procedures = await verifyRunbookDirectory();
    expect(procedures.map(({ reasonVocabulary }) => reasonVocabulary.runtimePolicy[0])).toEqual([
      'terms-hold',
      'quota-hold',
      'upstream-stale',
      'internal-fault',
      'source-disabled',
      'rollback',
      'source-disabled',
      'internal-fault',
    ]);
    expect(
      procedures.find(({ procedureId }) => procedureId === 'stale-feed')?.reasonVocabulary
        .operations,
    ).toEqual([
      'PROVIDER_EMPTY',
      'FRESHNESS_EMPTY',
      'FRESHNESS_STALE',
      'FRESHNESS_EXPIRED',
      'FRESHNESS_UNAVAILABLE',
      'FRESHNESS_CURRENT',
    ]);
    for (const procedure of procedures) {
      for (const reason of procedure.reasonVocabulary.runtimePolicy) {
        expect(RUNTIME_POLICY_REASON_CODES).toContain(reason);
      }
      for (const reason of procedure.reasonVocabulary.operations) {
        expect(OPERATIONS_REASON_CODES).toContain(reason);
      }
      const observedReasons = [
        ...procedure.entryEvidence.map(({ reasonCode }) => reasonCode),
        ...procedure.stopConditions.map(({ reasonCode }) => reasonCode),
      ];
      for (const reason of [
        ...procedure.reasonVocabulary.runtimePolicy,
        ...procedure.reasonVocabulary.operations,
      ]) {
        expect(observedReasons).toContain(reason);
      }
    }
  });

  it('fails closed on missing fields, unknown fields, and unknown reasons', async () => {
    const valid = await procedureValue('provider-term-hold');

    const missing = clone(valid);
    delete missing.purpose;
    policyFailure(missing, 'INVALID_SHAPE');

    const unknown = clone(valid);
    unknown.runtimeMutation = true;
    policyFailure(unknown, 'INVALID_SHAPE');

    const unknownReason = clone(valid);
    asRecord(unknownReason.reasonVocabulary).runtimePolicy = ['provider-hold-v2'];
    policyFailure(unknownReason, 'INVALID_REASON');

    const undeclaredKnownReason = clone(valid);
    const evidence = undeclaredKnownReason.entryEvidence;
    if (!Array.isArray(evidence)) throw new Error('Expected entryEvidence in test fixture.');
    asRecord(evidence[0]).reasonCode = 'quota-hold';
    policyFailure(undeclaredKnownReason, 'INVALID_REASON');
  });

  it.each([
    ['unsafe command', 'Run rm -rf / immediately.'],
    ['mutable secret', 'Store the API key in this procedure.'],
    ['runtime administration endpoint', 'Send a request to /api/v1/admin/disable.'],
    ['unauthorized control binding', 'Add an ADMIN_CONTROL binding.'],
    ['provider switching', 'Switch to an alternate provider.'],
    ['payment action', 'Upgrade the provider plan.'],
    ['unbounded retry', 'Keep retrying indefinitely.'],
    ['undeclared destination', 'Open https://example.test/control.'],
  ])('rejects %s text', async (_label, instruction) => {
    const candidate = await procedureValue('provider-term-hold');
    action(candidate).instruction = instruction;
    policyFailure(candidate, 'UNSAFE_INSTRUCTION');
  });

  it('rejects invalid action bounds, authority, receipt state, and execution claims', async () => {
    const valid = await procedureValue('provider-term-hold');

    const zeroAttempts = clone(valid);
    action(zeroAttempts).maximumAttempts = 0;
    policyFailure(zeroAttempts, 'INVALID_BOUND');

    const excessiveAttempts = clone(valid);
    action(excessiveAttempts).maximumAttempts = 4;
    policyFailure(excessiveAttempts, 'INVALID_BOUND');

    const forgedAuthority = clone(valid);
    action(forgedAuthority, 1).authority = 'read-only-local';
    policyFailure(forgedAuthority, 'INVALID_SEMANTICS');

    const commandField = clone(valid);
    action(commandField).command = 'echo bypass';
    policyFailure(commandField, 'INVALID_SHAPE');

    const executionClaim = clone(valid);
    asRecord(executionClaim.documentationBoundary).executionClaim = 'completed';
    policyFailure(executionClaim, 'INVALID_SEMANTICS');

    const receiptClaim = clone(valid);
    asRecord(receiptClaim.verificationReceipt).status = 'verified';
    policyFailure(receiptClaim, 'INVALID_SEMANTICS');
  });

  it('rejects extra, missing, and duplicate procedure files or fields', async () => {
    const extraDirectory = await copiedRunbookDirectory();
    await writeFile(join(extraDirectory, 'extra.json'), '{}\n', 'utf8');
    await expect(verifyRunbookDirectory(extraDirectory)).rejects.toMatchObject({
      code: 'INVALID_FILE_SET',
    });

    const missingDirectory = await copiedRunbookDirectory();
    await rm(join(missingDirectory, 'rollback.json'));
    await expect(verifyRunbookDirectory(missingDirectory)).rejects.toMatchObject({
      code: 'INVALID_FILE_SET',
    });

    const duplicateDirectory = await copiedRunbookDirectory();
    const duplicatePath = join(duplicateDirectory, 'provider-term-hold.json');
    const source = await readFile(duplicatePath, 'utf8');
    await writeFile(
      duplicatePath,
      source.replace('{\n', '{\n  "schemaVersion": "operator-procedure.v1",\n'),
      'utf8',
    );
    await expect(verifyRunbookDirectory(duplicateDirectory)).rejects.toMatchObject({
      code: 'NONCANONICAL_JSON',
    });
  });

  it('rejects a procedure mutation that no longer matches the closed manifest', async () => {
    const directory = await copiedRunbookDirectory();
    const path = join(directory, 'candidate-retention.json');
    const source = await readFile(path, 'utf8');
    await writeFile(
      path,
      source.replace('source-built synthetic candidate', 'source-built local candidate'),
    );
    await expect(verifyRunbookDirectory(directory)).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });
  });

  it('rejects manifest mutation and unknown manifest fields', async () => {
    const identityDirectory = await copiedRunbookDirectory();
    const identityPath = join(identityDirectory, 'manifest.json');
    const identityManifest = JSON.parse(await readFile(identityPath, 'utf8')) as MutableRecord;
    const identities = identityManifest.procedures;
    if (!Array.isArray(identities)) throw new Error('Expected manifest procedure identities.');
    asRecord(identities[0]).sha256 = '0'.repeat(64);
    await writeFile(identityPath, `${JSON.stringify(identityManifest, null, 2)}\n`, 'utf8');
    await expect(verifyRunbookDirectory(identityDirectory)).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });

    const unknownDirectory = await copiedRunbookDirectory();
    const unknownPath = join(unknownDirectory, 'manifest.json');
    const unknownManifest = JSON.parse(await readFile(unknownPath, 'utf8')) as MutableRecord;
    unknownManifest.executionMode = 'production';
    await writeFile(unknownPath, `${JSON.stringify(unknownManifest, null, 2)}\n`, 'utf8');
    await expect(verifyRunbookDirectory(unknownDirectory)).rejects.toMatchObject({
      code: 'INVALID_SHAPE',
    });
  });
});
