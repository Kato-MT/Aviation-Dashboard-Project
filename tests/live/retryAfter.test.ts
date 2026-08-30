import { describe, expect, it } from 'vitest';

import { parseRetryAfter } from '../../src/live/retryAfter';

const now = Date.parse('2026-08-27T12:00:10.000Z');

describe('provider Retry-After deadlines', () => {
  it.each(['300', ' 300 ', '000300'])('anchors delay-seconds %j to header receipt', (header) => {
    expect(parseRetryAfter(header, now)).toEqual({
      retryAfterSeconds: 300,
      retryAtMs: now + 300_000,
    });
  });

  it('preserves a zero delay', () => {
    expect(parseRetryAfter('0', now)).toEqual({ retryAfterSeconds: 0, retryAtMs: now });
  });

  it.each([
    'Thu, 27 Aug 2026 12:05:10 GMT',
    'Thursday, 27-Aug-26 12:05:10 GMT',
    'Thu Aug 27 12:05:10 2026',
  ])('supports HTTP date format %j', (header) => {
    expect(parseRetryAfter(header, now)).toEqual({
      retryAfterSeconds: 300,
      retryAtMs: now + 300_000,
    });
  });

  it.each([
    'Sun, 06 Nov 1994 08:49:37 GMT',
    'Sunday, 06-Nov-94 08:49:37 GMT',
    'Sun Nov  6 08:49:37 1994',
  ])('preserves past dates without inventing a new delay: %j', (header) => {
    expect(parseRetryAfter(header, now)).toEqual({
      retryAfterSeconds: 0,
      retryAtMs: Date.parse('1994-11-06T08:49:37.000Z'),
    });
  });

  it("uses the relative 50-year window rather than JavaScript's fixed two-digit-year cutoff", () => {
    const future = new Date('2050-11-06T08:49:37.000Z');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const header = `${days[future.getUTCDay()]}, 06-Nov-50 08:49:37 GMT`;
    expect(parseRetryAfter(header, now).retryAtMs).toBe(future.getTime());
  });

  it('waits conservatively through a leap second', () => {
    expect(parseRetryAfter('Sat, 31 Dec 2016 23:59:60 GMT', now).retryAtMs).toBe(
      Date.parse('2017-01-01T00:00:00.000Z'),
    );
  });

  it.each([
    null,
    '',
    ' ',
    '-1',
    '+300',
    '1.5',
    '1e3',
    'Infinity',
    'NaN',
    'tomorrow',
    '2026-08-27T12:05:10.000Z',
    'Wed, 27 Aug 2026 12:05:10 GMT',
    'Thu, 27 Bad 2026 12:05:10 GMT',
    'Thu, 32 Aug 2026 12:05:10 GMT',
    'Thu, 27 Aug 2026 25:05:10 GMT',
    'Thu, 27 Aug 2026 12:05:61 GMT',
    'Thu, 27 Aug 2026 12:05:10 UTC',
  ])('ignores malformed Retry-After %j', (header) => {
    expect(parseRetryAfter(header, now)).toEqual({});
  });

  it.each(['9'.repeat(100), '9999999999999'])(
    'blocks an unrepresentable valid delay instead of shortening it',
    (header) => {
      expect(parseRetryAfter(header, now)).toEqual({ retryBlocked: true });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects an unusable server clock %s',
    (clock) => {
      expect(() => parseRetryAfter('300', clock)).toThrow('receivedAtMs');
    },
  );
});
