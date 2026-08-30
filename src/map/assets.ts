import manifest from '../../maps/manifest.json';
import { RUNTIME_POLICY_LIMITS } from '../live/runtimePolicyLimits';

export const MAP_ID = manifest.id;
export const MAP_PREFIX = `/map-assets/${MAP_ID}/`;
export const MAX_MAP_RANGE_BYTES: number = RUNTIME_POLICY_LIMITS.map.maximumRangeBytes;

export interface MapAsset {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

const assets = new Map<string, Readonly<MapAsset>>(
  manifest.assets.map((asset) => [MAP_PREFIX + asset.path, Object.freeze({ ...asset })]),
);

export function findMapAsset(pathname: string): Readonly<MapAsset> | undefined {
  if (pathname.length > 256) return undefined;
  try {
    const decoded = decodeURIComponent(pathname);
    // One canonical encoding prevents alternative cache keys and encoded separators.
    if (encodeURI(decoded) !== pathname) return undefined;
    return assets.get(decoded);
  } catch {
    return undefined;
  }
}
