import { describe, expect, it } from 'vitest';
import { parseIsoTimestamp, parseLegacyElapsedTimestamp } from '../../src/core/time';

describe('parseLegacyElapsedTimestamp', () => {
  it('parses valid 00:00 timestamp', () => {
    const result = parseLegacyElapsedTimestamp('00:00');
    expect(result).toEqual({
      timestampMs: 0,
      normalized: '1970-01-01T00:00:00.000Z',
    });
  });

  it('parses single-digit minute timestamp', () => {
    const result = parseLegacyElapsedTimestamp('0:00');
    expect(result).toEqual({
      timestampMs: 0,
      normalized: '1970-01-01T00:00:00.000Z',
    });
  });

  it('parses minutes and seconds correctly', () => {
    expect(parseLegacyElapsedTimestamp('00:10')).toEqual({
      timestampMs: 10_000,
      normalized: '1970-01-01T00:00:10.000Z',
    });

    expect(parseLegacyElapsedTimestamp('14:00')).toEqual({
      timestampMs: 840_000,
      normalized: '1970-01-01T00:14:00.000Z',
    });
  });

  it('parses fractional seconds with 1, 2, or 3 decimal places', () => {
    expect(parseLegacyElapsedTimestamp('00:00.1')).toEqual({
      timestampMs: 100,
      normalized: '1970-01-01T00:00:00.100Z',
    });

    expect(parseLegacyElapsedTimestamp('00:00.12')).toEqual({
      timestampMs: 120,
      normalized: '1970-01-01T00:00:00.120Z',
    });

    expect(parseLegacyElapsedTimestamp('00:00.123')).toEqual({
      timestampMs: 123,
      normalized: '1970-01-01T00:00:00.123Z',
    });

    expect(parseLegacyElapsedTimestamp('100:59.5')).toEqual({
      timestampMs: 6_059_500,
      normalized: '1970-01-01T01:40:59.500Z',
    });
  });

  it('handles maximum supported 6-digit minutes', () => {
    const result = parseLegacyElapsedTimestamp('999999:59.999');
    expect(result).toEqual({
      timestampMs: 59_999_999_999,
      normalized: '1971-11-26T10:39:59.999Z',
    });
  });

  it('trims leading and trailing whitespace', () => {
    expect(parseLegacyElapsedTimestamp('   05:30   ')).toEqual({
      timestampMs: 330_000,
      normalized: '1970-01-01T00:05:30.000Z',
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['minutes > 6 digits', '1234567:00'],
    ['seconds >= 60', '00:60'],
    ['seconds = 99', '00:99'],
    ['single digit seconds', '00:5'],
    ['fractional seconds > 3 decimal places', '00:00.1234'],
    ['decimal point with no fraction digits', '00:00.'],
    ['decimal in minutes', '1.5:00'],
    ['negative minutes', '-1:00'],
    ['negative seconds', '00:-10'],
    ['non-numeric minutes', 'ab:00'],
    ['non-numeric seconds', '00:cd'],
    ['missing colon separator', '0000'],
    ['period as separator', '00.00'],
    ['hyphen as separator', '00-00'],
    ['semicolon as separator', '00;00'],
    ['leading non-numeric character', 'a00:00'],
    ['trailing non-numeric character', '00:00z'],
  ])('returns null for invalid format: %s (%s)', (_, input) => {
    expect(parseLegacyElapsedTimestamp(input)).toBeNull();
  });
});

describe('parseIsoTimestamp', () => {
  it('parses valid ISO timestamps and normalizes to UTC', () => {
    expect(parseIsoTimestamp('2026-07-17T01:00:00-04:00')).toEqual({
      timestampMs: Date.parse('2026-07-17T05:00:00.000Z'),
      normalized: '2026-07-17T05:00:00.000Z',
    });

    expect(parseIsoTimestamp('1970-01-01T00:00:00.000Z')).toEqual({
      timestampMs: 0,
      normalized: '1970-01-01T00:00:00.000Z',
    });
  });

  it('trims whitespace around ISO timestamps', () => {
    expect(parseIsoTimestamp('  1970-01-01T00:00:00.000Z  ')).toEqual({
      timestampMs: 0,
      normalized: '1970-01-01T00:00:00.000Z',
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['invalid text', 'today-ish'],
    ['malformed date', '2026-13-45'],
  ])('returns null for invalid ISO timestamp: %s (%s)', (_, input) => {
    expect(parseIsoTimestamp(input)).toBeNull();
  });
});
