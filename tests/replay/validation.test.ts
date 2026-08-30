import { describe, expect, it } from 'vitest';

import { LIVE_STREAM_PROTOCOL_VERSION, parseLiveStreamMessage } from '../../src/live/protocol';
import {
  REPLAY_MAX_BYTES,
  computeReplayManifestDigest,
  loadBundledReplayScenario,
  normalizeReplaySnapshot,
  parseReplayManifest,
  type ReplayManifest,
} from '../../src/replay';

function mutable(value: unknown): ReplayManifest {
  return JSON.parse(JSON.stringify(value)) as ReplayManifest;
}

async function rehash(manifest: ReplayManifest): Promise<ReplayManifest> {
  manifest.provenance.canonicalSha256 = await computeReplayManifestDigest(manifest);
  return manifest;
}

function firstSnapshot(manifest: ReplayManifest) {
  const event = manifest.events.find((candidate) => candidate.kind === 'snapshot');
  if (!event || event.kind !== 'snapshot') throw new Error('Fixture snapshot is missing.');
  return event;
}

function firstHealth(manifest: ReplayManifest) {
  const event = manifest.events.find((candidate) => candidate.kind === 'health');
  if (!event || event.kind !== 'health') throw new Error('Fixture health is missing.');
  return event;
}

describe('airspace replay validation boundary', () => {
  it.each(['nominal-regional', 'data-quality-gaps', 'provider-outage-recovery'] as const)(
    'round-trips and deeply freezes the %s bundled manifest',
    async (scenarioId) => {
      const manifest = await loadBundledReplayScenario(scenarioId);
      const parsed = await parseReplayManifest(JSON.stringify(manifest));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.manifest).toEqual(manifest);
      expect(Object.isFrozen(parsed.manifest)).toBe(true);
      expect(Object.isFrozen(parsed.manifest.events)).toBe(true);
      expect(Object.isFrozen(parsed.manifest.events[0])).toBe(true);
      expect(parsed.manifest.provenance).toMatchObject({
        synthetic: true,
        classification: 'SYNTHETIC_UNCLASSIFIED',
        units: {
          altitude: 'feet',
          groundSpeed: 'knots',
          verticalRate: 'feet-per-minute',
          track: 'degrees',
          time: 'UTC ISO-8601',
        },
      });
    },
  );

  it('rejects the normalized replay record on the Live wire even after its replay marker is removed', async () => {
    const manifest = await loadBundledReplayScenario('nominal-regional');
    const event = manifest.events.find((candidate) => candidate.kind === 'snapshot');
    expect(event?.kind).toBe('snapshot');
    if (event?.kind !== 'snapshot') return;
    const snapshot = normalizeReplaySnapshot(event.snapshot);
    const result = parseLiveStreamMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'snapshot.aircraft[0].aircraftId must be a normalized surveillance identifier.',
        'snapshot.aircraft[0].identifierKind must match the surveillance identifier.',
      ]),
    );
  });

  it('fails closed on invalid JSON, non-objects and excessive UTF-8 input', async () => {
    await expect(parseReplayManifest('{')).resolves.toEqual({
      ok: false,
      errors: ['Replay manifest is not valid JSON.'],
    });
    await expect(parseReplayManifest([])).resolves.toEqual({
      ok: false,
      errors: ['Replay manifest must be a JSON object.'],
    });
    const oversized = `{"padding":"${'x'.repeat(REPLAY_MAX_BYTES)}"}`;
    await expect(parseReplayManifest(oversized)).resolves.toEqual({
      ok: false,
      errors: [`Replay manifest exceeds ${REPLAY_MAX_BYTES} UTF-8 bytes.`],
    });
  });

  it('detects canonical content tampering and does not trust a matching old digest', async () => {
    const manifest = mutable(await loadBundledReplayScenario('nominal-regional'));
    const event = manifest.events[0];
    expect(event?.kind).toBe('snapshot');
    if (event?.kind !== 'snapshot') return;
    event.snapshot.aircraft[0]!.position!.latitude += 0.25;

    const result = await parseReplayManifest(manifest);
    expect(result).toEqual({
      ok: false,
      errors: ['Replay manifest digest does not match its canonical content.'],
    });
  });

  it.each([
    [
      'unknown top-level field',
      (manifest: ReplayManifest) => Object.assign(manifest, { owner: 'nobody' }),
    ],
    [
      'forged real-looking identity',
      (manifest: ReplayManifest) => {
        const event = manifest.events[0]!;
        if (event.kind === 'snapshot') event.snapshot.aircraft[0]!.aircraftId = 'a1b2c3' as never;
      },
    ],
    [
      'missing synthetic discriminator',
      (manifest: ReplayManifest) => {
        const event = manifest.events[0]!;
        if (event.kind === 'snapshot') event.snapshot.aircraft[0]!.synthetic = false as never;
      },
    ],
    [
      'duplicate aircraft identity',
      (manifest: ReplayManifest) => {
        const event = manifest.events[0]!;
        if (event.kind === 'snapshot') {
          event.snapshot.aircraft.push({ ...event.snapshot.aircraft[0]! });
          event.snapshot.validation.receivedAircraft += 1;
          event.snapshot.validation.acceptedAircraft += 1;
        }
      },
    ],
    [
      'nonfinite speed',
      (manifest: ReplayManifest) => {
        const event = manifest.events[0]!;
        if (event.kind === 'snapshot') event.snapshot.aircraft[0]!.groundSpeedKnots = Number.NaN;
      },
    ],
    [
      'noncanonical event timestamp',
      (manifest: ReplayManifest) => {
        const event = manifest.events[0]!;
        if (event.kind === 'snapshot') event.snapshot.generatedAt = '2026-08-28T12:00:00Z';
      },
    ],
    [
      'unit mismatch',
      (manifest: ReplayManifest) => {
        manifest.provenance.units.altitude = 'meters' as never;
      },
    ],
    [
      'mid-scenario region change',
      (manifest: ReplayManifest) => {
        const event = manifest.events.find(
          (candidate) => candidate.kind === 'snapshot' && candidate.index > 0,
        );
        if (event?.kind === 'snapshot') event.snapshot.regionId = 'savannah-statesboro';
      },
    ],
  ])('rejects %s before digest trust', async (_label, mutate) => {
    const manifest = mutable(await loadBundledReplayScenario('nominal-regional'));
    mutate(manifest);
    const result = await parseReplayManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it('recomputes ordering semantics so a rehashed forged disposition still fails', async () => {
    const manifest = mutable(await loadBundledReplayScenario('data-quality-gaps'));
    const rejected = manifest.events.find((event) => event.expectedDisposition === 'rejected')!;
    rejected.expectedDisposition = 'accepted';
    await rehash(manifest);

    const result = await parseReplayManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `events[${rejected.index}] expected disposition does not match session ordering.`,
    );
  });

  it.each([
    ['null provenance', (value: ReplayManifest) => (value.provenance = null as never)],
    [
      'wrong provenance generator',
      (value: ReplayManifest) => (value.provenance.generatorId = 'other' as never),
    ],
    ['malformed digest', (value: ReplayManifest) => (value.provenance.canonicalSha256 = 'ABC')],
    ['null units', (value: ReplayManifest) => (value.provenance.units = null as never)],
    [
      'non-object aircraft',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft[0] = null as never),
    ],
    [
      'unbounded aircraft text',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft[0]!.callsign = ' bad '),
    ],
    [
      'invalid contact timestamp',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.lastContactAt = 'later'),
    ],
    [
      'different observed basis',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.observedAt = '2026-08-28T11:59:59.000Z'),
    ],
    [
      'negative contact age',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.contactAgeSeconds = -1),
    ],
    [
      'contact age mismatch',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft[0]!.contactAgeSeconds = 1),
    ],
    [
      'invalid ground state',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.onGround = 'no' as never),
    ],
    [
      'unknown quality flag',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.qualityFlags = ['unknown'] as never),
    ],
    [
      'duplicate quality flag',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.qualityFlags = [
          'stale-contact',
          'stale-contact',
        ]),
    ],
    [
      'rate without basis',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.verticalRateBasis = undefined),
    ],
    [
      'nonfinite altitude',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.barometricAltitudeFeet =
          Number.POSITIVE_INFINITY),
    ],
    [
      'negative ground speed',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft[0]!.groundSpeedKnots = -1),
    ],
    [
      'closed-circle track',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft[0]!.trackDegrees = 360),
    ],
    [
      'partial position tuple',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.lastPositionAt = undefined),
    ],
    [
      'invalid coordinates',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.position = { latitude: 91, longitude: 0 }),
    ],
    [
      'invalid position timestamp',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.lastPositionAt = 'later'),
    ],
    [
      'negative position age',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.positionAgeSeconds = -1),
    ],
    [
      'position age mismatch',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.aircraft[0]!.positionAgeSeconds = 1),
    ],
    [
      'future provider clock',
      (value: ReplayManifest) => {
        const event = firstSnapshot(value);
        event.snapshot.providerGeneratedAt = new Date(
          Date.parse(event.snapshot.generatedAt) + 6_000,
        ).toISOString();
      },
    ],
    [
      'null validation summary',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.validation = null as never),
    ],
    [
      'negative validation count',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.validation.acceptedAircraft = -1),
    ],
    [
      'validation aircraft mismatch',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.validation.acceptedAircraft = 0),
    ],
    [
      'validation partition mismatch',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.validation.receivedAircraft = 2),
    ],
    [
      'wrong replay binding',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.feedEpoch = 'wrong'),
    ],
    ['null snapshot', (value: ReplayManifest) => (firstSnapshot(value).snapshot = null as never)],
    [
      'wrong snapshot schema',
      (value: ReplayManifest) =>
        (firstSnapshot(value).snapshot.schemaVersion = 'airspace.v9' as never),
    ],
    [
      'invalid snapshot sequence',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.sequence = -1),
    ],
    [
      'non-array aircraft',
      (value: ReplayManifest) => (firstSnapshot(value).snapshot.aircraft = null as never),
    ],
    [
      'excessive aircraft',
      (value: ReplayManifest) => {
        const event = firstSnapshot(value);
        event.snapshot.aircraft = Array.from({ length: 101 }, () => ({
          ...event.snapshot.aircraft[0]!,
        }));
      },
    ],
    ['null health', (value: ReplayManifest) => (firstHealth(value).health = null as never)],
    [
      'wrong health schema',
      (value: ReplayManifest) => (firstHealth(value).health.schemaVersion = 'airspace.v9' as never),
    ],
    [
      'invalid health instant',
      (value: ReplayManifest) => (firstHealth(value).health.checkedAt = 'later'),
    ],
    [
      'invalid health status',
      (value: ReplayManifest) => (firstHealth(value).health.status = 'failed' as never),
    ],
    [
      'negative failure count',
      (value: ReplayManifest) => (firstHealth(value).health.consecutiveFailures = -1),
    ],
    [
      'invalid optional health time',
      (value: ReplayManifest) => (firstHealth(value).health.lastSuccessAt = 'later'),
    ],
    [
      'future last success',
      (value: ReplayManifest) =>
        (firstHealth(value).health.lastSuccessAt = '2026-08-28T12:00:01.000Z'),
    ],
    [
      'negative upstream latency',
      (value: ReplayManifest) => (firstHealth(value).health.upstreamLatencyMs = -1),
    ],
    ['empty events', (value: ReplayManifest) => (value.events = [])],
    ['non-object event', (value: ReplayManifest) => (value.events[0] = null as never)],
    ['wrong event index', (value: ReplayManifest) => (value.events[0]!.index = 4)],
    ['invalid event offset', (value: ReplayManifest) => (value.events[0]!.offsetMs = -1)],
    ['decreasing event offsets', (value: ReplayManifest) => (value.events[2]!.offsetMs = 0)],
    ['blank event label', (value: ReplayManifest) => (value.events[0]!.label = '')],
    [
      'invalid expected disposition',
      (value: ReplayManifest) => (value.events[0]!.expectedDisposition = 'ignored' as never),
    ],
    [
      'mixed snapshot payload',
      (value: ReplayManifest) =>
        Object.assign(value.events[0]!, { health: firstHealth(value).health }),
    ],
    ['unknown event kind', (value: ReplayManifest) => (value.events[0]!.kind = 'fault' as never)],
    [
      'health-only event list',
      (value: ReplayManifest) => {
        const health = firstHealth(value);
        health.index = 0;
        value.events = [health];
      },
    ],
    ['wrong manifest schema', (value: ReplayManifest) => (value.schemaVersion = 'wrong' as never)],
    ['wrong scenario ID', (value: ReplayManifest) => (value.scenarioId = 'wrong' as never)],
    ['blank title', (value: ReplayManifest) => (value.title = '')],
    ['invalid seed', (value: ReplayManifest) => (value.seed = 0)],
    ['false synthetic marker', (value: ReplayManifest) => (value.synthetic = false as never)],
    ['invalid start time', (value: ReplayManifest) => (value.startAt = 'later')],
    ['invalid duration', (value: ReplayManifest) => (value.durationMs = 0)],
  ])('reports strict validation evidence for %s', async (_label, mutate) => {
    const manifest = mutable(await loadBundledReplayScenario('nominal-regional'));
    mutate(manifest);
    expect((await parseReplayManifest(manifest)).ok).toBe(false);
  });

  it.each([
    [
      'nominal movement receipts',
      'nominal-regional' as const,
      (value: ReplayManifest) => {
        value.events = value.events.slice(0, 3);
      },
    ],
    [
      'quality coverage',
      'data-quality-gaps' as const,
      (value: ReplayManifest) => {
        for (const event of value.events) {
          if (event.kind !== 'snapshot') continue;
          for (const aircraft of event.snapshot.aircraft) aircraft.qualityFlags = [];
        }
      },
    ],
    [
      'outage coverage',
      'provider-outage-recovery' as const,
      (value: ReplayManifest) => {
        value.events = value.events.filter(
          (event) => event.kind !== 'health' || event.health.status !== 'degraded',
        );
        value.events.forEach((event, index) => (event.index = index));
      },
    ],
  ])('rejects a rehashed manifest missing %s', async (_label, scenarioId, mutate) => {
    const manifest = mutable(await loadBundledReplayScenario(scenarioId));
    mutate(manifest);
    await rehash(manifest);
    expect((await parseReplayManifest(manifest)).ok).toBe(false);
  });

  it('isolates a validated manifest from later input mutation', async () => {
    const source = mutable(await loadBundledReplayScenario('nominal-regional'));
    const result = await parseReplayManifest(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    source.title = 'Tampered after validation';
    expect(result.manifest.title).toBe('Nominal regional movement');
  });
});
