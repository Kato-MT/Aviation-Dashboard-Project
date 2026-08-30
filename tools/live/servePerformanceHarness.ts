import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import mapManifest from '../../maps/manifest.json';
import { findMapAsset, MAP_ID, MAX_MAP_RANGE_BYTES } from '../../src/map/assets';
import { parseByteRange } from '../../src/map/ranges';
import { runtimePolicyCanonicalJson } from '../../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { PERFORMANCE_CLIENT_OUTDIR } from '../../vite.performance.config';
import { captureArtifactTreeIdentity, sameArtifactTreeIdentity } from './loadArtifactInput';
import type { PerformanceServerIdentity } from './performanceContract';
import { captureSourceIdentity, sameSourceIdentity } from './retainCandidate';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAP_ROOT = join(REPOSITORY_ROOT, '.map-data', MAP_ID);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob: data:",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

interface VerifiedMapFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly modifiedMs: number;
  readonly changedMs: number;
  readonly device: number;
  readonly inode: number;
}

function port(): number {
  const value = process.env.LIVE_TEST_PORT ?? '4174';
  if (!/^\d{4,5}$/u.test(value)) throw new Error('LIVE_TEST_PORT is invalid.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error('LIVE_TEST_PORT is invalid.');
  }
  return parsed;
}

function privateIdentityPath(listenPort: number): string {
  return join(REPOSITORY_ROOT, '.tmp-tests', `performance-server-identity-${listenPort}.json`);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.woff2':
      return 'font/woff2';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function safeHeaders(response: ServerResponse, type: string, length: number): void {
  response.setHeader('content-type', type);
  response.setHeader('content-length', String(length));
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
}

function sendFailure(response: ServerResponse, status: number, code: string): void {
  const body = Buffer.from(JSON.stringify({ error: code }));
  response.statusCode = status;
  safeHeaders(response, 'application/json; charset=utf-8', body.byteLength);
  response.end(body);
}

function within(root: string, path: string): string {
  const target = resolve(path);
  const difference = relative(resolve(root), target);
  if (difference === '..' || difference.startsWith(`..${sep}`) || difference.startsWith('/')) {
    throw new Error('Performance asset path escapes its root.');
  }
  return target;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadStaticAssets(root: string): Promise<ReadonlyMap<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const status = await lstat(path);
      if (status.isSymbolicLink()) throw new Error('Optimized performance output contains a link.');
      if (status.isDirectory()) {
        await visit(path, relativePath);
      } else if (status.isFile()) {
        const body = await readFile(path);
        if (body.byteLength === 0) throw new Error('Optimized performance output is empty.');
        assets.set(`/${relativePath.replaceAll('\\', '/')}`, {
          body,
          contentType: contentType(relativePath),
        });
      } else {
        throw new Error('Optimized performance output contains a non-file entry.');
      }
    }
  };
  await visit(root, '');
  if (!assets.has('/tests/live-browser/performance-harness.html')) {
    throw new Error('Optimized performance harness entry is missing.');
  }
  return assets;
}

async function verifyMapFiles(): Promise<{
  readonly files: ReadonlyMap<string, VerifiedMapFile>;
  readonly identity: PerformanceServerIdentity['map'];
}> {
  const files = new Map<string, VerifiedMapFile>();
  const identityHash = createHash('sha256');
  identityHash.update('airspace-performance-map.v1\0');
  for (const asset of mapManifest.assets) {
    const path = within(MAP_ROOT, join(MAP_ROOT, ...asset.path.split('/')));
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size !== asset.bytes) {
      throw new Error(`Local performance map asset has the wrong identity: ${asset.path}`);
    }
    const digest = await sha256File(path);
    if (digest !== asset.sha256) {
      throw new Error(`Local performance map asset has the wrong digest: ${asset.path}`);
    }
    files.set(asset.path, {
      path,
      bytes: asset.bytes,
      sha256: digest,
      contentType: asset.contentType,
      modifiedMs: status.mtimeMs,
      changedMs: status.ctimeMs,
      device: status.dev,
      inode: status.ino,
    });
    identityHash.update(`${asset.path}\0${asset.bytes}\0${digest}\0`);
  }
  if (
    files.size !== mapManifest.assets.length ||
    [...files.values()].reduce((sum, file) => sum + file.bytes, 0) !== mapManifest.totalBytes
  ) {
    throw new Error('Local performance map inventory does not match its manifest.');
  }
  return {
    files,
    identity: {
      id: MAP_ID,
      fileCount: files.size,
      totalBytes: mapManifest.totalBytes,
      sha256: identityHash.digest('hex'),
    },
  };
}

function sameMapFileIdentity(
  file: VerifiedMapFile,
  status: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    status.isFile() &&
    status.size === file.bytes &&
    status.mtimeMs === file.modifiedMs &&
    status.ctimeMs === file.changedMs &&
    status.dev === file.device &&
    status.ino === file.inode
  );
}

async function openVerifiedMapFile(file: VerifiedMapFile) {
  const handle = await open(file.path, constants.O_RDONLY);
  const status = await handle.stat();
  if (!sameMapFileIdentity(file, status)) {
    await handle.close();
    return undefined;
  }
  return handle;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('The optimized performance harness requires NODE_ENV=production.');
  }
  if (Object.keys(process.env).some((key) => /^VITE_/iu.test(key))) {
    throw new Error('The optimized performance harness rejects inherited VITE variables.');
  }
  const sourceBefore = await captureSourceIdentity(REPOSITORY_ROOT);
  await build({
    configFile: join(REPOSITORY_ROOT, 'vite.performance.config.ts'),
    mode: 'performance',
    logLevel: 'warn',
  });
  const sourceAfter = await captureSourceIdentity(REPOSITORY_ROOT);
  if (!sameSourceIdentity(sourceBefore, sourceAfter)) {
    throw new Error('Source changed while the optimized performance harness was built.');
  }
  const optimizedClient = await captureArtifactTreeIdentity(PERFORMANCE_CLIENT_OUTDIR);
  const staticAssets = await loadStaticAssets(PERFORMANCE_CLIENT_OUTDIR);
  const optimizedClientAfterLoad = await captureArtifactTreeIdentity(PERFORMANCE_CLIENT_OUTDIR);
  if (!sameArtifactTreeIdentity(optimizedClient, optimizedClientAfterLoad)) {
    throw new Error('Optimized performance output changed while it was loaded.');
  }
  const map = await verifyMapFiles();
  const identity: PerformanceServerIdentity = {
    schemaVersion: 'airspace-performance-server.v1',
    source: {
      head: sourceAfter.head,
      dirty: sourceAfter.dirty,
      contentSha256: sourceAfter.contentSha256,
    },
    optimizedClient,
    map: map.identity,
    policy: {
      limits: RUNTIME_POLICY_LIMITS,
      limitsSha256: createHash('sha256')
        .update(runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS))
        .digest('hex'),
    },
  };
  const listenPort = port();
  const origin = `http://127.0.0.1:${listenPort}`;
  let identityPublished = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (!identityPublished) {
        sendFailure(response, 503, 'PERFORMANCE_IDENTITY_NOT_READY');
        return;
      }
      if (request.headers.host !== `127.0.0.1:${listenPort}`) {
        sendFailure(response, 400, 'PERFORMANCE_HOST_REJECTED');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendFailure(response, 405, 'PERFORMANCE_METHOD_REJECTED');
        return;
      }
      const url = new URL(request.url ?? '/', origin);
      if (url.origin !== origin || url.search !== '') {
        sendFailure(response, 400, 'PERFORMANCE_URL_REJECTED');
        return;
      }
      const mapAsset = findMapAsset(url.pathname);
      if (mapAsset) {
        const file = map.files.get(mapAsset.path);
        const handle = file ? await openVerifiedMapFile(file) : undefined;
        if (!file || !handle) {
          sendFailure(response, 503, 'PERFORMANCE_MAP_IDENTITY_CHANGED');
          return;
        }
        const rangeHeader = request.method === 'GET' ? request.headers.range : undefined;
        const range = rangeHeader ? parseByteRange(rangeHeader, file.bytes) : undefined;
        if (
          (rangeHeader && !range) ||
          (range && range.length > MAX_MAP_RANGE_BYTES) ||
          (!range && file.bytes > MAX_MAP_RANGE_BYTES && request.method === 'GET')
        ) {
          await handle.close();
          response.setHeader('content-range', `bytes */${file.bytes}`);
          sendFailure(response, 416, 'PERFORMANCE_MAP_RANGE_REJECTED');
          return;
        }
        const length = range?.length ?? file.bytes;
        response.statusCode = range ? 206 : 200;
        safeHeaders(response, file.contentType, length);
        response.setHeader('accept-ranges', 'bytes');
        response.setHeader('etag', `"${file.sha256}"`);
        response.setHeader('x-map-id', MAP_ID);
        if (range) {
          response.setHeader(
            'content-range',
            `bytes ${range.offset}-${range.offset + range.length - 1}/${file.bytes}`,
          );
        }
        if (request.method === 'HEAD') {
          await handle.close();
          response.end();
        } else {
          const stream = handle.createReadStream({
            autoClose: true,
            start: range?.offset,
            end: range ? range.offset + range.length - 1 : undefined,
          });
          stream.once('error', () => response.destroy());
          response.once('close', () => stream.destroy());
          stream.pipe(response);
        }
        return;
      }
      const asset = staticAssets.get(url.pathname);
      if (!asset) {
        sendFailure(response, 404, 'PERFORMANCE_ASSET_NOT_FOUND');
        return;
      }
      response.statusCode = 200;
      safeHeaders(response, asset.contentType, asset.body.byteLength);
      response.setHeader('x-performance-client-sha256', optimizedClient.sha256);
      response.end(request.method === 'HEAD' ? undefined : asset.body);
    })().catch(() => {
      if (response.headersSent) response.destroy();
      else sendFailure(response, 500, 'PERFORMANCE_SERVER_FAILURE');
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => accept());
  });
  await mkdir(join(REPOSITORY_ROOT, '.tmp-tests'), { recursive: true });
  const identityPath = privateIdentityPath(listenPort);
  const temporaryIdentityPath = `${identityPath}.${process.pid}.tmp`;
  await writeFile(temporaryIdentityPath, `${JSON.stringify(identity)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporaryIdentityPath, identityPath);
  identityPublished = true;
  process.stdout.write(
    `Optimized performance harness ready on loopback; client ${optimizedClient.sha256}; map ${map.identity.sha256}.\n`,
  );
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
