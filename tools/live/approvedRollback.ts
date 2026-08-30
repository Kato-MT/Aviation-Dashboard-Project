import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APPROVED_RELEASE_TAG = 'v2.2.0';
const APPROVED_SOURCE_REVISION = 'd29e87e07586ca7790f86a65e55b2ce6e2fcc1c7';
const APPROVED_PUBLISHED_AT = '2026-07-19T22:56:18Z';
const APPROVED_RELEASE_URL =
  'https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/tag/v2.2.0';
const APPROVED_ARCHIVE_SOURCE_URL =
  'https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/download/v2.2.0/pages-build.tar.gz';
const APPROVED_ARCHIVE_SHA256 = '5c0558fc4818d5f4b152d1348ac0d19cc30a2e30560ffa1f779921012dab0348';
const APPROVED_RELEASE_CHECKSUMS_SHA256 =
  '0468c1ce91d6ae1dfd424cf5306f1d3dcb1e5721a1077e47b34397dd4e20ad84';
const MAX_ARCHIVE_OUTPUT_BYTES = 64 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;

export interface RollbackFileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ApprovedRollbackProvenance {
  schemaVersion: 'fdw-approved-rollback.v1';
  releaseTag: 'v2.2.0';
  sourceRevision: string;
  publishedAt: string;
  archive: {
    sourcePath: 'rollback/v2.2.0/pages-build.tar.gz';
    candidatePath: 'evidence/rollback-v2.2.0/pages-build.tar.gz';
    bytes: number;
    sha256: string;
  };
  manifest: {
    sourcePath: 'rollback/v2.2.0/manifest.json';
    candidatePath: 'evidence/rollback-v2.2.0/manifest.json';
    bytes: number;
    sha256: string;
  };
  releaseChecksums: {
    sourcePath: 'rollback/v2.2.0/release-checksums.sha256';
    candidatePath: 'evidence/rollback-v2.2.0/release-checksums.sha256';
    bytes: number;
    sha256: string;
  };
  runtimePolicy: {
    entryPath: 'index.html';
    compatibilityUrl: '/v2.html';
    approvedBasePath: '/Aviation-Dashboard-Project/';
    excludeFromPublicRuntime: ['**/*.map', 'sbom.cdx.json'];
    retainOriginalArchiveAsEvidence: true;
  };
  runtimeFiles: RollbackFileIdentity[];
  publicFiles: Array<
    RollbackFileIdentity & {
      candidatePaths: string[];
    }
  >;
  excludedPublicSourceMaps: RollbackFileIdentity[];
  excludedNonRuntimeFiles: RollbackFileIdentity[];
}

export interface ApprovedRollbackBundle {
  provenance: ApprovedRollbackProvenance;
  archiveContents: Buffer;
  manifestContents: Buffer;
  releaseChecksumsContents: Buffer;
  archiveFiles: ReadonlyMap<string, Buffer>;
}

function sha256(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!SHA256_PATTERN.test(result)) throw new Error(`${label} must be a lowercase SHA-256.`);
  return result;
}

function safePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} contains an unsafe path: ${value}`);
  }
  return normalized;
}

async function requiredFile(path: string, label: string): Promise<Buffer> {
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

function tarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field
    .subarray(0, end < 0 ? field.length : end)
    .toString('utf8')
    .trim();
}

function tarOctal(header: Buffer, start: number, length: number, label: string): number {
  const value = tarString(header, start, length).replaceAll(' ', '');
  if (!/^[0-7]+$/u.test(value)) throw new Error(`Rollback archive has an invalid ${label}.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Rollback archive has an excessive ${label}.`);
  }
  return parsed;
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const declared = tarOctal(header, 148, 8, 'header checksum');
  let computed = 0;
  for (let index = 0; index < header.length; index += 1) {
    computed += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (computed !== declared)
    throw new Error('Rollback archive has an invalid TAR header checksum.');
}

function parseTarGzip(archive: Buffer): ReadonlyMap<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_OUTPUT_BYTES });
  } catch (error) {
    throw new Error('Approved rollback archive is not a bounded valid gzip stream.', {
      cause: error,
    });
  }
  const files = new Map<string, Buffer>();
  let offset = 0;
  let entries = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      const tail = tar.subarray(offset);
      if (!tail.every((byte) => byte === 0)) {
        throw new Error('Rollback archive has non-zero data after its TAR terminator.');
      }
      return files;
    }
    verifyTarHeaderChecksum(header);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const path = rawPath === './' || rawPath === '.' ? undefined : safePath(rawPath, 'TAR entry');
    const size = tarOctal(header, 124, 12, 'entry size');
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Rollback archive contains a truncated TAR entry.');
    if (type === '\0' || type === '0') {
      if (path === undefined) throw new Error('Rollback archive has an unnamed file entry.');
      if (files.has(path)) throw new Error(`Rollback archive has a duplicate entry: ${path}`);
      files.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    } else if (type !== '5') {
      throw new Error(`Rollback archive contains unsupported entry type ${type}: ${rawPath}`);
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    entries += 1;
    if (entries > 10_000) throw new Error('Rollback archive contains too many entries.');
  }
  throw new Error('Rollback archive is missing its TAR terminator.');
}

function publicCandidatePaths(path: string): string[] {
  if (path === 'index.html') {
    return ['artifact/client/Aviation-Dashboard-Project/index.html', 'artifact/client/v2.html'];
  }
  return [`artifact/client/Aviation-Dashboard-Project/${path}`];
}

function identity(path: string, contents: Buffer): RollbackFileIdentity {
  return { path, bytes: contents.byteLength, sha256: sha256(contents) };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadApprovedRollback(
  repositoryRoot: string,
): Promise<ApprovedRollbackBundle> {
  const rollbackRoot = resolve(repositoryRoot, 'rollback', 'v2.2.0');
  const archivePath = join(rollbackRoot, 'pages-build.tar.gz');
  const manifestPath = join(rollbackRoot, 'manifest.json');
  const releaseChecksumsPath = join(rollbackRoot, 'release-checksums.sha256');
  const archiveContents = await requiredFile(archivePath, 'Approved rollback archive');
  const manifestContents = await requiredFile(manifestPath, 'Approved rollback manifest');
  const releaseChecksumsContents = await requiredFile(
    releaseChecksumsPath,
    'Approved rollback release checksums',
  );
  if (sha256(archiveContents) !== APPROVED_ARCHIVE_SHA256) {
    throw new Error('Approved rollback archive does not match the pinned SHA-256.');
  }
  if (sha256(releaseChecksumsContents) !== APPROVED_RELEASE_CHECKSUMS_SHA256) {
    throw new Error('Approved rollback release checksums do not match the pinned SHA-256.');
  }
  const archiveChecksumLine = `${APPROVED_ARCHIVE_SHA256}  pages-build.tar.gz`;
  if (!releaseChecksumsContents.toString('utf8').split(/\r?\n/u).includes(archiveChecksumLine)) {
    throw new Error('Approved rollback release checksums do not identify the pinned archive.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContents.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Approved rollback manifest is not valid JSON.', { cause: error });
  }
  const manifest = asObject(parsed, 'Approved rollback manifest');
  if (
    manifest.schemaVersion !== 'fdw-approved-rollback.v1' ||
    manifest.releaseTag !== APPROVED_RELEASE_TAG ||
    manifest.sourceRevision !== APPROVED_SOURCE_REVISION ||
    manifest.publishedAt !== APPROVED_PUBLISHED_AT ||
    manifest.releaseUrl !== APPROVED_RELEASE_URL
  ) {
    throw new Error('Approved rollback schema, tag, or source revision is not pinned v2.2.0.');
  }
  const archive = asObject(manifest.archive, 'Approved rollback archive identity');
  if (
    archive.path !== 'rollback/v2.2.0/pages-build.tar.gz' ||
    archive.sourceUrl !== APPROVED_ARCHIVE_SOURCE_URL ||
    archive.sha256 !== APPROVED_ARCHIVE_SHA256 ||
    requiredInteger(archive.bytes, 'Approved rollback archive bytes') !== archiveContents.byteLength
  ) {
    throw new Error('Approved rollback archive identity does not match its manifest.');
  }
  const releaseChecksums = asObject(
    manifest.releaseChecksums,
    'Approved rollback release-checksum identity',
  );
  if (
    releaseChecksums.path !== 'rollback/v2.2.0/release-checksums.sha256' ||
    releaseChecksums.sha256 !== APPROVED_RELEASE_CHECKSUMS_SHA256
  ) {
    throw new Error('Approved rollback release-checksum identity does not match its manifest.');
  }
  const runtimePolicy = asObject(manifest.runtimePolicy, 'Approved rollback runtime policy');
  const expectedPolicy: ApprovedRollbackProvenance['runtimePolicy'] = {
    entryPath: 'index.html',
    compatibilityUrl: '/v2.html',
    approvedBasePath: '/Aviation-Dashboard-Project/',
    excludeFromPublicRuntime: ['**/*.map', 'sbom.cdx.json'],
    retainOriginalArchiveAsEvidence: true,
  };
  if (!sameJson(runtimePolicy, expectedPolicy)) {
    throw new Error('Approved rollback runtime policy does not match the pinned policy.');
  }
  if (!Array.isArray(manifest.runtimeFiles) || manifest.runtimeFiles.length === 0) {
    throw new Error('Approved rollback runtime file list is missing.');
  }

  const archiveFiles = parseTarGzip(archiveContents);
  const runtimeFiles: RollbackFileIdentity[] = [];
  const runtimePaths = new Set<string>();
  for (const [index, value] of manifest.runtimeFiles.entries()) {
    const declared = asObject(value, `Approved rollback runtime file ${index}`);
    const path = safePath(
      requiredString(declared.path, `Approved rollback runtime file ${index} path`),
      `Approved rollback runtime file ${index}`,
    );
    if (runtimePaths.has(path) || /\.map$/iu.test(path) || path === 'sbom.cdx.json') {
      throw new Error(`Approved rollback runtime path is invalid or duplicated: ${path}`);
    }
    runtimePaths.add(path);
    const contents = archiveFiles.get(path);
    if (contents === undefined)
      throw new Error(`Rollback archive is missing runtime file ${path}.`);
    const actual = identity(path, contents);
    if (
      requiredInteger(declared.bytes, `Approved rollback runtime file ${path} bytes`) !==
        actual.bytes ||
      requiredSha256(declared.sha256, `Approved rollback runtime file ${path} digest`) !==
        actual.sha256
    ) {
      throw new Error(`Rollback runtime file does not match its manifest: ${path}`);
    }
    runtimeFiles.push(actual);
  }
  runtimeFiles.sort((left, right) => comparePaths(left.path, right.path));
  if (!runtimePaths.has('index.html')) throw new Error('Approved rollback index.html is missing.');

  const excludedPublicSourceMaps: RollbackFileIdentity[] = [];
  const excludedNonRuntimeFiles: RollbackFileIdentity[] = [];
  for (const [path, contents] of archiveFiles) {
    if (runtimePaths.has(path)) continue;
    if (/\.map$/iu.test(path)) excludedPublicSourceMaps.push(identity(path, contents));
    else excludedNonRuntimeFiles.push(identity(path, contents));
  }
  excludedPublicSourceMaps.sort((left, right) => comparePaths(left.path, right.path));
  excludedNonRuntimeFiles.sort((left, right) => comparePaths(left.path, right.path));
  if (excludedPublicSourceMaps.length === 0) {
    throw new Error('Approved rollback archive did not contain the declared private source maps.');
  }
  if (
    excludedNonRuntimeFiles.length !== 1 ||
    excludedNonRuntimeFiles[0]?.path !== 'sbom.cdx.json'
  ) {
    throw new Error('Approved rollback archive has undeclared non-runtime files.');
  }
  const publicFiles = runtimeFiles.map((file) => ({
    ...file,
    candidatePaths: publicCandidatePaths(file.path),
  }));
  const provenance: ApprovedRollbackProvenance = {
    schemaVersion: 'fdw-approved-rollback.v1',
    releaseTag: 'v2.2.0',
    sourceRevision: APPROVED_SOURCE_REVISION,
    publishedAt: APPROVED_PUBLISHED_AT,
    archive: {
      sourcePath: 'rollback/v2.2.0/pages-build.tar.gz',
      candidatePath: 'evidence/rollback-v2.2.0/pages-build.tar.gz',
      bytes: archiveContents.byteLength,
      sha256: APPROVED_ARCHIVE_SHA256,
    },
    manifest: {
      sourcePath: 'rollback/v2.2.0/manifest.json',
      candidatePath: 'evidence/rollback-v2.2.0/manifest.json',
      bytes: manifestContents.byteLength,
      sha256: sha256(manifestContents),
    },
    releaseChecksums: {
      sourcePath: 'rollback/v2.2.0/release-checksums.sha256',
      candidatePath: 'evidence/rollback-v2.2.0/release-checksums.sha256',
      bytes: releaseChecksumsContents.byteLength,
      sha256: APPROVED_RELEASE_CHECKSUMS_SHA256,
    },
    runtimePolicy: expectedPolicy,
    runtimeFiles,
    publicFiles,
    excludedPublicSourceMaps,
    excludedNonRuntimeFiles,
  };
  return {
    provenance,
    archiveContents,
    manifestContents,
    releaseChecksumsContents,
    archiveFiles,
  };
}

export async function writeApprovedRollback(
  bundle: ApprovedRollbackBundle,
  candidateRoot: string,
): Promise<void> {
  for (const file of bundle.provenance.publicFiles) {
    const contents = bundle.archiveFiles.get(file.path);
    if (contents === undefined)
      throw new Error(`Approved rollback runtime disappeared: ${file.path}`);
    for (const candidatePath of file.candidatePaths) {
      const destination = resolve(
        candidateRoot,
        ...safePath(candidatePath, 'Rollback output').split('/'),
      );
      const collision = await lstat(destination).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (collision !== undefined) {
        throw new Error(
          `Approved rollback output collides with the built artifact: ${candidatePath}`,
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
  }
  for (const [candidatePath, contents] of [
    [bundle.provenance.archive.candidatePath, bundle.archiveContents],
    [bundle.provenance.manifest.candidatePath, bundle.manifestContents],
    [bundle.provenance.releaseChecksums.candidatePath, bundle.releaseChecksumsContents],
  ] as const) {
    const destination = resolve(candidateRoot, ...candidatePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
}

export async function loadRetainedApprovedRollback(
  candidateRoot: string,
): Promise<ApprovedRollbackBundle> {
  const evidenceRoot = join(candidateRoot, 'evidence', 'rollback-v2.2.0');
  const archiveContents = await requiredFile(
    join(evidenceRoot, 'pages-build.tar.gz'),
    'Retained approved rollback archive',
  );
  const manifestContents = await requiredFile(
    join(evidenceRoot, 'manifest.json'),
    'Retained approved rollback manifest',
  );
  const releaseChecksumsContents = await requiredFile(
    join(evidenceRoot, 'release-checksums.sha256'),
    'Retained approved rollback release checksums',
  );

  const virtualRepository = {
    archiveContents,
    manifestContents,
    releaseChecksumsContents,
  };
  return loadApprovedRollbackFromContents(virtualRepository);
}

async function loadApprovedRollbackFromContents(contents: {
  archiveContents: Buffer;
  manifestContents: Buffer;
  releaseChecksumsContents: Buffer;
}): Promise<ApprovedRollbackBundle> {
  return validateApprovedRollbackContents(contents);
}

function validateApprovedRollbackContents(contents: {
  archiveContents: Buffer;
  manifestContents: Buffer;
  releaseChecksumsContents: Buffer;
}): ApprovedRollbackBundle {
  // Reuse the same strict parser by validating the retained bytes directly.
  const { archiveContents, manifestContents, releaseChecksumsContents } = contents;
  if (sha256(archiveContents) !== APPROVED_ARCHIVE_SHA256) {
    throw new Error('Retained rollback archive does not match the pinned SHA-256.');
  }
  if (sha256(releaseChecksumsContents) !== APPROVED_RELEASE_CHECKSUMS_SHA256) {
    throw new Error('Retained rollback checksums do not match the pinned SHA-256.');
  }
  if (
    !releaseChecksumsContents
      .toString('utf8')
      .split(/\r?\n/u)
      .includes(`${APPROVED_ARCHIVE_SHA256}  pages-build.tar.gz`)
  ) {
    throw new Error('Retained rollback checksums do not identify the pinned archive.');
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestContents.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Retained rollback manifest is not valid JSON.', { cause: error });
  }
  const manifest = asObject(manifestValue, 'Retained rollback manifest');
  const archive = asObject(manifest.archive, 'Retained rollback archive identity');
  const releaseChecksums = asObject(
    manifest.releaseChecksums,
    'Retained rollback checksum identity',
  );
  if (
    manifest.schemaVersion !== 'fdw-approved-rollback.v1' ||
    manifest.releaseTag !== APPROVED_RELEASE_TAG ||
    manifest.sourceRevision !== APPROVED_SOURCE_REVISION ||
    manifest.publishedAt !== APPROVED_PUBLISHED_AT ||
    manifest.releaseUrl !== APPROVED_RELEASE_URL ||
    archive.path !== 'rollback/v2.2.0/pages-build.tar.gz' ||
    archive.sourceUrl !== APPROVED_ARCHIVE_SOURCE_URL ||
    archive.sha256 !== APPROVED_ARCHIVE_SHA256 ||
    archive.bytes !== archiveContents.byteLength ||
    releaseChecksums.path !== 'rollback/v2.2.0/release-checksums.sha256' ||
    releaseChecksums.sha256 !== APPROVED_RELEASE_CHECKSUMS_SHA256
  ) {
    throw new Error('Retained rollback manifest does not match the pinned release identity.');
  }
  const archiveFiles = parseTarGzip(archiveContents);
  if (!Array.isArray(manifest.runtimeFiles) || manifest.runtimeFiles.length === 0)
    throw new Error('Retained rollback runtime list is missing.');
  const seenRuntimePaths = new Set<string>();
  const runtimeFiles = manifest.runtimeFiles.map((value, index) => {
    const declared = asObject(value, `Retained rollback runtime file ${index}`);
    const path = safePath(
      requiredString(declared.path, 'Retained rollback runtime path'),
      'Runtime',
    );
    if (seenRuntimePaths.has(path) || /\.map$/iu.test(path) || path === 'sbom.cdx.json') {
      throw new Error(`Retained rollback runtime path is invalid or duplicated: ${path}`);
    }
    seenRuntimePaths.add(path);
    const file = archiveFiles.get(path);
    if (file === undefined) throw new Error(`Retained rollback archive is missing ${path}.`);
    const actual = identity(path, file);
    if (declared.bytes !== actual.bytes || declared.sha256 !== actual.sha256) {
      throw new Error(`Retained rollback runtime identity is invalid: ${path}`);
    }
    return actual;
  });
  runtimeFiles.sort((left, right) => comparePaths(left.path, right.path));
  const runtimePaths = new Set(runtimeFiles.map((file) => file.path));
  if (!runtimePaths.has('index.html')) throw new Error('Retained rollback index.html is missing.');
  const excludedPublicSourceMaps: RollbackFileIdentity[] = [];
  const excludedNonRuntimeFiles: RollbackFileIdentity[] = [];
  for (const [path, file] of archiveFiles) {
    if (runtimePaths.has(path)) continue;
    (/\.map$/iu.test(path) ? excludedPublicSourceMaps : excludedNonRuntimeFiles).push(
      identity(path, file),
    );
  }
  excludedPublicSourceMaps.sort((left, right) => comparePaths(left.path, right.path));
  excludedNonRuntimeFiles.sort((left, right) => comparePaths(left.path, right.path));
  if (excludedPublicSourceMaps.length === 0) {
    throw new Error('Retained rollback source-map exclusions are missing.');
  }
  if (
    excludedNonRuntimeFiles.length !== 1 ||
    excludedNonRuntimeFiles[0]?.path !== 'sbom.cdx.json'
  ) {
    throw new Error('Retained rollback archive has undeclared non-runtime files.');
  }
  const runtimePolicy = asObject(manifest.runtimePolicy, 'Retained rollback runtime policy');
  const expectedPolicy: ApprovedRollbackProvenance['runtimePolicy'] = {
    entryPath: 'index.html',
    compatibilityUrl: '/v2.html',
    approvedBasePath: '/Aviation-Dashboard-Project/',
    excludeFromPublicRuntime: ['**/*.map', 'sbom.cdx.json'],
    retainOriginalArchiveAsEvidence: true,
  };
  if (!sameJson(runtimePolicy, expectedPolicy)) {
    throw new Error('Retained rollback runtime policy is invalid.');
  }
  const provenance: ApprovedRollbackProvenance = {
    schemaVersion: 'fdw-approved-rollback.v1',
    releaseTag: 'v2.2.0',
    sourceRevision: APPROVED_SOURCE_REVISION,
    publishedAt: APPROVED_PUBLISHED_AT,
    archive: {
      sourcePath: 'rollback/v2.2.0/pages-build.tar.gz',
      candidatePath: 'evidence/rollback-v2.2.0/pages-build.tar.gz',
      bytes: archiveContents.byteLength,
      sha256: APPROVED_ARCHIVE_SHA256,
    },
    manifest: {
      sourcePath: 'rollback/v2.2.0/manifest.json',
      candidatePath: 'evidence/rollback-v2.2.0/manifest.json',
      bytes: manifestContents.byteLength,
      sha256: sha256(manifestContents),
    },
    releaseChecksums: {
      sourcePath: 'rollback/v2.2.0/release-checksums.sha256',
      candidatePath: 'evidence/rollback-v2.2.0/release-checksums.sha256',
      bytes: releaseChecksumsContents.byteLength,
      sha256: APPROVED_RELEASE_CHECKSUMS_SHA256,
    },
    runtimePolicy: expectedPolicy,
    runtimeFiles,
    publicFiles: runtimeFiles.map((file) => ({
      ...file,
      candidatePaths: publicCandidatePaths(file.path),
    })),
    excludedPublicSourceMaps,
    excludedNonRuntimeFiles,
  };
  return { provenance, archiveContents, manifestContents, releaseChecksumsContents, archiveFiles };
}

export async function verifyApprovedRollbackRuntime(
  candidateRoot: string,
  expected: ApprovedRollbackProvenance,
): Promise<Set<string>> {
  const retained = await loadRetainedApprovedRollback(candidateRoot);
  if (!sameJson(retained.provenance, expected)) {
    throw new Error('Retained approved rollback does not match candidate provenance.');
  }
  const allowedSourceMapReferences = new Set<string>();
  for (const file of retained.provenance.publicFiles) {
    const expectedContents = retained.archiveFiles.get(file.path);
    if (expectedContents === undefined)
      throw new Error(`Rollback runtime is missing ${file.path}.`);
    for (const candidatePath of file.candidatePaths) {
      const actual = await requiredFile(
        resolve(candidateRoot, ...candidatePath.split('/')),
        `Retained rollback runtime ${candidatePath}`,
      );
      if (!actual.equals(expectedContents)) {
        throw new Error(
          `Retained rollback runtime bytes do not match ${file.path}: ${candidatePath}`,
        );
      }
      if (/sourceMappingURL\s*=/iu.test(actual.toString('utf8'))) {
        allowedSourceMapReferences.add(candidatePath);
      }
    }
  }
  return allowedSourceMapReferences;
}
