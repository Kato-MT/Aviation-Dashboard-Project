import { LIVE_PILOT_REGION_ID } from './pilotEnvelope';
import { REGION_CONFIGS } from './regions';
import type { LiveSourceDescriptor } from './source';
import type { RegionConfig } from './types';

export const LIVE_PILOT_REGION_CONFIGS = Object.freeze(
  REGION_CONFIGS.filter((region) => region.id === LIVE_PILOT_REGION_ID),
);

if (LIVE_PILOT_REGION_CONFIGS.length !== 1) {
  throw new Error('The public live-pilot region does not match exactly one fixed region.');
}

/** Synthetic assurance keeps all presets; real-source capability is Atlanta-only. */
export function regionConfigsForLiveSource(
  source: Pick<LiveSourceDescriptor, 'mode' | 'synthetic'>,
): readonly (typeof REGION_CONFIGS)[number][] {
  return source.mode === 'live' && !source.synthetic ? LIVE_PILOT_REGION_CONFIGS : REGION_CONFIGS;
}

export function getRegionConfigForLiveSource(
  source: Pick<LiveSourceDescriptor, 'mode' | 'synthetic'>,
  regionId: string,
): RegionConfig | undefined {
  return regionConfigsForLiveSource(source).find((region) => region.id === regionId);
}
