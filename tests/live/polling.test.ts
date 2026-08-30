import { describe, expect, it } from 'vitest';

import { LiveProviderError } from '../../src/live/provider';
import {
  MAX_POLL_TIMESTAMP_MS,
  POLL_INTERVAL_MS,
  pollDeadline,
  providerRetryPlan,
  validPollTimestamp,
} from '../../worker/polling';

const now = Date.parse('2026-08-27T12:00:00.000Z');
const providerError = (options: ConstructorParameters<typeof LiveProviderError>[2]) =>
  new LiveProviderError('UPSTREAM_RATE_LIMITED', 'Controlled provider failure.', options);

describe('shared polling deadlines', () => {
  it('takes the maximum of cadence, retry and circuit deadlines', () => {
    expect(pollDeadline({})).toBe(0);
    expect(pollDeadline({ nextPollAt: 30, nextRetryAt: 20, circuitOpenUntil: 10 })).toBe(30);
    expect(pollDeadline({ nextPollAt: 10, nextRetryAt: 30, circuitOpenUntil: 20 })).toBe(30);
    expect(pollDeadline({ nextPollAt: 10, nextRetryAt: 20, circuitOpenUntil: 30 })).toBe(30);
  });

  it('does not turn an explicitly blocked retry into an immediately due poll', () => {
    expect(pollDeadline({ retryBlocked: true, nextPollAt: now })).toBeUndefined();
    expect(pollDeadline({ retryBlocked: false, nextPollAt: now })).toBe(now);
  });

  it.each([0, now, MAX_POLL_TIMESTAMP_MS])(
    'accepts representable integer deadlines: %s',
    (value) => {
      expect(validPollTimestamp(value)).toBe(true);
    },
  );

  it.each([undefined, null, '0', -1, 0.5, NaN, Infinity, MAX_POLL_TIMESTAMP_MS + 1])(
    'rejects invalid persisted deadlines: %s',
    (value) => expect(validPollTimestamp(value)).toBe(false),
  );

  it.each([
    { failures: 1, random: 0, delay: 20_000, circuit: undefined },
    { failures: 1, random: 1, delay: 22_000, circuit: undefined },
    { failures: 2, random: 0.5, delay: 42_000, circuit: undefined },
    { failures: 3, random: 0, delay: 60_000, circuit: 60_000 },
    { failures: 3, random: 1, delay: 66_000, circuit: 66_000 },
    { failures: Number.MAX_SAFE_INTEGER, random: 0, delay: 60_000, circuit: 60_000 },
  ])('uses completion-based local backoff and nonnegative jitter: %j', (test) => {
    expect(providerRetryPlan(test.failures, undefined, now, () => test.random)).toEqual({
      retryBlocked: false,
      nextRetryAt: now + test.delay,
      circuitOpenUntil: test.circuit === undefined ? undefined : now + test.circuit,
    });
  });

  it.each([0, 1, 10, 20])(
    'does not let a short provider delay shorten local backoff: %s',
    (seconds) => {
      const plan = providerRetryPlan(
        1,
        providerError({ retryAtMs: now + seconds * 1_000 }),
        now,
        () => 1,
      );
      expect(plan.nextRetryAt).toBe(now + 22_000);
    },
  );

  it('keeps the absolute provider deadline instead of rebasing it on failure completion', () => {
    const plan = providerRetryPlan(
      3,
      providerError({ retryAtMs: now + 300_000, retryAfterSeconds: 300 }),
      now + 8_000,
      () => 1,
    );
    expect(plan).toEqual({
      retryBlocked: false,
      nextRetryAt: now + 300_000,
      circuitOpenUntil: now + 300_000,
    });
  });

  it('starts local backoff at failure completion even when the provider deadline is earlier', () => {
    const plan = providerRetryPlan(
      1,
      providerError({ retryAtMs: now + 15_000 }),
      now + 8_000,
      () => 0,
    );
    expect(plan.nextRetryAt).toBe(now + 28_000);
  });

  it('supports legacy relative provider delays without a sixty-second cap', () => {
    expect(
      providerRetryPlan(1, providerError({ retryAfterSeconds: 300 }), now, () => 0).nextRetryAt,
    ).toBe(now + 300_000);
  });

  it('also respects a later cadence reservation', () => {
    const plan = providerRetryPlan(1, undefined, now, () => 0);
    expect(pollDeadline({ ...plan, nextPollAt: now + 5 * POLL_INTERVAL_MS })).toBe(now + 50_000);
  });

  it.each([NaN, Infinity, -1])('bounds an unusable jitter source: %s', (draw) => {
    expect(providerRetryPlan(1, undefined, now, () => draw).nextRetryAt).toBe(now + 20_000);
  });

  it.each([
    { retryBlocked: true },
    { retryAtMs: Infinity },
    { retryAtMs: now + 0.5 },
    { retryAtMs: MAX_POLL_TIMESTAMP_MS + 1 },
    { retryAfterSeconds: Infinity },
    { retryAfterSeconds: NaN },
  ])('fails closed for an unrepresentable provider restriction: %j', (options) => {
    const plan = providerRetryPlan(1, providerError(options), now, () => 0);
    expect(plan).toEqual({
      retryBlocked: true,
      nextRetryAt: undefined,
      circuitOpenUntil: undefined,
    });
    expect(pollDeadline(plan)).toBeUndefined();
  });

  it.each([-1, NaN, MAX_POLL_TIMESTAMP_MS - POLL_INTERVAL_MS])(
    'fails closed when the completion clock cannot safely represent the next retry: %s',
    (finishedAt) =>
      expect(providerRetryPlan(1, undefined, finishedAt, () => 0).retryBlocked).toBe(true),
  );

  it.each([0, -1, 0.5, NaN, Infinity])('rejects an invalid failure count: %s', (failures) => {
    expect(() => providerRetryPlan(failures, undefined, now)).toThrow('failures');
  });
});
