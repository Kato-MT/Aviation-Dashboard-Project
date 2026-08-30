import { DEFAULT_LIVE_PROVIDER_ID } from './types';
import { isJsonRecord } from './validation';

export const LIVE_BUILD_TARGETS = [
  'local-mock',
  'mock-staging',
  'live-staging',
  'production',
] as const;
export type LiveBuildTarget = (typeof LIVE_BUILD_TARGETS)[number];
export type LiveProviderMode = 'disabled' | 'mock' | 'live';

export interface LiveSourceDescriptor {
  target: LiveBuildTarget;
  mode: LiveProviderMode;
  providerId: string;
  label: string;
  synthetic: boolean;
}

export function describeLiveSource(target: unknown, mode: unknown): Readonly<LiveSourceDescriptor> {
  if (
    !LIVE_BUILD_TARGETS.includes(target as LiveBuildTarget) ||
    (mode !== 'disabled' && mode !== 'mock' && mode !== 'live')
  ) {
    throw new Error('Unknown live build target or provider mode.');
  }
  const synthetic = target === 'local-mock' || target === 'mock-staging';
  if ((synthetic && mode === 'live') || (!synthetic && mode === 'mock')) {
    throw new Error('The provider mode is not permitted for this build target.');
  }
  return Object.freeze({
    target: target as LiveBuildTarget,
    mode,
    providerId: synthetic ? 'synthetic-test' : DEFAULT_LIVE_PROVIDER_ID,
    label: synthetic ? 'Synthetic integration feed' : 'ADSB.lol surveillance observations',
    synthetic,
  });
}

export function parseLiveSource(value: unknown): Readonly<LiveSourceDescriptor> | undefined {
  if (!isJsonRecord(value)) return undefined;
  try {
    const expected = describeLiveSource(value.target, value.mode);
    const keys = Object.keys(expected) as Array<keyof LiveSourceDescriptor>;
    return Object.keys(value).length === keys.length &&
      keys.every((key) => value[key] === expected[key])
      ? expected
      : undefined;
  } catch {
    return undefined;
  }
}
