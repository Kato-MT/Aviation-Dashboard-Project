import type { RegionConfig } from './types';

export const REGION_CONFIGS = [
  {
    id: 'atlanta',
    label: 'Atlanta',
    description: 'Metro Atlanta and surrounding north Georgia airspace.',
    center: { latitude: 33.6407, longitude: -84.4277 },
    radiusNauticalMiles: 100,
    bounds: { south: 31.9, west: -86.55, north: 35.35, east: -82.3 },
    defaultZoom: 6.8,
  },
  {
    id: 'savannah-statesboro',
    label: 'Savannah / Statesboro',
    description: 'Coastal and southeast Georgia regional airspace.',
    center: { latitude: 32.3, longitude: -81.5 },
    radiusNauticalMiles: 100,
    bounds: { south: 30.55, west: -83.6, north: 34.05, east: -79.4 },
    defaultZoom: 6.8,
  },
  {
    id: 'central-georgia',
    label: 'Central Georgia',
    description: 'Macon-centered view of central Georgia airspace.',
    center: { latitude: 32.65, longitude: -83.6 },
    radiusNauticalMiles: 100,
    bounds: { south: 30.9, west: -85.7, north: 34.4, east: -81.5 },
    defaultZoom: 6.8,
  },
] as const satisfies readonly RegionConfig[];

export type RegionId = (typeof REGION_CONFIGS)[number]['id'];

export function getRegionConfig(regionId: string): RegionConfig | undefined {
  return REGION_CONFIGS.find((region) => region.id === regionId);
}
