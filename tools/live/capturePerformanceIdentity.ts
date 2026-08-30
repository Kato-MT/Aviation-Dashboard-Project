import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERFORMANCE_CLIENT_OUTDIR } from '../../vite.performance.config';
import { captureArtifactTreeIdentity } from './loadArtifactInput';
import type { PerformanceIdentityCapture } from './performanceContract';
import { captureSourceIdentity } from './retainCandidate';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function main(): Promise<void> {
  const [source, optimizedClient] = await Promise.all([
    captureSourceIdentity(REPOSITORY_ROOT),
    captureArtifactTreeIdentity(PERFORMANCE_CLIENT_OUTDIR),
  ]);
  const capture: PerformanceIdentityCapture = {
    schemaVersion: 'airspace-performance-identity-capture.v1',
    source: {
      head: source.head,
      dirty: source.dirty,
      contentSha256: source.contentSha256,
    },
    optimizedClient,
  };
  process.stdout.write(`${JSON.stringify(capture)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
