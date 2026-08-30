import { execFileSync } from 'node:child_process';
import type { LiveBuildTarget } from '../../src/live/source';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';
import {
  compileRuntimePolicy,
  type RuntimePolicyInput,
  type RuntimePolicyV1,
} from '../../src/live/runtimePolicy';

export const LIVE_APPLICATION_VERSION = '3.0.0-dev';
export const LOCAL_UNRELEASED_SHA = 'local-unreleased';
export const LIVE_RUNTIME_POLICY_EPOCH = 'r3-local-1';
export const LIVE_RUNTIME_DEPLOYMENT_CLASS = 'loopback' as const;
export const LIVE_RUNTIME_DISABLE_REASON = 'source-disabled' as const;

export type EvidenceBuildTarget = LiveBuildTarget | 'static-preview' | 'offline';

export interface BuildIdentityEnvironment {
  M34_EXPECTED_SOURCE_HEAD?: string | undefined;
  GITHUB_SHA?: string | undefined;
}

export interface BuildSourceState {
  head: string;
  clean: boolean;
}

export function gitBuildSourceState(directory = process.cwd()): Readonly<BuildSourceState> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  })
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(head)) {
    throw new Error('The build source HEAD is not a full 40-character Git SHA.');
  }
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
    { cwd: directory, encoding: 'utf8' },
  );
  return Object.freeze({ head, clean: status.length === 0 });
}

function sourceSha(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return normalized;
}

/** Produces the one immutable identity baked into both the client and Worker build. */
export function evidenceBuildIdentity(
  target: EvidenceBuildTarget,
  environment: BuildIdentityEnvironment = process.env,
  sourceState?: Readonly<BuildSourceState>,
): Readonly<EvidenceBuildIdentity> {
  const expectedSourceHead = sourceSha(
    environment.M34_EXPECTED_SOURCE_HEAD,
    'M34_EXPECTED_SOURCE_HEAD',
  );
  const githubSha = sourceSha(environment.GITHUB_SHA, 'GITHUB_SHA');
  if (expectedSourceHead && githubSha && expectedSourceHead !== githubSha) {
    throw new Error('M34_EXPECTED_SOURCE_HEAD and GITHUB_SHA identify different source revisions.');
  }
  const releaseSha = expectedSourceHead ?? githubSha;
  if (releaseSha) {
    const actual = sourceState ?? gitBuildSourceState();
    if (!actual.clean) {
      throw new Error('An exact source SHA cannot be baked into a dirty working tree.');
    }
    if (actual.head !== releaseSha) {
      throw new Error('The requested build source SHA does not match the checked-out HEAD.');
    }
  }
  return Object.freeze({
    applicationVersion: LIVE_APPLICATION_VERSION,
    releaseSha: releaseSha ?? LOCAL_UNRELEASED_SHA,
    releaseStatus: 'unreleased',
    buildTarget: target,
  });
}

export interface LiveBuildOptions {
  target: LiveBuildTarget;
  synthetic: boolean;
  providerMode: 'mock' | 'disabled';
  mockDevOnly: boolean;
  outDir: string;
  workerName: string;
  workerMain: string;
  mockMain: string;
}

export function liveRuntimePolicyInput(
  options: Readonly<LiveBuildOptions>,
  identity: Readonly<EvidenceBuildIdentity>,
  allowedOrigins: readonly string[],
): Readonly<RuntimePolicyInput> {
  return Object.freeze({
    target: options.target,
    providerMode: options.providerMode,
    providerBaseUrl: options.synthetic ? 'https://mock-provider.invalid' : 'https://api.adsb.lol',
    mockBindingPresent: options.synthetic,
    allowedOrigins: [...allowedOrigins],
    deploymentClass: LIVE_RUNTIME_DEPLOYMENT_CLASS,
    release: {
      applicationVersion: identity.applicationVersion,
      releaseSha: identity.releaseSha,
      releaseStatus: identity.releaseStatus,
      buildTarget: options.target,
    },
    policyEpoch: LIVE_RUNTIME_POLICY_EPOCH,
    providerGate: {
      status: 'closed' as const,
      reason: LIVE_RUNTIME_DISABLE_REASON,
    },
  });
}

export async function compileLiveBuildRuntimePolicy(
  options: Readonly<LiveBuildOptions>,
  identity: Readonly<EvidenceBuildIdentity>,
  allowedOrigins: readonly string[],
): Promise<Readonly<RuntimePolicyV1>> {
  return compileRuntimePolicy(liveRuntimePolicyInput(options, identity, allowedOrigins));
}

export function liveBuildOptions(command: 'serve' | 'build', mode: string): LiveBuildOptions {
  let target: LiveBuildTarget;
  if (command === 'serve' && mode === 'development') target = 'local-mock';
  else if (command === 'build' && mode === 'mock-staging') target = 'mock-staging';
  else if (command === 'build' && mode === 'production') target = 'production';
  else
    throw new Error(
      'Use local development, an explicit mock-staging build, or disabled production.',
    );
  const synthetic = target !== 'production';
  return {
    target,
    synthetic,
    providerMode: synthetic ? 'mock' : 'disabled',
    mockDevOnly: target === 'local-mock',
    outDir: target === 'mock-staging' ? 'dist-mock-staging' : 'dist-live',
    workerName: `flight-airspace-${target}`,
    workerMain:
      target === 'local-mock' ? './tests/support/guardedAirspaceWorker.ts' : './worker/index.ts',
    mockMain:
      target === 'local-mock'
        ? './tests/support/guardedMockProvider.ts'
        : './tests/support/mockProvider.ts',
  };
}
