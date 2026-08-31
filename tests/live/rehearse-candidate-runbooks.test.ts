import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/live/retainCandidate', () => ({
  candidateSelectionRecordPath: vi.fn((candidate: string) => `${candidate}.selection.json`),
  verifyRetainedCandidate: vi.fn(),
}));

vi.mock('../../tools/live/rehearseRunbooks', () => ({
  MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES: 256 * 1024,
  RUNBOOK_REHEARSAL_EVIDENCE_CLASS: 'synthetic-local-runbook-rehearsal',
  RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION: 'runbook-rehearsal-request.v1',
  compileRunbookRehearsalBindings: vi.fn(),
  readRunbookRehearsalReceipt: vi.fn(),
  runSyntheticRunbookRehearsal: vi.fn(),
}));

import { runtimePolicyCanonicalJson } from '../../src/live/runtimePolicy';
import {
  candidateRunbookIdentityInput,
  rehearseCandidateRunbooks,
  verifyCandidateRunbookRehearsal,
} from '../../tools/live/rehearseCandidateRunbooks';
import {
  verifyRetainedCandidate,
  type RetainedCandidateProvenance,
} from '../../tools/live/retainCandidate';
import {
  compileRunbookRehearsalBindings,
  readRunbookRehearsalReceipt,
  runSyntheticRunbookRehearsal,
  type RunbookRehearsalBindingsV1,
  type RunbookRehearsalReceiptV1,
} from '../../tools/live/rehearseRunbooks';
import { OPERATOR_PROCEDURE_DEFINITIONS } from '../../tools/live/verifyRunbooks';

const roots: string[] = [];
const verifyCandidate = vi.mocked(verifyRetainedCandidate);
const compileBindings = vi.mocked(compileRunbookRehearsalBindings);
const readReceipt = vi.mocked(readRunbookRehearsalReceipt);
const runRehearsal = vi.mocked(runSyntheticRunbookRehearsal);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenance(overrides: { applicationVersion?: string; artifactSha256?: string } = {}) {
  return {
    candidateId: `mock-staging-${'a'.repeat(24)}`,
    application: {
      applicationName: 'flight-diagnostics-workbench',
      packageVersion: '2.2.0',
      applicationVersion: overrides.applicationVersion ?? '3.0.0-dev',
      releaseSha: 'local-unreleased',
      buildTarget: 'mock-staging',
      providerMode: 'mock',
    },
    source: {
      head: 'b'.repeat(40),
      contentSha256: 'c'.repeat(64),
    },
    retainedArtifact: {
      path: 'artifact',
      fileCount: 20,
      totalBytes: 2_000,
      sha256: overrides.artifactSha256 ?? 'd'.repeat(64),
    },
  } as RetainedCandidateProvenance;
}

function runtimePolicy(applicationVersion = '3.0.0-dev') {
  const body = {
    schemaVersion: 'runtime-policy.v1',
    policyEpoch: 'r3-local-1',
    target: 'mock-staging',
    deploymentClass: 'loopback',
    release: {
      applicationVersion,
      releaseSha: 'local-unreleased',
      releaseStatus: 'unreleased',
      buildTarget: 'mock-staging',
    },
    source: {
      descriptor: {
        target: 'mock-staging',
        mode: 'mock',
        providerId: 'synthetic-test',
        label: 'Synthetic integration feed',
        synthetic: true,
      },
    },
    limits: {
      schemaVersion: 'runtime-policy-limits.v2',
      browser: {
        bundle: { initialShellGzipBytes: 200_000, lazyMapGzipBytes: 400_000 },
      },
    },
  };
  return { ...body, policyId: sha256(runtimePolicyCanonicalJson(body)) };
}

function bindings(): RunbookRehearsalBindingsV1 {
  return {
    schemaVersion: 'runbook-rehearsal-bindings.v1',
    runbooks: {
      schemaVersion: 'operator-procedure-manifest.v1',
      path: 'manifest.json',
      bytes: 2_000,
      sha256: '1'.repeat(64),
      procedureCount: OPERATOR_PROCEDURE_DEFINITIONS.length,
    },
    compiledPolicy: {
      schemaVersion: 'runtime-policy.v1',
      policyId: '2'.repeat(64),
      policyEpoch: 'r3-runbook-rehearsal-1',
      canonicalSha256: '3'.repeat(64),
      sourceDescriptorSha256: '4'.repeat(64),
      limitsSchemaVersion: 'runtime-policy-limits.v2',
      limitsSha256: '5'.repeat(64),
      limits: runtimePolicy().limits,
    },
    source: {
      schemaVersion: 'synthetic-source-build-identity.v1',
      head: 'b'.repeat(40),
      contentSha256: 'c'.repeat(64),
    },
    release: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'b'.repeat(40),
      releaseStatus: 'unreleased',
      buildTarget: 'mock-staging',
    },
    syntheticArtifact: {
      schemaVersion: 'synthetic-artifact-identity.v1',
      kind: 'synthetic-source-built-artifact',
      fileCount: 20,
      totalBytes: 2_000,
      sha256: 'd'.repeat(64),
    },
    approvedRollback: {
      schemaVersion: 'fdw-approved-rollback.v1',
      releaseTag: 'v2.2.0',
      sourceRevision: 'd29e87e07586ca7790f86a65e55b2ce6e2fcc1c7',
      manifest: { bytes: 900, sha256: '6'.repeat(64) },
      archive: { bytes: 1_000, sha256: '7'.repeat(64) },
    },
  } as RunbookRehearsalBindingsV1;
}

function receipt(): RunbookRehearsalReceiptV1 {
  return {
    schemaVersion: 'runbook-rehearsal-receipt.v1',
    evidenceClass: 'synthetic-local-runbook-rehearsal',
    privacy: 'aggregate-only-no-aircraft-request-client-or-event-data',
    checkedAt: '2026-08-30T12:00:00.000Z',
    bindings: bindings(),
    procedureOutcomes: OPERATOR_PROCEDURE_DEFINITIONS.map(({ procedureId }) => ({
      procedureId,
      procedureSha256: '8'.repeat(64),
      runtimePolicyReasonCodes: [],
      operationsReasonCodes: [],
      entryEvidenceIds: [],
      rehearsedActionIds: [],
      rehearsedRollbackActionIds: [],
      stopConditionIds: [],
      result: 'verified' as const,
    })),
    summary: {
      procedureCount: OPERATOR_PROCEDURE_DEFINITIONS.length,
      verifiedCount: OPERATOR_PROCEDURE_DEFINITIONS.length,
      stoppedCount: 0,
      rolledBackCount: 0,
      recoveredCount: 0,
      finalResult: 'verified',
    },
    executionBoundary: {
      syntheticOnly: true,
      localOnly: true,
      networkRequests: 0,
      providerActions: 0,
      cloudActions: 0,
      deploymentActions: 0,
      runtimeMutations: 0,
      productionActions: 0,
    },
  } as RunbookRehearsalReceiptV1;
}

async function fixture(): Promise<{ candidate: string; output: string; selection: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rehearse-candidate-test-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  const output = join(root, 'runbook-receipt.json');
  const selection = `${candidate}.selection.json`;
  await mkdir(join(candidate, 'artifact', 'client'), { recursive: true });
  await writeFile(
    join(candidate, 'artifact', 'client', 'runtime-policy.json'),
    `${JSON.stringify(runtimePolicy(), null, 2)}\n`,
  );
  return { candidate, output, selection };
}

beforeEach(() => {
  verifyCandidate.mockReset();
  compileBindings.mockReset();
  readReceipt.mockReset();
  runRehearsal.mockReset();
  verifyCandidate.mockResolvedValue(provenance());
  compileBindings.mockResolvedValue(bindings());
  readReceipt.mockResolvedValue(receipt());
  runRehearsal.mockImplementation(async ({ outputPath }) => {
    await writeFile(outputPath, '{}\n', { flag: 'wx' });
    return receipt();
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('retained-candidate runbook rehearsal', () => {
  it('constructs one all-verified eight-procedure request from exact retained provenance', async () => {
    const item = await fixture();

    const result = await rehearseCandidateRunbooks({
      candidateDirectory: item.candidate,
      outputPath: item.output,
      expectedSelectionRecordSha256: '9'.repeat(64),
      expectedSourceHead: 'b'.repeat(40),
      checkedAt: '2026-08-30T12:00:00.000Z',
    });

    expect(result.summary).toMatchObject({ procedureCount: 8, verifiedCount: 8 });
    expect(verifyCandidate).toHaveBeenCalledTimes(2);
    expect(verifyCandidate).toHaveBeenCalledWith({
      candidateDirectory: item.candidate,
      selectionRecordPath: item.selection,
      expectedTarget: 'mock-staging',
      expectedSelectionRecordSha256: '9'.repeat(64),
      expectedSourceHead: 'b'.repeat(40),
    });
    expect(runRehearsal).toHaveBeenCalledTimes(1);
    expect(runRehearsal).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: item.output,
        request: {
          schemaVersion: 'runbook-rehearsal-request.v1',
          evidenceClass: 'synthetic-local-runbook-rehearsal',
          checkedAt: '2026-08-30T12:00:00.000Z',
          source: {
            schemaVersion: 'synthetic-source-build-identity.v1',
            head: 'b'.repeat(40),
            contentSha256: 'c'.repeat(64),
          },
          release: {
            applicationVersion: '3.0.0-dev',
            releaseSha: 'b'.repeat(40),
            releaseStatus: 'unreleased',
            buildTarget: 'mock-staging',
          },
          syntheticArtifact: {
            schemaVersion: 'synthetic-artifact-identity.v1',
            kind: 'synthetic-source-built-artifact',
            fileCount: 20,
            totalBytes: 2_000,
            sha256: 'd'.repeat(64),
          },
          outcomes: OPERATOR_PROCEDURE_DEFINITIONS.map(({ procedureId }) => ({
            procedureId,
            result: 'verified',
          })),
        },
      }),
    );
    expect(readReceipt).toHaveBeenCalledWith(
      item.output,
      expect.objectContaining({ finalResult: 'verified' }),
      expect.objectContaining({ repositoryRoot: expect.any(String) }),
    );
  });

  it('preserves a pre-existing output and does not begin candidate verification', async () => {
    const item = await fixture();
    await writeFile(item.output, 'existing receipt\n');

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedCandidateId: `mock-staging-${'a'.repeat(24)}`,
      }),
    ).rejects.toThrow('already exists');
    await expect(readFile(item.output, 'utf8')).resolves.toBe('existing receipt\n');
    expect(verifyCandidate).not.toHaveBeenCalled();
    expect(runRehearsal).not.toHaveBeenCalled();
  });

  it('does not remove a racing writer output reported as an atomic no-overwrite conflict', async () => {
    const item = await fixture();
    runRehearsal.mockImplementationOnce(async ({ outputPath }) => {
      await writeFile(outputPath, 'competing receipt\n', { flag: 'wx' });
      throw Object.assign(new Error('Runbook rehearsal output already exists.'), {
        code: 'INVALID_OUTPUT',
      });
    });

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedSelectionRecordSha256: '9'.repeat(64),
      }),
    ).rejects.toThrow('already exists');
    await expect(readFile(item.output, 'utf8')).resolves.toBe('competing receipt\n');
  });

  it('cleans a partial output when the rehearsal runner fails', async () => {
    const item = await fixture();
    runRehearsal.mockImplementationOnce(async ({ outputPath }) => {
      await writeFile(outputPath, 'partial\n', { flag: 'wx' });
      throw new Error('synthetic rehearsal failed');
    });

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedSelectionRecordSha256: '9'.repeat(64),
      }),
    ).rejects.toThrow('synthetic rehearsal failed');
    await expect(readFile(item.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans the receipt when full post-rehearsal candidate verification fails', async () => {
    const item = await fixture();
    verifyCandidate
      .mockResolvedValueOnce(provenance())
      .mockRejectedValueOnce(new Error('candidate post-verification failed'));

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedSelectionRecordSha256: '9'.repeat(64),
      }),
    ).rejects.toThrow('candidate post-verification failed');
    expect(verifyCandidate).toHaveBeenCalledTimes(2);
    await expect(readFile(item.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a retained policy mismatch before creating a rehearsal receipt', async () => {
    const item = await fixture();
    verifyCandidate.mockResolvedValue(provenance({ applicationVersion: '3.0.1' }));

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedSelectionRecordSha256: '9'.repeat(64),
      }),
    ).rejects.toThrow('incompatible with candidate provenance');
    expect(runRehearsal).not.toHaveBeenCalled();
    await expect(readFile(item.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a candidate mutation and removes the created receipt', async () => {
    const item = await fixture();
    verifyCandidate
      .mockResolvedValueOnce(provenance())
      .mockResolvedValueOnce(provenance({ artifactSha256: '0'.repeat(64) }));

    await expect(
      rehearseCandidateRunbooks({
        candidateDirectory: item.candidate,
        outputPath: item.output,
        expectedSelectionRecordSha256: '9'.repeat(64),
      }),
    ).rejects.toThrow('Candidate identity changed');
    await expect(readFile(item.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a verified receipt whose procedure summary is not all verified', async () => {
    const item = await fixture();
    const input = candidateRunbookIdentityInput(provenance(), {
      identity: {
        path: 'artifact/client/runtime-policy.json',
        bytes: 1,
        sha256: '1'.repeat(64),
      },
      canonicalSha256: '2'.repeat(64),
      limits: {
        schemaVersion: 'runtime-policy-limits.v2',
        canonicalSha256: '3'.repeat(64),
      },
      policy: runtimePolicy(),
    } as never);
    await writeFile(item.output, '{}\n');
    const badReceipt = receipt();
    readReceipt.mockResolvedValueOnce({
      ...badReceipt,
      summary: { ...badReceipt.summary, verifiedCount: 7 },
    });

    await expect(verifyCandidateRunbookRehearsal(item.output, input)).rejects.toThrow(
      'did not verify every closed procedure',
    );
  });
});
