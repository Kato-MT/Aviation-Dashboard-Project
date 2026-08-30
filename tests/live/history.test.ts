import { describe, expect, it } from 'vitest';
import type { ClockReading, ServerTimeInterval } from '../../src/live/clock';
import { LIVE_HISTORY_RETENTION_MS, LiveHistoryBuffer } from '../../src/live/history';
import type { AircraftState } from '../../src/live/types';
import { aircraftFixture, LIVE_FIXTURE_TIME, snapshotFixture } from './fixtures';

const BASE = Date.parse(LIVE_FIXTURE_TIME);
const stamp = (elapsed: number) => new Date(BASE + elapsed).toISOString();
const reading = (elapsed: number): ClockReading => ({
  monotonicMs: elapsed,
  wallMs: BASE + 7 * 86_400_000 + elapsed,
});
const time = (elapsed: number): ServerTimeInterval => ({
  earliestMs: BASE + elapsed,
  latestMs: BASE + elapsed,
  referenceAgeMs: 0,
});
const aircraft = (elapsed: number, overrides: Partial<AircraftState> = {}) =>
  aircraftFixture({
    observedAt: stamp(elapsed),
    lastContactAt: stamp(elapsed),
    lastPositionAt: stamp(elapsed),
    position: { latitude: 33.64 + elapsed / 1_000_000, longitude: -84.43 },
    ...overrides,
  });
const snapshot = (elapsed: number, tracks = [aircraft(elapsed)]) =>
  snapshotFixture({
    sequence: elapsed + 1,
    generatedAt: stamp(elapsed),
    providerGeneratedAt: stamp(elapsed),
    aircraft: tracks,
  });
const current = (buffer: LiveHistoryBuffer, id = 'a1b2c3') => buffer.histories.get(id)!;

describe('bounded live observation history', () => {
  it('uses one 120-sample budget for both independently timestamped channels', () => {
    const buffer = new LiveHistoryBuffer();
    for (let index = 0; index < 121; index += 1) {
      const elapsed = index * 1_000;
      buffer.ingest(snapshot(elapsed), reading(elapsed));
    }
    expect(current(buffer).samples).toHaveLength(120);
    expect(buffer.trails.get('a1b2c3')).toHaveLength(120);
    expect(current(buffer).samples[0]!.sequence).toBe(1_001);
    expect(current(buffer).samples.at(-1)!.sequence).toBe(120_001);
    expect(current(buffer).samples[0]!.position?.observedAt).toBe(stamp(1_000));
    expect(current(buffer).incompleteReasons).toEqual(['sample-limit']);
  });

  it('expires samples at the exact 15-minute cutoff without a new snapshot or time sample', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(0));
    const histories = buffer.histories;
    const trails = buffer.trails;
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS - 1));
    expect(buffer.histories).toBe(histories);
    expect(buffer.trails).toBe(trails);
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS));
    expect(buffer.histories.size).toBe(0);
    expect(buffer.trails.size).toBe(0);
    expect(histories.size).toBe(1);
    expect(trails.get('a1b2c3')).toHaveLength(1);
  });

  it('prunes an older position while retaining a newer state measurement from the same receipt', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0, [aircraft(0, { lastPositionAt: stamp(-10_000) })]), reading(0));
    const first = current(buffer).samples[0]!;
    expect(first.position?.observedAt).toBe(stamp(-10_000));
    expect(first.measurements?.observedAt).toBe(stamp(0));
    expect(first.position).not.toHaveProperty('altitudeFeet');
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS - 10_000));
    const remaining = current(buffer).samples[0]!;
    expect(remaining.position).toBeUndefined();
    expect(remaining.measurements).toBe(first.measurements);
    expect(buffer.trails.size).toBe(0);
    expect(current(buffer).incompleteReasons).toContain('retention-limit');
    expect(first.position).toBeDefined();
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS));
    expect(buffer.histories.size).toBe(0);
  });

  it('uses measured delivery age without extending expiry when later clock bounds move backward', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(10_000), time(10_000));
    buffer.maintain(reading(20_000), time(15_000));
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS));
    expect(buffer.histories.size).toBe(0);
  });

  it('never keeps a sample more than 15 minutes after its receipt', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(10_000));
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS + 9_999));
    expect(buffer.histories.size).toBe(1);
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS + 10_000));
    expect(buffer.histories.size).toBe(0);
  });

  it('records new state evidence without duplicating or copying an unchanged position trail', () => {
    const buffer = new LiveHistoryBuffer();
    const first = aircraft(0);
    buffer.ingest(snapshot(0, [first]), reading(0));
    const trails = buffer.trails;
    buffer.ingest(
      snapshot(1_000, [
        aircraft(1_000, {
          position: first.position,
          lastPositionAt: first.lastPositionAt,
          barometricAltitudeFeet: 12_100,
        }),
      ]),
      reading(1_000),
    );
    expect(buffer.trails).toBe(trails);
    expect(current(buffer).samples).toHaveLength(2);
    expect(current(buffer).samples[1]).toMatchObject({
      sequence: 1_001,
      receivedAt: stamp(1_000),
      position: undefined,
      measurements: { observedAt: stamp(1_000), barometricAltitudeFeet: 12_100 },
    });
  });

  it('records a new position without inventing a new measurement time', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(0));
    buffer.ingest(
      snapshot(1_000, [aircraft(1_000, { observedAt: stamp(0), lastContactAt: stamp(0) })]),
      reading(1_000),
    );
    expect(current(buffer).samples).toHaveLength(2);
    expect(current(buffer).samples[1]!.measurements).toBeUndefined();
    expect(current(buffer).samples[1]!.sequence).toBe(1_001);
    expect(current(buffer).samples[1]!.position?.observedAt).toBe(stamp(1_000));
    expect(buffer.trails.get('a1b2c3')).toHaveLength(2);
  });

  it('preserves zero values and missing measurements without filling missing fields', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(
      snapshot(0, [
        aircraft(0, { groundSpeedKnots: 0, barometricAltitudeFeet: 0, onGround: true }),
      ]),
      reading(0),
    );
    buffer.ingest(
      snapshot(1_000, [
        aircraft(1_000, {
          groundSpeedKnots: undefined,
          barometricAltitudeFeet: undefined,
          onGround: null,
        }),
      ]),
      reading(1_000),
    );
    expect(current(buffer).samples[0]!.measurements).toMatchObject({
      groundSpeedKnots: 0,
      barometricAltitudeFeet: 0,
      onGround: true,
    });
    expect(current(buffer).samples[1]!.measurements).toMatchObject({
      groundSpeedKnots: undefined,
      barometricAltitudeFeet: undefined,
      onGround: null,
      geometricAltitudeFeet: 12_275,
      verticalRateBasis: 'barometric',
    });
  });

  it('treats a later observation at unchanged coordinates as a genuine position', () => {
    const buffer = new LiveHistoryBuffer();
    const first = aircraft(0);
    buffer.ingest(snapshot(0, [first]), reading(0));
    buffer.ingest(snapshot(1_000, [aircraft(1_000, { position: first.position })]), reading(1_000));
    expect(buffer.trails.get('a1b2c3')).toHaveLength(2);
    expect(buffer.trails.get('a1b2c3')![1]!.breakBefore).toBe(false);
  });

  it.each(['conflict', 'regression'] as const)(
    'retains accepted positions and breaks recovery after a position %s',
    (mode) => {
      const buffer = new LiveHistoryBuffer();
      buffer.ingest(snapshot(1_000), reading(1_000));
      const trail = buffer.trails.get('a1b2c3');
      buffer.ingest(
        snapshot(2_000, [
          aircraft(2_000, {
            lastPositionAt: stamp(mode === 'conflict' ? 1_000 : 0),
            position: { latitude: 34, longitude: -85 },
          }),
        ]),
        reading(2_000),
      );
      expect(buffer.trails.get('a1b2c3')).toBe(trail);
      expect(current(buffer).incompleteReasons).toContain(
        mode === 'conflict' ? 'conflicting-observation' : 'regressed-time',
      );
      buffer.ingest(snapshot(3_000), reading(3_000));
      expect(buffer.trails.get('a1b2c3')).toHaveLength(2);
      expect(buffer.trails.get('a1b2c3')![1]!.breakBefore).toBe(true);
    },
  );

  it.each(['conflict', 'regression'] as const)(
    'retains accepted measurements and breaks recovery after a state %s',
    (mode) => {
      const buffer = new LiveHistoryBuffer();
      buffer.ingest(snapshot(1_000), reading(1_000));
      buffer.ingest(
        snapshot(2_000, [
          aircraft(2_000, {
            observedAt: stamp(mode === 'conflict' ? 1_000 : 0),
            barometricAltitudeFeet: 99_000,
          }),
        ]),
        reading(2_000),
      );
      expect(current(buffer).samples[1]!.measurements).toBeUndefined();
      expect(current(buffer).incompleteReasons).toContain(
        mode === 'conflict' ? 'conflicting-observation' : 'regressed-time',
      );
      buffer.ingest(snapshot(3_000), reading(3_000));
      expect(current(buffer).samples[2]!.measurements?.breakBefore).toBe(true);
      expect(current(buffer).samples[0]!.measurements?.barometricAltitudeFeet).toBe(12_000);
    },
  );

  it.each(['missing', 'time-uncertain', 'provider-time-regression'] as const)(
    'breaks the next position segment after %s evidence',
    (kind) => {
      const buffer = new LiveHistoryBuffer();
      buffer.ingest(snapshot(0), reading(0));
      buffer.ingest(
        snapshot(1_000, [
          aircraft(
            1_000,
            kind === 'missing'
              ? { position: undefined, lastPositionAt: undefined }
              : { qualityFlags: [kind] },
          ),
        ]),
        reading(1_000),
      );
      expect(buffer.trails.get('a1b2c3')).toHaveLength(1);
      buffer.ingest(snapshot(2_000), reading(2_000));
      expect(buffer.trails.get('a1b2c3')![1]!.breakBefore).toBe(true);
      if (kind !== 'missing') {
        expect(current(buffer).samples).toHaveLength(2);
        expect(current(buffer).samples[1]!.measurements?.breakBefore).toBe(true);
      }
    },
  );

  it('breaks segments across departure and across an expired observation interval', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(0));
    buffer.ingest(snapshot(1_000, []), reading(1_000));
    expect(current(buffer).incompleteReasons).toContain('feed-gap');
    buffer.ingest(snapshot(2_000), reading(2_000));
    buffer.ingest(snapshot(122_000), reading(122_000));
    expect(buffer.trails.get('a1b2c3')!.map((point) => point.breakBefore)).toEqual([
      true,
      true,
      true,
    ]);
    expect(current(buffer).samples[2]!.measurements?.breakBefore).toBe(true);
  });

  it('retains state-only evidence without creating a geographic trail', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0, [aircraft(0, { position: undefined })]), reading(0));
    expect(buffer.trails.size).toBe(0);
    expect(current(buffer).samples[0]!.measurements?.observedAt).toBe(stamp(0));
    expect(current(buffer).incompleteReasons).toContain('missing-position');
  });

  it('marks an expired interval incomplete even without an intervening missing snapshot', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(0));
    buffer.ingest(snapshot(120_000), reading(120_000));
    expect(current(buffer).incompleteReasons).toContain('feed-gap');
    expect(current(buffer).samples[1]!.position?.breakBefore).toBe(true);
    expect(current(buffer).samples[1]!.measurements?.breakBefore).toBe(true);
  });

  it('does not admit observations already outside the source retention window', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(
      snapshot(LIVE_HISTORY_RETENTION_MS, [aircraft(0)]),
      reading(LIVE_HISTORY_RETENTION_MS),
    );
    expect(buffer.histories.size).toBe(0);
    expect(buffer.trails.size).toBe(0);
  });

  it('excludes future or malformed channel times while preserving independently valid evidence', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0, [aircraft(0, { lastPositionAt: stamp(1_000) })]), reading(0));
    expect(current(buffer).samples[0]!.position).toBeUndefined();
    expect(current(buffer).samples[0]!.measurements).toBeDefined();
    buffer.ingest(snapshot(1_000, [aircraft(1_000, { observedAt: stamp(2_000) })]), reading(1_000));
    expect(current(buffer).samples[1]!.position).toBeDefined();
    expect(current(buffer).samples[1]!.measurements).toBeUndefined();
    buffer.ingest(snapshot(2_000, [aircraft(2_000, { observedAt: 'invalid' })]), reading(2_000));
    expect(current(buffer).samples[2]!.measurements).toBeUndefined();
    buffer.ingest(snapshot(3_000), reading(3_000));
    expect(current(buffer).samples[3]!.measurements?.breakBefore).toBe(true);
    expect(current(buffer).incompleteReasons).toContain('time-uncertain');
    const accepted = buffer.histories;
    buffer.ingest({ ...snapshot(4_000), generatedAt: 'invalid' }, reading(4_000));
    expect(buffer.histories).toBe(accepted);
  });

  it('uses selected-track priority and deterministic eviction without defeating expiry', () => {
    const buffer = new LiveHistoryBuffer(120, 2);
    buffer.ingest(snapshot(0, [aircraft(0, { aircraftId: 'selected' })]), reading(0));
    buffer.ingest(
      snapshot(1_000, [aircraft(1_000, { aircraftId: 'c' }), aircraft(1_000, { aircraftId: 'b' })]),
      reading(1_000),
      undefined,
      'selected',
    );
    expect([...buffer.histories.keys()]).toEqual(['selected', 'c']);
    buffer.maintain(reading(LIVE_HISTORY_RETENTION_MS));
    expect(buffer.histories.has('selected')).toBe(false);
    expect(buffer.histories.has('c')).toBe(true);
  });

  it('evicts departed non-selected histories before active ones and caps the default at 500', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0, [aircraft(0, { aircraftId: 'departed' })]), reading(0));
    const tracks = Array.from({ length: 501 }, (_, index) =>
      aircraft(1_000, { aircraftId: 'track-' + index.toString().padStart(3, '0') }),
    );
    buffer.ingest(snapshot(1_000, tracks), reading(1_000));
    expect(buffer.histories.size).toBe(500);
    expect(buffer.histories.has('departed')).toBe(false);
    expect(buffer.histories.has('track-000')).toBe(false);
    expect(buffer.histories.has('track-500')).toBe(true);
  });

  it('keeps unchanged map/array references and copies only changed aircraft evidence', () => {
    const buffer = new LiveHistoryBuffer();
    const first = aircraft(0);
    const second = aircraft(0, { aircraftId: 'other' });
    buffer.ingest(snapshot(0, [first, second]), reading(0));
    const before = buffer.histories;
    const trails = buffer.trails;
    buffer.ingest(snapshot(1_000, [first, second]), reading(1_000));
    expect(buffer.histories).toBe(before);
    expect(buffer.trails).toBe(trails);
    buffer.ingest(
      snapshot(2_000, [first, aircraft(2_000, { aircraftId: 'other' })]),
      reading(2_000),
    );
    expect(buffer.histories).not.toBe(before);
    expect(current(buffer)).toBe(before.get('a1b2c3'));
    expect(buffer.trails.get('a1b2c3')).toBe(trails.get('a1b2c3'));
    expect(current(buffer, 'other').samples).toHaveLength(2);
    expect(before.get('other')!.samples).toHaveLength(1);
    const updated = buffer.histories;
    buffer.maintain(reading(3_000), time(3_000));
    expect(buffer.histories).toBe(updated);
  });

  it('copies source values and does not retain mutable input objects', () => {
    const buffer = new LiveHistoryBuffer();
    const source = aircraft(0);
    buffer.ingest(snapshot(0, [source]), reading(0));
    source.position!.latitude = 0;
    source.barometricAltitudeFeet = 0;
    expect(current(buffer).samples[0]!.position?.latitude).toBe(33.64);
    expect(current(buffer).samples[0]!.measurements?.barometricAltitudeFeet).toBe(12_000);
  });

  it.each(['wall', 'monotonic', 'invalid'] as const)(
    'clears conservatively after a %s clock discontinuity without publishing a new time reference',
    (kind) => {
      const buffer = new LiveHistoryBuffer();
      buffer.ingest(snapshot(1_000), reading(1_000));
      const next = reading(kind === 'monotonic' ? 0 : 2_000);
      if (kind === 'wall') next.wallMs += 60_000;
      if (kind === 'invalid') next.monotonicMs = Number.NaN;
      buffer.maintain(next);
      expect(buffer.histories.size).toBe(0);
      expect(buffer.trails.size).toBe(0);
    },
  );

  it('clears all evidence and accepts a fresh session after reset', () => {
    const buffer = new LiveHistoryBuffer();
    buffer.ingest(snapshot(0), reading(0));
    buffer.clear();
    buffer.clear();
    expect(buffer.histories.size).toBe(0);
    buffer.ingest(snapshot(0), reading(1_000));
    expect(buffer.histories.size).toBe(1);
  });

  it.each([
    [0, 500],
    [121, 500],
    [120, 0],
    [120, 501],
    [Number.NaN, 1],
  ])('rejects limits outside the contract: %s samples, %s histories', (samples, histories) =>
    expect(() => new LiveHistoryBuffer(samples, histories)).toThrow(RangeError),
  );
});
