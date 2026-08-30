import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_REPLAY_SCENARIOS, loadBundledReplayScenario } from '../../src/replay';
import {
  loadApprovedRollback,
  verifyApprovedRollbackRuntime,
  writeApprovedRollback,
  type ApprovedRollbackProvenance,
} from './approvedRollback';
import { assertEvidenceOutputPlacement, containsCanonicalPath } from './evidenceOutputPolicy';
import { auditPrivacyTree } from './operationsPrivacyAudit';
import { assertLiveArtifactPolicy, assertPrivacySafeTextArtifact } from './runtimePolicyArtifact';

const PROVENANCE_SCHEMA_VERSION = 'airspace-retained-candidate.v1';
const SOURCE_IDENTITY_SCHEMA_VERSION = 'git-working-tree-content.v2';
const FILE_INVENTORY_SCHEMA_VERSION = 'sha256-file-inventory.v1';
const TRACKED_WORKTREE_SCHEMA_VERSION = 'git-index-worktree-inventory.v2';
const SELECTION_SCHEMA_VERSION = 'airspace-candidate-selection.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SOURCE_MAP_REFERENCE =
  /(?:\r?\n)?\/\/[#@]\s*sourceMappingURL=[^\r\n]*(?:\r?\n|$)|\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//giu;
const TEXT_ARTIFACT_PATTERN = /\.(?:css|html|js|mjs)$/iu;

export interface GitRunner {
  (arguments_: readonly string[], repositoryRoot: string): Promise<Buffer>;
}

export interface TrackedFileModeResolver {
  (absolutePath: string, observedMode: number): number;
}

const useObservedTrackedFileMode: TrackedFileModeResolver = (_path, observedMode) => observedMode;

export interface RetainCandidateOptions {
  outputDirectory: string;
  selectionRecordPath?: string;
  repositoryRoot?: string;
  gitRunner?: GitRunner;
  selectionObserver?: (selection: RetainedCandidateSelection) => void;
}

export interface RetainedCandidateSelection {
  candidateId: string;
  selectionRecordPath: string;
  selectionRecordSha256: string;
}

export interface VerifyCandidateOptions {
  candidateDirectory: string;
  selectionRecordPath?: string;
  expectedSelectionRecordSha256?: string;
  expectedCandidateId?: string;
  expectedSourceIdentity?: SourceIdentity;
  expectedSourceHead?: string;
  expectedTarget?: 'mock-staging';
}

export interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

interface DirectoryIdentity {
  fileCount: number;
  totalBytes: number;
  sha256: string;
  files: FileIdentity[];
}

export interface CandidateTreeIdentity {
  schemaVersion: typeof FILE_INVENTORY_SCHEMA_VERSION;
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

export interface CandidateSelectionRecord {
  schemaVersion: typeof SELECTION_SCHEMA_VERSION;
  candidateId: string;
  candidateCommitmentSha256: string;
  candidate: CandidateTreeIdentity;
  source: {
    head: string;
    contentSha256: string;
  };
  provenance: FileIdentity;
  checksums: FileIdentity;
  retainedArtifact: CandidateTreeIdentity;
}

export interface SourceIdentity {
  schemaVersion: typeof SOURCE_IDENTITY_SCHEMA_VERSION;
  head: string;
  dirty: boolean;
  gitStatus: {
    format: 'porcelain-v1-z';
    bytes: number;
    sha256: string;
  };
  trackedPatch: {
    format: 'git-diff-binary-full-index';
    bytes: number;
    sha256: string;
  };
  trackedContent: {
    format: typeof TRACKED_WORKTREE_SCHEMA_VERSION;
    objectFormat: 'sha1' | 'sha256';
    fileModeEnforced: boolean;
    fileCount: number;
    missingFileCount: number;
    totalBytes: number;
    executableModeMismatchCount: number;
    indexMismatchCount: number;
    sha256: string;
  };
  untrackedContent: {
    fileCount: number;
    totalBytes: number;
    sha256: string;
  };
  contentSha256: string;
}

interface BuildIdentity {
  applicationName: string;
  packageVersion: string;
  applicationVersion: string;
  releaseSha: string;
  buildTarget: 'mock-staging';
  providerMode: 'mock';
  workerName: 'flight-airspace-mock-staging';
  mockProviderName: 'flight-airspace-mock-provider';
  clientRootEntrypoint: 'client/index.html';
  clientDevelopmentEntrypoint: 'client/live.html';
  workerEntrypoint: string;
  mockProviderEntrypoint: string;
}

export interface RetainedCandidateProvenance {
  schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  candidateId: string;
  deterministic: true;
  buildPerformed: false;
  deploymentPerformed: false;
  source: SourceIdentity;
  application: BuildIdentity;
  sourceArtifact: {
    path: 'dist-mock-staging';
    fileCount: number;
    totalBytes: number;
    sha256: string;
    omittedSourceMaps: FileIdentity[];
    normalizedSourceMapReferences: Array<{
      path: string;
      sourceSha256: string;
      retainedSha256: string;
    }>;
  };
  retainedArtifact: {
    path: 'artifact';
    fileCount: number;
    totalBytes: number;
    sha256: string;
  };
  mapManifest: {
    sourcePath: 'maps/manifest.json';
    candidatePath: 'evidence/map-manifest.json';
    schemaVersion: string;
    id: string;
    assetCount: number;
    totalBytes: number;
    sha256: string;
    basemapSha256: string;
    payload: {
      sourcePath: string;
      candidatePath: string;
      fileCount: number;
      totalBytes: number;
      sha256: string;
    };
  };
  replayScenarios: Array<{
    schemaVersion: string;
    scenarioId: string;
    seed: number;
    generatorId: string;
    generatorVersion: string;
    canonicalSha256: string;
  }>;
  rollback: ApprovedRollbackProvenance;
  sbom: {
    sourcePath: 'dist/sbom.cdx.json';
    candidatePath: 'evidence/sbom.cdx.json';
    format: 'CycloneDX';
    specVersion: string;
    documentVersion: number;
    bytes: number;
    sha256: string;
  };
  checksums: {
    path: 'checksums.sha256';
    algorithm: 'SHA-256';
    format: 'sha256sum';
    excludedPaths: ['checksums.sha256'];
  };
}

interface MapManifestIdentity {
  schemaVersion: string;
  id: string;
  assetCount: number;
  totalBytes: number;
  sha256: string;
  basemapSha256: string;
  assets: FileIdentity[];
  contents: Buffer;
}

interface SbomIdentity {
  specVersion: string;
  documentVersion: number;
  bytes: number;
  sha256: string;
  contents: Buffer;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareNames(left, right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareNames);
  const expected = [...allowed].sort(compareNames);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set.`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256.`);
  return digest;
}

function parseJson(contents: Buffer, label: string): unknown {
  try {
    return JSON.parse(contents.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function normalizeRelativePath(path: string, label: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} contains an unsafe relative path: ${path}`);
  }
  return normalized;
}

function within(root: string, path: string): string {
  const normalized = normalizeRelativePath(path, 'File identity');
  const target = resolve(root, ...normalized.split('/'));
  const back = relative(root, target);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`File path escapes its root: ${path}`);
  }
  return target;
}

function containsPath(root: string, path: string): boolean {
  const back = relative(root, path);
  return back === '' || (back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inventoryDirectory(root: string): Promise<DirectoryIdentity> {
  const rootStatus = await lstat(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Required directory is missing: ${root}`);
    }
    throw error;
  });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error(`Required directory is not a real directory: ${root}`);
  }

  const files: FileIdentity[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareNames(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        throw new Error(`Candidate inputs cannot contain symbolic links: ${relativePath}`);
      }
      if (status.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!status.isFile()) {
        throw new Error(`Candidate inputs must contain only regular files: ${relativePath}`);
      }
      const contents = await readFile(path);
      if (contents.byteLength === 0) {
        throw new Error(`Candidate input is empty: ${relativePath}`);
      }
      files.push({
        path: normalizeRelativePath(relativePath, 'Artifact'),
        bytes: contents.byteLength,
        sha256: sha256(contents),
      });
    }
  }
  await visit(root, '');
  if (files.length === 0) throw new Error(`Required directory contains no files: ${root}`);
  files.sort((left, right) => compareNames(left.path, right.path));
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: inventorySha256(files),
    files,
  };
}

function inventorySha256(files: readonly FileIdentity[]): string {
  const hash = createHash('sha256');
  hash.update(`${FILE_INVENTORY_SCHEMA_VERSION}\0`);
  for (const file of [...files].sort((left, right) => compareNames(left.path, right.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.sha256 === right.sha256
  );
}

function candidateTreeIdentity(identity: DirectoryIdentity): CandidateTreeIdentity {
  return {
    schemaVersion: FILE_INVENTORY_SCHEMA_VERSION,
    fileCount: identity.fileCount,
    totalBytes: identity.totalBytes,
    sha256: identity.sha256,
  };
}

export async function captureCandidateTreeIdentity(
  candidateDirectory: string,
): Promise<CandidateTreeIdentity> {
  return candidateTreeIdentity(await inventoryDirectory(resolve(candidateDirectory)));
}

export function sameCandidateTreeIdentity(
  left: CandidateTreeIdentity,
  right: CandidateTreeIdentity,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.sha256 === right.sha256
  );
}

export function candidateSelectionRecordPath(candidateDirectory: string): string {
  return `${resolve(candidateDirectory)}.selection.json`;
}

function resolvedSelectionRecordPath(
  candidateDirectory: string,
  configuredPath: string | undefined,
): string {
  const selectionPath = resolve(configuredPath ?? candidateSelectionRecordPath(candidateDirectory));
  if (containsPath(resolve(candidateDirectory), selectionPath)) {
    throw new Error('Candidate selection record must remain outside the immutable candidate.');
  }
  return selectionPath;
}

function scopedDirectoryIdentity(
  candidate: DirectoryIdentity,
  prefix: string,
  label: string,
): DirectoryIdentity {
  const normalizedPrefix = `${normalizeRelativePath(prefix, label).replace(/\/+$/u, '')}/`;
  const files = candidate.files
    .filter((file) => file.path.startsWith(normalizedPrefix))
    .map((file) => ({ ...file, path: file.path.slice(normalizedPrefix.length) }));
  if (files.length === 0) throw new Error(`${label} contains no retained files.`);
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: inventorySha256(files),
    files,
  };
}

function runGit(arguments_: readonly string[], repositoryRoot: string): Promise<Buffer> {
  return new Promise((accept, reject) => {
    execFile(
      'git',
      [...arguments_],
      { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
          reject(
            new Error(`Git command failed (${arguments_.join(' ')}): ${detail || error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        accept(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function nulPaths(contents: Buffer, label: string): string[] {
  if (contents.byteLength === 0) return [];
  if (contents.at(-1) !== 0) throw new Error(`${label} did not use the required NUL termination.`);
  return contents
    .subarray(0, -1)
    .toString('utf8')
    .split('\0')
    .map((path) => normalizeRelativePath(path, label))
    .sort(compareNames);
}

interface TrackedIndexEntry {
  path: string;
  mode: string;
  objectId: string;
}

function trackedIndexEntries(contents: Buffer): TrackedIndexEntry[] {
  if (contents.byteLength === 0) return [];
  if (contents.at(-1) !== 0) {
    throw new Error('Git tracked-file index did not use the required NUL termination.');
  }
  const entries = contents
    .subarray(0, -1)
    .toString('utf8')
    .split('\0')
    .map((entry) => {
      const separator = entry.indexOf('\t');
      if (separator <= 0) throw new Error('Git returned an invalid tracked-file index entry.');
      const [mode, objectId, stage, ...extra] = entry.slice(0, separator).split(' ');
      if (
        mode === undefined ||
        objectId === undefined ||
        stage !== '0' ||
        extra.length > 0 ||
        !/^[0-7]{6}$/u.test(mode) ||
        !GIT_OBJECT_PATTERN.test(objectId)
      ) {
        throw new Error('Git returned an invalid or unmerged tracked-file index entry.');
      }
      return {
        path: normalizeRelativePath(entry.slice(separator + 1), 'Git tracked-file index'),
        mode,
        objectId,
      };
    })
    .sort((left, right) => compareNames(left.path, right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('Git returned duplicate tracked-file index paths.');
  }
  return entries;
}

async function trackedWorktreeIdentity(
  repositoryRoot: string,
  gitRunner: GitRunner,
  modeResolver: TrackedFileModeResolver,
): Promise<SourceIdentity['trackedContent']> {
  const objectFormat = (await gitRunner(['rev-parse', '--show-object-format'], repositoryRoot))
    .toString('utf8')
    .trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(`Unsupported Git object format: ${objectFormat}`);
  }
  const fileModeConfiguration = (
    await gitRunner(['config', '--type=bool', '--default=true', 'core.fileMode'], repositoryRoot)
  )
    .toString('utf8')
    .trim();
  if (fileModeConfiguration !== 'true' && fileModeConfiguration !== 'false') {
    throw new Error(`Git returned an invalid core.fileMode value: ${fileModeConfiguration}`);
  }
  const fileModeEnforced = fileModeConfiguration === 'true';
  const entries = trackedIndexEntries(
    await gitRunner(['ls-files', '--stage', '-z'], repositoryRoot),
  );
  const identityHash = createHash('sha256');
  identityHash.update(
    `${TRACKED_WORKTREE_SCHEMA_VERSION}\0${objectFormat}\0${fileModeEnforced ? 'mode-enforced' : 'mode-ignored'}\0`,
  );
  let missingFileCount = 0;
  let totalBytes = 0;
  let executableModeMismatchCount = 0;
  let indexMismatchCount = 0;

  for (const entry of entries) {
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      throw new Error(`Tracked source must use a regular-file Git mode: ${entry.path}`);
    }
    const absolutePath = within(repositoryRoot, entry.path);
    const status = await lstat(absolutePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    identityHash.update(entry.path);
    identityHash.update('\0');
    identityHash.update(entry.mode);
    identityHash.update('\0');
    identityHash.update(entry.objectId);
    identityHash.update('\0');
    if (status === null) {
      missingFileCount += 1;
      indexMismatchCount += 1;
      identityHash.update('missing\0');
      continue;
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Tracked source must be a regular file: ${entry.path}`);
    }
    const contents = await readFile(absolutePath);
    const effectiveMode = modeResolver(absolutePath, status.mode);
    const worktreeMode = (effectiveMode & 0o111) === 0 ? '100644' : '100755';
    const worktreeObjectId = createHash(objectFormat)
      .update(`blob ${contents.byteLength}\0`)
      .update(contents)
      .digest('hex');
    const contentMismatch = worktreeObjectId !== entry.objectId;
    const executableModeMismatch = fileModeEnforced && worktreeMode !== entry.mode;
    if (executableModeMismatch) executableModeMismatchCount += 1;
    if (contentMismatch || executableModeMismatch) indexMismatchCount += 1;
    totalBytes += contents.byteLength;
    identityHash.update('file\0');
    identityHash.update(worktreeMode);
    identityHash.update('\0');
    identityHash.update(String(contents.byteLength));
    identityHash.update('\0');
    identityHash.update(sha256(contents));
    identityHash.update('\0');
    identityHash.update(worktreeObjectId);
    identityHash.update('\0');
  }

  return {
    format: TRACKED_WORKTREE_SCHEMA_VERSION,
    objectFormat,
    fileModeEnforced,
    fileCount: entries.length,
    missingFileCount,
    totalBytes,
    executableModeMismatchCount,
    indexMismatchCount,
    sha256: identityHash.digest('hex'),
  };
}

export async function captureSourceIdentity(
  repositoryRoot: string,
  gitRunner: GitRunner = runGit,
  modeResolver: TrackedFileModeResolver = useObservedTrackedFileMode,
): Promise<SourceIdentity> {
  const head = (await gitRunner(['rev-parse', '--verify', 'HEAD'], repositoryRoot))
    .toString('utf8')
    .trim()
    .toLowerCase();
  if (!GIT_OBJECT_PATTERN.test(head)) throw new Error(`Git returned an invalid HEAD: ${head}`);

  const status = await gitRunner(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    repositoryRoot,
  );
  const patch = await gitRunner(
    ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--'],
    repositoryRoot,
  );
  const trackedContent = await trackedWorktreeIdentity(repositoryRoot, gitRunner, modeResolver);
  const untrackedPaths = nulPaths(
    await gitRunner(['ls-files', '--others', '--exclude-standard', '-z'], repositoryRoot),
    'Git untracked-file list',
  );
  const uniquePaths = new Set(untrackedPaths);
  if (uniquePaths.size !== untrackedPaths.length) {
    throw new Error('Git returned duplicate untracked-file paths.');
  }

  const untrackedFiles: FileIdentity[] = [];
  for (const path of untrackedPaths) {
    const absolutePath = within(repositoryRoot, path);
    const status = await lstat(absolutePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Untracked source disappeared while its identity was read: ${path}`);
      }
      throw error;
    });
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`Untracked source must be a regular file: ${path}`);
    }
    const contents = await readFile(absolutePath);
    untrackedFiles.push({ path, bytes: contents.byteLength, sha256: sha256(contents) });
  }

  const statusSha256 = sha256(status);
  const patchSha256 = sha256(patch);
  const untrackedSha256 = inventorySha256(untrackedFiles);
  const contentSha256 = sha256(
    [
      SOURCE_IDENTITY_SCHEMA_VERSION,
      head,
      statusSha256,
      patchSha256,
      trackedContent.sha256,
      untrackedSha256,
    ].join('\0'),
  );
  return {
    schemaVersion: SOURCE_IDENTITY_SCHEMA_VERSION,
    head,
    dirty: status.byteLength > 0 || trackedContent.indexMismatchCount > 0,
    gitStatus: {
      format: 'porcelain-v1-z',
      bytes: status.byteLength,
      sha256: statusSha256,
    },
    trackedPatch: {
      format: 'git-diff-binary-full-index',
      bytes: patch.byteLength,
      sha256: patchSha256,
    },
    trackedContent,
    untrackedContent: {
      fileCount: untrackedFiles.length,
      totalBytes: untrackedFiles.reduce((total, file) => total + file.bytes, 0),
      sha256: untrackedSha256,
    },
    contentSha256,
  };
}

export function sameSourceIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  const status = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${path}`);
    }
    throw error;
  });
  if (!status.isFile() || status.isSymbolicLink() || status.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`);
  }
  return readFile(path);
}

function assertPrivacySafeEvidence(contents: Buffer, label: string): void {
  assertPrivacySafeTextArtifact(contents.toString('utf8'), label);
}

async function assertCandidateEvidencePrivacy(
  candidateDirectory: string,
  inventory: DirectoryIdentity,
): Promise<void> {
  for (const file of inventory.files) {
    if (file.path.startsWith('artifact/')) continue;
    if (file.path === 'evidence/rollback-v2.2.0/pages-build.tar.gz') continue;
    const allowed =
      file.path === 'checksums.sha256' ||
      [
        'evidence/map-manifest.json',
        'evidence/provenance.json',
        'evidence/rollback-v2.2.0/manifest.json',
        'evidence/rollback-v2.2.0/release-checksums.sha256',
        'evidence/sbom.cdx.json',
      ].includes(file.path);
    if (!allowed) continue;
    assertPrivacySafeEvidence(await readFile(within(candidateDirectory, file.path)), file.path);
  }
}

async function mapManifestIdentity(path: string): Promise<MapManifestIdentity> {
  const contents = await readRequiredFile(path, 'Map manifest');
  const document = asObject(parseJson(contents, 'Map manifest'), 'Map manifest');
  const schemaVersion = requiredString(document.schemaVersion, 'Map manifest schemaVersion');
  if (schemaVersion !== 'map-assets.v1') {
    throw new Error(`Unsupported map manifest schemaVersion: ${schemaVersion}`);
  }
  const id = requiredString(document.id, 'Map manifest id');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`Map manifest id is not a safe immutable key: ${id}`);
  }
  const totalBytes = requiredSafeInteger(document.totalBytes, 'Map manifest totalBytes');
  if (!Array.isArray(document.assets) || document.assets.length === 0) {
    throw new Error('Map manifest assets must be a non-empty array.');
  }
  const paths = new Set<string>();
  const assets: FileIdentity[] = [];
  let computedBytes = 0;
  let basemapSha256: string | undefined;
  for (const [index, value] of document.assets.entries()) {
    const asset = asObject(value, `Map manifest asset ${index}`);
    const assetPath = normalizeRelativePath(
      requiredString(asset.path, `Map manifest asset ${index} path`),
      `Map manifest asset ${index}`,
    );
    if (paths.has(assetPath)) throw new Error(`Duplicate map manifest asset: ${assetPath}`);
    paths.add(assetPath);
    const assetBytes = requiredSafeInteger(asset.bytes, `Map manifest asset ${assetPath} bytes`);
    computedBytes += assetBytes;
    const assetSha256 = requiredString(asset.sha256, `Map manifest asset ${assetPath} sha256`);
    if (!SHA256_PATTERN.test(assetSha256)) {
      throw new Error(`Map manifest asset ${assetPath} has an invalid SHA-256.`);
    }
    assets.push({ path: assetPath, bytes: assetBytes, sha256: assetSha256 });
    if (assetPath === 'basemap.pmtiles') basemapSha256 = assetSha256;
  }
  if (computedBytes !== totalBytes) {
    throw new Error(
      `Map manifest totalBytes mismatch: declared ${totalBytes}, computed ${computedBytes}.`,
    );
  }
  if (basemapSha256 === undefined) {
    throw new Error('Map manifest must identify basemap.pmtiles.');
  }
  return {
    schemaVersion,
    id,
    assetCount: document.assets.length,
    totalBytes,
    sha256: sha256(contents),
    basemapSha256,
    assets: assets.sort((left, right) => compareNames(left.path, right.path)),
    contents,
  };
}

function validateMapPayloadIdentity(
  manifest: MapManifestIdentity,
  payload: DirectoryIdentity,
  label: string,
): void {
  if (
    payload.fileCount !== manifest.assetCount ||
    payload.totalBytes !== manifest.totalBytes ||
    payload.files.length !== manifest.assets.length
  ) {
    throw new Error(
      `${label} file count or byte total does not match map manifest ${manifest.id}.`,
    );
  }
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const expected = manifest.assets[index];
    const actual = payload.files[index];
    if (
      expected === undefined ||
      actual === undefined ||
      expected.path !== actual.path ||
      expected.bytes !== actual.bytes ||
      expected.sha256 !== actual.sha256
    ) {
      throw new Error(
        `${label} has a missing, extra, or mismatched map asset near ${expected?.path ?? actual?.path ?? index}.`,
      );
    }
  }
}

async function copyMapPayload(
  sourceRoot: string,
  destinationRoot: string,
  manifest: MapManifestIdentity,
  source: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  validateMapPayloadIdentity(manifest, source, 'Source map payload');
  await mkdir(destinationRoot, { recursive: true });
  for (const asset of manifest.assets) {
    const contents = await readFile(within(sourceRoot, asset.path));
    if (contents.byteLength !== asset.bytes || sha256(contents) !== asset.sha256) {
      throw new Error(`Source map asset changed while it was copied: ${asset.path}`);
    }
    const destination = within(destinationRoot, asset.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const retained = await inventoryDirectory(destinationRoot);
  validateMapPayloadIdentity(manifest, retained, 'Retained map payload');
  return retained;
}

async function sbomIdentity(path: string): Promise<SbomIdentity> {
  const contents = await readRequiredFile(
    path,
    'CycloneDX SBOM (run pnpm sbom:generate before retaining a candidate)',
  );
  const document = asObject(parseJson(contents, 'CycloneDX SBOM'), 'CycloneDX SBOM');
  if (document.bomFormat !== 'CycloneDX') {
    throw new Error('SBOM bomFormat must be CycloneDX.');
  }
  const specVersion = requiredString(document.specVersion, 'SBOM specVersion');
  if (!/^\d+\.\d+$/u.test(specVersion)) throw new Error('SBOM specVersion is invalid.');
  const documentVersion = requiredSafeInteger(document.version, 'SBOM version');
  if (documentVersion < 1) throw new Error('SBOM version must be at least 1.');
  return {
    specVersion,
    documentVersion,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    contents,
  };
}

function findFile(inventory: DirectoryIdentity, path: string): FileIdentity {
  const file = inventory.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Mock-staging artifact is missing ${path}.`);
  return file;
}

async function buildIdentity(
  repositoryRoot: string,
  artifactRoot: string,
  inventory: DirectoryIdentity,
  source: SourceIdentity,
): Promise<BuildIdentity> {
  for (const required of [
    'client/index.html',
    'client/live.html',
    'airspace_worker/wrangler.json',
    'mock_provider/wrangler.json',
  ]) {
    findFile(inventory, required);
  }
  const packageDocument = asObject(
    parseJson(
      await readRequiredFile(join(repositoryRoot, 'package.json'), 'Package metadata'),
      'Package metadata',
    ),
    'Package metadata',
  );
  const worker = asObject(
    parseJson(
      await readRequiredFile(
        join(artifactRoot, 'airspace_worker', 'wrangler.json'),
        'Mock-staging Worker configuration',
      ),
      'Mock-staging Worker configuration',
    ),
    'Mock-staging Worker configuration',
  );
  const mock = asObject(
    parseJson(
      await readRequiredFile(
        join(artifactRoot, 'mock_provider', 'wrangler.json'),
        'Mock-provider configuration',
      ),
      'Mock-provider configuration',
    ),
    'Mock-provider configuration',
  );
  const vars = asObject(worker.vars, 'Mock-staging Worker vars');
  const assets = asObject(worker.assets, 'Mock-staging Worker assets');
  const workerName = requiredString(worker.name, 'Mock-staging Worker name');
  const mockProviderName = requiredString(mock.name, 'Mock-provider name');
  if (workerName !== 'flight-airspace-mock-staging') {
    throw new Error(`Unexpected mock-staging Worker name: ${workerName}`);
  }
  if (mockProviderName !== 'flight-airspace-mock-provider') {
    throw new Error(`Unexpected mock-provider name: ${mockProviderName}`);
  }
  if (vars.LIVE_BUILD_TARGET !== 'mock-staging' || vars.LIVE_PROVIDER_MODE !== 'mock') {
    throw new Error('Worker is not an explicit mock-staging/mock build.');
  }
  if (assets.directory !== '../client') {
    throw new Error('Worker assets directory must reference the retained client directory.');
  }
  if (!Array.isArray(worker.services) || worker.services.length !== 1) {
    throw new Error('Mock-staging Worker must have exactly one mock-provider service binding.');
  }
  const service = asObject(worker.services[0], 'Mock-staging service binding');
  if (service.binding !== 'MOCK_PROVIDER' || service.service !== 'flight-airspace-mock-provider') {
    throw new Error('Mock-staging Worker has a mismatched mock-provider binding.');
  }
  const mockVars = asObject(mock.vars, 'Mock-provider vars');
  if (mockVars.MOCK_SCENARIO !== 'nominal') {
    throw new Error('Mock-provider default scenario must be nominal.');
  }
  const workerMain = normalizeRelativePath(
    requiredString(worker.main, 'Mock-staging Worker main'),
    'Mock-staging Worker main',
  );
  const mockMain = normalizeRelativePath(
    requiredString(mock.main, 'Mock-provider main'),
    'Mock-provider main',
  );
  findFile(inventory, `airspace_worker/${workerMain}`);
  findFile(inventory, `mock_provider/${mockMain}`);

  const mockCode = (
    await readRequiredFile(join(artifactRoot, 'mock_provider', mockMain), 'Mock-provider bundle')
  ).toString('utf8');
  if (!mockCode.includes('SYNTHETIC_OUTAGE')) {
    throw new Error(
      'Mock-provider bundle does not contain the required synthetic outage scenario.',
    );
  }
  if (mockCode.includes('https://api.adsb.lol') || mockCode.includes('globalThis.fetch')) {
    throw new Error('Mock-provider bundle contains a forbidden real-provider network path.');
  }

  const releaseSha = requiredString(vars.RELEASE_SHA, 'Worker RELEASE_SHA').toLowerCase();
  if (releaseSha !== 'local-unreleased') {
    if (!/^[a-f0-9]{7,64}$/u.test(releaseSha) || !source.head.startsWith(releaseSha)) {
      throw new Error(`Worker RELEASE_SHA does not match source HEAD: ${releaseSha}`);
    }
  }
  return {
    applicationName: requiredString(packageDocument.name, 'Package name'),
    packageVersion: requiredString(packageDocument.version, 'Package version'),
    applicationVersion: requiredString(vars.APP_VERSION, 'Worker APP_VERSION'),
    releaseSha,
    buildTarget: 'mock-staging',
    providerMode: 'mock',
    workerName: 'flight-airspace-mock-staging',
    mockProviderName: 'flight-airspace-mock-provider',
    clientRootEntrypoint: 'client/index.html',
    clientDevelopmentEntrypoint: 'client/live.html',
    workerEntrypoint: `airspace_worker/${workerMain}`,
    mockProviderEntrypoint: `mock_provider/${mockMain}`,
  };
}

async function replayIdentities(): Promise<RetainedCandidateProvenance['replayScenarios']> {
  const identities = [];
  for (const metadata of [...BUNDLED_REPLAY_SCENARIOS].sort((left, right) =>
    compareNames(left.id, right.id),
  )) {
    const manifest = await loadBundledReplayScenario(metadata.id, metadata.defaultSeed);
    if (
      manifest.scenarioId !== metadata.id ||
      manifest.seed !== metadata.defaultSeed ||
      !SHA256_PATTERN.test(manifest.provenance.canonicalSha256)
    ) {
      throw new Error(`Bundled replay identity is invalid for ${metadata.id}.`);
    }
    identities.push({
      schemaVersion: manifest.schemaVersion,
      scenarioId: manifest.scenarioId,
      seed: manifest.seed,
      generatorId: manifest.provenance.generatorId,
      generatorVersion: manifest.provenance.generatorVersion,
      canonicalSha256: manifest.provenance.canonicalSha256,
    });
  }
  if (identities.length === 0) throw new Error('No bundled replay scenarios were found.');
  return identities;
}

function withoutSourceMapReference(contents: Buffer, path: string): Buffer {
  if (!TEXT_ARTIFACT_PATTERN.test(path)) return contents;
  const text = contents.toString('utf8');
  return Buffer.from(text.replace(SOURCE_MAP_REFERENCE, ''), 'utf8');
}

async function copyRetainedArtifact(
  sourceRoot: string,
  destinationRoot: string,
  source: DirectoryIdentity,
): Promise<{
  omittedSourceMaps: FileIdentity[];
  normalizedSourceMapReferences: RetainedCandidateProvenance['sourceArtifact']['normalizedSourceMapReferences'];
}> {
  const omittedSourceMaps: FileIdentity[] = [];
  const normalizedSourceMapReferences: RetainedCandidateProvenance['sourceArtifact']['normalizedSourceMapReferences'] =
    [];
  await mkdir(destinationRoot, { recursive: true });
  for (const file of source.files) {
    if (/\.map$/iu.test(file.path)) {
      omittedSourceMaps.push(file);
      continue;
    }
    const sourcePath = within(sourceRoot, file.path);
    const destinationPath = within(destinationRoot, file.path);
    const sourceContents = await readFile(sourcePath);
    if (sourceContents.byteLength !== file.bytes || sha256(sourceContents) !== file.sha256) {
      throw new Error(`Build artifact changed while it was copied: ${file.path}`);
    }
    const retainedContents = withoutSourceMapReference(sourceContents, file.path);
    if (/sourceMappingURL\s*=/iu.test(retainedContents.toString('utf8'))) {
      throw new Error(`A public source-map reference remains in ${file.path}.`);
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, retainedContents);
    const retainedSha256 = sha256(retainedContents);
    if (retainedSha256 !== file.sha256) {
      normalizedSourceMapReferences.push({
        path: file.path,
        sourceSha256: file.sha256,
        retainedSha256,
      });
    }
  }
  return { omittedSourceMaps, normalizedSourceMapReferences };
}

function validateRetainedArtifact(source: DirectoryIdentity, retained: DirectoryIdentity): void {
  const expected = source.files
    .filter((file) => !/\.map$/iu.test(file.path))
    .map((file) => file.path)
    .sort(compareNames);
  const actual = retained.files.map((file) => file.path).sort(compareNames);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Retained artifact is not a complete source-map-free copy of mock staging.');
  }
  const publicMap = actual.find((path) => /\.map$/iu.test(path));
  if (publicMap) throw new Error(`Retained artifact exposes a public source map: ${publicMap}`);
}

export function candidateCommitmentSha256(provenance: RetainedCandidateProvenance): string {
  const committed = Object.fromEntries(
    Object.entries(provenance).filter(([key]) => key !== 'candidateId'),
  );
  return sha256(canonicalJson(committed));
}

export function candidateIdForProvenance(provenance: RetainedCandidateProvenance): string {
  return `mock-staging-${candidateCommitmentSha256(provenance).slice(0, 24)}`;
}

async function writeChecksums(candidateRoot: string): Promise<void> {
  const inventory = await inventoryDirectory(candidateRoot);
  if (inventory.files.some((file) => file.path === 'checksums.sha256')) {
    throw new Error('Checksum manifest unexpectedly existed before checksum generation.');
  }
  const lines = inventory.files.map((file) => `${file.sha256}  ${file.path}`);
  await writeFile(join(candidateRoot, 'checksums.sha256'), `${lines.join('\n')}\n`, 'utf8');
}

async function unchangedFile(path: string, expectedSha256: string, label: string): Promise<void> {
  const current = await readRequiredFile(path, label);
  if (sha256(current) !== expectedSha256) throw new Error(`${label} changed during assembly.`);
}

function validateProvenanceShape(document: Record<string, unknown>): RetainedCandidateProvenance {
  if (document.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported retained-candidate provenance schema: ${String(document.schemaVersion)}`,
    );
  }
  const candidateId = requiredString(document.candidateId, 'Candidate id');
  if (!/^mock-staging-[a-f0-9]{24}$/u.test(candidateId)) {
    throw new Error('Candidate id has an invalid format.');
  }
  if (
    document.deterministic !== true ||
    document.buildPerformed !== false ||
    document.deploymentPerformed !== false
  ) {
    throw new Error('Candidate provenance contains invalid build or deployment truth boundaries.');
  }

  const source = asObject(document.source, 'Candidate source identity');
  const head = requiredString(source.head, 'Candidate source HEAD');
  if (!GIT_OBJECT_PATTERN.test(head)) throw new Error('Candidate source HEAD is invalid.');
  if (
    source.schemaVersion !== SOURCE_IDENTITY_SCHEMA_VERSION ||
    typeof source.dirty !== 'boolean'
  ) {
    throw new Error('Candidate source identity schema or dirty flag is invalid.');
  }
  requiredSha256(source.contentSha256, 'Candidate source content identity');
  const gitStatus = asObject(source.gitStatus, 'Candidate Git status identity');
  if (gitStatus.format !== 'porcelain-v1-z')
    throw new Error('Candidate Git status format is invalid.');
  requiredSafeInteger(gitStatus.bytes, 'Candidate Git status bytes');
  requiredSha256(gitStatus.sha256, 'Candidate Git status digest');
  const trackedPatch = asObject(source.trackedPatch, 'Candidate tracked patch identity');
  if (trackedPatch.format !== 'git-diff-binary-full-index') {
    throw new Error('Candidate tracked patch format is invalid.');
  }
  requiredSafeInteger(trackedPatch.bytes, 'Candidate tracked patch bytes');
  requiredSha256(trackedPatch.sha256, 'Candidate tracked patch digest');
  const trackedContent = asObject(source.trackedContent, 'Candidate tracked content identity');
  if (
    trackedContent.format !== TRACKED_WORKTREE_SCHEMA_VERSION ||
    (trackedContent.objectFormat !== 'sha1' && trackedContent.objectFormat !== 'sha256') ||
    typeof trackedContent.fileModeEnforced !== 'boolean'
  ) {
    throw new Error('Candidate tracked content format is invalid.');
  }
  const trackedFileCount = requiredSafeInteger(
    trackedContent.fileCount,
    'Candidate tracked file count',
  );
  const missingTrackedFileCount = requiredSafeInteger(
    trackedContent.missingFileCount,
    'Candidate missing tracked file count',
  );
  requiredSafeInteger(trackedContent.totalBytes, 'Candidate tracked bytes');
  const executableModeMismatchCount = requiredSafeInteger(
    trackedContent.executableModeMismatchCount,
    'Candidate executable-mode mismatch count',
  );
  const trackedIndexMismatchCount = requiredSafeInteger(
    trackedContent.indexMismatchCount,
    'Candidate tracked index mismatch count',
  );
  requiredSha256(trackedContent.sha256, 'Candidate tracked content digest');
  if (
    missingTrackedFileCount > trackedFileCount ||
    executableModeMismatchCount > trackedFileCount ||
    trackedIndexMismatchCount > trackedFileCount ||
    executableModeMismatchCount > trackedIndexMismatchCount ||
    (trackedIndexMismatchCount > 0 && source.dirty !== true)
  ) {
    throw new Error('Candidate tracked content counts are inconsistent.');
  }
  const untracked = asObject(source.untrackedContent, 'Candidate untracked content identity');
  requiredSafeInteger(untracked.fileCount, 'Candidate untracked file count');
  requiredSafeInteger(untracked.totalBytes, 'Candidate untracked bytes');
  requiredSha256(untracked.sha256, 'Candidate untracked content digest');

  const application = asObject(document.application, 'Candidate application identity');
  for (const [key, label] of [
    ['applicationName', 'application name'],
    ['packageVersion', 'package version'],
    ['applicationVersion', 'application version'],
    ['releaseSha', 'release SHA'],
    ['workerName', 'Worker name'],
    ['mockProviderName', 'mock-provider name'],
    ['clientRootEntrypoint', 'root entrypoint'],
    ['clientDevelopmentEntrypoint', 'development entrypoint'],
    ['workerEntrypoint', 'Worker entrypoint'],
    ['mockProviderEntrypoint', 'mock-provider entrypoint'],
  ] as const) {
    requiredString(application[key], `Candidate ${label}`);
  }
  if (application.buildTarget !== 'mock-staging' || application.providerMode !== 'mock') {
    throw new Error('Candidate provenance does not identify an explicit mock-staging/mock build.');
  }

  const sourceArtifact = asObject(document.sourceArtifact, 'Candidate source artifact identity');
  if (sourceArtifact.path !== 'dist-mock-staging') {
    throw new Error('Candidate source artifact path is invalid.');
  }
  requiredSafeInteger(sourceArtifact.fileCount, 'Candidate source artifact file count');
  requiredSafeInteger(sourceArtifact.totalBytes, 'Candidate source artifact bytes');
  requiredSha256(sourceArtifact.sha256, 'Candidate source artifact digest');
  if (!Array.isArray(sourceArtifact.omittedSourceMaps)) {
    throw new Error('Candidate omitted-source-map evidence must be an array.');
  }
  const omittedPaths = new Set<string>();
  for (const [index, value] of sourceArtifact.omittedSourceMaps.entries()) {
    const map = asObject(value, `Omitted source map ${index}`);
    const path = normalizeRelativePath(
      requiredString(map.path, `Omitted source map ${index} path`),
      `Omitted source map ${index}`,
    );
    if (!/\.map$/iu.test(path) || omittedPaths.has(path)) {
      throw new Error(`Omitted source-map identity is invalid: ${path}`);
    }
    omittedPaths.add(path);
    requiredSafeInteger(map.bytes, `Omitted source map ${path} bytes`);
    requiredSha256(map.sha256, `Omitted source map ${path} digest`);
  }
  if (!Array.isArray(sourceArtifact.normalizedSourceMapReferences)) {
    throw new Error('Candidate source-map normalization evidence must be an array.');
  }
  const normalizedPaths = new Set<string>();
  for (const [index, value] of sourceArtifact.normalizedSourceMapReferences.entries()) {
    const normalized = asObject(value, `Source-map normalization ${index}`);
    const path = normalizeRelativePath(
      requiredString(normalized.path, `Source-map normalization ${index} path`),
      `Source-map normalization ${index}`,
    );
    if (normalizedPaths.has(path)) throw new Error(`Duplicate source-map normalization: ${path}`);
    normalizedPaths.add(path);
    const sourceDigest = requiredSha256(
      normalized.sourceSha256,
      `Source-map normalization ${path} source digest`,
    );
    const retainedDigest = requiredSha256(
      normalized.retainedSha256,
      `Source-map normalization ${path} retained digest`,
    );
    if (sourceDigest === retainedDigest) {
      throw new Error(`Source-map normalization did not change ${path}.`);
    }
  }

  const retainedArtifact = asObject(
    document.retainedArtifact,
    'Candidate retained artifact identity',
  );
  if (retainedArtifact.path !== 'artifact') throw new Error('Retained artifact path is invalid.');
  requiredSafeInteger(retainedArtifact.fileCount, 'Retained artifact file count');
  requiredSafeInteger(retainedArtifact.totalBytes, 'Retained artifact bytes');
  requiredSha256(retainedArtifact.sha256, 'Retained artifact digest');

  const mapManifest = asObject(document.mapManifest, 'Candidate map-manifest identity');
  if (
    mapManifest.sourcePath !== 'maps/manifest.json' ||
    mapManifest.candidatePath !== 'evidence/map-manifest.json'
  ) {
    throw new Error('Candidate map-manifest links are invalid.');
  }
  requiredString(mapManifest.schemaVersion, 'Candidate map-manifest schema');
  requiredString(mapManifest.id, 'Candidate map-manifest id');
  requiredSafeInteger(mapManifest.assetCount, 'Candidate map-manifest asset count');
  requiredSafeInteger(mapManifest.totalBytes, 'Candidate map-manifest bytes');
  requiredSha256(mapManifest.sha256, 'Candidate map-manifest digest');
  requiredSha256(mapManifest.basemapSha256, 'Candidate basemap digest');
  const mapPayload = asObject(mapManifest.payload, 'Candidate map payload identity');
  const mapId = requiredString(mapManifest.id, 'Candidate map-manifest id');
  if (
    mapPayload.sourcePath !== `.map-data/${mapId}` ||
    mapPayload.candidatePath !== `artifact/map_assets/${mapId}`
  ) {
    throw new Error('Candidate map payload links are invalid.');
  }
  requiredSafeInteger(mapPayload.fileCount, 'Candidate map payload file count');
  requiredSafeInteger(mapPayload.totalBytes, 'Candidate map payload bytes');
  requiredSha256(mapPayload.sha256, 'Candidate map payload digest');

  if (!Array.isArray(document.replayScenarios) || document.replayScenarios.length === 0) {
    throw new Error('Candidate replay-scenario identities must be a non-empty array.');
  }
  const scenarioIds = new Set<string>();
  for (const [index, value] of document.replayScenarios.entries()) {
    const replay = asObject(value, `Candidate replay identity ${index}`);
    const scenarioId = requiredString(replay.scenarioId, `Candidate replay ${index} id`);
    if (scenarioIds.has(scenarioId)) throw new Error(`Duplicate replay identity: ${scenarioId}`);
    scenarioIds.add(scenarioId);
    requiredString(replay.schemaVersion, `Candidate replay ${scenarioId} schema`);
    const seed = requiredSafeInteger(replay.seed, `Candidate replay ${scenarioId} seed`);
    if (seed < 1) throw new Error(`Candidate replay ${scenarioId} seed is invalid.`);
    requiredString(replay.generatorId, `Candidate replay ${scenarioId} generator id`);
    requiredString(replay.generatorVersion, `Candidate replay ${scenarioId} generator version`);
    requiredSha256(replay.canonicalSha256, `Candidate replay ${scenarioId} digest`);
  }

  asObject(document.rollback, 'Candidate approved rollback identity');

  const sbom = asObject(document.sbom, 'Candidate SBOM identity');
  if (
    sbom.sourcePath !== 'dist/sbom.cdx.json' ||
    sbom.candidatePath !== 'evidence/sbom.cdx.json' ||
    sbom.format !== 'CycloneDX'
  ) {
    throw new Error('Candidate SBOM links or format are invalid.');
  }
  requiredString(sbom.specVersion, 'Candidate SBOM spec version');
  requiredSafeInteger(sbom.documentVersion, 'Candidate SBOM document version');
  requiredSafeInteger(sbom.bytes, 'Candidate SBOM bytes');
  requiredSha256(sbom.sha256, 'Candidate SBOM digest');

  const checksums = asObject(document.checksums, 'Candidate checksum identity');
  if (
    checksums.path !== 'checksums.sha256' ||
    checksums.algorithm !== 'SHA-256' ||
    checksums.format !== 'sha256sum' ||
    !Array.isArray(checksums.excludedPaths) ||
    checksums.excludedPaths.length !== 1 ||
    checksums.excludedPaths[0] !== 'checksums.sha256'
  ) {
    throw new Error('Candidate checksum provenance is invalid.');
  }
  return document as unknown as RetainedCandidateProvenance;
}

async function readCandidateProvenance(
  candidateDirectory: string,
): Promise<RetainedCandidateProvenance> {
  const contents = await readRequiredFile(
    join(candidateDirectory, 'evidence', 'provenance.json'),
    'Candidate provenance',
  );
  const document = asObject(parseJson(contents, 'Candidate provenance'), 'Candidate provenance');
  const provenance = validateProvenanceShape(document);
  const canonical = `${JSON.stringify(provenance, null, 2)}\n`;
  if (!contents.equals(Buffer.from(canonical, 'utf8'))) {
    throw new Error('Candidate provenance is not in its deterministic canonical representation.');
  }
  return provenance;
}

function validatedCandidateTreeIdentity(value: unknown, label: string): CandidateTreeIdentity {
  const identity = asObject(value, label);
  exactKeys(identity, ['schemaVersion', 'fileCount', 'totalBytes', 'sha256'], label);
  if (identity.schemaVersion !== FILE_INVENTORY_SCHEMA_VERSION) {
    throw new Error(`${label} has an invalid inventory schema.`);
  }
  return {
    schemaVersion: FILE_INVENTORY_SCHEMA_VERSION,
    fileCount: requiredSafeInteger(identity.fileCount, `${label} file count`),
    totalBytes: requiredSafeInteger(identity.totalBytes, `${label} total bytes`),
    sha256: requiredSha256(identity.sha256, `${label} digest`),
  };
}

function validatedSelectedFile(value: unknown, expectedPath: string, label: string): FileIdentity {
  const identity = asObject(value, label);
  exactKeys(identity, ['path', 'bytes', 'sha256'], label);
  if (identity.path !== expectedPath) throw new Error(`${label} path is invalid.`);
  return {
    path: expectedPath,
    bytes: requiredSafeInteger(identity.bytes, `${label} bytes`),
    sha256: requiredSha256(identity.sha256, `${label} digest`),
  };
}

function validateSelectionRecord(document: Record<string, unknown>): CandidateSelectionRecord {
  exactKeys(
    document,
    [
      'schemaVersion',
      'candidateId',
      'candidateCommitmentSha256',
      'candidate',
      'source',
      'provenance',
      'checksums',
      'retainedArtifact',
    ],
    'Candidate selection record',
  );
  if (document.schemaVersion !== SELECTION_SCHEMA_VERSION) {
    throw new Error(`Unsupported candidate selection schema: ${String(document.schemaVersion)}`);
  }
  const candidateId = requiredString(document.candidateId, 'Selected candidate id');
  if (!/^mock-staging-[a-f0-9]{24}$/u.test(candidateId)) {
    throw new Error('Selected candidate id has an invalid format.');
  }
  const source = asObject(document.source, 'Selected source identity');
  exactKeys(source, ['head', 'contentSha256'], 'Selected source identity');
  const head = requiredString(source.head, 'Selected source HEAD');
  if (!GIT_OBJECT_PATTERN.test(head)) throw new Error('Selected source HEAD is invalid.');
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    candidateId,
    candidateCommitmentSha256: requiredSha256(
      document.candidateCommitmentSha256,
      'Selected candidate commitment',
    ),
    candidate: validatedCandidateTreeIdentity(document.candidate, 'Selected candidate tree'),
    source: {
      head,
      contentSha256: requiredSha256(source.contentSha256, 'Selected source content identity'),
    },
    provenance: validatedSelectedFile(
      document.provenance,
      'evidence/provenance.json',
      'Selected provenance',
    ),
    checksums: validatedSelectedFile(
      document.checksums,
      'checksums.sha256',
      'Selected checksum manifest',
    ),
    retainedArtifact: validatedCandidateTreeIdentity(
      document.retainedArtifact,
      'Selected retained artifact',
    ),
  };
}

async function readSelectionRecord(
  path: string,
): Promise<{ record: CandidateSelectionRecord; identity: FileIdentity; contents: Buffer }> {
  const contents = await readRequiredFile(path, 'Candidate selection record');
  const document = asObject(
    parseJson(contents, 'Candidate selection record'),
    'Candidate selection record',
  );
  const record = validateSelectionRecord(document);
  if (!contents.equals(Buffer.from(canonicalJson(record), 'utf8'))) {
    throw new Error(
      'Candidate selection record is not in its deterministic canonical representation.',
    );
  }
  return {
    record,
    contents,
    identity: {
      path,
      bytes: contents.byteLength,
      sha256: sha256(contents),
    },
  };
}

function selectedFileMatches(expected: FileIdentity, actual: FileIdentity): boolean {
  return (
    expected.path === actual.path &&
    expected.bytes === actual.bytes &&
    expected.sha256 === actual.sha256
  );
}

async function verifyChecksumAllowlist(
  candidateDirectory: string,
  inventory: DirectoryIdentity,
): Promise<void> {
  const checksum = findFile(inventory, 'checksums.sha256');
  const retainedFiles = inventory.files.filter((file) => file.path !== 'checksums.sha256');
  const expected = `${retainedFiles.map((file) => `${file.sha256}  ${file.path}`).join('\n')}\n`;
  const actual = await readFile(within(candidateDirectory, checksum.path), 'utf8');
  if (actual !== expected) {
    throw new Error(
      'Candidate checksum allowlist has an extra, missing, reordered, or mismatched file.',
    );
  }
}

async function verifyCandidateLayout(candidateDirectory: string): Promise<DirectoryIdentity> {
  const inventory = await inventoryDirectory(candidateDirectory);
  for (const file of inventory.files) {
    if (/\.map$/iu.test(file.path)) {
      throw new Error(`Retained candidate exposes a public source map: ${file.path}`);
    }
    const allowed =
      file.path === 'checksums.sha256' ||
      file.path.startsWith('artifact/') ||
      [
        'evidence/map-manifest.json',
        'evidence/provenance.json',
        'evidence/rollback-v2.2.0/manifest.json',
        'evidence/rollback-v2.2.0/pages-build.tar.gz',
        'evidence/rollback-v2.2.0/release-checksums.sha256',
        'evidence/sbom.cdx.json',
      ].includes(file.path);
    if (!allowed) throw new Error(`Retained candidate contains an unexpected file: ${file.path}`);
  }
  return inventory;
}

async function verifySourceMapReferences(
  candidateDirectory: string,
  inventory: DirectoryIdentity,
  approvedRollbackReferences: ReadonlySet<string>,
): Promise<void> {
  for (const file of inventory.files) {
    if (!file.path.startsWith('artifact/') || !TEXT_ARTIFACT_PATTERN.test(file.path)) continue;
    const contents = await readFile(within(candidateDirectory, file.path), 'utf8');
    if (/sourceMappingURL\s*=/iu.test(contents) && !approvedRollbackReferences.has(file.path)) {
      throw new Error(`Retained candidate exposes a source-map reference: ${file.path}`);
    }
  }
}

async function verifyCandidateBuild(
  candidateDirectory: string,
  provenance: RetainedCandidateProvenance,
  candidateInventory: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const artifactRoot = join(candidateDirectory, 'artifact');
  await assertLiveArtifactPolicy(artifactRoot, 'mock-staging');
  const inventory = scopedDirectoryIdentity(candidateInventory, 'artifact', 'Retained artifact');
  if (
    inventory.fileCount !== provenance.retainedArtifact.fileCount ||
    inventory.totalBytes !== provenance.retainedArtifact.totalBytes ||
    inventory.sha256 !== provenance.retainedArtifact.sha256
  ) {
    throw new Error('Retained artifact bytes do not match provenance.');
  }
  for (const required of [
    provenance.application.clientRootEntrypoint,
    provenance.application.clientDevelopmentEntrypoint,
    provenance.application.workerEntrypoint,
    provenance.application.mockProviderEntrypoint,
    'airspace_worker/wrangler.json',
    'mock_provider/wrangler.json',
  ]) {
    findFile(inventory, required);
  }
  const worker = asObject(
    parseJson(
      await readRequiredFile(
        join(artifactRoot, 'airspace_worker', 'wrangler.json'),
        'Retained Worker configuration',
      ),
      'Retained Worker configuration',
    ),
    'Retained Worker configuration',
  );
  const mock = asObject(
    parseJson(
      await readRequiredFile(
        join(artifactRoot, 'mock_provider', 'wrangler.json'),
        'Retained mock-provider configuration',
      ),
      'Retained mock-provider configuration',
    ),
    'Retained mock-provider configuration',
  );
  const vars = asObject(worker.vars, 'Retained Worker vars');
  const assets = asObject(worker.assets, 'Retained Worker assets');
  if (
    worker.name !== provenance.application.workerName ||
    mock.name !== provenance.application.mockProviderName ||
    vars.LIVE_BUILD_TARGET !== provenance.application.buildTarget ||
    vars.LIVE_PROVIDER_MODE !== provenance.application.providerMode ||
    vars.APP_VERSION !== provenance.application.applicationVersion ||
    String(vars.RELEASE_SHA).toLowerCase() !== provenance.application.releaseSha ||
    assets.directory !== '../client'
  ) {
    throw new Error('Retained build configuration does not match provenance.');
  }
  if (
    `airspace_worker/${String(worker.main)}` !== provenance.application.workerEntrypoint ||
    `mock_provider/${String(mock.main)}` !== provenance.application.mockProviderEntrypoint
  ) {
    throw new Error('Retained build entrypoints do not match provenance.');
  }
  if (!Array.isArray(worker.services) || worker.services.length !== 1) {
    throw new Error('Retained Worker mock-provider service binding is missing.');
  }
  const service = asObject(worker.services[0], 'Retained Worker service binding');
  if (
    service.binding !== 'MOCK_PROVIDER' ||
    service.service !== provenance.application.mockProviderName
  ) {
    throw new Error('Retained Worker mock-provider service binding is invalid.');
  }
  const mockVars = asObject(mock.vars, 'Retained mock-provider vars');
  if (mockVars.MOCK_SCENARIO !== 'nominal') {
    throw new Error('Retained mock-provider scenario is not nominal.');
  }
  const mockCode = await readFile(
    within(artifactRoot, provenance.application.mockProviderEntrypoint),
    'utf8',
  );
  if (
    !mockCode.includes('SYNTHETIC_OUTAGE') ||
    mockCode.includes('https://api.adsb.lol') ||
    mockCode.includes('globalThis.fetch')
  ) {
    throw new Error('Retained mock-provider bundle violates the synthetic-only boundary.');
  }
  for (const normalized of provenance.sourceArtifact.normalizedSourceMapReferences) {
    const retained = findFile(inventory, normalized.path);
    if (retained.sha256 !== normalized.retainedSha256) {
      throw new Error(`Source-map normalization identity does not match ${normalized.path}.`);
    }
  }
  return inventory;
}

export async function verifyRetainedCandidate(
  options: VerifyCandidateOptions,
): Promise<RetainedCandidateProvenance> {
  const candidateDirectory = resolve(options.candidateDirectory);
  const selectionPath = resolvedSelectionRecordPath(
    candidateDirectory,
    options.selectionRecordPath,
  );
  if (
    options.expectedSelectionRecordSha256 === undefined &&
    options.expectedCandidateId === undefined
  ) {
    throw new Error(
      'Retained-candidate verification requires an externally supplied selection-record SHA-256 or candidate id.',
    );
  }
  const expectedSelectionRecordSha256 = options.expectedSelectionRecordSha256?.toLowerCase();
  if (
    expectedSelectionRecordSha256 !== undefined &&
    !SHA256_PATTERN.test(expectedSelectionRecordSha256)
  ) {
    throw new Error('Expected selection-record SHA-256 must be a lowercase SHA-256.');
  }
  const trustedCandidateId = options.expectedCandidateId?.toLowerCase();
  if (
    trustedCandidateId !== undefined &&
    !/^mock-staging-[a-f0-9]{24}$/u.test(trustedCandidateId)
  ) {
    throw new Error('Expected candidate id has an invalid format.');
  }
  // The runner and the channel carrying either expected value are the explicit trust boundary.
  const selectionBefore = await readSelectionRecord(selectionPath);
  if (
    expectedSelectionRecordSha256 !== undefined &&
    selectionBefore.identity.sha256 !== expectedSelectionRecordSha256
  ) {
    throw new Error('Candidate selection record does not match the externally supplied SHA-256.');
  }
  if (
    trustedCandidateId !== undefined &&
    selectionBefore.record.candidateId !== trustedCandidateId
  ) {
    throw new Error(
      'Candidate selection record does not match the externally supplied candidate id.',
    );
  }
  const candidateInventory = await verifyCandidateLayout(candidateDirectory);
  if (
    !sameCandidateTreeIdentity(
      selectionBefore.record.candidate,
      candidateTreeIdentity(candidateInventory),
    )
  ) {
    throw new Error('Retained candidate tree does not match the trusted selection record.');
  }
  await assertCandidateEvidencePrivacy(candidateDirectory, candidateInventory);
  await verifyChecksumAllowlist(candidateDirectory, candidateInventory);
  const provenance = await readCandidateProvenance(candidateDirectory);
  const provenanceFile = findFile(candidateInventory, 'evidence/provenance.json');
  const checksumFile = findFile(candidateInventory, 'checksums.sha256');
  if (
    !selectedFileMatches(selectionBefore.record.provenance, provenanceFile) ||
    !selectedFileMatches(selectionBefore.record.checksums, checksumFile)
  ) {
    throw new Error('Candidate provenance or checksum manifest does not match selection.');
  }
  if (
    provenance.candidateId !== selectionBefore.record.candidateId ||
    provenance.source.head !== selectionBefore.record.source.head ||
    provenance.source.contentSha256 !== selectionBefore.record.source.contentSha256
  ) {
    throw new Error('Candidate provenance does not match the selected candidate identity.');
  }
  if (
    options.expectedSourceIdentity !== undefined &&
    !sameSourceIdentity(provenance.source, options.expectedSourceIdentity)
  ) {
    throw new Error('Candidate source content does not exactly match the expected checkout.');
  }
  if (options.expectedTarget !== undefined && options.expectedTarget !== 'mock-staging') {
    throw new Error(`Unsupported expected target: ${String(options.expectedTarget)}`);
  }
  if (
    options.expectedTarget !== undefined &&
    provenance.application.buildTarget !== options.expectedTarget
  ) {
    throw new Error(
      `Candidate target ${provenance.application.buildTarget} does not match ${options.expectedTarget}.`,
    );
  }
  if (options.expectedSourceHead !== undefined) {
    const expectedHead = options.expectedSourceHead.toLowerCase();
    if (!/^[a-f0-9]{7,64}$/u.test(expectedHead)) {
      throw new Error('Expected source HEAD must be a 7-to-64-character hexadecimal Git id.');
    }
    if (!provenance.source.head.startsWith(expectedHead)) {
      throw new Error(
        `Candidate source HEAD ${provenance.source.head} does not match expected ${expectedHead}.`,
      );
    }
  }
  const releaseSha = provenance.application.releaseSha;
  if (releaseSha !== 'local-unreleased' && !provenance.source.head.startsWith(releaseSha)) {
    throw new Error('Candidate release SHA does not match its source HEAD.');
  }

  const approvedRollbackReferences = await verifyApprovedRollbackRuntime(
    candidateDirectory,
    provenance.rollback,
  );
  await verifySourceMapReferences(
    candidateDirectory,
    candidateInventory,
    approvedRollbackReferences,
  );
  const mapManifest = await mapManifestIdentity(
    join(candidateDirectory, 'evidence', 'map-manifest.json'),
  );
  if (
    mapManifest.schemaVersion !== provenance.mapManifest.schemaVersion ||
    mapManifest.id !== provenance.mapManifest.id ||
    mapManifest.assetCount !== provenance.mapManifest.assetCount ||
    mapManifest.totalBytes !== provenance.mapManifest.totalBytes ||
    mapManifest.sha256 !== provenance.mapManifest.sha256 ||
    mapManifest.basemapSha256 !== provenance.mapManifest.basemapSha256
  ) {
    throw new Error('Retained map manifest does not match provenance.');
  }
  const retainedMapPayload = scopedDirectoryIdentity(
    candidateInventory,
    provenance.mapManifest.payload.candidatePath,
    'Retained map payload',
  );
  validateMapPayloadIdentity(mapManifest, retainedMapPayload, 'Retained map payload');
  if (
    retainedMapPayload.fileCount !== provenance.mapManifest.payload.fileCount ||
    retainedMapPayload.totalBytes !== provenance.mapManifest.payload.totalBytes ||
    retainedMapPayload.sha256 !== provenance.mapManifest.payload.sha256
  ) {
    throw new Error('Retained map payload does not match provenance.');
  }
  const retainedArtifact = await verifyCandidateBuild(
    candidateDirectory,
    provenance,
    candidateInventory,
  );
  if (
    !sameCandidateTreeIdentity(
      selectionBefore.record.retainedArtifact,
      candidateTreeIdentity(retainedArtifact),
    )
  ) {
    throw new Error('Retained artifact does not match the trusted selection record.');
  }
  const expectedRetainedFileCount =
    provenance.sourceArtifact.fileCount -
    provenance.sourceArtifact.omittedSourceMaps.length +
    provenance.mapManifest.payload.fileCount +
    provenance.rollback.publicFiles.reduce((count, file) => count + file.candidatePaths.length, 0);
  if (retainedArtifact.fileCount !== expectedRetainedFileCount) {
    throw new Error('Source, map, rollback, and retained artifact file counts do not reconcile.');
  }
  const sbom = await sbomIdentity(join(candidateDirectory, 'evidence', 'sbom.cdx.json'));
  if (
    sbom.specVersion !== provenance.sbom.specVersion ||
    sbom.documentVersion !== provenance.sbom.documentVersion ||
    sbom.bytes !== provenance.sbom.bytes ||
    sbom.sha256 !== provenance.sbom.sha256
  ) {
    throw new Error('Retained SBOM does not match provenance.');
  }
  const expectedReplayScenarios = await replayIdentities();
  if (JSON.stringify(expectedReplayScenarios) !== JSON.stringify(provenance.replayScenarios)) {
    throw new Error('Retained replay scenario identities do not match the verifier source.');
  }
  const commitmentSha256 = candidateCommitmentSha256(provenance);
  const expectedCandidateId = candidateIdForProvenance(provenance);
  if (provenance.candidateId !== expectedCandidateId) {
    throw new Error('Retained candidate id does not match its declared content identities.');
  }
  if (selectionBefore.record.candidateCommitmentSha256 !== commitmentSha256) {
    throw new Error('Candidate commitment does not match the trusted selection record.');
  }
  const finalInventory = await verifyCandidateLayout(candidateDirectory);
  if (!sameDirectoryIdentity(candidateInventory, finalInventory)) {
    throw new Error('Retained candidate changed during verification.');
  }
  if (
    !sameCandidateTreeIdentity(
      selectionBefore.record.candidate,
      candidateTreeIdentity(finalInventory),
    )
  ) {
    throw new Error('Retained candidate final identity does not match selection.');
  }
  await assertCandidateEvidencePrivacy(candidateDirectory, finalInventory);
  await verifyChecksumAllowlist(candidateDirectory, finalInventory);
  await auditPrivacyTree(
    { root: candidateDirectory, files: finalInventory.files },
    selectionBefore.record.candidate,
  );
  const selectionAfter = await readSelectionRecord(selectionPath);
  if (
    selectionAfter.identity.bytes !== selectionBefore.identity.bytes ||
    selectionAfter.identity.sha256 !== selectionBefore.identity.sha256
  ) {
    throw new Error('Candidate selection record changed during verification.');
  }
  return provenance;
}

export async function retainMockStagingCandidate(
  options: RetainCandidateOptions,
): Promise<RetainedCandidateProvenance> {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  );
  const artifactRoot = join(repositoryRoot, 'dist-mock-staging');
  const mapManifestPath = join(repositoryRoot, 'maps', 'manifest.json');
  const sbomPath = join(repositoryRoot, 'dist', 'sbom.cdx.json');
  const outputDirectory = resolve(options.outputDirectory);
  const selectionRecordPath = resolvedSelectionRecordPath(
    outputDirectory,
    options.selectionRecordPath,
  );
  const protectedPaths = [
    join(repositoryRoot, 'dist-live'),
    artifactRoot,
    join(repositoryRoot, 'dist'),
    join(repositoryRoot, 'maps'),
    join(repositoryRoot, '.map-data'),
    join(repositoryRoot, 'rollback'),
  ];
  const canonicalOutputDirectory = await assertEvidenceOutputPlacement({
    repositoryRoot,
    outputPath: outputDirectory,
    label: 'Candidate output',
    allowedRepositoryRoots: ['.tmp-tests'],
    protectedPaths,
  });
  const canonicalSelectionRecordPath = await assertEvidenceOutputPlacement({
    repositoryRoot,
    outputPath: selectionRecordPath,
    label: 'Candidate selection record',
    allowedRepositoryRoots: ['.tmp-tests'],
    protectedPaths,
  });
  if (
    containsCanonicalPath(canonicalOutputDirectory, canonicalSelectionRecordPath) ||
    containsCanonicalPath(canonicalSelectionRecordPath, canonicalOutputDirectory)
  ) {
    throw new Error(
      'Candidate output and selection record must remain independent evidence paths.',
    );
  }
  if (await exists(outputDirectory)) {
    throw new Error(`Candidate output already exists: ${outputDirectory}`);
  }
  if (await exists(selectionRecordPath)) {
    throw new Error(`Candidate selection record already exists: ${selectionRecordPath}`);
  }
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(dirname(selectionRecordPath), { recursive: true });

  const gitRunner = options.gitRunner ?? runGit;
  const sourceBefore = await captureSourceIdentity(repositoryRoot, gitRunner);
  const artifactBefore = await inventoryDirectory(artifactRoot);
  await assertLiveArtifactPolicy(artifactRoot, 'mock-staging', { allowSourceMaps: true });
  const application = await buildIdentity(
    repositoryRoot,
    artifactRoot,
    artifactBefore,
    sourceBefore,
  );
  const mapManifest = await mapManifestIdentity(mapManifestPath);
  const sourceMapPayloadRoot = join(repositoryRoot, '.map-data', mapManifest.id);
  const sourceMapPayloadBefore = await inventoryDirectory(sourceMapPayloadRoot);
  validateMapPayloadIdentity(mapManifest, sourceMapPayloadBefore, 'Source map payload');
  const sbom = await sbomIdentity(sbomPath);
  const replayScenarios = await replayIdentities();
  const rollback = await loadApprovedRollback(repositoryRoot);
  assertPrivacySafeEvidence(mapManifest.contents, 'maps/manifest.json');
  assertPrivacySafeEvidence(sbom.contents, 'dist/sbom.cdx.json');
  assertPrivacySafeEvidence(rollback.manifestContents, rollback.provenance.manifest.sourcePath);
  assertPrivacySafeEvidence(
    rollback.releaseChecksumsContents,
    rollback.provenance.releaseChecksums.sourcePath,
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'fdw-retained-candidate-'));
  let candidatePublished = false;
  let selectionPublished = false;
  let completed = false;
  try {
    const artifactDirectory = join(temporaryDirectory, 'artifact');
    const evidenceDirectory = join(temporaryDirectory, 'evidence');
    const transformations = await copyRetainedArtifact(
      artifactRoot,
      artifactDirectory,
      artifactBefore,
    );
    const retainedMockArtifact = await inventoryDirectory(artifactDirectory);
    await assertLiveArtifactPolicy(artifactDirectory, 'mock-staging');
    await auditPrivacyTree(
      { root: artifactDirectory, files: retainedMockArtifact.files },
      candidateTreeIdentity(retainedMockArtifact),
    );
    validateRetainedArtifact(artifactBefore, retainedMockArtifact);
    const retainedMapPayload = await copyMapPayload(
      sourceMapPayloadRoot,
      join(artifactDirectory, 'map_assets', mapManifest.id),
      mapManifest,
      sourceMapPayloadBefore,
    );
    await writeApprovedRollback(rollback, temporaryDirectory);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'map-manifest.json'), mapManifest.contents);
    await writeFile(join(evidenceDirectory, 'sbom.cdx.json'), sbom.contents);

    const retainedArtifact = await inventoryDirectory(artifactDirectory);
    const provenance: RetainedCandidateProvenance = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      candidateId: `mock-staging-${'0'.repeat(24)}`,
      deterministic: true,
      buildPerformed: false,
      deploymentPerformed: false,
      source: sourceBefore,
      application,
      sourceArtifact: {
        path: 'dist-mock-staging',
        fileCount: artifactBefore.fileCount,
        totalBytes: artifactBefore.totalBytes,
        sha256: artifactBefore.sha256,
        omittedSourceMaps: transformations.omittedSourceMaps,
        normalizedSourceMapReferences: transformations.normalizedSourceMapReferences,
      },
      retainedArtifact: {
        path: 'artifact',
        fileCount: retainedArtifact.fileCount,
        totalBytes: retainedArtifact.totalBytes,
        sha256: retainedArtifact.sha256,
      },
      mapManifest: {
        sourcePath: 'maps/manifest.json',
        candidatePath: 'evidence/map-manifest.json',
        schemaVersion: mapManifest.schemaVersion,
        id: mapManifest.id,
        assetCount: mapManifest.assetCount,
        totalBytes: mapManifest.totalBytes,
        sha256: mapManifest.sha256,
        basemapSha256: mapManifest.basemapSha256,
        payload: {
          sourcePath: `.map-data/${mapManifest.id}`,
          candidatePath: `artifact/map_assets/${mapManifest.id}`,
          fileCount: retainedMapPayload.fileCount,
          totalBytes: retainedMapPayload.totalBytes,
          sha256: retainedMapPayload.sha256,
        },
      },
      replayScenarios,
      rollback: rollback.provenance,
      sbom: {
        sourcePath: 'dist/sbom.cdx.json',
        candidatePath: 'evidence/sbom.cdx.json',
        format: 'CycloneDX',
        specVersion: sbom.specVersion,
        documentVersion: sbom.documentVersion,
        bytes: sbom.bytes,
        sha256: sbom.sha256,
      },
      checksums: {
        path: 'checksums.sha256',
        algorithm: 'SHA-256',
        format: 'sha256sum',
        excludedPaths: ['checksums.sha256'],
      },
    };
    provenance.candidateId = candidateIdForProvenance(provenance);
    await writeFile(
      join(evidenceDirectory, 'provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
      'utf8',
    );
    await writeChecksums(temporaryDirectory);
    const assembledCandidate = await verifyCandidateLayout(temporaryDirectory);
    await assertCandidateEvidencePrivacy(temporaryDirectory, assembledCandidate);
    await verifyChecksumAllowlist(temporaryDirectory, assembledCandidate);
    await auditPrivacyTree(
      { root: temporaryDirectory, files: assembledCandidate.files },
      candidateTreeIdentity(assembledCandidate),
    );
    const selectionRecord: CandidateSelectionRecord = {
      schemaVersion: SELECTION_SCHEMA_VERSION,
      candidateId: provenance.candidateId,
      candidateCommitmentSha256: candidateCommitmentSha256(provenance),
      candidate: candidateTreeIdentity(assembledCandidate),
      source: {
        head: provenance.source.head,
        contentSha256: provenance.source.contentSha256,
      },
      provenance: findFile(assembledCandidate, 'evidence/provenance.json'),
      checksums: findFile(assembledCandidate, 'checksums.sha256'),
      retainedArtifact: candidateTreeIdentity(retainedArtifact),
    };
    const selectionContents = canonicalJson(selectionRecord);
    const assertProtectedInputsUnchanged = async (stage: string): Promise<void> => {
      const artifactCurrent = await inventoryDirectory(artifactRoot);
      if (!sameDirectoryIdentity(artifactBefore, artifactCurrent)) {
        throw new Error(`Mock-staging build changed ${stage}.`);
      }
      await unchangedFile(mapManifestPath, mapManifest.sha256, 'Map manifest');
      const sourceMapPayloadCurrent = await inventoryDirectory(sourceMapPayloadRoot);
      validateMapPayloadIdentity(mapManifest, sourceMapPayloadCurrent, 'Source map payload');
      if (!sameDirectoryIdentity(sourceMapPayloadBefore, sourceMapPayloadCurrent)) {
        throw new Error(`Source map payload changed ${stage}.`);
      }
      await unchangedFile(sbomPath, sbom.sha256, 'CycloneDX SBOM');
      await unchangedFile(
        join(repositoryRoot, rollback.provenance.archive.sourcePath),
        rollback.provenance.archive.sha256,
        'Approved rollback archive',
      );
      await unchangedFile(
        join(repositoryRoot, rollback.provenance.manifest.sourcePath),
        rollback.provenance.manifest.sha256,
        'Approved rollback manifest',
      );
      await unchangedFile(
        join(repositoryRoot, rollback.provenance.releaseChecksums.sourcePath),
        rollback.provenance.releaseChecksums.sha256,
        'Approved rollback release checksums',
      );
      const sourceCurrent = await captureSourceIdentity(repositoryRoot, gitRunner);
      if (!sameSourceIdentity(sourceBefore, sourceCurrent)) {
        throw new Error(`Git source identity changed ${stage}.`);
      }
    };

    await assertProtectedInputsUnchanged('during candidate assembly');
    if (await exists(outputDirectory)) {
      throw new Error(`Candidate output appeared during assembly: ${outputDirectory}`);
    }
    if (await exists(selectionRecordPath)) {
      throw new Error(
        `Candidate selection record appeared during assembly: ${selectionRecordPath}`,
      );
    }
    const finalTemporaryInventory = await verifyCandidateLayout(temporaryDirectory);
    if (!sameDirectoryIdentity(assembledCandidate, finalTemporaryInventory)) {
      throw new Error('Retained candidate changed before publication.');
    }
    await rename(temporaryDirectory, outputDirectory);
    candidatePublished = true;
    const publishedInventory = await verifyCandidateLayout(outputDirectory);
    if (!sameDirectoryIdentity(assembledCandidate, publishedInventory)) {
      throw new Error('Retained candidate changed while it was published.');
    }
    await writeFile(selectionRecordPath, selectionContents, { encoding: 'utf8', flag: 'wx' });
    selectionPublished = true;
    const selectionRecordSha256 = sha256(selectionContents);
    const publishedSelection = await readSelectionRecord(selectionRecordPath);
    if (publishedSelection.identity.sha256 !== selectionRecordSha256) {
      throw new Error('Published selection record does not match its in-memory identity.');
    }
    const finalPublishedInventory = await verifyCandidateLayout(outputDirectory);
    if (!sameDirectoryIdentity(assembledCandidate, finalPublishedInventory)) {
      throw new Error('Retained candidate changed during selection publication.');
    }
    await assertProtectedInputsUnchanged('during selection publication');
    options.selectionObserver?.(
      Object.freeze({
        candidateId: provenance.candidateId,
        selectionRecordPath,
        selectionRecordSha256,
      }),
    );
    completed = true;
    return provenance;
  } finally {
    if (!completed) {
      if (selectionPublished) await rm(selectionRecordPath, { force: true });
      if (candidatePublished) await rm(outputDirectory, { force: true, recursive: true });
      else await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

function cliArguments(arguments_: readonly string[]): RetainCandidateOptions {
  let repositoryRoot: string | undefined;
  let outputDirectory: string | undefined;
  let selectionRecordPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag ?? 'CLI argument'}.`);
    }
    if (flag === '--repository') repositoryRoot = value;
    else if (flag === '--output') outputDirectory = value;
    else if (flag === '--selection-record') selectionRecordPath = value;
    else throw new Error(`Unknown argument: ${flag ?? ''}`);
  }
  if (outputDirectory === undefined) {
    throw new Error(
      'Usage: tsx tools/live/retainCandidate.ts --output <new-directory> [--selection-record <new-file>] [--repository <root>]',
    );
  }
  return {
    outputDirectory,
    ...(selectionRecordPath === undefined ? {} : { selectionRecordPath }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = cliArguments(process.argv.slice(2));
  let retainedSelection: RetainedCandidateSelection | undefined;
  options.selectionObserver = (selection) => {
    retainedSelection = selection;
  };
  retainMockStagingCandidate(options).then(
    (provenance) => {
      if (retainedSelection === undefined) {
        throw new Error('Candidate retention did not emit its in-memory selection identity.');
      }
      console.log(
        `M34_CANDIDATE_SELECTION ${JSON.stringify({
          candidateId: retainedSelection.candidateId,
          selectionRecordSha256: retainedSelection.selectionRecordSha256,
        })}`,
      );
      console.log(
        `Retained ${provenance.candidateId}. No rebuild, deployment, or network request was performed.`,
      );
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
