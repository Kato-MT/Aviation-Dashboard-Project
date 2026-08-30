import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  RUNTIME_POLICY_SCHEMA_VERSION,
  runtimePolicyCanonicalJson,
  type RuntimePolicyReleaseIdentity,
  type RuntimePolicyV1,
} from '../../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS_SCHEMA_VERSION } from '../../src/live/runtimePolicyLimits';
import {
  candidateSelectionRecordPath,
  verifyRetainedCandidate,
  type RetainedCandidateProvenance,
  type VerifyCandidateOptions,
} from './retainCandidate';
import {
  MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES,
  RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
  RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION,
  compileRunbookRehearsalBindings,
  readRunbookRehearsalReceipt,
  runSyntheticRunbookRehearsal,
  type RunbookRehearsalEnvironmentOptions,
  type RunbookRehearsalIdentityInputV1,
  type RunbookRehearsalReceiptV1,
  type SyntheticRunbookArtifactIdentityV1,
  type SyntheticRunbookSourceIdentityV1,
} from './rehearseRunbooks';
import { OPERATOR_PROCEDURE_DEFINITIONS } from './verifyRunbooks';

const MAX_RETAINED_RUNTIME_POLICY_BYTES = 256 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD_PATTERN = /^[a-f0-9]{40}$/u;
const RUNTIME_POLICY_CANDIDATE_PATH = 'artifact/client/runtime-policy.json' as const;
const MODULE_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type JsonRecord = Record<string, unknown>;

export interface RetainedRuntimePolicyBinding {
  readonly identity: {
    readonly path: typeof RUNTIME_POLICY_CANDIDATE_PATH;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly canonicalSha256: string;
  readonly limits: {
    readonly schemaVersion: typeof RUNTIME_POLICY_LIMITS_SCHEMA_VERSION;
    readonly canonicalSha256: string;
  };
  readonly policy: Readonly<RuntimePolicyV1>;
}

export interface VerifiedCandidateRunbookRehearsal {
  readonly receipt: Readonly<RunbookRehearsalReceiptV1>;
  readonly receiptIdentity: {
    readonly bytes: number;
    readonly sha256: string;
  };
}

export interface RehearseCandidateRunbooksOptions
  extends
    Omit<VerifyCandidateOptions, 'candidateDirectory' | 'expectedTarget'>,
    RunbookRehearsalEnvironmentOptions {
  readonly candidateDirectory: string;
  readonly outputPath: string;
  readonly checkedAt?: string;
}

interface StableFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contents: Buffer;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be non-empty canonical text.`);
  }
  return value;
}

async function readStableFile(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<StableFile> {
  const absolute = resolve(path);
  const before = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${absolute}`);
    }
    throw error;
  });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded non-empty regular file.`);
  }
  const contents = await readFile(absolute);
  const after = await lstat(absolute);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    contents.byteLength !== after.size
  ) {
    throw new Error(`${label} changed while it was read.`);
  }
  return Object.freeze({
    path: absolute,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    contents,
  });
}

function parseRetainedRuntimePolicy(contents: Buffer): Readonly<RuntimePolicyV1> {
  let source: string;
  try {
    source = UTF8.decode(contents);
  } catch {
    throw new Error('Retained runtime policy is not strict UTF-8.');
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Retained runtime policy is not valid JSON.');
  }
  const policy = record(value, 'Retained runtime policy');
  const release = record(policy.release, 'Retained runtime policy release');
  const sourceRecord = record(policy.source, 'Retained runtime policy source');
  const descriptor = record(sourceRecord.descriptor, 'Retained runtime policy source descriptor');
  const limits = record(policy.limits, 'Retained runtime policy limits');
  const policyId = text(policy.policyId, 'Retained runtime policy id');
  if (
    policy.schemaVersion !== RUNTIME_POLICY_SCHEMA_VERSION ||
    !SHA256_PATTERN.test(policyId) ||
    policy.target !== 'mock-staging' ||
    descriptor.target !== 'mock-staging' ||
    descriptor.mode !== 'mock' ||
    descriptor.providerId !== 'synthetic-test' ||
    descriptor.synthetic !== true ||
    release.buildTarget !== 'mock-staging' ||
    (release.releaseStatus !== 'unreleased' && release.releaseStatus !== 'exact-release') ||
    limits.schemaVersion !== RUNTIME_POLICY_LIMITS_SCHEMA_VERSION
  ) {
    throw new Error('Retained runtime policy is not the required synthetic mock-staging policy.');
  }
  const releaseSha = text(release.releaseSha, 'Retained runtime policy release SHA');
  if (releaseSha !== 'local-unreleased' && !SOURCE_HEAD_PATTERN.test(releaseSha)) {
    throw new Error('Retained runtime policy release SHA is invalid.');
  }
  const policyBody = Object.fromEntries(
    Object.entries(policy).filter(([key]) => key !== 'policyId'),
  );
  if (sha256(runtimePolicyCanonicalJson(policyBody)) !== policyId) {
    throw new Error('Retained runtime policy id does not match its canonical policy body.');
  }
  return policy as unknown as Readonly<RuntimePolicyV1>;
}

export async function readRetainedRuntimePolicyBinding(
  candidateDirectory: string,
): Promise<Readonly<RetainedRuntimePolicyBinding>> {
  const file = await readStableFile(
    resolve(candidateDirectory, ...RUNTIME_POLICY_CANDIDATE_PATH.split('/')),
    'Retained runtime policy',
    MAX_RETAINED_RUNTIME_POLICY_BYTES,
  );
  const policy = parseRetainedRuntimePolicy(file.contents);
  return Object.freeze({
    identity: Object.freeze({
      path: RUNTIME_POLICY_CANDIDATE_PATH,
      bytes: file.bytes,
      sha256: file.sha256,
    }),
    canonicalSha256: sha256(runtimePolicyCanonicalJson(policy)),
    limits: Object.freeze({
      schemaVersion: RUNTIME_POLICY_LIMITS_SCHEMA_VERSION,
      canonicalSha256: sha256(runtimePolicyCanonicalJson(policy.limits)),
    }),
    policy,
  });
}

export function candidateRunbookIdentityInput(
  provenance: Readonly<RetainedCandidateProvenance>,
  runtimePolicy: Readonly<RetainedRuntimePolicyBinding>,
): Readonly<RunbookRehearsalIdentityInputV1> {
  const policy = runtimePolicy.policy;
  if (
    provenance.application.buildTarget !== 'mock-staging' ||
    provenance.application.providerMode !== 'mock' ||
    policy.target !== provenance.application.buildTarget ||
    policy.source.descriptor.target !== provenance.application.buildTarget ||
    policy.source.descriptor.mode !== provenance.application.providerMode ||
    policy.source.descriptor.providerId !== 'synthetic-test' ||
    policy.source.descriptor.synthetic !== true ||
    policy.release.applicationVersion !== provenance.application.applicationVersion ||
    policy.release.buildTarget !== provenance.application.buildTarget ||
    policy.release.releaseSha !== provenance.application.releaseSha
  ) {
    throw new Error('Retained runtime policy is incompatible with candidate provenance.');
  }
  if (!SOURCE_HEAD_PATTERN.test(provenance.source.head)) {
    throw new Error('Candidate source identity must contain one full Git SHA.');
  }
  if (
    policy.release.releaseSha !== 'local-unreleased' &&
    policy.release.releaseSha !== provenance.source.head
  ) {
    throw new Error('Retained release SHA does not match the candidate source identity.');
  }
  const source: SyntheticRunbookSourceIdentityV1 = {
    schemaVersion: 'synthetic-source-build-identity.v1',
    head: provenance.source.head,
    contentSha256: provenance.source.contentSha256,
  };
  const release: RuntimePolicyReleaseIdentity = {
    applicationVersion: policy.release.applicationVersion,
    // A local-unreleased artifact has no release SHA to bind. The rehearsal binds its exact
    // retained source revision instead, while acceptance records both distinct identities.
    releaseSha: provenance.source.head,
    releaseStatus: policy.release.releaseStatus,
    buildTarget: 'mock-staging',
  };
  const syntheticArtifact: SyntheticRunbookArtifactIdentityV1 = {
    schemaVersion: 'synthetic-artifact-identity.v1',
    kind: 'synthetic-source-built-artifact',
    fileCount: provenance.retainedArtifact.fileCount,
    totalBytes: provenance.retainedArtifact.totalBytes,
    sha256: provenance.retainedArtifact.sha256,
  };
  return Object.freeze({
    source: Object.freeze(source),
    release: Object.freeze(release),
    syntheticArtifact: Object.freeze(syntheticArtifact),
  });
}

export async function verifyCandidateRunbookRehearsal(
  path: string,
  input: Readonly<RunbookRehearsalIdentityInputV1>,
  options: Readonly<RunbookRehearsalEnvironmentOptions> = {},
): Promise<Readonly<VerifiedCandidateRunbookRehearsal>> {
  const fileBefore = await readStableFile(
    path,
    'Candidate runbook rehearsal receipt',
    MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES,
  );
  const bindings = await compileRunbookRehearsalBindings(input, options);
  const receipt = await readRunbookRehearsalReceipt(
    fileBefore.path,
    { bindings, finalResult: 'verified' },
    options,
  );
  if (
    receipt.summary.procedureCount !== OPERATOR_PROCEDURE_DEFINITIONS.length ||
    receipt.summary.verifiedCount !== OPERATOR_PROCEDURE_DEFINITIONS.length ||
    receipt.procedureOutcomes.some(({ result }) => result !== 'verified')
  ) {
    throw new Error('Candidate runbook rehearsal did not verify every closed procedure.');
  }
  const fileAfter = await readStableFile(
    fileBefore.path,
    'Candidate runbook rehearsal receipt',
    MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES,
  );
  if (fileBefore.bytes !== fileAfter.bytes || fileBefore.sha256 !== fileAfter.sha256) {
    throw new Error('Candidate runbook rehearsal receipt changed during verification.');
  }
  return Object.freeze({
    receipt,
    receiptIdentity: Object.freeze({ bytes: fileBefore.bytes, sha256: fileBefore.sha256 }),
  });
}

function outputIsWithinCandidate(outputPath: string, candidateDirectory: string): boolean {
  const relationship = relative(candidateDirectory, outputPath);
  return (
    relationship === '' ||
    (!relationship.startsWith(`..${sep}`) && relationship !== '..' && !isAbsolute(relationship))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function rehearseCandidateRunbooks(
  options: Readonly<RehearseCandidateRunbooksOptions>,
): Promise<Readonly<RunbookRehearsalReceiptV1>> {
  const candidateDirectory = resolve(options.candidateDirectory);
  const outputPath = resolve(options.outputPath);
  if (outputIsWithinCandidate(outputPath, candidateDirectory)) {
    throw new Error('Runbook rehearsal output cannot mutate the retained candidate.');
  }
  if (await pathExists(outputPath)) {
    throw new Error('Runbook rehearsal output already exists.');
  }
  const repositoryRoot = resolve(options.repositoryRoot ?? MODULE_REPOSITORY_ROOT);
  const selectionRecordPath = resolve(
    options.selectionRecordPath ?? candidateSelectionRecordPath(candidateDirectory),
  );
  const verificationOptions: VerifyCandidateOptions = {
    candidateDirectory,
    selectionRecordPath,
    expectedTarget: 'mock-staging',
    ...(options.expectedSelectionRecordSha256 === undefined
      ? {}
      : { expectedSelectionRecordSha256: options.expectedSelectionRecordSha256 }),
    ...(options.expectedCandidateId === undefined
      ? {}
      : { expectedCandidateId: options.expectedCandidateId }),
    ...(options.expectedSourceIdentity === undefined
      ? {}
      : { expectedSourceIdentity: options.expectedSourceIdentity }),
    ...(options.expectedSourceHead === undefined
      ? {}
      : { expectedSourceHead: options.expectedSourceHead }),
  };
  const environment = {
    repositoryRoot,
    ...(options.procedureDirectory === undefined
      ? {}
      : { procedureDirectory: options.procedureDirectory }),
  } as const;
  let rehearsalStarted = false;
  try {
    const firstProvenance = await verifyRetainedCandidate(verificationOptions);
    const firstRuntimePolicy = await readRetainedRuntimePolicyBinding(candidateDirectory);
    const identityInput = candidateRunbookIdentityInput(firstProvenance, firstRuntimePolicy);
    const request = {
      schemaVersion: RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION,
      evidenceClass: RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
      checkedAt: options.checkedAt ?? new Date().toISOString(),
      ...identityInput,
      outcomes: OPERATOR_PROCEDURE_DEFINITIONS.map(({ procedureId }) => ({
        procedureId,
        result: 'verified' as const,
      })),
    } as const;
    rehearsalStarted = true;
    await runSyntheticRunbookRehearsal({ request, outputPath, ...environment });
    const verified = await verifyCandidateRunbookRehearsal(outputPath, identityInput, environment);
    const finalProvenance = await verifyRetainedCandidate(verificationOptions);
    if (JSON.stringify(finalProvenance) !== JSON.stringify(firstProvenance)) {
      throw new Error('Candidate identity changed during synthetic runbook rehearsal.');
    }
    const finalRuntimePolicy = await readRetainedRuntimePolicyBinding(candidateDirectory);
    if (JSON.stringify(finalRuntimePolicy) !== JSON.stringify(firstRuntimePolicy)) {
      throw new Error('Retained runtime policy changed during synthetic runbook rehearsal.');
    }
    return verified.receipt;
  } catch (error) {
    const rehearsalError = error as { code?: unknown; message?: unknown };
    const outputConflict =
      rehearsalError.code === 'INVALID_OUTPUT' &&
      typeof rehearsalError.message === 'string' &&
      /already exists/u.test(rehearsalError.message);
    if (rehearsalStarted && !outputConflict) await rm(outputPath, { force: true });
    throw error;
  }
}

function cliArguments(arguments_: readonly string[]): RehearseCandidateRunbooksOptions {
  const candidateDirectory = arguments_[0];
  if (candidateDirectory === undefined || candidateDirectory.startsWith('--')) {
    throw new Error(
      'Usage: tsx tools/live/rehearseCandidateRunbooks.ts <candidate-directory> --output <new-receipt.json> (--expected-selection-sha256 <sha256> | --expected-candidate-id <id>) [--selection-record <file>] [--expected-source-head <sha>] [--checked-at <ISO-8601>]',
    );
  }
  const parsed: Record<string, string> = {};
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw new Error(`Missing value for ${flag ?? 'CLI argument'}.`);
    }
    if (
      ![
        '--output',
        '--selection-record',
        '--expected-selection-sha256',
        '--expected-candidate-id',
        '--expected-source-head',
        '--checked-at',
      ].includes(flag) ||
      flag in parsed
    ) {
      throw new Error(`Unknown or duplicate argument: ${flag}.`);
    }
    parsed[flag] = value;
  }
  if (parsed['--output'] === undefined) {
    throw new Error('Runbook rehearsal receipt output is required.');
  }
  if (
    parsed['--expected-selection-sha256'] === undefined &&
    parsed['--expected-candidate-id'] === undefined
  ) {
    throw new Error('An expected selection SHA-256 or candidate id is required.');
  }
  return {
    candidateDirectory,
    outputPath: parsed['--output'],
    ...(parsed['--selection-record'] === undefined
      ? {}
      : { selectionRecordPath: parsed['--selection-record'] }),
    ...(parsed['--expected-selection-sha256'] === undefined
      ? {}
      : { expectedSelectionRecordSha256: parsed['--expected-selection-sha256'] }),
    ...(parsed['--expected-candidate-id'] === undefined
      ? {}
      : { expectedCandidateId: parsed['--expected-candidate-id'] }),
    ...(parsed['--expected-source-head'] === undefined
      ? {}
      : { expectedSourceHead: parsed['--expected-source-head'] }),
    ...(parsed['--checked-at'] === undefined ? {} : { checkedAt: parsed['--checked-at'] }),
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  rehearseCandidateRunbooks(cliArguments(process.argv.slice(2))).then(
    (receipt) => {
      console.log(
        `Recorded ${receipt.summary.finalResult} synthetic rehearsal for ${receipt.summary.procedureCount} retained-candidate runbooks. No network, provider, cloud, deployment, runtime, or production action was performed.`,
      );
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
