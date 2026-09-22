import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import mapManifest from '../../maps/manifest.json';
import { MAP_ID } from '../../src/map/assets';
import { captureArtifactTreeIdentity } from './loadArtifactInput';
import {
  requirePerformanceRunPaths,
  type PerformanceIdentityCapture,
  type PerformanceServerIdentity,
} from './performanceContract';
import { captureSourceIdentity } from './retainCandidate';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAP_ROOT = join(REPOSITORY_ROOT, '.map-data', MAP_ID);
const PERFORMANCE_RUN_PATHS = requirePerformanceRunPaths(REPOSITORY_ROOT, process.env);

function within(root: string, path: string): string {
  const target = resolve(path);
  const difference = relative(resolve(root), target);
  if (difference === '..' || difference.startsWith(`..${sep}`) || difference.startsWith('/')) {
    throw new Error('Performance map identity path escapes its root.');
  }
  return target;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function captureMapIdentity(): Promise<PerformanceServerIdentity['map']> {
  if (
    mapManifest.schemaVersion !== 'map-assets.v1' ||
    mapManifest.id !== MAP_ID ||
    !Number.isSafeInteger(mapManifest.totalBytes) ||
    mapManifest.totalBytes < 0 ||
    !Array.isArray(mapManifest.assets) ||
    mapManifest.assets.length < 1
  ) {
    throw new Error('Performance map manifest identity is invalid.');
  }
  const identityHash = createHash('sha256');
  identityHash.update('airspace-performance-map.v1\0');
  let totalBytes = 0;
  for (const asset of mapManifest.assets) {
    if (
      typeof asset.path !== 'string' ||
      asset.path.length < 1 ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new Error('Performance map manifest asset identity is invalid.');
    }
    const path = within(MAP_ROOT, join(MAP_ROOT, ...asset.path.split('/')));
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size !== asset.bytes) {
      throw new Error(`Performance map asset has the wrong identity: ${asset.path}`);
    }
    const digest = await sha256File(path);
    if (digest !== asset.sha256) {
      throw new Error(`Performance map asset has the wrong digest: ${asset.path}`);
    }
    totalBytes += asset.bytes;
    identityHash.update(`${asset.path}\0${asset.bytes}\0${digest}\0`);
  }
  if (totalBytes !== mapManifest.totalBytes) {
    throw new Error('Performance map byte inventory does not match its manifest.');
  }
  return {
    id: MAP_ID,
    fileCount: mapManifest.assets.length,
    totalBytes,
    sha256: identityHash.digest('hex'),
  };
}

async function main(): Promise<void> {
  const [source, optimizedClient, map] = await Promise.all([
    captureSourceIdentity(REPOSITORY_ROOT),
    captureArtifactTreeIdentity(PERFORMANCE_RUN_PATHS.clientOutput),
    captureMapIdentity(),
  ]);
  const capture: PerformanceIdentityCapture = {
    schemaVersion: 'airspace-performance-identity-capture.v2',
    source: {
      head: source.head,
      dirty: source.dirty,
      contentSha256: source.contentSha256,
    },
    optimizedClient,
    map,
  };
  process.stdout.write(`${JSON.stringify(capture)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
