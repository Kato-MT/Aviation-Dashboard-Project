import { describe, expect, it } from 'vitest';

import benchmark from '../../benchmark/latest.json';
import { DEFAULT_INPUT_LIMITS, validateUploadLimits } from '../../src/core';

describe('performance and bounded-input evidence', () => {
  it('TC-PERF-001 through TC-PERF-003 records all required benchmark scales', () => {
    expect(benchmark.reproducibility.sizes).toEqual([1_000, 10_000, 100_000]);
    expect(benchmark.results.map((result) => result.sampleCount)).toEqual([1_000, 10_000, 100_000]);
    for (const result of benchmark.results) {
      expect(result.iterations).toBeGreaterThanOrEqual(3);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.throughputPerSecond).toBeGreaterThan(0);
      expect(result.findingCount).toBe(0);
    }
  });

  it('TC-CSV-018 enforces the exact 10 MiB upload boundary', () => {
    expect(validateUploadLimits(DEFAULT_INPUT_LIMITS.maxBytes, 1)).toEqual([]);
    expect(validateUploadLimits(DEFAULT_INPUT_LIMITS.maxBytes + 1, 1)[0]?.code).toBe(
      'UPLOAD_TOO_LARGE',
    );
  });

  it('TC-CSV-019 enforces the exact 250,000-sample boundary', () => {
    expect(validateUploadLimits(1, DEFAULT_INPUT_LIMITS.maxSamples)).toEqual([]);
    expect(validateUploadLimits(1, DEFAULT_INPUT_LIMITS.maxSamples + 1)[0]?.code).toBe(
      'SAMPLE_LIMIT_EXCEEDED',
    );
  });
});
