import { AIRSPACE_SCHEMA_VERSION } from '../live/types';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../live/protocol';
import { isBoundedText, isFiniteNumber, isJsonRecord, isSafeInteger } from '../live/validation';
import type { MapEvidenceSummary, ReleaseGateEvidence } from './types';

export const BUNDLED_SCHEMA_IDENTITIES = Object.freeze([
  AIRSPACE_SCHEMA_VERSION,
  `live-stream.${LIVE_STREAM_PROTOCOL_VERSION}`,
  'map-assets.v1',
  'operations.v1',
  'runtime-policy.v1',
] as const);

// This is the intentionally bounded projection of maps/manifest.json used by the UI. Importing
// the source manifest would also place its 776-entry asset allowlist in the browser bundle.
export const BUNDLED_MAP_SUMMARY: Readonly<MapEvidenceSummary> = Object.freeze({
  manifestSchemaVersion: 'map-assets.v1',
  mapId: 'georgia-20260828-z12',
  sourceUrl: 'https://build.protomaps.com/20260828.pmtiles',
  sourceDate: '2026-08-28',
  tilesetVersion: '4.15.2',
  bounds: Object.freeze([-86.8, 30.3, -79.15, 35.6] as const),
  minZoom: 0,
  maxZoom: 12,
  cliVersion: '1.31.2',
  styleVersion: '5.7.2',
  styleCommit: '3ea8293a28131c3dc63f1bb20827bdb8a76df06f',
  assetsCommit: '028c18f713baecad011301ff7a69acc39bcc2ae7',
  osmReplicationTime: '2026-08-28T04:00:00Z',
  totalBytes: 133_533_691,
  assetCount: 776,
  addressedTiles: 8_514,
  basemapBytes: 122_391_249,
  basemapSha256: '286238718ff1006ada90f1bbd03958c0f4510a3e01ceee578798e81920bf72a6',
});

export const DEFAULT_RELEASE_GATES: readonly Readonly<ReleaseGateEvidence>[] = Object.freeze([
  Object.freeze({
    id: 'm3-service',
    gate: 'Regional service foundation',
    implementation: 'implemented',
    execution: 'not-executed',
    release: 'pending',
    evidence:
      'The implementation covers bounded delivery, near-limit eventual fairness, reconnect accounting, publication restart boundaries, safe sequence exhaustion, guarded local egress, generated-Worker dry-run, and Live CI configuration. This static build does not bundle a current-source execution receipt, so none is claimed here.',
  }),
  Object.freeze({
    id: 'm3-load-soak',
    gate: 'Measured local smoke and maximum load',
    implementation: 'implemented',
    execution: 'passed-historical',
    release: 'pending',
    evidence:
      'Corrected historical reports passed on source-content SHA 32d2ff35734f8dfebcdbab319d577b57587cdff379ea5ea285eb47b2f60353bb with Worker bundle SHA 18e84c4cad96686e129d689de83471821871b1c235f8333dd5736eff18765c93. Smoke ran 2026-08-29T06:28:18.793Z to 06:29:17.543Z via pnpm live:load:smoke; report test-results/live-load/smoke.json SHA-256 a5fce408cf8d62b5e291b383cef8b364852637a5bfbfa09a0497b8b12a7e5023. Maximum ran 06:30:06.150Z to 06:31:38.166Z via pnpm live:load:maximum; report test-results/live-load/maximum.json SHA-256 96735b268ff205d6969d8b39c915005bab9a389e07cde1e21bf471d0944b4721. These local Miniflare/workerd results do not cover the current source tree or Cloudflare production.',
  }),
  Object.freeze({
    id: 'm3-soak',
    gate: 'Thirty-minute local soak and memory plateau',
    implementation: 'implemented',
    execution: 'passed-historical',
    release: 'pending',
    evidence:
      'A qualifying historical soak passed from 2026-08-29T06:34:52.813Z to 07:05:00.253Z via pnpm live:load:soak on source-content SHA 32d2ff35734f8dfebcdbab319d577b57587cdff379ea5ea285eb47b2f60353bb and Worker bundle SHA 18e84c4cad96686e129d689de83471821871b1c235f8333dd5736eff18765c93. Report test-results/live-load/soak.json SHA-256 41cda60f3c50172ef3b8f46f114668d9710fc6862b5a8f7f10da4afbf9beef95. It is local Miniflare/workerd evidence, not current-source, Cloudflare, provider, deployment, or public-release proof.',
  }),
  Object.freeze({
    id: 'm3-hosted-ci',
    gate: 'Hosted exact-SHA CI',
    implementation: 'implemented',
    execution: 'external-evidence-needed',
    release: 'pending',
    evidence:
      'The required Live CI workflow exists locally, but no GitHub Actions run on an exact committed SHA is claimed.',
  }),
  Object.freeze({
    id: 'g1-platform',
    gate: 'G1 physical Cloudflare proof',
    implementation: 'not-applicable',
    execution: 'external-evidence-needed',
    release: 'pending',
    evidence:
      'Physical capacity, buffering, restart behavior, metering, headroom, kill-switch behavior, account controls, and the production operating envelope require an owner-approved mock platform run.',
  }),
  Object.freeze({
    id: 'm3-investigation',
    gate: 'Linked Live investigation',
    implementation: 'implemented',
    execution: 'not-executed',
    release: 'pending',
    evidence:
      'Map, chart, table, exact receipt selection, and corrected named map-region semantics are implemented. Historical local checks exist, but this static ledger does not bind a current-source browser receipt. This is not retained-candidate or deployment evidence.',
  }),
  Object.freeze({
    id: 'm3-replay-evidence',
    gate: 'Replay and Evidence workspace',
    implementation: 'implemented',
    execution: 'not-executed',
    release: 'pending',
    evidence:
      'Replay, Evidence, lifecycle, accessibility, and portfolio-walkthrough checks passed historically on their recorded source. This build bundles no current-source execution receipt. This is not retained-candidate, hosted, or deployment proof.',
  }),
  Object.freeze({
    id: 'm3-retained-candidate',
    gate: 'Retained candidate demonstration',
    implementation: 'implemented',
    execution: 'passed-historical',
    release: 'pending',
    evidence:
      'A historical mock-staging candidate passed five zero-retry retained-artifact cases with unchanged checksums. Current-source, committed-SHA, hosted, deployment, provider, and public-release proof remain open.',
  }),
  Object.freeze({
    id: 'g2-provider',
    gate: 'G2 real-provider production approval',
    implementation: 'not-applicable',
    execution: 'external-evidence-needed',
    release: 'pending',
    evidence:
      'Provider coordination, current license review, a bounded test budget, and owner approval are separate external gates.',
  }),
  Object.freeze({
    id: 'g3-public-v3',
    gate: 'G3 exact public v3 release',
    implementation: 'in-progress',
    execution: 'not-executed',
    release: 'pending',
    evidence:
      'No exact v3 artifact, public cutover, or independent production verification is claimed by this development build.',
  }),
]);

function requireText(value: unknown, label: string, maxLength = 128): string {
  if (!isBoundedText(value, maxLength)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!isSafeInteger(value, 0, maximum)) throw new Error(`${label} is invalid.`);
  return value;
}

function requireBounds(value: unknown): readonly [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate, index) =>
      isFiniteNumber(coordinate, index % 2 === 0 ? -180 : -90, index % 2 === 0 ? 180 : 90),
    ) ||
    (value[0] as number) >= (value[2] as number) ||
    (value[1] as number) >= (value[3] as number)
  ) {
    throw new Error('Map bounds are invalid.');
  }
  return Object.freeze([value[0], value[1], value[2], value[3]] as [
    number,
    number,
    number,
    number,
  ]);
}

function isMapManifestTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value.includes('.') ? canonical === value : canonical.replace('.000Z', 'Z') === value;
}

/**
 * Projects the source map manifest into the small evidence shape used by the browser. The returned
 * value never retains the large assets array.
 */
export function parseMapManifestSummary(value: unknown): Readonly<MapEvidenceSummary> {
  if (!isJsonRecord(value) || value.schemaVersion !== 'map-assets.v1') {
    throw new Error('Map manifest identity is invalid.');
  }
  if (!isJsonRecord(value.source) || !isJsonRecord(value.archive)) {
    throw new Error('Map manifest provenance is invalid.');
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 4_096) {
    throw new Error('Map manifest asset inventory is invalid.');
  }
  const basemap = value.assets.find(
    (asset: unknown) => isJsonRecord(asset) && asset.path === 'basemap.pmtiles',
  );
  if (!isJsonRecord(basemap)) throw new Error('Map manifest basemap identity is missing.');
  const minZoom = requireInteger(value.minZoom, 'Minimum zoom', 24);
  const maxZoom = requireInteger(value.maxZoom, 'Maximum zoom', 24);
  if (minZoom > maxZoom) throw new Error('Map zoom range is invalid.');
  if (!isMapManifestTimestamp(value.osmReplicationTime)) {
    throw new Error('Map replication time is invalid.');
  }
  const sha256 = requireText(basemap.sha256, 'Basemap digest', 64);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('Basemap digest is invalid.');
  const sourceDate = requireText(value.source.date, 'Map source date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceDate)) throw new Error('Map source date is invalid.');

  return Object.freeze({
    manifestSchemaVersion: 'map-assets.v1',
    mapId: requireText(value.id, 'Map ID', 64),
    sourceUrl: requireText(value.source.url, 'Map source URL', 512),
    sourceDate,
    tilesetVersion: requireText(value.source.tilesetVersion, 'Tileset version', 64),
    bounds: requireBounds(value.bounds),
    minZoom,
    maxZoom,
    cliVersion: requireText(value.cliVersion, 'Map CLI version', 64),
    styleVersion: requireText(value.styleVersion, 'Map style version', 64),
    styleCommit: requireText(value.styleCommit, 'Map style commit', 64),
    assetsCommit: requireText(value.assetsCommit, 'Map assets commit', 64),
    osmReplicationTime: value.osmReplicationTime,
    totalBytes: requireInteger(value.totalBytes, 'Map asset bytes'),
    assetCount: value.assets.length,
    addressedTiles: requireInteger(value.archive.addressedTiles, 'Addressed map tiles'),
    basemapBytes: requireInteger(basemap.bytes, 'Basemap bytes'),
    basemapSha256: sha256,
  });
}
