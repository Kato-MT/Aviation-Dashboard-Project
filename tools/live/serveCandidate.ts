import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertV4MiniflareOptions,
  Miniflare,
  type Json,
  type V4MiniflareOptions,
  type V4WorkerOptions,
} from 'miniflare';

import {
  captureCandidateTreeIdentity,
  captureSourceIdentity,
  candidateSelectionRecordPath,
  sameCandidateTreeIdentity,
  sameSourceIdentity,
  verifyRetainedCandidate,
  type CandidateTreeIdentity,
  type RetainedCandidateProvenance,
  type SourceIdentity,
  type VerifyCandidateOptions,
} from './retainCandidate';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_PORT = 4174;
const SEED_CONCURRENCY = 12;
const SEED_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface MapAsset {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface RetainedMapManifest {
  schemaVersion: 'map-assets.v1';
  id: string;
  totalBytes: number;
  assets: MapAsset[];
}

interface RetainedWorkerRuntime {
  name: string;
  scriptPath: string;
  modulesRoot: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: Record<string, Json>;
  runWorkerFirst: boolean | string[];
  htmlHandling: 'none';
  assetBinding: string;
  bucketName: string;
  durableObjectClassName: string;
  mockProviderBinding: string;
}

interface RetainedMockRuntime {
  name: string;
  scriptPath: string;
  modulesRoot: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: Record<string, Json>;
}

interface CandidateRuntimeConfiguration {
  candidateDirectory: string;
  artifactRoot: string;
  clientRoot: string;
  mapPayloadRoot: string;
  provenance: RetainedCandidateProvenance;
  manifest: RetainedMapManifest;
  worker: RetainedWorkerRuntime;
  mock: RetainedMockRuntime;
}

export interface CandidateServerEnvironment {
  candidateDirectory: string;
  selectionRecordPath?: string;
  expectedSelectionRecordSha256?: string;
  expectedCandidateId?: string;
  expectedSourceHead?: string;
  host: '127.0.0.1';
  port: number;
}

export interface VerifiedCandidateSnapshot {
  stagingRoot: string;
  sourceCandidateDirectory: string;
  candidateDirectory: string;
  provenance: RetainedCandidateProvenance;
  sourceIdentity: CandidateTreeIdentity;
  snapshotIdentity: CandidateTreeIdentity;
  verification: VerifyCandidateOptions;
}

export interface CandidateSnapshotDependencies {
  verifyCandidate?: typeof verifyRetainedCandidate;
  captureIdentity?: typeof captureCandidateTreeIdentity;
  copyCandidate?: (source: string, destination: string) => Promise<void>;
}

interface SeedReceipt {
  index: number;
  path: string;
  bytes: number;
  sha256: string;
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

function safeRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/iu.test(path) ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`${label} contains an unsafe relative path: ${path}`);
  }
  return path;
}

function within(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const difference = relative(resolvedRoot, resolvedPath);
  if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new Error(`${label} leaves its retained candidate root.`);
  }
  return resolvedPath;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function jsonBindings(value: unknown, label: string): Record<string, Json> {
  const object = asObject(value, label);
  const bindings: Record<string, Json> = {};
  for (const [name, binding] of Object.entries(object)) {
    if (typeof binding !== 'string') throw new Error(`${label}.${name} must be a string.`);
    bindings[name] = binding;
  }
  return bindings;
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}`, { cause: error });
  }
  return asObject(parsed, label);
}

function compatibilityFlags(config: Record<string, unknown>, label: string): string[] {
  const value = config.compatibility_flags;
  if (value === undefined) return [];
  const flags = requiredArray(value, `${label} compatibility flags`);
  if (!flags.every((flag) => typeof flag === 'string')) {
    throw new Error(`${label} compatibility flags must be strings.`);
  }
  return flags as string[];
}

function findNamedBinding(
  value: unknown,
  bindingName: string,
  label: string,
): Record<string, unknown> {
  const bindings = requiredArray(asObject(value, label).bindings, `${label} bindings`).map(
    (binding, index) => asObject(binding, `${label} binding ${index}`),
  );
  const matches = bindings.filter((binding) => binding.name === bindingName);
  if (matches.length !== 1) throw new Error(`${label} must bind ${bindingName} exactly once.`);
  return matches[0]!;
}

function findNamedEntry(value: unknown, name: string, label: string): Record<string, unknown> {
  const entries = requiredArray(value, label).map((entry, index) =>
    asObject(entry, `${label} entry ${index}`),
  );
  const matches = entries.filter((entry) => entry.binding === name);
  if (matches.length !== 1) throw new Error(`${label} must bind ${name} exactly once.`);
  return matches[0]!;
}

function manifestAsset(value: unknown, index: number): MapAsset {
  const asset = asObject(value, `Map manifest asset ${index}`);
  const path = safeRelativePath(asset.path, `Map manifest asset ${index} path`);
  const bytes = requiredInteger(asset.bytes, `Map manifest asset ${path} bytes`);
  if (bytes === 0) throw new Error(`Map manifest asset ${path} must be non-empty.`);
  return {
    path,
    bytes,
    sha256: requiredSha256(asset.sha256, `Map manifest asset ${path} digest`),
    contentType: requiredString(asset.contentType, `Map manifest asset ${path} content type`),
  };
}

export async function loadRetainedMapManifest(
  candidateDirectory: string,
  provenance: RetainedCandidateProvenance,
): Promise<RetainedMapManifest> {
  const manifestPath = within(
    candidateDirectory,
    join(candidateDirectory, ...provenance.mapManifest.candidatePath.split('/')),
    'Retained map manifest',
  );
  const document = await readJsonObject(manifestPath, 'Retained map manifest');
  const assets = requiredArray(document.assets, 'Retained map manifest assets').map(manifestAsset);
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.path)) throw new Error(`Retained map manifest duplicates ${asset.path}.`);
    seen.add(asset.path);
  }
  const manifest: RetainedMapManifest = {
    schemaVersion: document.schemaVersion as 'map-assets.v1',
    id: requiredString(document.id, 'Retained map manifest id'),
    totalBytes: requiredInteger(document.totalBytes, 'Retained map manifest total bytes'),
    assets,
  };
  if (
    document.schemaVersion !== 'map-assets.v1' ||
    manifest.id !== provenance.mapManifest.id ||
    assets.length !== provenance.mapManifest.assetCount ||
    manifest.totalBytes !== provenance.mapManifest.totalBytes ||
    assets.reduce((total, asset) => total + asset.bytes, 0) !== manifest.totalBytes
  ) {
    throw new Error('Retained map manifest does not match candidate provenance.');
  }
  return manifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyRetainedMapPayload(
  mapPayloadRoot: string,
  manifest: RetainedMapManifest,
): Promise<void> {
  for (const asset of manifest.assets) {
    const path = within(
      mapPayloadRoot,
      join(mapPayloadRoot, ...asset.path.split('/')),
      `Retained map asset ${asset.path}`,
    );
    const status = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Retained map asset is missing: ${asset.path}`);
      }
      throw error;
    });
    if (!status.isFile() || status.isSymbolicLink() || status.size !== asset.bytes) {
      throw new Error(`Retained map asset has the wrong file identity: ${asset.path}`);
    }
    if ((await sha256File(path)) !== asset.sha256) {
      throw new Error(`Retained map asset has the wrong SHA-256: ${asset.path}`);
    }
  }
}

async function loadRuntimeConfiguration(
  candidateDirectory: string,
  provenance: RetainedCandidateProvenance,
): Promise<Omit<CandidateRuntimeConfiguration, 'manifest' | 'mapPayloadRoot'>> {
  const artifactRoot = within(
    candidateDirectory,
    join(candidateDirectory, provenance.retainedArtifact.path),
    'Retained artifact',
  );
  const clientRoot = within(artifactRoot, join(artifactRoot, 'client'), 'Retained client');
  const workerRoot = within(
    artifactRoot,
    join(artifactRoot, dirname(provenance.application.workerEntrypoint)),
    'Retained airspace worker',
  );
  const mockRoot = within(
    artifactRoot,
    join(artifactRoot, dirname(provenance.application.mockProviderEntrypoint)),
    'Retained mock provider',
  );
  const workerConfig = await readJsonObject(
    join(workerRoot, 'wrangler.json'),
    'Retained airspace Worker configuration',
  );
  const mockConfig = await readJsonObject(
    join(mockRoot, 'wrangler.json'),
    'Retained mock-provider configuration',
  );
  const workerName = requiredString(workerConfig.name, 'Retained airspace Worker name');
  const mockName = requiredString(mockConfig.name, 'Retained mock-provider name');
  const workerMain = safeRelativePath(workerConfig.main, 'Retained airspace Worker entrypoint');
  const mockMain = safeRelativePath(mockConfig.main, 'Retained mock-provider entrypoint');
  const workerBindings = jsonBindings(workerConfig.vars, 'Retained airspace Worker vars');
  const mockBindings = jsonBindings(mockConfig.vars, 'Retained mock-provider vars');
  const assets = asObject(workerConfig.assets, 'Retained airspace Worker assets');
  const assetDirectory = within(
    artifactRoot,
    resolve(workerRoot, requiredString(assets.directory, 'Retained client directory')),
    'Retained client directory',
  );
  const runWorkerFirstValue = assets.run_worker_first;
  const runWorkerFirst =
    typeof runWorkerFirstValue === 'boolean'
      ? runWorkerFirstValue
      : requiredArray(runWorkerFirstValue, 'Retained worker-first routes').map((route, index) =>
          requiredString(route, `Retained worker-first route ${index}`),
        );
  const htmlHandling = requiredString(assets.html_handling, 'Retained HTML asset handling policy');
  const durableObject = findNamedBinding(
    workerConfig.durable_objects,
    'REGION_FEEDS',
    'Retained durable objects',
  );
  const r2 = findNamedEntry(workerConfig.r2_buckets, 'MAP_ASSETS', 'Retained R2 bindings');
  const service = findNamedEntry(
    workerConfig.services,
    'MOCK_PROVIDER',
    'Retained service bindings',
  );
  if (
    workerName !== provenance.application.workerName ||
    mockName !== provenance.application.mockProviderName ||
    `airspace_worker/${workerMain}` !== provenance.application.workerEntrypoint ||
    `mock_provider/${mockMain}` !== provenance.application.mockProviderEntrypoint ||
    workerBindings.LIVE_BUILD_TARGET !== 'mock-staging' ||
    workerBindings.LIVE_PROVIDER_MODE !== 'mock' ||
    assetDirectory !== clientRoot ||
    requiredString(assets.binding, 'Retained asset binding') !== 'ASSETS' ||
    htmlHandling !== 'none' ||
    assets.not_found_handling !== 'none' ||
    requiredString(durableObject.class_name, 'Retained durable-object class') !==
      'RegionalFeedHub' ||
    requiredString(service.service, 'Retained mock-provider service') !== mockName ||
    mockBindings.MOCK_SCENARIO !== 'nominal'
  ) {
    throw new Error('Retained Worker runtime configuration is not the verified mock candidate.');
  }
  return {
    candidateDirectory,
    artifactRoot,
    clientRoot,
    provenance,
    worker: {
      name: workerName,
      scriptPath: within(workerRoot, join(workerRoot, workerMain), 'Retained worker script'),
      modulesRoot: workerRoot,
      compatibilityDate: requiredString(
        workerConfig.compatibility_date,
        'Retained airspace Worker compatibility date',
      ),
      compatibilityFlags: compatibilityFlags(workerConfig, 'Retained airspace Worker'),
      bindings: workerBindings,
      runWorkerFirst,
      htmlHandling,
      assetBinding: 'ASSETS',
      bucketName: requiredString(r2.bucket_name, 'Retained R2 bucket name'),
      durableObjectClassName: 'RegionalFeedHub',
      mockProviderBinding: 'MOCK_PROVIDER',
    },
    mock: {
      name: mockName,
      scriptPath: within(mockRoot, join(mockRoot, mockMain), 'Retained mock-provider script'),
      modulesRoot: mockRoot,
      compatibilityDate: requiredString(
        mockConfig.compatibility_date,
        'Retained mock-provider compatibility date',
      ),
      compatibilityFlags: compatibilityFlags(mockConfig, 'Retained mock provider'),
      bindings: mockBindings,
    },
  };
}

export function candidateServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CandidateServerEnvironment {
  const configuredCandidate = environment.M34_CANDIDATE_DIRECTORY?.trim();
  if (!configuredCandidate) {
    throw new Error('M34_CANDIDATE_DIRECTORY is required and must name a retained candidate.');
  }
  const rawPort = environment.LIVE_TEST_PORT?.trim() || String(DEFAULT_PORT);
  if (!/^\d{4,5}$/u.test(rawPort)) throw new Error('LIVE_TEST_PORT is invalid.');
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('LIVE_TEST_PORT is invalid.');
  }
  const expectedSourceHead = environment.M34_EXPECTED_SOURCE_HEAD?.trim();
  const selectionRecordPath = environment.M34_SELECTION_RECORD_PATH?.trim();
  const expectedSelectionRecordSha256 = environment.M34_EXPECTED_SELECTION_SHA256?.trim();
  const expectedCandidateId = environment.M34_EXPECTED_CANDIDATE_ID?.trim();
  if (!expectedSelectionRecordSha256 && !expectedCandidateId) {
    throw new Error(
      'M34_EXPECTED_SELECTION_SHA256 or M34_EXPECTED_CANDIDATE_ID is required for retained-candidate serving.',
    );
  }
  return {
    candidateDirectory: resolve(configuredCandidate),
    host: '127.0.0.1',
    port,
    ...(selectionRecordPath ? { selectionRecordPath: resolve(selectionRecordPath) } : {}),
    ...(expectedSelectionRecordSha256 ? { expectedSelectionRecordSha256 } : {}),
    ...(expectedCandidateId ? { expectedCandidateId } : {}),
    ...(expectedSourceHead ? { expectedSourceHead } : {}),
  };
}

function candidateVerification(
  candidateDirectory: string,
  environment: CandidateServerEnvironment,
  source: SourceIdentity,
): VerifyCandidateOptions {
  return {
    candidateDirectory,
    selectionRecordPath:
      environment.selectionRecordPath ??
      candidateSelectionRecordPath(environment.candidateDirectory),
    expectedSourceIdentity: source,
    expectedSourceHead: environment.expectedSourceHead ?? source.head,
    expectedTarget: 'mock-staging',
    ...(environment.expectedSelectionRecordSha256 === undefined
      ? {}
      : { expectedSelectionRecordSha256: environment.expectedSelectionRecordSha256 }),
    ...(environment.expectedCandidateId === undefined
      ? {}
      : { expectedCandidateId: environment.expectedCandidateId }),
  };
}

async function copyCandidate(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
}

export async function createVerifiedCandidateSnapshot(
  environment: CandidateServerEnvironment,
  source: SourceIdentity,
  dependencies: CandidateSnapshotDependencies = {},
): Promise<VerifiedCandidateSnapshot> {
  const verifier = dependencies.verifyCandidate ?? verifyRetainedCandidate;
  const captureIdentity = dependencies.captureIdentity ?? captureCandidateTreeIdentity;
  const copier = dependencies.copyCandidate ?? copyCandidate;
  const sourceVerification = candidateVerification(
    environment.candidateDirectory,
    environment,
    source,
  );
  const provenance = await verifier(sourceVerification);
  const sourceIdentity = await captureIdentity(environment.candidateDirectory);
  const stagingRoot = await mkdtemp(join(tmpdir(), 'fdw-candidate-runtime-'));
  const snapshotDirectory = join(stagingRoot, 'candidate');
  try {
    await copier(environment.candidateDirectory, snapshotDirectory);
    const [sourceAfterCopy, snapshotIdentity] = await Promise.all([
      captureIdentity(environment.candidateDirectory),
      captureIdentity(snapshotDirectory),
    ]);
    if (
      !sameCandidateTreeIdentity(sourceIdentity, sourceAfterCopy) ||
      !sameCandidateTreeIdentity(sourceIdentity, snapshotIdentity)
    ) {
      throw new Error('Candidate source or private snapshot changed while it was copied.');
    }
    const verification = candidateVerification(snapshotDirectory, environment, source);
    const snapshotProvenance = await verifier(verification);
    if (JSON.stringify(snapshotProvenance) !== JSON.stringify(provenance)) {
      throw new Error('Private candidate snapshot provenance does not match the selected source.');
    }
    const finalSourceIdentity = await captureIdentity(environment.candidateDirectory);
    if (!sameCandidateTreeIdentity(sourceIdentity, finalSourceIdentity)) {
      throw new Error('Candidate source changed while its private snapshot was verified.');
    }
    return {
      stagingRoot,
      sourceCandidateDirectory: environment.candidateDirectory,
      candidateDirectory: snapshotDirectory,
      provenance,
      sourceIdentity,
      snapshotIdentity,
      verification,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function completeVerifiedCandidateSnapshot(
  snapshot: VerifiedCandidateSnapshot,
  source: SourceIdentity,
  dependencies: CandidateSnapshotDependencies = {},
): Promise<void> {
  const verifier = dependencies.verifyCandidate ?? verifyRetainedCandidate;
  const captureIdentity = dependencies.captureIdentity ?? captureCandidateTreeIdentity;
  const snapshotProvenance = await verifier({
    ...snapshot.verification,
    candidateDirectory: snapshot.candidateDirectory,
    expectedSourceIdentity: source,
  });
  if (JSON.stringify(snapshotProvenance) !== JSON.stringify(snapshot.provenance)) {
    throw new Error('Private candidate snapshot provenance changed during execution.');
  }
  const snapshotAfter = await captureIdentity(snapshot.candidateDirectory);
  if (!sameCandidateTreeIdentity(snapshot.snapshotIdentity, snapshotAfter)) {
    throw new Error('Private candidate snapshot changed during execution.');
  }
  const sourceProvenance = await verifier({
    ...snapshot.verification,
    candidateDirectory: snapshot.sourceCandidateDirectory,
    expectedSourceIdentity: source,
  });
  const sourceAfter = await captureIdentity(snapshot.sourceCandidateDirectory);
  if (
    JSON.stringify(sourceProvenance) !== JSON.stringify(snapshot.provenance) ||
    !sameCandidateTreeIdentity(snapshot.sourceIdentity, sourceAfter)
  ) {
    throw new Error('Selected candidate source changed during execution.');
  }
}

export async function disposeVerifiedCandidateSnapshot(
  snapshot: VerifiedCandidateSnapshot,
): Promise<void> {
  const stagingRoot = resolve(snapshot.stagingRoot);
  const temporaryRoot = resolve(tmpdir());
  const relativePath = relative(temporaryRoot, stagingRoot);
  if (
    dirname(relativePath) !== '.' ||
    !basename(stagingRoot).startsWith('fdw-candidate-runtime-')
  ) {
    throw new Error('Refusing to remove an unrecognized candidate snapshot directory.');
  }
  await rm(stagingRoot, { recursive: true, force: true });
}

const BOOTSTRAP_WORKER = String.raw`
let ready = false;
const seeded = new Set();

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function authorized(request, env) {
  return request.headers.get('x-m34-seed-secret') === env.SEED_SECRET;
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__m34/runtime-egress' && request.method === 'GET') {
      const status = await env.EGRESS_AUDIT.fetch(
        new Request('http://m34-egress/__m34/status', {
          headers: { 'x-m34-seed-secret': env.SEED_SECRET },
        }),
      );
      return new Response(status.body, { status: status.status, headers: status.headers });
    }
    if (url.pathname.startsWith('/__m34/')) {
      if (!authorized(request, env)) return json({ error: 'NOT_FOUND' }, 404);
      const match = url.pathname.match(/^\/__m34\/seed\/(\d+)$/);
      if (match && request.method === 'POST') {
        const index = Number(match[1]);
        const asset = env.MAP_MANIFEST[index];
        if (!asset || !Number.isSafeInteger(index)) return json({ error: 'INVALID_SEED_INDEX' }, 400);
        const source = await env.MAP_SOURCE.fetch(
          new Request('http://map-source/' + encodedPath(asset.path)),
        );
        if (!source.ok) return json({ error: 'MAP_SOURCE_UNAVAILABLE', index }, 500);
        const declaredLength = source.headers.get('content-length');
        if (declaredLength !== null && Number(declaredLength) !== asset.bytes) {
          return json({ error: 'MAP_SOURCE_SIZE_MISMATCH', index }, 500);
        }
        const key = env.MAP_ID + '/' + asset.path;
        await env.MAP_ASSETS.put(key, source.body, {
          httpMetadata: { contentType: asset.contentType },
          customMetadata: { sha256: asset.sha256 },
        });
        const stored = await env.MAP_ASSETS.head(key);
        if (
          !stored ||
          stored.size !== asset.bytes ||
          stored.customMetadata?.sha256 !== asset.sha256
        ) {
          return json({ error: 'R2_SEED_IDENTITY_MISMATCH', index }, 500);
        }
        seeded.add(index);
        return json({ index, path: asset.path, bytes: stored.size, sha256: asset.sha256 });
      }
      if (url.pathname === '/__m34/finish' && request.method === 'POST') {
        if (seeded.size !== env.MAP_MANIFEST.length) {
          return json(
            { error: 'MAP_SEED_INCOMPLETE', seeded: seeded.size, expected: env.MAP_MANIFEST.length },
            409,
          );
        }
        ready = true;
        return json({ candidateId: env.CANDIDATE_ID, mapId: env.MAP_ID, seeded: seeded.size });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    }
    if (!ready) {
      return json({ error: 'M34_CANDIDATE_STARTING' }, 503, { 'retry-after': '1' });
    }
    return env.MAIN.fetch(request);
  },
};
`;

const EGRESS_BLOCKER_WORKER = String.raw`
let blockedAttempts = 0;

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === '/__m34/status' &&
      request.headers.get('x-m34-seed-secret') === env.SEED_SECRET
    ) {
      return Response.json(
        { blockedAttempts },
        { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
      );
    }
    blockedAttempts += 1;
    return Response.json(
      { error: 'M34_EXTERNAL_NETWORK_BLOCKED' },
      {
        status: 502,
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      },
    );
  },
};
`;

function externalNetworkBlocker(): Promise<Response> {
  return Promise.resolve(
    Response.json(
      { error: 'M34_EXTERNAL_NETWORK_BLOCKED' },
      {
        status: 502,
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      },
    ),
  );
}

function manifestBinding(manifest: RetainedMapManifest): Json {
  return manifest.assets.map((asset) => ({ ...asset })) as Json;
}

export interface RetainedMiniflareAssetOptions {
  directory: string;
  binding: string;
  runWorkerFirst: boolean | string[];
  htmlHandling: 'none';
}

export function retainedMiniflareAssets(options: RetainedMiniflareAssetOptions) {
  return {
    directory: options.directory,
    binding: options.binding,
    run_worker_first: options.runWorkerFirst,
    // The v5 converter needs this internal fact to route Worker-first requests to the retained
    // script. It derives the owning Worker from the enclosing worker configuration.
    routerConfig: { has_user_worker: true },
    assetConfig: {
      html_handling: options.htmlHandling,
      not_found_handling: 'none' as const,
    },
  };
}

function miniflareOptions(
  runtime: CandidateRuntimeConfiguration,
  environment: CandidateServerEnvironment,
  secret: string,
  resourceTmpPath: string,
): V4MiniflareOptions {
  const bootstrapName = 'm34-retained-candidate-entry';
  const egressName = 'm34-external-egress-blocker';
  const localOrigin = `http://${environment.host}:${environment.port}`;
  // Every retained worker's global fetch is routed through the local audit worker. The audit
  // worker counts and rejects attempts, and its own fallback is a Node-side response that never
  // opens a socket. Service bindings between the retained main and mock workers stay internal.
  const outboundService = egressName;
  const bootstrap: V4WorkerOptions = {
    name: bootstrapName,
    script: BOOTSTRAP_WORKER,
    modules: true,
    compatibilityDate: runtime.worker.compatibilityDate,
    bindings: {
      CANDIDATE_ID: runtime.provenance.candidateId,
      MAP_ID: runtime.manifest.id,
      MAP_MANIFEST: manifestBinding(runtime.manifest),
      SEED_SECRET: secret,
    },
    serviceBindings: {
      MAIN: runtime.worker.name,
      EGRESS_AUDIT: egressName,
      MAP_SOURCE: { disk: { path: runtime.mapPayloadRoot, writable: false } },
    },
    r2Buckets: { MAP_ASSETS: runtime.worker.bucketName },
    outboundService,
    unsafeRegisterWorker: false,
  };
  const worker: V4WorkerOptions = {
    name: runtime.worker.name,
    scriptPath: runtime.worker.scriptPath,
    modules: true,
    modulesRoot: runtime.worker.modulesRoot,
    compatibilityDate: runtime.worker.compatibilityDate,
    compatibilityFlags: runtime.worker.compatibilityFlags,
    bindings: {
      ...runtime.worker.bindings,
      ALLOWED_ORIGINS: localOrigin,
    },
    serviceBindings: {
      [runtime.worker.mockProviderBinding]: runtime.mock.name,
    },
    durableObjects: {
      REGION_FEEDS: {
        className: runtime.worker.durableObjectClassName,
        useSQLite: true,
      },
    },
    r2Buckets: { MAP_ASSETS: runtime.worker.bucketName },
    assets: retainedMiniflareAssets({
      directory: runtime.clientRoot,
      binding: runtime.worker.assetBinding,
      runWorkerFirst: runtime.worker.runWorkerFirst,
      htmlHandling: runtime.worker.htmlHandling,
    }),
    outboundService,
    unsafeRegisterWorker: false,
  };
  const mock: V4WorkerOptions = {
    name: runtime.mock.name,
    scriptPath: runtime.mock.scriptPath,
    modules: true,
    modulesRoot: runtime.mock.modulesRoot,
    compatibilityDate: runtime.mock.compatibilityDate,
    compatibilityFlags: runtime.mock.compatibilityFlags,
    bindings: runtime.mock.bindings,
    outboundService,
    unsafeRegisterWorker: false,
  };
  const egress: V4WorkerOptions = {
    name: egressName,
    script: EGRESS_BLOCKER_WORKER,
    modules: true,
    compatibilityDate: runtime.worker.compatibilityDate,
    bindings: { SEED_SECRET: secret },
    outboundService: externalNetworkBlocker,
    unsafeRegisterWorker: false,
  };
  return {
    host: environment.host,
    port: environment.port,
    logRequests: false,
    resourceTmpPath,
    telemetry: { enabled: false },
    workers: [bootstrap, worker, mock, egress],
  };
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
  try {
    return asObject(JSON.parse(body) as unknown, label);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

async function seedMapAssets(
  origin: string,
  manifest: RetainedMapManifest,
  secret: string,
  shutdownSignal: AbortSignal,
): Promise<void> {
  let nextIndex = 0;
  const seedOne = async (index: number): Promise<void> => {
    const response = await fetch(`${origin}/__m34/seed/${index}`, {
      method: 'POST',
      headers: { 'x-m34-seed-secret': secret },
      signal: AbortSignal.any([shutdownSignal, AbortSignal.timeout(SEED_TIMEOUT_MS)]),
    });
    const receipt = (await responseJson(response, `Map seed ${index}`)) as unknown as SeedReceipt;
    const expected = manifest.assets[index];
    if (
      expected === undefined ||
      receipt.index !== index ||
      receipt.path !== expected.path ||
      receipt.bytes !== expected.bytes ||
      receipt.sha256 !== expected.sha256
    ) {
      throw new Error(`Map seed ${index} returned the wrong retained identity.`);
    }
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= manifest.assets.length) return;
      await seedOne(index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SEED_CONCURRENCY, manifest.assets.length) }, () => worker()),
  );
  const finish = await fetch(`${origin}/__m34/finish`, {
    method: 'POST',
    headers: { 'x-m34-seed-secret': secret },
    signal: AbortSignal.any([shutdownSignal, AbortSignal.timeout(SEED_TIMEOUT_MS)]),
  });
  const receipt = await responseJson(finish, 'Map seed completion');
  if (receipt.mapId !== manifest.id || receipt.seeded !== manifest.assets.length) {
    throw new Error('Map seed completion returned the wrong retained identity.');
  }
}

function shutdownLatch(): {
  signal: AbortSignal;
  promise: Promise<NodeJS.Signals>;
  requested(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let requested = false;
  let resolveShutdown!: (signal: NodeJS.Signals) => void;
  const promise = new Promise<NodeJS.Signals>((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = () => {
      if (requested) return;
      requested = true;
      controller.abort(new Error(`Candidate runtime received ${signal}.`));
      resolveShutdown(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    signal: controller.signal,
    promise,
    requested: () => requested,
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

async function runVerifiedCandidateSnapshot(
  snapshot: VerifiedCandidateSnapshot,
  environment: CandidateServerEnvironment,
): Promise<void> {
  const provenance = snapshot.provenance;
  const manifest = await loadRetainedMapManifest(snapshot.candidateDirectory, provenance);
  const partialRuntime = await loadRuntimeConfiguration(snapshot.candidateDirectory, provenance);
  const mapPayloadRoot = within(
    snapshot.candidateDirectory,
    join(snapshot.candidateDirectory, ...provenance.mapManifest.payload.candidatePath.split('/')),
    'Retained map payload',
  );
  await verifyRetainedMapPayload(mapPayloadRoot, manifest);
  const runtime: CandidateRuntimeConfiguration = {
    ...partialRuntime,
    manifest,
    mapPayloadRoot,
  };
  const resourceTmpPath = join(snapshot.stagingRoot, 'tmp');
  await mkdir(resourceTmpPath, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const origin = `http://${environment.host}:${environment.port}`;
  const shutdown = shutdownLatch();
  let miniflare: Miniflare | undefined;
  try {
    miniflare = new Miniflare(
      convertV4MiniflareOptions(miniflareOptions(runtime, environment, secret, resourceTmpPath)),
    );
    await miniflare.ready;
    if (shutdown.requested()) return;
    try {
      await seedMapAssets(origin, manifest, secret, shutdown.signal);
    } catch (error) {
      if (shutdown.requested()) return;
      throw error;
    }
    const audit = await responseJson(
      await fetch(`${origin}/__m34/runtime-egress`, {
        signal: AbortSignal.timeout(10_000),
      }),
      'External-egress audit',
    );
    if (audit.blockedAttempts !== 0) {
      throw new Error('The retained candidate attempted external network access during startup.');
    }
    console.log(
      `M34_CANDIDATE_READY ${JSON.stringify({
        candidateId: provenance.candidateId,
        origin,
        mapId: manifest.id,
        mapAssets: manifest.assets.length,
        externalEgressAttempts: 0,
      })}`,
    );
    await shutdown.promise;
  } finally {
    shutdown.dispose();
    if (miniflare !== undefined) await miniflare.dispose().catch(() => undefined);
  }
}

export async function serveRetainedCandidate(
  environment = candidateServerEnvironment(),
): Promise<void> {
  const sourceIdentity = await captureSourceIdentity(REPOSITORY_ROOT);
  const snapshot = await createVerifiedCandidateSnapshot(environment, sourceIdentity);
  const errors: unknown[] = [];
  try {
    await runVerifiedCandidateSnapshot(snapshot, environment);
  } catch (error) {
    errors.push(error);
  }
  try {
    const sourceAfter = await captureSourceIdentity(REPOSITORY_ROOT);
    if (!sameSourceIdentity(sourceIdentity, sourceAfter)) {
      throw new Error('Exact checkout source changed during candidate serving.');
    }
    await completeVerifiedCandidateSnapshot(snapshot, sourceIdentity);
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeVerifiedCandidateSnapshot(snapshot);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Candidate serving and immutable-snapshot finalization failed.',
    );
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  serveRetainedCandidate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
