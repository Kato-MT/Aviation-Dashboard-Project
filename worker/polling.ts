import type { LiveProviderError } from '../src/live/provider';
import { RUNTIME_POLICY_LIMITS } from '../src/live/runtimePolicyLimits';

export const POLL_INTERVAL_MS: number = RUNTIME_POLICY_LIMITS.provider.pollIntervalMs;
export const MAX_POLL_TIMESTAMP_MS = Date.parse('9999-12-31T23:59:59.999Z');
const CIRCUIT_BREAKER_FAILURES = RUNTIME_POLICY_LIMITS.provider.circuitBreakerFailures;
const CIRCUIT_BREAKER_MS = RUNTIME_POLICY_LIMITS.provider.circuitBreakerMs;

export interface PollControl {
  nextPollAt?: number | undefined;
  nextRetryAt?: number | undefined;
  circuitOpenUntil?: number | undefined;
  retryBlocked?: boolean | undefined;
}

/** Undefined means no automatic poll is allowed, not an immediate retry. */
export function pollDeadline(control: PollControl): number | undefined {
  return control.retryBlocked
    ? undefined
    : Math.max(control.nextPollAt ?? 0, control.nextRetryAt ?? 0, control.circuitOpenUntil ?? 0);
}

export function validPollTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_POLL_TIMESTAMP_MS
  );
}

/** Provider instructions are lower bounds. Local jitter never shortens them. */
export function providerRetryPlan(
  failures: number,
  error: LiveProviderError | undefined,
  finishedAt: number,
  random: () => number = Math.random,
): Pick<PollControl, 'nextRetryAt' | 'circuitOpenUntil' | 'retryBlocked'> {
  if (!Number.isSafeInteger(failures) || failures < 1) {
    throw new RangeError('failures must be a positive safe integer.');
  }
  const blocked = { retryBlocked: true, nextRetryAt: undefined, circuitOpenUntil: undefined };
  if (
    error?.retryBlocked ||
    !validPollTimestamp(finishedAt) ||
    !validPollTimestamp(finishedAt + POLL_INTERVAL_MS)
  )
    return blocked;
  let providerDeadline = error?.retryAtMs;
  if (providerDeadline === undefined && error?.retryAfterSeconds !== undefined) {
    providerDeadline = finishedAt + Math.ceil(Math.max(0, error.retryAfterSeconds) * 1_000);
  }
  if (providerDeadline !== undefined && !validPollTimestamp(providerDeadline)) return blocked;
  const base = Math.min(20_000 * 2 ** Math.min(2, Math.max(0, failures - 1)), CIRCUIT_BREAKER_MS);
  const draw = random();
  const jitter = Math.floor(
    Math.min(1, Math.max(0, Number.isFinite(draw) ? draw : 0)) * base * 0.1,
  );
  const nextRetryAt = Math.max(
    finishedAt + POLL_INTERVAL_MS,
    providerDeadline ?? 0,
    finishedAt + base + jitter,
  );
  const circuitOpenUntil =
    failures >= CIRCUIT_BREAKER_FAILURES
      ? Math.max(nextRetryAt, finishedAt + CIRCUIT_BREAKER_MS)
      : undefined;
  if (
    !validPollTimestamp(nextRetryAt) ||
    (circuitOpenUntil !== undefined && !validPollTimestamp(circuitOpenUntil))
  )
    return blocked;
  return { retryBlocked: false, nextRetryAt, circuitOpenUntil };
}
