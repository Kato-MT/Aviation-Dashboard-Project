import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  verifyRetainedCandidate,
  type RetainedCandidateProvenance,
  type SourceIdentity,
  type VerifyCandidateOptions,
} from './retainCandidate';

const ARTIFACT_IDENTITY_SCHEMA_VERSION = 'sha256-file-inventory.v1' as const;
const LOAD_OUTPUT_ROOT = ['test-results', 'live-load'] as const;
const SAFE_OUTPUT_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/iu;

export type LoadArtifactRequest =
  { mode: 'artifact-root'; path: string } | { mode: 'retained-candidate'; path: string };

export interface ArtifactTreeIdentity {
  schemaVersion: typeof ARTIFACT_IDENTITY_SCHEMA_VERSION;
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

export interface CandidateLoadIdentity {
  candidateId: string;
  sourceHead: string;
  sourceContentSha256: string;
  releaseSha: string;
  retainedArtifactSha256: string;
}

export interface ResolvedLoadArtifactInput {
  mode: LoadArtifactRequest['mode'];
  requestedPath: string;
  artifactPath: string;
  artifactRoot: string;
  workerRoot: string;
  workerConfigPath: string;
  clientRoot: string;
  protectedRoots: readonly string[];
  identityBefore: ArtifactTreeIdentity;
  candidateBefore: CandidateLoadIdentity | null;
  candidateRoot: string | null;
  candidateSelection: CandidateSelectionExpectation | null;
}

export interface CandidateSelectionExpectation {
  selectionRecordPath?: string;
  expectedSelectionRecordSha256?: string;
  expectedCandidateId?: string;
}

export interface LoadArtifactRuntimePaths {
  artifactRoot: string;
  workerRoot: string;
  workerConfigPath: string;
  clientRoot: string;
}

export interface StagedLoadArtifactInput extends LoadArtifactRuntimePaths {
  stagingRoot: string;
  identityBefore: ArtifactTreeIdentity;
}

export interface CompletedStagedLoadArtifactInput {
  identityAfter: ArtifactTreeIdentity;
  unchanged: boolean;
  gate: {
    id: 'immutable-execution-snapshot';
    passed: boolean;
    detail: string;
  };
}

export interface ResolvedLoadHarnessOutput {
  absolutePath: string;
  reportPath: string;
}

export interface CompletedLoadArtifactInput {
  identityAfter: ArtifactTreeIdentity;
  candidateAfter: CandidateLoadIdentity | null;
  unchanged: boolean;
  gate: {
    id: 'immutable-artifact-input';
    passed: boolean;
    detail: string;
  };
}

interface FileSnapshot {
  path: string;
  absolutePath: string;
  bytes: number;
  modifiedMs: number;
  changedMs: number;
  device: number;
  inode: number;
}

export interface LoadArtifactDependencies {
  verifyCandidate?: typeof verifyRetainedCandidate;
  selectionExpectation?: CandidateSelectionExpectation;
}

function candidateVerificationOptions(
  candidateDirectory: string,
  source: SourceIdentity,
  selection: CandidateSelectionExpectation | undefined,
): VerifyCandidateOptions {
  if (
    selection?.expectedSelectionRecordSha256 === undefined &&
    selection?.expectedCandidateId === undefined
  ) {
    throw new Error(
      'Candidate-bound load execution requires an externally supplied selection-record SHA-256 or candidate id.',
    );
  }
  return {
    candidateDirectory,
    expectedSourceHead: source.head,
    expectedSourceIdentity: source,
    expectedTarget: 'mock-staging',
    ...(selection.selectionRecordPath === undefined
      ? {}
      : { selectionRecordPath: selection.selectionRecordPath }),
    ...(selection.expectedSelectionRecordSha256 === undefined
      ? {}
      : { expectedSelectionRecordSha256: selection.expectedSelectionRecordSha256 }),
    ...(selection.expectedCandidateId === undefined
      ? {}
      : { expectedCandidateId: selection.expectedCandidateId }),
  };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsPath(root: string, target: string): boolean {
  const back = relative(root, target);
  return back === '' || (!back.startsWith(`..${sep}`) && back !== '..' && !isAbsolute(back));
}

function normalizedRequestPath(value: string, label: string): string {
  const path = value.trim();
  if (path.length === 0 || path.includes('\0')) throw new Error(`${label} must not be empty.`);
  return path;
}

function repositoryRelativePath(repositoryRoot: string, target: string, label: string): string {
  const path = relative(repositoryRoot, target);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} must be a directory beneath the repository root.`);
  }
  return path.replaceAll('\\', '/');
}

async function requiredDirectory(path: string, label: string): Promise<void> {
  const status = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
}

async function requiredNonemptyFile(path: string, label: string): Promise<void> {
  const status = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  });
  if (!status.isFile() || status.isSymbolicLink() || status.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`);
  }
}

async function rejectSymlinkedComponents(repositoryRoot: string, target: string): Promise<void> {
  const requested = relative(repositoryRoot, target);
  let current = repositoryRoot;
  for (const part of requested.split(sep)) {
    current = join(current, part);
    const status = await lstat(current);
    if (status.isSymbolicLink()) {
      throw new Error(
        `Load-artifact paths cannot traverse a symbolic link or junction: ${current}`,
      );
    }
  }
}

async function resolveContainedDirectory(
  repositoryRoot: string,
  requestedPath: string,
  label: string,
): Promise<{ absolutePath: string; reportPath: string }> {
  const canonicalRepository = await realpath(resolve(repositoryRoot));
  const requested = resolve(canonicalRepository, normalizedRequestPath(requestedPath, label));
  if (!containsPath(canonicalRepository, requested) || requested === canonicalRepository) {
    throw new Error(`${label} must be a directory beneath the repository root.`);
  }
  await rejectSymlinkedComponents(canonicalRepository, requested);
  await requiredDirectory(requested, label);
  const canonicalRequested = await realpath(requested);
  if (!containsPath(canonicalRepository, canonicalRequested)) {
    throw new Error(`${label} resolves outside the repository root.`);
  }
  return {
    absolutePath: canonicalRequested,
    reportPath: repositoryRelativePath(canonicalRepository, canonicalRequested, label),
  };
}

async function snapshotFiles(root: string): Promise<FileSnapshot[]> {
  await requiredDirectory(root, 'Load artifact root');
  const files: FileSnapshot[] = [];

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink()) {
        throw new Error(
          `Load artifacts cannot contain symbolic links or junctions: ${relativePath}`,
        );
      }
      if (status.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!status.isFile()) {
        throw new Error(`Load artifacts may contain only regular files: ${relativePath}`);
      }
      if (status.size === 0) throw new Error(`Load artifact file is empty: ${relativePath}`);
      files.push({
        path: relativePath.replaceAll('\\', '/'),
        absolutePath,
        bytes: status.size,
        modifiedMs: status.mtimeMs,
        changedMs: status.ctimeMs,
        device: status.dev,
        inode: status.ino,
      });
    }
  }

  await visit(root, '');
  if (files.length === 0) throw new Error('Load artifact root contains no files.');
  return files.sort((left, right) => compareNames(left.path, right.path));
}

function sameFileSnapshots(left: readonly FileSnapshot[], right: readonly FileSnapshot[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.path === other.path &&
        entry.bytes === other.bytes &&
        entry.modifiedMs === other.modifiedMs &&
        entry.changedMs === other.changedMs &&
        entry.device === other.device &&
        entry.inode === other.inode
      );
    })
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function captureArtifactTreeIdentity(root: string): Promise<ArtifactTreeIdentity> {
  const before = await snapshotFiles(root);
  const files = [] as Array<{ path: string; bytes: number; sha256: string }>;
  for (const file of before) {
    files.push({ path: file.path, bytes: file.bytes, sha256: await sha256File(file.absolutePath) });
  }
  const after = await snapshotFiles(root);
  if (!sameFileSnapshots(before, after)) {
    throw new Error('Load artifact tree changed while its identity was captured.');
  }

  const hash = createHash('sha256');
  hash.update(`${ARTIFACT_IDENTITY_SCHEMA_VERSION}\0`);
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return {
    schemaVersion: ARTIFACT_IDENTITY_SCHEMA_VERSION,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: hash.digest('hex'),
  };
}

export function sameArtifactTreeIdentity(
  left: ArtifactTreeIdentity,
  right: ArtifactTreeIdentity,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.sha256 === right.sha256
  );
}

export async function stageLoadArtifactInput(
  input: ResolvedLoadArtifactInput,
): Promise<StagedLoadArtifactInput> {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'airspace-load-artifact-'));
  const artifactRoot = join(stagingRoot, 'artifact');
  try {
    await cp(input.artifactRoot, artifactRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await assertArtifactTopology(artifactRoot);
    const identityBefore = await captureArtifactTreeIdentity(artifactRoot);
    if (!sameArtifactTreeIdentity(input.identityBefore, identityBefore)) {
      throw new Error('Private execution snapshot does not match the accepted artifact identity.');
    }
    const workerRoot = join(artifactRoot, 'airspace_worker');
    return {
      stagingRoot,
      artifactRoot,
      workerRoot,
      workerConfigPath: join(workerRoot, 'wrangler.json'),
      clientRoot: join(artifactRoot, 'client'),
      identityBefore,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function completeStagedLoadArtifactInput(
  staged: StagedLoadArtifactInput,
): Promise<CompletedStagedLoadArtifactInput> {
  const identityAfter = await captureArtifactTreeIdentity(staged.artifactRoot);
  const unchanged = sameArtifactTreeIdentity(staged.identityBefore, identityAfter);
  return {
    identityAfter,
    unchanged,
    gate: {
      id: 'immutable-execution-snapshot',
      passed: unchanged,
      detail:
        'The harness-owned execution snapshot matched the accepted artifact identity and remained unchanged during measurement.',
    },
  };
}

export async function disposeStagedLoadArtifactInput(
  staged: StagedLoadArtifactInput,
): Promise<void> {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const canonicalStagingRoot = await realpath(staged.stagingRoot);
  if (
    !containsPath(canonicalTemporaryRoot, canonicalStagingRoot) ||
    basename(canonicalStagingRoot).startsWith('airspace-load-artifact-') === false
  ) {
    throw new Error('Refusing to remove an unrecognized load-artifact staging directory.');
  }
  await rm(canonicalStagingRoot, { recursive: true, force: true });
}

function candidateIdentity(
  provenance: RetainedCandidateProvenance,
  currentSource: SourceIdentity,
): CandidateLoadIdentity {
  if (provenance.source.head !== currentSource.head) {
    throw new Error(
      'Retained candidate source HEAD does not exactly match the load harness checkout.',
    );
  }
  if (provenance.source.dirty || currentSource.dirty) {
    throw new Error('Candidate-bound load evidence requires a clean committed source identity.');
  }
  if (provenance.source.contentSha256 !== currentSource.contentSha256) {
    throw new Error(
      'Retained candidate source content does not exactly match the load harness checkout.',
    );
  }
  if (provenance.application.releaseSha !== currentSource.head) {
    throw new Error('Retained candidate release SHA is not the exact committed source HEAD.');
  }
  return {
    candidateId: provenance.candidateId,
    sourceHead: provenance.source.head,
    sourceContentSha256: provenance.source.contentSha256,
    releaseSha: provenance.application.releaseSha,
    retainedArtifactSha256: provenance.retainedArtifact.sha256,
  };
}

function sameCandidateIdentity(
  left: CandidateLoadIdentity | null,
  right: CandidateLoadIdentity | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertArtifactTopology(artifactRoot: string): Promise<void> {
  await requiredNonemptyFile(
    join(artifactRoot, 'airspace_worker', 'wrangler.json'),
    'Generated Worker configuration',
  );
  await requiredNonemptyFile(
    join(artifactRoot, 'airspace_worker', 'index.js'),
    'Generated Worker bundle',
  );
  await requiredNonemptyFile(join(artifactRoot, 'client', 'index.html'), 'Generated client root');
  await requiredNonemptyFile(
    join(artifactRoot, 'mock_provider', 'wrangler.json'),
    'Generated mock-provider configuration',
  );
  await requiredNonemptyFile(
    join(artifactRoot, 'mock_provider', 'index.js'),
    'Generated mock-provider bundle',
  );
}

async function isRetainedArtifactBypass(artifactRoot: string): Promise<boolean> {
  if (relative(join(artifactRoot, '..'), artifactRoot).replaceAll('\\', '/') !== 'artifact') {
    return false;
  }
  const candidateRoot = resolve(artifactRoot, '..');
  try {
    await requiredNonemptyFile(join(candidateRoot, 'checksums.sha256'), 'Candidate checksums');
    await requiredNonemptyFile(
      join(candidateRoot, 'evidence', 'provenance.json'),
      'Candidate provenance',
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (error instanceof Error && error.message.includes(' is missing:')) return false;
    throw error;
  }
}

export async function resolveLoadArtifactInput(
  request: LoadArtifactRequest,
  repositoryRoot: string,
  currentSource: SourceIdentity,
  dependencies: LoadArtifactDependencies = {},
): Promise<ResolvedLoadArtifactInput> {
  const verifier = dependencies.verifyCandidate ?? verifyRetainedCandidate;
  const selected = await resolveContainedDirectory(
    repositoryRoot,
    request.path,
    request.mode === 'artifact-root' ? 'Artifact root' : 'Candidate directory',
  );
  let artifactRoot = selected.absolutePath;
  let artifactPath = selected.reportPath;
  let candidateRoot: string | null = null;
  let candidateBefore: CandidateLoadIdentity | null = null;
  let candidateSelection: CandidateSelectionExpectation | null = null;

  if (request.mode === 'retained-candidate') {
    candidateRoot = selected.absolutePath;
    candidateSelection =
      dependencies.selectionExpectation === undefined
        ? null
        : { ...dependencies.selectionExpectation };
    const provenance = await verifier(
      candidateVerificationOptions(candidateRoot, currentSource, candidateSelection ?? undefined),
    );
    candidateBefore = candidateIdentity(provenance, currentSource);
    artifactRoot = join(candidateRoot, provenance.retainedArtifact.path);
    await requiredDirectory(artifactRoot, 'Retained candidate artifact root');
    artifactPath = repositoryRelativePath(resolve(repositoryRoot), artifactRoot, 'Artifact root');
  } else if (await isRetainedArtifactBypass(artifactRoot)) {
    throw new Error(
      'A retained candidate artifact must be selected by candidate directory so provenance and checksums are verified.',
    );
  }

  await assertArtifactTopology(artifactRoot);
  const identityBefore = await captureArtifactTreeIdentity(artifactRoot);
  if (
    candidateBefore !== null &&
    identityBefore.sha256 !== candidateBefore.retainedArtifactSha256
  ) {
    throw new Error('Retained candidate artifact identity does not match verified provenance.');
  }

  const workerRoot = join(artifactRoot, 'airspace_worker');
  return {
    mode: request.mode,
    requestedPath: selected.reportPath,
    artifactPath,
    artifactRoot,
    workerRoot,
    workerConfigPath: join(workerRoot, 'wrangler.json'),
    clientRoot: join(artifactRoot, 'client'),
    protectedRoots: candidateRoot === null ? [artifactRoot] : [candidateRoot],
    identityBefore,
    candidateBefore,
    candidateRoot,
    candidateSelection,
  };
}

export async function completeLoadArtifactInput(
  input: ResolvedLoadArtifactInput,
  sourceBefore: SourceIdentity,
  dependencies: LoadArtifactDependencies = {},
): Promise<CompletedLoadArtifactInput> {
  const verifier = dependencies.verifyCandidate ?? verifyRetainedCandidate;
  let candidateAfter: CandidateLoadIdentity | null = null;
  if (input.candidateRoot !== null) {
    const provenance = await verifier(
      candidateVerificationOptions(
        input.candidateRoot,
        sourceBefore,
        input.candidateSelection ?? undefined,
      ),
    );
    candidateAfter = candidateIdentity(provenance, sourceBefore);
  }
  const identityAfter = await captureArtifactTreeIdentity(input.artifactRoot);
  const unchanged =
    sameArtifactTreeIdentity(input.identityBefore, identityAfter) &&
    sameCandidateIdentity(input.candidateBefore, candidateAfter);
  return {
    identityAfter,
    candidateAfter,
    unchanged,
    gate: {
      id: 'immutable-artifact-input',
      passed: unchanged,
      detail:
        input.mode === 'retained-candidate'
          ? 'The verified clean-source candidate, checksum allowlist, provenance, and complete retained artifact identity remained unchanged.'
          : 'The complete explicit mock-staging artifact tree identity remained unchanged.',
    },
  };
}

async function canonicalOutputTarget(
  canonicalRepository: string,
  absolutePath: string,
): Promise<string> {
  let existing = absolutePath;
  const missingSuffix: string[] = [];
  while (true) {
    const status = await lstat(existing).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (status !== null) {
      if (status.isSymbolicLink()) {
        throw new Error('Output path cannot traverse a symbolic link or junction.');
      }
      if (existing === absolutePath && status.isDirectory()) {
        throw new Error('Output path must identify a file, not a directory.');
      }
      if (existing !== absolutePath && !status.isDirectory()) {
        throw new Error('Output path parent must be a real directory.');
      }
      break;
    }
    missingSuffix.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing || !containsPath(canonicalRepository, parent)) {
      throw new Error('Output path must remain beneath the repository root.');
    }
    existing = parent;
  }
  await rejectSymlinkedComponents(canonicalRepository, existing);
  const canonicalExisting = await realpath(existing);
  if (!containsPath(canonicalRepository, canonicalExisting)) {
    throw new Error('Output path resolves outside the repository root.');
  }
  return resolve(canonicalExisting, ...missingSuffix);
}

async function isTrackedRepositoryPath(
  canonicalRepository: string,
  reportPath: string,
): Promise<boolean> {
  const gitMetadata = await lstat(join(canonicalRepository, '.git')).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (gitMetadata === null) return false;
  return new Promise((accept, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '-z', '--', reportPath],
      { cwd: canonicalRepository, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
          reject(
            new Error(
              `Unable to verify that the load-report path is untracked: ${detail || error.message}`,
              {
                cause: error,
              },
            ),
          );
          return;
        }
        accept(stdout.byteLength > 0);
      },
    );
  });
}

export async function resolveLoadHarnessOutputPath(
  outputPath: string,
  repositoryRoot: string,
  protectedRoots: readonly string[],
): Promise<ResolvedLoadHarnessOutput> {
  const requested = normalizedRequestPath(outputPath, 'Output path');
  if (isAbsolute(requested)) throw new Error('Output path must be repository-relative.');
  const parts = requested.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        !SAFE_OUTPUT_SEGMENT.test(part) ||
        part.endsWith('.') ||
        part.endsWith(' '),
    )
  ) {
    throw new Error('Output path must be a normalized repository-relative file path.');
  }
  if (
    parts.length <= LOAD_OUTPUT_ROOT.length ||
    LOAD_OUTPUT_ROOT.some((part, index) => parts[index]?.toLowerCase() !== part)
  ) {
    throw new Error('Output path must be beneath test-results/live-load.');
  }
  const canonicalRepository = await realpath(resolve(repositoryRoot));
  const absolutePath = resolve(canonicalRepository, ...parts);
  if (!containsPath(canonicalRepository, absolutePath) || absolutePath === canonicalRepository) {
    throw new Error('Output path must remain beneath the repository root.');
  }
  const canonicalTarget = await canonicalOutputTarget(canonicalRepository, absolutePath);
  const canonicalProtectedRoots = await Promise.all(
    protectedRoots.map(async (root) => realpath(root)),
  );
  if (canonicalProtectedRoots.some((root) => containsPath(root, canonicalTarget))) {
    throw new Error('Output path must not modify the selected artifact or retained candidate.');
  }
  const canonicalReportPath = repositoryRelativePath(
    canonicalRepository,
    canonicalTarget,
    'Output path',
  );
  if (await isTrackedRepositoryPath(canonicalRepository, canonicalReportPath)) {
    throw new Error('Output path must not overwrite a tracked repository file.');
  }
  return { absolutePath: canonicalTarget, reportPath: canonicalReportPath };
}

export async function revalidateLoadHarnessOutputPath(
  output: ResolvedLoadHarnessOutput,
  repositoryRoot: string,
  protectedRoots: readonly string[],
): Promise<void> {
  const current = await resolveLoadHarnessOutputPath(
    output.reportPath,
    repositoryRoot,
    protectedRoots,
  );
  if (relative(current.absolutePath, output.absolutePath) !== '') {
    throw new Error('Output path identity changed after validation.');
  }
}
