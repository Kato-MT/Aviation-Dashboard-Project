import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_LIMITS } from '../../src/core/constants';
import { resolveInputLimits, utf8ByteLength, validateUploadLimits } from '../../src/core/limits';

describe('utf8ByteLength', () => {
  it('returns 0 for an empty string', () => {
    expect(utf8ByteLength('')).toBe(0);
  });

  it('returns byte length for standard ASCII strings', () => {
    const ascii = 'Hello, World!';
    expect(utf8ByteLength(ascii)).toBe(ascii.length);
    expect(utf8ByteLength(ascii)).toBe(13);
  });

  it('returns correct byte length for 2-byte UTF-8 characters', () => {
    // 'café' has 4 characters, 'é' takes 2 bytes -> 5 bytes total
    const str = 'café';
    expect(str.length).toBe(4);
    expect(utf8ByteLength(str)).toBe(5);
  });

  it('returns correct byte length for 3-byte UTF-8 characters', () => {
    // '✈' (U+2708) takes 3 bytes in UTF-8
    const str = '✈';
    expect(str.length).toBe(1);
    expect(utf8ByteLength(str)).toBe(3);

    // '汉字' has 2 characters, each takes 3 bytes -> 6 bytes total
    const cjkStr = '汉字';
    expect(cjkStr.length).toBe(2);
    expect(utf8ByteLength(cjkStr)).toBe(6);
  });

  it('returns correct byte length for 4-byte UTF-8 surrogate pair characters (emojis)', () => {
    // '🚀' (U+1F680) is a surrogate pair in JS UTF-16 (length 2), 4 bytes in UTF-8
    const rocket = '🚀';
    expect(rocket.length).toBe(2);
    expect(utf8ByteLength(rocket)).toBe(4);
  });

  it('returns correct byte length for mixed ASCII and multi-byte Unicode strings', () => {
    // 'Flight ✈️ 101' -> 'Flight ' (7) + '✈' (3) + variation selector (3) + ' 101' (4) = 17 bytes
    const mixed = 'Flight ✈️ 101';
    expect(utf8ByteLength(mixed)).toBe(new TextEncoder().encode(mixed).byteLength);
  });
});

describe('resolveInputLimits', () => {
  it('returns default limits when no overrides are provided', () => {
    expect(resolveInputLimits()).toEqual(DEFAULT_INPUT_LIMITS);
  });

  it('applies partial overrides for maxBytes', () => {
    const limits = resolveInputLimits({ maxBytes: 1024 });
    expect(limits).toEqual({
      maxBytes: 1024,
      maxSamples: DEFAULT_INPUT_LIMITS.maxSamples,
    });
  });

  it('applies partial overrides for maxSamples', () => {
    const limits = resolveInputLimits({ maxSamples: 500 });
    expect(limits).toEqual({
      maxBytes: DEFAULT_INPUT_LIMITS.maxBytes,
      maxSamples: 500,
    });
  });

  it('applies full overrides for maxBytes and maxSamples', () => {
    const limits = resolveInputLimits({ maxBytes: 2048, maxSamples: 100 });
    expect(limits).toEqual({
      maxBytes: 2048,
      maxSamples: 100,
    });
  });
});

describe('validateUploadLimits', () => {
  it('returns no issues when input is within default limits', () => {
    const issues = validateUploadLimits(100, 100);
    expect(issues).toEqual([]);
  });

  it('returns UPLOAD_TOO_LARGE issue when input bytes exceed limit', () => {
    const maxBytes = DEFAULT_INPUT_LIMITS.maxBytes;
    const issues = validateUploadLimits(maxBytes + 1, 100);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      disposition: 'fatal',
      observedValue: maxBytes + 1,
    });
  });

  it('returns SAMPLE_LIMIT_EXCEEDED issue when sample count exceeds limit', () => {
    const maxSamples = DEFAULT_INPUT_LIMITS.maxSamples;
    const issues = validateUploadLimits(100, maxSamples + 1);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'SAMPLE_LIMIT_EXCEEDED',
      disposition: 'fatal',
      observedValue: maxSamples + 1,
    });
  });

  it('returns both issues when byte count and sample count exceed limits', () => {
    const maxBytes = DEFAULT_INPUT_LIMITS.maxBytes;
    const maxSamples = DEFAULT_INPUT_LIMITS.maxSamples;
    const issues = validateUploadLimits(maxBytes + 1, maxSamples + 1);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code)).toEqual(['UPLOAD_TOO_LARGE', 'SAMPLE_LIMIT_EXCEEDED']);
  });

  it('respects custom limit overrides', () => {
    const issues = validateUploadLimits(500, 50, { maxBytes: 400, maxSamples: 40 });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code)).toEqual(['UPLOAD_TOO_LARGE', 'SAMPLE_LIMIT_EXCEEDED']);
  });
});
