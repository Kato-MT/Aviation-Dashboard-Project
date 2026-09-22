import { describe, expect, it } from 'vitest';
import { parseIsoTimestamp } from '../../src/core/time';

describe('parseIsoTimestamp', () => {
  it('returns null for empty or whitespace-only strings', () => {
    expect(parseIsoTimestamp('')).toBeNull();
    expect(parseIsoTimestamp('   ')).toBeNull();
    expect(parseIsoTimestamp('\t\n\r ')).toBeNull();
  });

  it('returns null for invalid date strings', () => {
    expect(parseIsoTimestamp('today-ish')).toBeNull();
    expect(parseIsoTimestamp('invalid-date')).toBeNull();
    expect(parseIsoTimestamp('2026-13-45')).toBeNull();
    expect(parseIsoTimestamp('not a timestamp')).toBeNull();
  });

  it('parses valid ISO UTC timestamps with milliseconds', () => {
    const result = parseIsoTimestamp('2026-07-17T05:00:00.123Z');
    expect(result).not.toBeNull();
    expect(result).toEqual({
      normalized: '2026-07-17T05:00:00.123Z',
      timestampMs: Date.parse('2026-07-17T05:00:00.123Z'),
    });
  });

  it('parses valid ISO UTC timestamps without milliseconds', () => {
    const result = parseIsoTimestamp('2026-07-17T05:00:00Z');
    expect(result).not.toBeNull();
    expect(result).toEqual({
      normalized: '2026-07-17T05:00:00.000Z',
      timestampMs: Date.parse('2026-07-17T05:00:00.000Z'),
    });
  });

  it('normalizes ISO timestamps with non-UTC timezone offsets', () => {
    const resultMinus4 = parseIsoTimestamp('2026-07-17T01:00:00-04:00');
    expect(resultMinus4).not.toBeNull();
    expect(resultMinus4?.normalized).toBe('2026-07-17T05:00:00.000Z');
    expect(resultMinus4?.timestampMs).toBe(Date.parse('2026-07-17T05:00:00.000Z'));

    const resultPlus2 = parseIsoTimestamp('2026-07-17T07:00:00+02:00');
    expect(resultPlus2).not.toBeNull();
    expect(resultPlus2?.normalized).toBe('2026-07-17T05:00:00.000Z');
    expect(resultPlus2?.timestampMs).toBe(Date.parse('2026-07-17T05:00:00.000Z'));
  });

  it('handles timestamps surrounded by whitespace', () => {
    const result = parseIsoTimestamp('   2026-07-17T05:00:00.000Z \t ');
    expect(result).not.toBeNull();
    expect(result?.normalized).toBe('2026-07-17T05:00:00.000Z');
    expect(result?.timestampMs).toBe(Date.parse('2026-07-17T05:00:00.000Z'));
  });

  it('parses date-only ISO strings', () => {
    const result = parseIsoTimestamp('2026-07-17');
    expect(result).not.toBeNull();
    expect(result?.normalized).toBe('2026-07-17T00:00:00.000Z');
    expect(result?.timestampMs).toBe(Date.parse('2026-07-17T00:00:00.000Z'));
  });
});
