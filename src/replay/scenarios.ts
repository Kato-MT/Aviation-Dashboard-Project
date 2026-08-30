import { AIRSPACE_SCHEMA_VERSION } from '../live/types';
import type { AircraftQualityFlag, LiveFeedHealth, LiveFeedStatus } from '../live/types';
import {
  AIRSPACE_REPLAY_GENERATOR_ID,
  AIRSPACE_REPLAY_GENERATOR_VERSION,
  AIRSPACE_REPLAY_SCHEMA_VERSION,
  REPLAY_PROVIDER_ID,
} from './types';
import type {
  ReplayAircraftState,
  ReplayEvent,
  ReplayEventDisposition,
  ReplayHealthEvent,
  ReplayManifest,
  ReplayScenarioId,
  ReplayScenarioMetadata,
  ReplaySnapshot,
  ReplaySnapshotEvent,
  ValidatedReplayManifest,
} from './types';
import { computeReplayManifestDigest, parseReplayManifest } from './validation';

export const BUNDLED_REPLAY_SCENARIOS: readonly ReplayScenarioMetadata[] = Object.freeze([
  Object.freeze({
    id: 'nominal-regional',
    title: 'Nominal regional movement',
    description: 'Multiple synthetic aircraft move through ordinary, accepted regional receipts.',
    defaultSeed: 20_260_828,
    durationMs: 120_000,
  }),
  Object.freeze({
    id: 'data-quality-gaps',
    title: 'Observation quality and ordering gaps',
    description:
      'Positionless, sparse, delayed, stale, duplicate and out-of-order synthetic observations.',
    defaultSeed: 20_260_829,
    durationMs: 180_000,
  }),
  Object.freeze({
    id: 'provider-outage-recovery',
    title: 'Provider outage and recovery',
    description:
      'A deterministic degradation, outage, retained-evidence interval and synthetic recovery.',
    defaultSeed: 20_260_830,
    durationMs: 1_080_000,
  }),
]);

interface ScenarioContext {
  metadata: ReplayScenarioMetadata;
  seed: number;
  startAt: string;
  feedEpoch: string;
  random: () => number;
}

interface AircraftOptions {
  number: number;
  receiptOffsetMs: number;
  contactAgeSeconds?: number;
  positionAgeSeconds?: number;
  position?: boolean;
  altitude?: number | undefined;
  speed?: number | undefined;
  track?: number | undefined;
  verticalRate?: number | undefined;
  callsign?: string | undefined;
  qualityFlags?: AircraftQualityFlag[] | undefined;
  latitudeOffset?: number | undefined;
  longitudeOffset?: number | undefined;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function timeAt(context: ScenarioContext, offsetMs: number): string {
  return new Date(Date.parse(context.startAt) + offsetMs).toISOString();
}

function aircraft(context: ScenarioContext, options: AircraftOptions): ReplayAircraftState {
  const contactAgeSeconds = options.contactAgeSeconds ?? 0;
  const includePosition = options.position ?? true;
  const positionAgeSeconds = options.positionAgeSeconds ?? contactAgeSeconds;
  const receiptMs = Date.parse(context.startAt) + options.receiptOffsetMs;
  const lastContactAt = new Date(receiptMs - contactAgeSeconds * 1_000).toISOString();
  const baseLatitude = 33.6407 + (context.random() - 0.5) * 0.02;
  const baseLongitude = -84.4277 + (context.random() - 0.5) * 0.02;
  const qualityFlags = options.qualityFlags ?? [];
  return {
    aircraftId: `demo:${context.metadata.id}:${options.number}`,
    identifierKind: 'synthetic',
    synthetic: true,
    ...(options.callsign === undefined ? {} : { callsign: options.callsign }),
    registration: `DEMO-${String(options.number).padStart(2, '0')}`,
    aircraftType: options.number % 2 === 0 ? 'A320' : 'B738',
    category: 'A3',
    ...(includePosition
      ? {
          position: {
            latitude: Number((baseLatitude + (options.latitudeOffset ?? 0)).toFixed(6)),
            longitude: Number((baseLongitude + (options.longitudeOffset ?? 0)).toFixed(6)),
          },
          lastPositionAt: new Date(receiptMs - positionAgeSeconds * 1_000).toISOString(),
          positionAgeSeconds,
        }
      : {}),
    ...(options.altitude === undefined ? {} : { barometricAltitudeFeet: options.altitude }),
    ...(options.speed === undefined ? {} : { groundSpeedKnots: options.speed }),
    ...(options.track === undefined ? {} : { trackDegrees: options.track }),
    ...(options.verticalRate === undefined
      ? {}
      : {
          verticalRateFeetPerMinute: options.verticalRate,
          verticalRateBasis: 'barometric' as const,
        }),
    onGround: false,
    sourceType: 'synthetic-replay',
    observedAt: lastContactAt,
    lastContactAt,
    contactAgeSeconds,
    qualityFlags,
  };
}

function snapshot(
  context: ScenarioContext,
  offsetMs: number,
  sequence: number,
  records: ReplayAircraftState[],
): ReplaySnapshot {
  const generatedAt = timeAt(context, offsetMs);
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: REPLAY_PROVIDER_ID,
    regionId: 'atlanta',
    feedEpoch: context.feedEpoch,
    sequence,
    generatedAt,
    providerGeneratedAt: generatedAt,
    aircraft: records,
    validation: {
      receivedAircraft: records.length,
      acceptedAircraft: records.length,
      rejectedAircraft: 0,
      duplicateAircraft: 0,
      invalidFields: 0,
    },
  };
}

function snapshotEvent(
  context: ScenarioContext,
  events: ReplayEvent[],
  options: {
    offsetMs: number;
    sequence: number;
    label: string;
    description: string;
    records: ReplayAircraftState[];
    expectedDisposition?: ReplayEventDisposition | undefined;
  },
): void {
  const event: ReplaySnapshotEvent = {
    index: events.length,
    offsetMs: options.offsetMs,
    kind: 'snapshot',
    label: options.label,
    description: options.description,
    expectedDisposition: options.expectedDisposition ?? 'accepted',
    snapshot: snapshot(context, options.offsetMs, options.sequence, options.records),
  };
  events.push(event);
}

function healthEvent(
  context: ScenarioContext,
  events: ReplayEvent[],
  options: {
    offsetMs: number;
    status: LiveFeedStatus;
    label: string;
    description: string;
    message: string;
    failures?: number | undefined;
    lastSnapshotOffsetMs?: number | undefined;
    lastSuccessOffsetMs?: number | undefined;
  },
): void {
  const checkedAt = timeAt(context, options.offsetMs);
  const health: LiveFeedHealth = {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: REPLAY_PROVIDER_ID,
    regionId: 'atlanta',
    feedEpoch: context.feedEpoch,
    status: options.status,
    checkedAt,
    ...(options.lastSuccessOffsetMs === undefined
      ? {}
      : { lastSuccessAt: timeAt(context, options.lastSuccessOffsetMs) }),
    ...(options.lastSnapshotOffsetMs === undefined
      ? {}
      : { lastSnapshotAt: timeAt(context, options.lastSnapshotOffsetMs) }),
    ...(options.status === 'live' ? { upstreamLatencyMs: 42 } : {}),
    consecutiveFailures: options.failures ?? 0,
    ...(options.status === 'offline'
      ? {
          retryAt: timeAt(
            context,
            Math.min(context.metadata.durationMs, options.offsetMs + 60_000),
          ),
        }
      : {}),
    message: options.message,
  };
  const event: ReplayHealthEvent = {
    index: events.length,
    offsetMs: options.offsetMs,
    kind: 'health',
    label: options.label,
    description: options.description,
    expectedDisposition: 'accepted',
    health,
  };
  events.push(event);
}

function nominalEvents(context: ScenarioContext): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const [receipt, offsetMs] of [0, 30_000, 60_000, 90_000, 120_000].entries()) {
    const records = [1, 2, 3].map((number) =>
      aircraft(context, {
        number,
        receiptOffsetMs: offsetMs,
        altitude: 8_000 + number * 1_500 + receipt * 200,
        speed: 230 + number * 18,
        track: (70 + number * 35 + receipt * 3) % 360,
        verticalRate: receipt < 2 ? 500 : receipt === 2 ? 0 : -300,
        callsign: `DEMO${number}N`,
        latitudeOffset: receipt * 0.012 + number * 0.004,
        longitudeOffset: receipt * 0.009 - number * 0.003,
      }),
    );
    snapshotEvent(context, events, {
      offsetMs,
      sequence: receipt + 1,
      label: receipt === 0 ? 'Replay begins' : `Nominal receipt ${receipt + 1}`,
      description:
        'Accepted synthetic regional positions and independent flight-state measurements.',
      records,
    });
    if (receipt === 0) {
      healthEvent(context, events, {
        offsetMs,
        status: 'live',
        label: 'Synthetic source ready',
        description: 'The replay source is healthy. No provider or network connection exists.',
        message: 'Bundled synthetic replay is available.',
        lastSnapshotOffsetMs: 0,
        lastSuccessOffsetMs: 0,
      });
    }
  }
  return events;
}

function qualityEvents(context: ScenarioContext): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  snapshotEvent(context, events, {
    offsetMs: 0,
    sequence: 10,
    label: 'Quality scenario begins',
    description: 'A complete current synthetic receipt establishes the ordering baseline.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 0,
        altitude: 12_000,
        speed: 310,
        track: 110,
        verticalRate: 400,
        callsign: 'GAP1',
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 20_000,
    sequence: 11,
    label: 'Missing and sparse fields',
    description:
      'A positionless row remains inspectable while two rows omit independent measurements.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 20_000,
        position: false,
        altitude: 12_200,
        speed: 312,
        track: 112,
        qualityFlags: ['missing-position'],
        callsign: 'GAP1',
      }),
      aircraft(context, {
        number: 2,
        receiptOffsetMs: 20_000,
        speed: 205,
        track: 250,
      }),
      aircraft(context, {
        number: 3,
        receiptOffsetMs: 20_000,
        altitude: 7_400,
        track: 35,
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 40_000,
    sequence: 12,
    label: 'Freshness boundaries',
    description:
      'Current, delayed, stale and expired synthetic observation ages coexist in one receipt.',
    records: [
      aircraft(context, {
        number: 4,
        receiptOffsetMs: 40_000,
        contactAgeSeconds: 10,
        positionAgeSeconds: 10,
        altitude: 12_400,
        speed: 315,
        track: 114,
        callsign: 'AGE4',
      }),
      aircraft(context, {
        number: 5,
        receiptOffsetMs: 40_000,
        contactAgeSeconds: 30,
        positionAgeSeconds: 30,
        altitude: 7_500,
        track: 252,
      }),
      aircraft(context, {
        number: 6,
        receiptOffsetMs: 40_000,
        contactAgeSeconds: 60,
        positionAgeSeconds: 60,
        speed: 190,
        track: 36,
        qualityFlags: ['stale-contact', 'stale-position'],
      }),
      aircraft(context, {
        number: 7,
        receiptOffsetMs: 40_000,
        contactAgeSeconds: 125,
        positionAgeSeconds: 125,
        altitude: 5_000,
        speed: 160,
        track: 300,
        qualityFlags: ['stale-contact', 'stale-position'],
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 50_000,
    sequence: 12,
    label: 'Duplicate delivery attempt',
    description: 'The normalized forward-only session rejects a duplicate sequence.',
    expectedDisposition: 'rejected',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 50_000,
        altitude: 99_999,
        speed: 999,
        track: 180,
        callsign: 'GAP1',
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 55_000,
    sequence: 9,
    label: 'Out-of-order delivery attempt',
    description: 'The normalized forward-only session rejects a regressed sequence.',
    expectedDisposition: 'rejected',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 55_000,
        altitude: 1_000,
        speed: 20,
        track: 10,
        qualityFlags: ['provider-time-regression'],
        callsign: 'GAP1',
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 70_000,
    sequence: 13,
    label: 'Ordering recovers',
    description: 'A later increasing sequence is accepted after rejected delivery attempts.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 70_000,
        altitude: 12_700,
        speed: 320,
        track: 118,
        verticalRate: 100,
        callsign: 'GAP1',
      }),
    ],
  });
  return events;
}

function outageEvents(context: ScenarioContext): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  snapshotEvent(context, events, {
    offsetMs: 0,
    sequence: 1,
    label: 'Last full receipt',
    description: 'One aircraft will return after recovery; another will expire during the gap.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 0,
        altitude: 15_000,
        speed: 340,
        track: 90,
        callsign: 'KEEP1',
      }),
      aircraft(context, {
        number: 2,
        receiptOffsetMs: 0,
        altitude: 6_000,
        speed: 180,
        track: 210,
        callsign: 'DROP2',
      }),
    ],
  });
  healthEvent(context, events, {
    offsetMs: 0,
    status: 'live',
    label: 'Synthetic source ready',
    description: 'The replay begins healthy without contacting a provider.',
    message: 'Bundled synthetic replay is available.',
    lastSnapshotOffsetMs: 0,
    lastSuccessOffsetMs: 0,
  });
  snapshotEvent(context, events, {
    offsetMs: 30_000,
    sequence: 2,
    label: 'Aircraft departs before outage',
    description:
      'The persistent aircraft receives a new observation; the other becomes retained history.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 30_000,
        altitude: 15_400,
        speed: 342,
        track: 92,
        callsign: 'KEEP1',
        latitudeOffset: 0.02,
        longitudeOffset: 0.015,
      }),
    ],
  });
  healthEvent(context, events, {
    offsetMs: 60_000,
    status: 'degraded',
    label: 'Synthetic degradation',
    description:
      'Health degrades while the last accepted snapshot remains available as aged evidence.',
    message: 'Synthetic upstream latency exceeded the scenario threshold.',
    failures: 1,
    lastSnapshotOffsetMs: 30_000,
    lastSuccessOffsetMs: 30_000,
  });
  healthEvent(context, events, {
    offsetMs: 90_000,
    status: 'offline',
    label: 'Synthetic outage',
    description: 'No new observations arrive. This state does not imply an aircraft fault.',
    message: 'Synthetic upstream observations are unavailable.',
    failures: 2,
    lastSnapshotOffsetMs: 30_000,
    lastSuccessOffsetMs: 30_000,
  });
  healthEvent(context, events, {
    offsetMs: 990_000,
    status: 'live',
    label: 'Synthetic source recovers',
    description:
      'Health recovers after the retained-history window without automatic Live fallback.',
    message: 'Bundled synthetic replay recovered on schedule.',
    failures: 0,
    lastSnapshotOffsetMs: 30_000,
    lastSuccessOffsetMs: 990_000,
  });
  snapshotEvent(context, events, {
    offsetMs: 1_000_000,
    sequence: 3,
    label: 'First recovery receipt',
    description:
      'The persistent synthetic aircraft returns; the expired aircraft is not recreated.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 1_000_000,
        altitude: 18_000,
        speed: 355,
        track: 100,
        callsign: 'KEEP1',
        latitudeOffset: 0.08,
        longitudeOffset: 0.06,
      }),
    ],
  });
  snapshotEvent(context, events, {
    offsetMs: 1_040_000,
    sequence: 4,
    label: 'Recovery stabilizes',
    description: 'A second accepted recovery receipt proves normal ordering resumed.',
    records: [
      aircraft(context, {
        number: 1,
        receiptOffsetMs: 1_040_000,
        altitude: 18_400,
        speed: 358,
        track: 102,
        callsign: 'KEEP1',
        latitudeOffset: 0.1,
        longitudeOffset: 0.075,
      }),
      aircraft(context, {
        number: 3,
        receiptOffsetMs: 1_040_000,
        altitude: 9_500,
        speed: 245,
        track: 315,
        callsign: 'NEW3',
      }),
    ],
  });
  return events;
}

function metadataFor(id: ReplayScenarioId): ReplayScenarioMetadata {
  const metadata = BUNDLED_REPLAY_SCENARIOS.find((scenario) => scenario.id === id);
  if (!metadata) throw new RangeError(`Unknown bundled replay scenario: ${id}.`);
  return metadata;
}

function buildManifest(id: ReplayScenarioId, seed: number): ReplayManifest {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
    throw new RangeError('Replay seed must be an integer from 1 through 4294967295.');
  }
  const metadata = metadataFor(id);
  const startAt =
    id === 'nominal-regional'
      ? '2026-08-28T12:00:00.000Z'
      : id === 'data-quality-gaps'
        ? '2026-08-28T13:00:00.000Z'
        : '2026-08-28T14:00:00.000Z';
  const context: ScenarioContext = {
    metadata,
    seed,
    startAt,
    feedEpoch: `replay-${id}-${seed}`,
    random: seededRandom(seed),
  };
  const events =
    id === 'nominal-regional'
      ? nominalEvents(context)
      : id === 'data-quality-gaps'
        ? qualityEvents(context)
        : outageEvents(context);
  return {
    schemaVersion: AIRSPACE_REPLAY_SCHEMA_VERSION,
    scenarioId: id,
    title: metadata.title,
    description: metadata.description,
    seed,
    synthetic: true,
    startAt,
    durationMs: metadata.durationMs,
    provenance: {
      synthetic: true,
      classification: 'SYNTHETIC_UNCLASSIFIED',
      generatorId: AIRSPACE_REPLAY_GENERATOR_ID,
      generatorVersion: AIRSPACE_REPLAY_GENERATOR_VERSION,
      canonicalSha256: '0'.repeat(64),
      units: {
        altitude: 'feet',
        groundSpeed: 'knots',
        verticalRate: 'feet-per-minute',
        track: 'degrees',
        time: 'UTC ISO-8601',
      },
    },
    events,
  };
}

export async function loadBundledReplayScenario(
  id: ReplayScenarioId,
  seed = metadataFor(id).defaultSeed,
): Promise<ValidatedReplayManifest> {
  const manifest = buildManifest(id, seed);
  manifest.provenance.canonicalSha256 = await computeReplayManifestDigest(manifest);
  const parsed = await parseReplayManifest(manifest);
  if (!parsed.ok) {
    throw new Error(`Bundled replay scenario failed validation: ${parsed.errors.join(' ')}`);
  }
  return parsed.manifest;
}
