import { describe, expect, it } from 'vitest';
import { nearestMapEvidence } from '../../src/map/hitTest';
import { LIVE_FIXTURE_EPOCH } from '../live/fixtures';

const point = { x: 100, y: 100 };
const project = ([x, y]: [number, number]) => ({ x, y });
const binding = {
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  feedEpoch: LIVE_FIXTURE_EPOCH,
} as const;
const feature = (id: string, x: number, y: number, historySequence?: number) => ({
  geometry: { type: 'Point', coordinates: [x, y] },
  properties: {
    aircraftId: id,
    ...(historySequence === undefined ? {} : { historySequence, ...binding }),
  },
});

describe('geographic hit testing', () => {
  it('selects the nearest observed position instead of the first overlapping symbol box', () => {
    const neighbors = [feature('neighbor', 112, 111), feature('intended', 100, 101)];
    expect(nearestMapEvidence(neighbors, point, project)).toEqual({
      mode: 'latest',
      aircraftId: 'intended',
    });
    expect(nearestMapEvidence([...neighbors].reverse(), point, project)).toEqual({
      mode: 'latest',
      aircraftId: 'intended',
    });
  });
  it('uses a deterministic identity tie-break for coincident observations', () => {
    expect(
      nearestMapEvidence([feature('b', 100, 100), feature('a', 100, 100)], point, project),
    ).toEqual({ mode: 'latest', aircraftId: 'a' });
  });
  it('prefers an exact trail receipt and then the newest coincident receipt', () => {
    expect(
      nearestMapEvidence(
        [feature('track', 100, 100), feature('track', 100, 100, 1), feature('track', 100, 100, 2)],
        point,
        project,
      ),
    ).toEqual({
      mode: 'exact',
      key: { aircraftId: 'track', sequence: 2, ...binding },
    });
  });
  it('does not select distant observations just because a large collision box overlaps', () => {
    expect(nearestMapEvidence([feature('distant', 123, 100)], point, project)).toBeUndefined();
    expect(nearestMapEvidence([feature('edge', 122, 100)], point, project)).toEqual({
      mode: 'latest',
      aircraftId: 'edge',
    });
  });
  it('ignores non-observation and malformed features', () => {
    expect(
      nearestMapEvidence(
        [
          { geometry: { type: 'Polygon', coordinates: [] }, properties: { aircraftId: 'polygon' } },
          { geometry: { type: 'Point' }, properties: { aircraftId: 'missing' } },
          { geometry: { type: 'Point', coordinates: [100, 100] }, properties: null },
          { geometry: { type: 'Point', coordinates: [100, 100] }, properties: { aircraftId: 123 } },
          feature('invalid', NaN, 100),
          feature('invalid-sequence', 100, 100, -1),
          {
            geometry: { type: 'Point', coordinates: [100, 100] },
            properties: { aircraftId: 'missing-binding', historySequence: 1 },
          },
          {
            geometry: { type: 'Point', coordinates: [100, 100, 100] },
            properties: { aircraftId: 'invalid' },
          },
        ],
        point,
        project,
      ),
    ).toBeUndefined();
  });
  it('ignores nonfinite projections and an empty map', () => {
    expect(
      nearestMapEvidence([feature('invalid', 100, 100)], point, () => ({ x: Infinity, y: 100 })),
    ).toBeUndefined();
    expect(nearestMapEvidence([], point, project)).toBeUndefined();
  });
});
