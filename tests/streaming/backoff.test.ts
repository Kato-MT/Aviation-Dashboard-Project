import { describe, expect, it } from 'vitest';

import { BoundedExponentialBackoff } from '../../src/streaming/backoff';

describe('BoundedExponentialBackoff', () => {
  it('uses default options when instantiated without arguments', () => {
    const backoff = new BoundedExponentialBackoff({ jitterRatio: 0 });
    expect(backoff.attempts).toBe(0);
    // Defaults: initialDelayMs=250, multiplier=2, max=10000, maxAttempts=8
    expect(backoff.nextDelay()).toBe(250);
    expect(backoff.attempts).toBe(1);
    expect(backoff.nextDelay()).toBe(500);
    expect(backoff.attempts).toBe(2);
  });

  it.each([
    { options: { initialDelayMs: -1 }, error: 'Backoff delays cannot be negative.' },
    { options: { maximumDelayMs: -100 }, error: 'Backoff delays cannot be negative.' },
    {
      options: { initialDelayMs: 500, maximumDelayMs: 250 },
      error: 'maximumDelayMs cannot be less than initialDelayMs.',
    },
    { options: { multiplier: 0.5 }, error: 'Backoff multiplier must be at least 1.' },
    { options: { maximumAttempts: -1 }, error: 'maximumAttempts must be a non-negative safe integer.' },
    { options: { maximumAttempts: 2.5 }, error: 'maximumAttempts must be a non-negative safe integer.' },
    { options: { maximumAttempts: Number.NaN }, error: 'maximumAttempts must be a non-negative safe integer.' },
    { options: { jitterRatio: -0.1 }, error: 'jitterRatio must be between 0 and 1.' },
    { options: { jitterRatio: 1.1 }, error: 'jitterRatio must be between 0 and 1.' },
  ])('validates options and throws RangeError for invalid values', ({ options, error }) => {
    expect(() => new BoundedExponentialBackoff(options)).toThrow(RangeError);
    expect(() => new BoundedExponentialBackoff(options)).toThrow(error);
  });

  it('calculates exponential backoff and caps at maximumDelayMs', () => {
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 100,
      maximumDelayMs: 350,
      multiplier: 2,
      maximumAttempts: 5,
      jitterRatio: 0,
    });

    expect(backoff.nextDelay()).toBe(100); // 100 * 2^0 = 100
    expect(backoff.nextDelay()).toBe(200); // 100 * 2^1 = 200
    expect(backoff.nextDelay()).toBe(350); // min(350, 100 * 2^2 = 400) = 350
    expect(backoff.nextDelay()).toBe(350); // min(350, 100 * 2^3 = 800) = 350
    expect(backoff.nextDelay()).toBe(350); // min(350, 100 * 2^4 = 1600) = 350
    expect(backoff.attempts).toBe(5);
    expect(backoff.nextDelay()).toBeNull();
    expect(backoff.attempts).toBe(5);
  });

  it('applies jitter according to custom random function', () => {
    let mockRandomValue = 0.5;
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 100,
      maximumDelayMs: 1000,
      multiplier: 2,
      maximumAttempts: 5,
      jitterRatio: 0.2, // +/- 20%
      random: () => mockRandomValue,
    });

    // random = 0.5 -> random()*2 - 1 = 0 -> jitter = 0 -> delay = 100
    expect(backoff.nextDelay()).toBe(100);

    // attempt 1: base = 200
    // random = 0 -> random()*2 - 1 = -1 -> jitter = 200 * 0.2 * (-1) = -40 -> delay = 160
    mockRandomValue = 0;
    expect(backoff.nextDelay()).toBe(160);

    // attempt 2: base = 400
    // random = 1 -> random()*2 - 1 = 1 -> jitter = 400 * 0.2 * (1) = 80 -> delay = 480
    mockRandomValue = 1;
    expect(backoff.nextDelay()).toBe(480);
  });

  it('clamps output to a non-negative integer when jitter would cause negative delay', () => {
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 10,
      maximumDelayMs: 100,
      multiplier: 1,
      maximumAttempts: 3,
      jitterRatio: 1.0, // +/- 100%
      random: () => 0, // jitter = base * 1.0 * (-1) = -base -> result = 0
    });

    expect(backoff.nextDelay()).toBe(0);
  });

  it('resets attempt count when reset() is called', () => {
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 50,
      maximumDelayMs: 500,
      multiplier: 2,
      maximumAttempts: 2,
      jitterRatio: 0,
    });

    expect(backoff.nextDelay()).toBe(50);
    expect(backoff.nextDelay()).toBe(100);
    expect(backoff.attempts).toBe(2);
    expect(backoff.nextDelay()).toBeNull();

    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.nextDelay()).toBe(50);
  });

  it('uses Math.random by default when random option is not provided', () => {
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 100,
      jitterRatio: 0.1,
    });
    const delay = backoff.nextDelay();
    expect(delay).toBeGreaterThanOrEqual(90);
    expect(delay).toBeLessThanOrEqual(110);
  });
});
