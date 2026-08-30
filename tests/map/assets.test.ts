import { describe, expect, it } from 'vitest';
import manifest from '../../maps/manifest.json';
import { findMapAsset, MAP_PREFIX } from '../../src/map/assets';
import { etagMatches, parseByteRange } from '../../src/map/ranges';

describe('immutable map asset allowlist', () => {
  it('resolves every published asset only at its exact encoded path', () => {
    for (const asset of manifest.assets) {
      expect(findMapAsset(encodeURI(MAP_PREFIX + asset.path))).toEqual(asset);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(asset.bytes).toBeGreaterThan(0);
    }
  });
  it.each([
    '/map-assets/other/basemap.pmtiles',
    MAP_PREFIX + '../basemap.pmtiles',
    MAP_PREFIX + 'fonts%2FNoto%20Sans%20Italic%2F0-255.pbf',
    MAP_PREFIX + '%62asemap.pmtiles',
    MAP_PREFIX + 'unknown.png',
    MAP_PREFIX + '%ZZ',
    MAP_PREFIX + 'a'.repeat(257),
  ])('rejects non-allowlisted or noncanonical path %s', (path) => {
    expect(findMapAsset(path)).toBeUndefined();
  });
});

describe('bounded single byte ranges', () => {
  it.each([
    ['bytes=0-0', { offset: 0, length: 1 }],
    ['bytes=3-9', { offset: 3, length: 7 }],
    ['bytes=3-', { offset: 3, length: 7 }],
    ['bytes=3-99', { offset: 3, length: 7 }],
    ['bytes=-3', { offset: 7, length: 3 }],
    ['bytes=-30', { offset: 0, length: 10 }],
  ])('parses %s', (value, expected) => {
    expect(parseByteRange(value as string, 10)).toEqual(expected);
  });
  it.each([
    '',
    'bytes=-',
    'bytes=-0',
    'bytes=10-',
    'bytes=5-2',
    'bytes=0-1,4-5',
    'bytes=0-1\n',
    'bytes=0-1\r\n',
    'bytes= 0-1',
    'bytes=0.1-1',
    'items=0-1',
    'bytes=9007199254740992-',
    'bytes=0-9007199254740992',
    'x'.repeat(129),
  ])('rejects %j', (value) => {
    expect(parseByteRange(value, 10)).toBeUndefined();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])('rejects object size %s', (size) => {
    expect(parseByteRange('bytes=0-1', size)).toBeUndefined();
  });
  it('distinguishes weak and strong entity-tag comparison', () => {
    expect(etagMatches('W/"asset"', '"asset"', true)).toBe(true);
    expect(etagMatches('W/"asset"', '"asset"', false)).toBe(false);
    expect(etagMatches('"other", "asset"', '"asset"', false)).toBe(true);
    expect(etagMatches('*', '"asset"', false)).toBe(true);
    expect(etagMatches('x'.repeat(1025), '"asset"', true)).toBe(false);
  });
});
