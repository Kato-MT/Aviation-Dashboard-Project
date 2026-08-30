import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  finalizeLiveBuildArtifact,
  liveBuildArtifactReady,
  type ConnectedBuildTarget,
} from './runtimePolicyArtifact';

const WRAPPER_ENVIRONMENT_KEY = 'LIVE_CONNECTED_BUILD_WRAPPER';
const TARGETS: Readonly<
  Record<ConnectedBuildTarget, Readonly<{ mode: string; outputDirectory: string }>>
> = Object.freeze({
  production: Object.freeze({ mode: 'production', outputDirectory: 'dist-live' }),
  'mock-staging': Object.freeze({ mode: 'mock-staging', outputDirectory: 'dist-mock-staging' }),
});

function connectedTarget(value: string | undefined): ConnectedBuildTarget {
  if (value === 'production' || value === 'mock-staging') return value;
  throw new Error('Connected build target must be production or mock-staging.');
}

async function runVite(target: ConnectedBuildTarget): Promise<void> {
  const viteEntry = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  await access(viteEntry);
  const spec = TARGETS[target];
  const child = spawn(
    process.execPath,
    [viteEntry, 'build', '--config', 'vite.live.config.ts', '--mode', spec.mode],
    {
      cwd: process.cwd(),
      env: { ...process.env, [WRAPPER_ENVIRONMENT_KEY]: '1' },
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Connected Vite build ended from signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`Connected Vite build failed with exit code ${exitCode}.`);
}

export async function buildConnectedArtifact(target: ConnectedBuildTarget): Promise<void> {
  const spec = TARGETS[target];
  await runVite(target);
  if (!(await liveBuildArtifactReady(spec.outputDirectory, target))) {
    throw new Error(
      `Connected ${target} output was incomplete after Vite finished; finalization was not attempted.`,
    );
  }
  await finalizeLiveBuildArtifact(spec.outputDirectory, target);
  process.stdout.write(
    `Connected ${target} artifact finalized and whole-tree verified at ${spec.outputDirectory}. No deployment was performed.\n`,
  );
}

await buildConnectedArtifact(connectedTarget(process.argv[2]));
