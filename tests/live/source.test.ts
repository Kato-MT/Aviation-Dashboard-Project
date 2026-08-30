import { describe, expect, it } from 'vitest';
import { describeLiveSource, LIVE_BUILD_TARGETS, parseLiveSource } from '../../src/live/source';

describe('server-owned source provenance', () => {
  it.each(LIVE_BUILD_TARGETS)('round trips enabled and disabled provenance for %s', (target) => {
    const synthetic = target === 'local-mock' || target === 'mock-staging';
    for (const mode of [synthetic ? 'mock' : 'live', 'disabled']) {
      const source = describeLiveSource(target, mode);
      expect(parseLiveSource(source)).toEqual(source);
      expect(source.synthetic).toBe(synthetic);
      expect(source.providerId).toBe(synthetic ? 'synthetic-test' : 'adsb-lol');
    }
  });

  it.each([
    ['local-mock', 'live'],
    ['mock-staging', 'live'],
    ['production', 'mock'],
    ['live-staging', 'mock'],
    ['unknown', 'disabled'],
    ['production', 'automatic'],
  ])('rejects mixed or unknown targets: %s %s', (target, mode) => {
    expect(() => describeLiveSource(target, mode)).toThrow();
  });

  it.each([
    null,
    [],
    {},
    { ...describeLiveSource('local-mock', 'mock'), synthetic: false },
    { ...describeLiveSource('local-mock', 'mock'), providerId: 'adsb-lol' },
    { ...describeLiveSource('production', 'live'), label: 'Synthetic' },
    { ...describeLiveSource('production', 'disabled'), extra: true },
  ])('withholds startup for untrusted provenance: %j', (value) => {
    expect(parseLiveSource(value)).toBeUndefined();
  });
});
