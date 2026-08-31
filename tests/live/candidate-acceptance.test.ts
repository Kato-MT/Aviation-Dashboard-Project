import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/live/retainCandidate', () => ({
  candidateCommitmentSha256: vi.fn(() => '5'.repeat(64)),
  candidateSelectionRecordPath: vi.fn((candidate: string) => `${candidate}.selection.json`),
  captureSourceIdentity: vi.fn(),
  sameSourceIdentity: vi.fn(
    (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  ),
  verifyRetainedCandidate: vi.fn(),
}));

vi.mock('../../tools/live/rehearseCandidateRunbooks', () => ({
  candidateRunbookIdentityInput: vi.fn(),
  readRetainedRuntimePolicyBinding: vi.fn(),
  verifyCandidateRunbookRehearsal: vi.fn(),
}));

vi.mock('../../tools/live/verifyBrowserBudgets', () => ({
  BROWSER_BUDGET_SCHEMA_VERSION: 'airspace-browser-budgets.v1',
  verifyBrowserBudgets: vi.fn(),
}));

import {
  M34_ACCEPTANCE_CASE_NAMES,
  parsePassingJunit,
  recordCandidateAcceptance,
} from '../../tools/live/recordCandidateAcceptance';
import {
  captureSourceIdentity,
  verifyRetainedCandidate,
  type RetainedCandidateProvenance,
  type SourceIdentity,
} from '../../tools/live/retainCandidate';
import {
  candidateRunbookIdentityInput,
  readRetainedRuntimePolicyBinding,
  verifyCandidateRunbookRehearsal,
  type RetainedRuntimePolicyBinding,
  type VerifiedCandidateRunbookRehearsal,
} from '../../tools/live/rehearseCandidateRunbooks';
import {
  verifyBrowserBudgets,
  type BrowserBudgetReport,
} from '../../tools/live/verifyBrowserBudgets';

const roots: string[] = [];
const verifyCandidate = vi.mocked(verifyRetainedCandidate);
const captureSource = vi.mocked(captureSourceIdentity);
const candidateRunbookInput = vi.mocked(candidateRunbookIdentityInput);
const readRuntimePolicy = vi.mocked(readRetainedRuntimePolicyBinding);
const verifyRunbook = vi.mocked(verifyCandidateRunbookRehearsal);
const verifyBudgets = vi.mocked(verifyBrowserBudgets);
const SOURCE = {
  head: 'b'.repeat(40),
  contentSha256: 'c'.repeat(64),
} as SourceIdentity;

function junit(
  overrides: Partial<Record<'tests' | 'failures' | 'errors' | 'skipped', number>> = {},
  names: readonly string[] = M34_ACCEPTANCE_CASE_NAMES,
): string {
  const counts = {
    tests: M34_ACCEPTANCE_CASE_NAMES.length,
    failures: 0,
    errors: 0,
    skipped: 0,
    ...overrides,
  };
  const cases = names
    .slice(0, counts.tests)
    .map(
      (name) =>
        `<testcase name="${name}" classname="m34-entry-artifact.spec.ts" time="0.1"></testcase>`,
    )
    .join('');
  return `<testsuites tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}" time="0.5"><testsuite name="m34-entry-artifact.spec.ts" hostname="m34-built-chromium" tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}" time="0.5" timestamp="2026-08-28T21:00:00.000Z">${cases}</testsuite></testsuites>`;
}

function provenance(): RetainedCandidateProvenance {
  return {
    candidateId: `mock-staging-${'a'.repeat(24)}`,
    application: { buildTarget: 'mock-staging', providerMode: 'mock' },
    source: { head: 'b'.repeat(40), contentSha256: 'c'.repeat(64) },
    retainedArtifact: { fileCount: 20, totalBytes: 2_000, sha256: 'd'.repeat(64) },
    mapManifest: {
      id: 'map-z12',
      sha256: 'e'.repeat(64),
      basemapSha256: 'f'.repeat(64),
      payload: { fileCount: 776, totalBytes: 99_000, sha256: '1'.repeat(64) },
    },
    rollback: {
      releaseTag: 'v2.2.0',
      sourceRevision: 'd29e87e07586ca7790f86a65e55b2ce6e2fcc1c7',
      archive: { sha256: '2'.repeat(64) },
    },
    replayScenarios: [
      {
        schemaVersion: 'airspace-replay.v1',
        scenarioId: 'nominal-regional',
        seed: 20_260_828,
        generatorId: 'bundled',
        generatorVersion: '1',
        canonicalSha256: '3'.repeat(64),
      },
    ],
  } as RetainedCandidateProvenance;
}

function runtimePolicyBinding(): RetainedRuntimePolicyBinding {
  return {
    identity: {
      path: 'artifact/client/runtime-policy.json',
      bytes: 5_000,
      sha256: '7'.repeat(64),
    },
    canonicalSha256: '8'.repeat(64),
    limits: {
      schemaVersion: 'runtime-policy-limits.v2',
      canonicalSha256: '9'.repeat(64),
    },
    policy: {
      schemaVersion: 'runtime-policy.v1',
      policyId: 'a'.repeat(64),
      policyEpoch: 'r3-local-1',
      target: 'mock-staging',
      release: {
        applicationVersion: '3.0.0-dev',
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
    },
  } as RetainedRuntimePolicyBinding;
}

function runbookVerification(
  limitsSha256 = '9'.repeat(64),
  receiptSha256 = 'b'.repeat(64),
): VerifiedCandidateRunbookRehearsal {
  return {
    receiptIdentity: { bytes: 12_000, sha256: receiptSha256 },
    receipt: {
      schemaVersion: 'runbook-rehearsal-receipt.v1',
      evidenceClass: 'synthetic-local-runbook-rehearsal',
      privacy: 'aggregate-only-no-aircraft-request-client-or-event-data',
      checkedAt: '2026-08-30T12:00:00.000Z',
      bindings: {
        schemaVersion: 'runbook-rehearsal-bindings.v1',
        runbooks: {
          schemaVersion: 'operator-procedure-manifest.v1',
          path: 'manifest.json',
          bytes: 2_000,
          sha256: 'c'.repeat(64),
          procedureCount: 8,
        },
        compiledPolicy: {
          schemaVersion: 'runtime-policy.v1',
          policyId: 'd'.repeat(64),
          policyEpoch: 'r3-runbook-rehearsal-1',
          canonicalSha256: 'e'.repeat(64),
          sourceDescriptorSha256: 'f'.repeat(64),
          limitsSchemaVersion: 'runtime-policy-limits.v2',
          limitsSha256,
          limits: runtimePolicyBinding().policy.limits,
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
          manifest: { bytes: 900, sha256: '1'.repeat(64) },
          archive: { bytes: 1_000, sha256: '2'.repeat(64) },
        },
      },
      procedureOutcomes: [],
      summary: {
        procedureCount: 8,
        verifiedCount: 8,
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
    },
  } as VerifiedCandidateRunbookRehearsal;
}

function browserBudget(): BrowserBudgetReport {
  return {
    schemaVersion: 'airspace-browser-budgets.v1',
    artifact: {
      target: 'mock-staging',
      clientIdentity: {
        schemaVersion: 'sha256-file-inventory.v1',
        fileCount: 8,
        totalBytes: 700_000,
        sha256: '3'.repeat(64),
      },
    },
    initialShell: {
      limitGzipBytes: 200_000,
      totalGzipBytes: 100_000,
      assets: [],
    },
    lazyMap: { limitGzipBytes: 400_000, totalGzipBytes: 250_000, assets: [] },
    styles: { totalBytes: 30_000, totalGzipBytes: 10_000, assets: [] },
    fonts: { totalBytes: 40_000, totalGzipBytes: 35_000, assets: [] },
  };
}

async function acceptanceFixture(): Promise<{
  root: string;
  candidate: string;
  report: string;
  runbook: string;
  output: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'candidate-acceptance-test-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  const report = join(root, 'results.xml');
  const runbook = join(root, 'runbook-rehearsal.json');
  const output = join(root, 'acceptance.json');
  await mkdir(candidate);
  await writeFile(
    join(candidate, 'checksums.sha256'),
    `${'4'.repeat(64)}  artifact/client/index.html\n`,
  );
  await writeFile(`${candidate}.selection.json`, '{"selected":true}\n');
  await writeFile(report, junit());
  await writeFile(runbook, '{"synthetic":true}\n');
  return { root, candidate, report, runbook, output };
}

beforeEach(() => {
  verifyCandidate.mockReset();
  captureSource.mockReset();
  candidateRunbookInput.mockReset();
  readRuntimePolicy.mockReset();
  verifyRunbook.mockReset();
  verifyBudgets.mockReset();
  captureSource.mockResolvedValue(SOURCE);
  candidateRunbookInput.mockReturnValue({
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
  });
  readRuntimePolicy.mockResolvedValue(runtimePolicyBinding());
  verifyRunbook.mockResolvedValue(runbookVerification());
  verifyBudgets.mockResolvedValue(browserBudget());
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('M3.4 acceptance receipt', () => {
  it('keeps the receipt allowlist synchronized with the exact browser acceptance spec', async () => {
    const spec = await readFile(
      join(process.cwd(), 'tests/live-browser/m34-entry-artifact.spec.ts'),
      'utf8',
    );
    const declarations = [...spec.matchAll(/^test\(/gmu)];
    const names = [...spec.matchAll(/^test\('([^']+)'/gmu)].map((match) => {
      const name = match[1];
      if (name === undefined) throw new Error('M3.4 test declaration is missing its case name.');
      return name;
    });

    expect(names).toHaveLength(declarations.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...M34_ACCEPTANCE_CASE_NAMES].sort());
  });

  it('accepts only the exact zero-failure, zero-skip M3.4 JUnit report', () => {
    expect(parsePassingJunit(junit())).toMatchObject({
      tests: M34_ACCEPTANCE_CASE_NAMES.length,
      failures: 0,
      errors: 0,
      skipped: 0,
      durationSeconds: 0.5,
      executedAt: '2026-08-28T21:00:00.000Z',
      suiteName: 'm34-entry-artifact.spec.ts',
      projectName: 'm34-built-chromium',
      caseNames: [...M34_ACCEPTANCE_CASE_NAMES].sort(),
    });
  });

  it.each([
    [{ failures: 1 }, 'zero failed'],
    [{ errors: 1 }, 'zero failed'],
    [{ skipped: 1 }, 'zero failed'],
    [
      { tests: M34_ACCEPTANCE_CASE_NAMES.length - 1 },
      `exactly ${M34_ACCEPTANCE_CASE_NAMES.length}`,
    ],
  ] as const)('rejects an incomplete report: %j', (overrides, message) => {
    expect(() => parsePassingJunit(junit(overrides))).toThrow(message);
  });

  it('rejects arbitrary passing case names', () => {
    const names = Array.from(
      { length: M34_ACCEPTANCE_CASE_NAMES.length },
      (_, index) => `arbitrary case ${index + 1}`,
    );
    expect(() => parsePassingJunit(junit({}, names))).toThrow('exact M3.4 acceptance cases');
  });

  it('binds the strict rehearsal, distinct policies, canonical limits, retained budgets, and browser evidence', async () => {
    const fixture = await acceptanceFixture();
    const identity = provenance();
    verifyCandidate.mockResolvedValue(identity);

    const receipt = await recordCandidateAcceptance({
      candidateDirectory: fixture.candidate,
      junitPath: fixture.report,
      runbookReceiptPath: fixture.runbook,
      outputPath: fixture.output,
      expectedSelectionRecordSha256: '6'.repeat(64),
    });

    expect(verifyCandidate).toHaveBeenCalledTimes(2);
    expect(verifyCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateDirectory: fixture.candidate,
        expectedSelectionRecordSha256: '6'.repeat(64),
        expectedSourceIdentity: SOURCE,
        selectionRecordPath: `${fixture.candidate}.selection.json`,
      }),
    );
    expect(captureSource).toHaveBeenCalledTimes(2);
    expect(readRuntimePolicy).toHaveBeenCalledTimes(2);
    expect(verifyRunbook).toHaveBeenCalledTimes(2);
    expect(verifyRunbook).toHaveBeenCalledWith(
      fixture.runbook,
      expect.objectContaining({
        source: expect.objectContaining({ head: identity.source.head }),
        syntheticArtifact: expect.objectContaining({ sha256: identity.retainedArtifact.sha256 }),
      }),
      expect.objectContaining({ repositoryRoot: expect.any(String) }),
    );
    expect(verifyBudgets).toHaveBeenCalledWith(
      join(fixture.candidate, 'artifact'),
      'mock-staging',
      runtimePolicyBinding().policy.limits.browser.bundle,
    );
    expect(receipt).toMatchObject({
      schemaVersion: 'airspace-m34-acceptance.v2',
      candidate: {
        id: identity.candidateId,
        retainedArtifact: identity.retainedArtifact,
        runtimePolicy: {
          path: 'artifact/client/runtime-policy.json',
          sha256: '7'.repeat(64),
          policyId: 'a'.repeat(64),
          policyEpoch: 'r3-local-1',
          canonicalSha256: '8'.repeat(64),
          limits: { canonicalSha256: '9'.repeat(64) },
        },
        selectionRecord: {
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          candidateCommitmentSha256: '5'.repeat(64),
        },
      },
      browser: {
        configuredRetries: 0,
        retryEvidence: {
          format: 'Playwright configuration',
          path: 'playwright.m34.config.ts',
          retries: 0,
        },
      },
      browserBudgets: {
        target: 'mock-staging',
        clientIdentity: { sha256: '3'.repeat(64) },
        initialShell: { limitGzipBytes: 200_000, totalGzipBytes: 100_000 },
        lazyMap: { limitGzipBytes: 400_000, totalGzipBytes: 250_000 },
      },
      runbookRehearsal: {
        sha256: 'b'.repeat(64),
        source: {
          head: identity.source.head,
          contentSha256: identity.source.contentSha256,
        },
        syntheticArtifact: expect.objectContaining({
          fileCount: identity.retainedArtifact.fileCount,
          totalBytes: identity.retainedArtifact.totalBytes,
          sha256: identity.retainedArtifact.sha256,
        }),
        policies: {
          retained: { policyId: 'a'.repeat(64), policyEpoch: 'r3-local-1' },
          rehearsal: {
            policyId: 'd'.repeat(64),
            policyEpoch: 'r3-runbook-rehearsal-1',
          },
          limits: { canonicalSha256: '9'.repeat(64) },
        },
        summary: { procedureCount: 8, verifiedCount: 8, finalResult: 'verified' },
        executionBoundary: {
          networkRequests: 0,
          providerActions: 0,
          cloudActions: 0,
          deploymentActions: 0,
          runtimeMutations: 0,
          productionActions: 0,
        },
      },
      map: {
        id: identity.mapManifest.id,
        manifestSha256: identity.mapManifest.sha256,
        payload: identity.mapManifest.payload,
      },
    });
    expect(receipt.candidate.runtimePolicy.policyId).not.toBe(
      receipt.runbookRehearsal.policies.rehearsal.policyId,
    );
    expect(JSON.stringify(receipt.browserBudgets)).not.toContain('"assets"');
    await expect(readFile(`${fixture.output}.sha256`, 'utf8')).resolves.toContain(
      '  acceptance.json\n',
    );
  });

  it('rejects a rehearsal whose canonical limits differ from the retained policy', async () => {
    const fixture = await acceptanceFixture();
    verifyCandidate.mockResolvedValue(provenance());
    verifyRunbook.mockResolvedValue(runbookVerification('0'.repeat(64)));

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: fixture.output,
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('different canonical limits');
    expect(verifyBudgets).not.toHaveBeenCalled();
    await expect(readFile(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects retained policy and candidate provenance incompatibility before recording', async () => {
    const fixture = await acceptanceFixture();
    verifyCandidate.mockResolvedValue(provenance());
    candidateRunbookInput.mockImplementation(() => {
      throw new Error('Retained runtime policy is incompatible with candidate provenance.');
    });

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: fixture.output,
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('incompatible with candidate provenance');
    expect(verifyRunbook).not.toHaveBeenCalled();
  });

  it('removes acceptance outputs when the strict rehearsal identity mutates post-write', async () => {
    const fixture = await acceptanceFixture();
    verifyCandidate.mockResolvedValue(provenance());
    verifyRunbook
      .mockResolvedValueOnce(runbookVerification())
      .mockResolvedValueOnce(runbookVerification('9'.repeat(64), '0'.repeat(64)));

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: fixture.output,
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('Runbook rehearsal receipt changed');
    await expect(readFile(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${fixture.output}.sha256`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink JUnit input', async () => {
    const fixture = await acceptanceFixture();
    const targetDirectory = join(fixture.root, 'report-target');
    const linkedReport = join(fixture.root, 'report-link');
    await mkdir(targetDirectory);
    await symlink(targetDirectory, linkedReport, process.platform === 'win32' ? 'junction' : 'dir');
    verifyCandidate.mockResolvedValue(provenance());

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: linkedReport,
        runbookReceiptPath: fixture.runbook,
        outputPath: fixture.output,
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('non-empty regular file');
    expect(verifyCandidate).toHaveBeenCalledTimes(1);
  });

  it('keeps an output child named ..acceptance inside the immutable candidate boundary', async () => {
    const fixture = await acceptanceFixture();

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: join(fixture.candidate, '..acceptance.json'),
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('Acceptance evidence overlaps a protected source or build input');
    expect(captureSource).not.toHaveBeenCalled();
  });

  it('rejects an output under the raw production build before writing', async () => {
    const fixture = await acceptanceFixture();

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: join('dist-live', 'client', 'assets', 'acceptance.js'),
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow(/dedicated evidence root|protected source or build input/u);
    expect(captureSource).not.toHaveBeenCalled();
  });

  it('removes its receipt when the full post-write candidate verification fails', async () => {
    const fixture = await acceptanceFixture();
    verifyCandidate
      .mockResolvedValueOnce(provenance())
      .mockRejectedValueOnce(new Error('candidate changed'));

    await expect(
      recordCandidateAcceptance({
        candidateDirectory: fixture.candidate,
        junitPath: fixture.report,
        runbookReceiptPath: fixture.runbook,
        outputPath: fixture.output,
        expectedSelectionRecordSha256: '6'.repeat(64),
      }),
    ).rejects.toThrow('candidate changed');
    await expect(readFile(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${fixture.output}.sha256`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
