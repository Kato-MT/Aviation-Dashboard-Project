export interface BackoffOptions {
  initialDelayMs: number;
  maximumDelayMs: number;
  multiplier: number;
  maximumAttempts: number;
  jitterRatio: number;
  random?: () => number;
}

const DEFAULT_OPTIONS: BackoffOptions = {
  initialDelayMs: 250,
  maximumDelayMs: 10_000,
  multiplier: 2,
  maximumAttempts: 8,
  jitterRatio: 0.2,
};

export class BoundedExponentialBackoff {
  private readonly options: BackoffOptions;
  private attemptCount = 0;

  constructor(options: Partial<BackoffOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.initialDelayMs < 0 || this.options.maximumDelayMs < 0) {
      throw new RangeError('Backoff delays cannot be negative.');
    }
    if (this.options.maximumDelayMs < this.options.initialDelayMs) {
      throw new RangeError('maximumDelayMs cannot be less than initialDelayMs.');
    }
    if (this.options.multiplier < 1) {
      throw new RangeError('Backoff multiplier must be at least 1.');
    }
    if (!Number.isSafeInteger(this.options.maximumAttempts) || this.options.maximumAttempts < 0) {
      throw new RangeError('maximumAttempts must be a non-negative safe integer.');
    }
    if (this.options.jitterRatio < 0 || this.options.jitterRatio > 1) {
      throw new RangeError('jitterRatio must be between 0 and 1.');
    }
  }

  get attempts(): number {
    return this.attemptCount;
  }

  nextDelay(): number | null {
    if (this.attemptCount >= this.options.maximumAttempts) {
      return null;
    }
    const base = Math.min(
      this.options.maximumDelayMs,
      this.options.initialDelayMs * this.options.multiplier ** this.attemptCount,
    );
    this.attemptCount += 1;
    const random = this.options.random ?? Math.random;
    const jitter = base * this.options.jitterRatio * (random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  reset(): void {
    this.attemptCount = 0;
  }
}
