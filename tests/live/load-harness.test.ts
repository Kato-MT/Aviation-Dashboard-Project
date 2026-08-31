import { describe, expect, it } from 'vitest';

import {
  assessProviderCadence,
  assessSoakMemoryPlateau,
  attemptAccountingIsComplete,
  measuredOutcome,
  parseLoadHarnessCli,
  percentile,
  summarizeSamples,
  theilSenBytesPerMinute,
  validateAckReceiptTiming,
  type AckReceiptTiming,
  type HardGate,
} from '../../tools/live/loadHarnessReport';

function ackTiming(overrides: Partial<AckReceiptTiming> = {}): AckReceiptTiming {
  return {
    clientIndex: 7,
    deliveryId: 'delivery-17',
    configuredDelayMs: 25,
    receivedMonotonicMs: 100,
    timerFiredMonotonicMs: 125,
    callbackMonotonicMs: 126,
    ...overrides,
  };
}

function gate(id: string, category: HardGate['category'], passed: boolean): HardGate {
  return { id, category, passed, detail: `${id}: ${passed ? 'passed' : 'failed'}` };
}

describe('load-harness CLI contract', () => {
  const rawArtifact = ['--artifact-root', 'dist-mock-staging'] as const;
  const parseRaw = (argv: readonly string[] = []) => parseLoadHarnessCli([...rawArtifact, ...argv]);

  it('requires an explicit input and uses the complete smoke scenario for a raw artifact', () => {
    expect(() => parseLoadHarnessCli([])).toThrow(
      'Exactly one --artifact-root or --candidate-directory must be supplied.',
    );
    expect(parseRaw()).toEqual({
      scenario: {
        profile: 'smoke',
        durationMs: 30_000,
        recordsPerSnapshot: 500,
        offeredViewers: 26,
        admittedViewers: 25,
        stalledViewerIndex: 24,
        ackDelaysMs: [0, 25, 100, 500],
        regionId: 'atlanta',
        pingProbeIntervalMs: 2_000,
        memorySampleIntervalMs: 5_000,
      },
      artifactInput: { mode: 'artifact-root', path: 'dist-mock-staging' },
      help: false,
    });
  });

  it('selects a retained candidate and permits help without an input', () => {
    expect(parseLoadHarnessCli(['--candidate-directory', '.tmp-tests/candidate'])).toMatchObject({
      artifactInput: { mode: 'retained-candidate', path: '.tmp-tests/candidate' },
      help: false,
    });
    expect(parseLoadHarnessCli(['--help'])).toMatchObject({ help: true });
  });

  it('rejects missing, empty, duplicate, and conflicting input selectors', () => {
    expect(() => parseLoadHarnessCli(['--artifact-root'])).toThrow(
      '--artifact-root requires a value.',
    );
    expect(() => parseLoadHarnessCli(['--candidate-directory', '  '])).toThrow(
      '--candidate-directory requires a value.',
    );
    expect(() => parseLoadHarnessCli(['--artifact-root', 'one', '--artifact-root', 'two'])).toThrow(
      'Exactly one --artifact-root or --candidate-directory must be supplied.',
    );
    expect(() =>
      parseLoadHarnessCli(['--artifact-root', 'one', '--candidate-directory', 'two']),
    ).toThrow('Exactly one --artifact-root or --candidate-directory must be supplied.');
  });

  it.each([
    ['maximum', 30_000, 2_000],
    ['soak', 1_800_000, 500],
  ] as const)('uses the declared defaults for the %s profile', (profile, durationMs, records) => {
    expect(parseRaw(['--profile', profile]).scenario).toMatchObject({
      profile,
      durationMs,
      recordsPerSnapshot: records,
    });
  });

  it('rejects unknown and missing profile names', () => {
    expect(() => parseRaw(['--profile', 'burst'])).toThrow(
      '--profile must be one of: smoke, maximum, soak.',
    );
    expect(() => parseRaw(['--profile'])).toThrow('--profile requires a value.');
  });

  it('refuses a soak shorter than 1,800 seconds and accepts the exact boundary', () => {
    expect(() => parseRaw(['--profile', 'soak', '--duration-seconds', '1799'])).toThrow(
      'The soak profile must run for at least 30 real minutes.',
    );
    expect(parseRaw(['--profile', 'soak', '--duration-seconds', '1800']).scenario.durationMs).toBe(
      1_800_000,
    );
  });

  it('requires enough measured time to observe the next policy-cadence publication', () => {
    expect(() => parseRaw(['--duration-seconds', '24'])).toThrow(
      'Measured profiles must run for at least 25 real seconds so the evidence window can include a policy-cadence provider publication.',
    );
    expect(parseRaw(['--duration-seconds', '25']).scenario.durationMs).toBe(25_000);
  });

  it.each([
    ['smoke', '500', '2000'],
    ['maximum', '2000', '500'],
  ] as const)(
    'keeps the %s profile at its fixed record count',
    (profile, requiredRecords, wrongRecords) => {
      expect(
        parseRaw(['--profile', profile, '--records', requiredRecords]).scenario.recordsPerSnapshot,
      ).toBe(Number(requiredRecords));
      expect(() => parseRaw(['--profile', profile, '--records', wrongRecords])).toThrow(
        `The ${profile} profile requires exactly ${Number(requiredRecords).toLocaleString('en-US')} synthetic records.`,
      );
    },
  );
});

describe('load-harness sample summaries', () => {
  it('interpolates percentiles without mutating sample order', () => {
    const samples = [30, 0, 20, 10];

    expect(percentile(samples, 0)).toBe(0);
    expect(percentile(samples, 50)).toBe(15);
    expect(percentile(samples, 95)).toBeCloseTo(28.5);
    expect(percentile(samples, 100)).toBe(30);
    expect(samples).toEqual([30, 0, 20, 10]);
  });

  it('summarizes finite samples and represents an empty measurement explicitly', () => {
    const summary = summarizeSamples([30, 0, 20, 10]);
    expect(summary).toMatchObject({
      count: 4,
      min: 0,
      max: 30,
      mean: 15,
      p50: 15,
    });
    expect(summary.p95).toBeCloseTo(28.5);
    expect(summary.p99).toBeCloseTo(29.7);
    expect(summarizeSamples([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it('rejects invalid percentile requests and non-finite samples', () => {
    for (const requested of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => percentile([1], requested)).toThrow(
        'Percentile must be finite and within [0, 100].',
      );
    }
    expect(() => summarizeSamples([1, Number.NaN])).toThrow('Measured samples must all be finite.');
  });
});

describe('load-harness soak memory assessment', () => {
  const durationMs = 30 * 60_000;
  const sampleIntervalMs = 5_000;

  function samples(growthPerMinuteBytes = 0) {
    return Array.from({ length: durationMs / sampleIntervalMs + 1 }, (_, index) => {
      const atMs = index * sampleIntervalMs;
      return {
        atMs,
        scheduledAtMs: atMs,
        completedAtMs: atMs + 25,
        pollDurationMs: 25,
        rssBytes: 256 * 1_024 * 1_024 + (growthPerMinuteBytes * atMs) / 60_000,
        pids: [41],
      };
    });
  }

  it('accepts a complete stable 30-minute process plateau', () => {
    expect(assessSoakMemoryPlateau(samples(), durationMs, sampleIntervalMs)).toMatchObject({
      eligible: true,
      passed: true,
      expectedSamples: 361,
      observedSamples: 361,
      completeness: 1,
      missedSamples: 0,
      invalidSampleCount: 0,
      stableProcessIdentity: true,
      startBoundaryCovered: true,
      endBoundaryCovered: true,
      duplicateTimestampCount: 0,
      duplicateScheduledTimestampCount: 0,
      maximumGapMs: 5_000,
      maximumPollDurationMs: 25,
      tailGrowthBytes: 0,
      theilSenBytesPerMinute: 0,
    });
  });

  it('rejects sustained growth, missing samples, and a workerd PID replacement', () => {
    const growing = assessSoakMemoryPlateau(
      samples(1 * 1_024 * 1_024),
      durationMs,
      sampleIntervalMs,
    );
    expect(growing.passed).toBe(false);
    expect(growing.theilSenBytesPerMinute).toBeCloseTo(1 * 1_024 * 1_024);

    const incomplete = samples().slice(0, -10);
    expect(assessSoakMemoryPlateau(incomplete, durationMs, sampleIntervalMs).passed).toBe(false);

    const replaced = samples();
    replaced.at(-1)!.pids = [42];
    expect(assessSoakMemoryPlateau(replaced, durationMs, sampleIntervalMs)).toMatchObject({
      stableProcessIdentity: false,
      passed: false,
    });
  });

  it('does not classify a shorter sample as a soak plateau', () => {
    expect(assessSoakMemoryPlateau(samples(), 29 * 60_000, sampleIntervalMs)).toMatchObject({
      eligible: false,
      passed: false,
      expectedSamples: 0,
    });
  });

  it('rejects excessive gaps, missing boundary coverage, duplicate timestamps, and slow polls', () => {
    const gap = samples();
    gap.splice(100, 2);
    expect(assessSoakMemoryPlateau(gap, durationMs, sampleIntervalMs)).toMatchObject({
      completeness: expect.any(Number),
      maximumGapMs: 15_000,
      passed: false,
    });

    const lateStart = samples().map((sample) => ({
      ...sample,
      atMs: sample.atMs + 10_000,
      scheduledAtMs: sample.scheduledAtMs + 10_000,
      completedAtMs: sample.completedAtMs + 10_000,
    }));
    expect(assessSoakMemoryPlateau(lateStart, durationMs, sampleIntervalMs)).toMatchObject({
      startBoundaryCovered: false,
      passed: false,
    });

    const duplicate = samples();
    duplicate[1] = { ...duplicate[0]! };
    expect(assessSoakMemoryPlateau(duplicate, durationMs, sampleIntervalMs)).toMatchObject({
      duplicateTimestampCount: 1,
      duplicateScheduledTimestampCount: 1,
      passed: false,
    });

    const slowPoll = samples();
    slowPoll[10] = {
      ...slowPoll[10]!,
      completedAtMs: slowPoll[10]!.atMs + 6_000,
      pollDurationMs: 6_000,
    };
    expect(assessSoakMemoryPlateau(slowPoll, durationMs, sampleIntervalMs)).toMatchObject({
      maximumPollDurationMs: 6_000,
      passed: false,
    });

    const inconsistentTiming = samples();
    inconsistentTiming[20] = {
      ...inconsistentTiming[20]!,
      completedAtMs: inconsistentTiming[20]!.atMs + 125,
      pollDurationMs: 25,
    };
    expect(assessSoakMemoryPlateau(inconsistentTiming, durationMs, sampleIntervalMs)).toMatchObject(
      {
        invalidSampleCount: 1,
        passed: false,
      },
    );
  });

  it('uses a robust median pairwise slope', () => {
    expect(
      theilSenBytesPerMinute([
        { atMs: 0, rssBytes: 100 },
        { atMs: 60_000, rssBytes: 200 },
        { atMs: 120_000, rssBytes: 300 },
        { atMs: 180_000, rssBytes: 400 },
        { atMs: 240_000, rssBytes: 100_000 },
      ]),
    ).toBe(100);
  });
});

describe('load-harness integrity helpers', () => {
  it('enforces both early and late provider cadence bounds', () => {
    expect(assessProviderCadence([100, 10_100, 20_200], 10_000, 1_000, 5_000)).toMatchObject({
      valid: true,
      gapsMs: [10_000, 10_100],
      minimumAllowedGapMs: 9_000,
      maximumAllowedGapMs: 15_000,
    });
    expect(assessProviderCadence([100, 4_100, 8_100], 10_000, 1_000, 5_000).valid).toBe(false);
    expect(assessProviderCadence([100, 16_100], 10_000, 1_000, 5_000).valid).toBe(false);
    expect(assessProviderCadence([100, 50], 10_000, 1_000, 5_000).valid).toBe(false);
    expect(assessProviderCadence([100], 10_000, 1_000, 5_000).valid).toBe(true);
  });

  it('accepts a well-ordered ACK receipt timing sample', () => {
    expect(validateAckReceiptTiming(ackTiming())).toEqual([]);
  });

  it('allows sub-two-millisecond timer sampling jitter but rejects larger early firing', () => {
    expect(validateAckReceiptTiming(ackTiming({ timerFiredMonotonicMs: 123.1 }))).toEqual([]);
    expect(validateAckReceiptTiming(ackTiming({ timerFiredMonotonicMs: 122.9 }))).toContain(
      'The ACK timer fired before its configured delay elapsed.',
    );
  });

  it('reports invalid identity and every reversed ACK timing relationship', () => {
    expect(
      validateAckReceiptTiming(
        ackTiming({
          clientIndex: -1,
          deliveryId: '',
          timerFiredMonotonicMs: 99,
          callbackMonotonicMs: 98,
        }),
      ),
    ).toEqual([
      'clientIndex must be a non-negative safe integer.',
      'deliveryId must be non-empty.',
      'The ACK timer cannot fire before frame receipt.',
      'The ACK send callback cannot precede the ACK timer.',
      'The ACK timer fired before its configured delay elapsed.',
    ]);
  });

  it.each([
    ['configuredDelayMs', -1],
    ['receivedMonotonicMs', Number.NaN],
    ['timerFiredMonotonicMs', Number.POSITIVE_INFINITY],
    ['callbackMonotonicMs', -1],
  ] as const)('rejects a non-finite or negative %s value', (field, value) => {
    expect(validateAckReceiptTiming(ackTiming({ [field]: value }))).toContain(
      `${field} must be finite and non-negative.`,
    );
  });

  it('requires every offered connection attempt to have exactly one terminal classification', () => {
    expect(
      attemptAccountingIsComplete({
        offered: 101,
        admitted: 100,
        classifiedRejected: 1,
        failed: 0,
      }),
    ).toBe(true);
    expect(
      attemptAccountingIsComplete({
        offered: 101,
        admitted: 100,
        classifiedRejected: 0,
        failed: 0,
      }),
    ).toBe(false);
  });

  it.each([
    { offered: -1, admitted: 0, classifiedRejected: 0, failed: 0 },
    { offered: 1.5, admitted: 1, classifiedRejected: 0.5, failed: 0 },
    { offered: Number.MAX_SAFE_INTEGER + 1, admitted: 0, classifiedRejected: 0, failed: 0 },
  ])('rejects invalid attempt counters: %j', (attempts) => {
    expect(attemptAccountingIsComplete(attempts)).toBe(false);
  });

  it.each([
    {
      name: 'all gates pass with a healthy generator',
      gates: [
        gate('inputs', 'harness-integrity', true),
        gate('delivery', 'workerd-correctness', true),
      ],
      generatorHealthy: true,
      expected: 'passed',
    },
    {
      name: 'a workerd gate fails with a healthy generator',
      gates: [
        gate('inputs', 'harness-integrity', true),
        gate('delivery', 'workerd-correctness', false),
      ],
      generatorHealthy: true,
      expected: 'failed',
    },
    {
      name: 'the generator is unhealthy but harness integrity holds',
      gates: [
        gate('inputs', 'harness-integrity', true),
        gate('delivery', 'workerd-correctness', false),
      ],
      generatorHealthy: false,
      expected: 'inconclusive',
    },
    {
      name: 'harness integrity fails even when the generator is unhealthy',
      gates: [
        gate('inputs', 'harness-integrity', false),
        gate('delivery', 'workerd-correctness', true),
      ],
      generatorHealthy: false,
      expected: 'failed',
    },
  ])('classifies the measured run when $name', ({ gates, generatorHealthy, expected }) => {
    expect(measuredOutcome(gates, generatorHealthy)).toBe(expected);
  });
});
