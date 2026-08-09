import { describe, expect, it } from 'vitest';
import { analyzeTelemetryRun, countFindingsByRule } from '../../src/core/rule-engine';
import type { DetectionRule, ValidationIssue } from '../../src/core/types';
import { includedBaselineProfile } from '../../src/profiles/included-baseline';
import { makeRun, makeSample, profileWith } from './helpers';

const fixedTime = '2026-07-17T00:00:00.000Z';

function analyze(
  samples = [makeSample(0), makeSample(1), makeSample(2)],
  rules: DetectionRule[] = [],
) {
  return analyzeTelemetryRun(makeRun(samples), profileWith({ rules }), { generatedAt: fixedTime });
}

describe('profile-driven threshold and range rules', () => {
  const speedThreshold: DetectionRule = {
    id: 'test.speed.threshold',
    kind: 'threshold',
    label: 'Speed threshold',
    description: 'Test threshold',
    severity: 'warning',
    enabled: true,
    channel: 'speed',
    operator: '>',
    threshold: 520,
  };

  it('does not trigger a strict threshold at its boundary', () => {
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: 520, fuel: 90 } })],
      [speedThreshold],
    );
    expect(result.findings).toHaveLength(0);
  });

  it('triggers a strict threshold one unit above its boundary', () => {
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: 521, fuel: 90 } })],
      [speedThreshold],
    );
    expect(result.findings[0]?.ruleId).toBe('test.speed.threshold');
  });

  it('does not execute a disabled rule', () => {
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: 999, fuel: 90 } })],
      [{ ...speedThreshold, enabled: false }],
    );
    expect(result.findings).toHaveLength(0);
  });

  it.each([
    [0, false],
    [100, false],
    [-0.01, true],
    [100.01, true],
  ])('checks inclusive range value %s', (fuel, expectedFinding) => {
    const rule: DetectionRule = {
      id: 'test.fuel.range',
      kind: 'range',
      label: 'Fuel range',
      description: 'Test range',
      severity: 'error',
      enabled: true,
      channel: 'fuel',
      minimum: 0,
      maximum: 100,
    };
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: 200, fuel } })],
      [rule],
    );
    expect(result.findings.length > 0).toBe(expectedFinding);
  });

  it.each([
    ['>', 10, 11, true],
    ['>=', 10, 10, true],
    ['<', 10, 9, true],
    ['<=', 10, 10, true],
  ] as const)('supports the %s threshold operator', (operator, threshold, value, expected) => {
    const rule: DetectionRule = {
      ...speedThreshold,
      id: `test.${operator}`,
      operator,
      threshold,
    };
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: value, fuel: 90 } })],
      [rule],
    );
    expect(result.findings.length > 0).toBe(expected);
  });
});

describe('time-based change rules', () => {
  it('uses elapsed seconds for an absolute rate violation', () => {
    const rule: DetectionRule = {
      id: 'test.altitude.rate',
      kind: 'rate',
      label: 'Altitude rate',
      description: 'Test rate',
      severity: 'warning',
      enabled: true,
      channel: 'altitude',
      maximumAbsoluteRate: 100,
    };
    const result = analyze(
      [
        makeSample(0, { measurements: { altitude: 0, speed: 200, fuel: 90 } }),
        makeSample(1, { measurements: { altitude: 1_500, speed: 200, fuel: 90 } }),
      ],
      [rule],
    );
    expect(result.findings[0]?.evidence.calculatedRate).toBe(150);
  });

  it('does not report a rate across a duplicate timestamp', () => {
    const rule: DetectionRule = {
      id: 'test.rate',
      kind: 'rate',
      label: 'Rate',
      description: 'Test rate',
      severity: 'warning',
      enabled: true,
      channel: 'altitude',
      maximumAbsoluteRate: 1,
    };
    const result = analyze(
      [makeSample(0), makeSample(1, { timestampMs: 0, timestamp: new Date(0).toISOString() })],
      [rule],
    );
    expect(result.findings.filter((finding) => finding.ruleId === 'test.rate')).toHaveLength(0);
  });

  it('uses actual cadence for a decrease-rate rule', () => {
    const rule: DetectionRule = {
      id: 'test.fuel.decrease',
      kind: 'decrease-rate',
      label: 'Fuel decrease',
      description: 'Test decrease',
      severity: 'warning',
      enabled: true,
      channel: 'fuel',
      maximumDecreaseRate: 0.2,
    };
    const result = analyze(
      [
        makeSample(0, { measurements: { altitude: 1_000, speed: 200, fuel: 90 } }),
        makeSample(1, {
          timestampMs: 20_000,
          timestamp: new Date(20_000).toISOString(),
          measurements: { altitude: 1_000, speed: 200, fuel: 87 },
        }),
      ],
      [rule],
    );
    expect(result.findings.filter((finding) => finding.ruleId === rule.id)).toHaveLength(0);
  });

  it('finds a window decrease on 5-second cadence without sample-count assumptions', () => {
    const rule: DetectionRule = {
      id: 'test.window',
      kind: 'window-decrease',
      label: 'Window decrease',
      description: 'Test window',
      severity: 'error',
      enabled: true,
      channel: 'altitude',
      maximumDecrease: 900,
      windowMs: 20_000,
      toleranceMs: 0,
    };
    const samples = [2_000, 1_900, 1_800, 1_600, 1_000].map((altitude, index) =>
      makeSample(index, {
        timestampMs: index * 5_000,
        timestamp: new Date(index * 5_000).toISOString(),
        measurements: { altitude, speed: 200, fuel: 90 },
      }),
    );
    const result = analyze(samples, [rule]);
    expect(result.findings.filter((finding) => finding.ruleId === rule.id)).toHaveLength(1);
  });

  it('respects window tolerance', () => {
    const rule: DetectionRule = {
      id: 'test.window-tolerance',
      kind: 'window-decrease',
      label: 'Window tolerance',
      description: 'Test window',
      severity: 'error',
      enabled: true,
      channel: 'altitude',
      maximumDecrease: 100,
      windowMs: 20_000,
      toleranceMs: 1_000,
    };
    const samples = [
      makeSample(0, { timestampMs: 0, measurements: { altitude: 2_000, speed: 200, fuel: 90 } }),
      makeSample(1, {
        timestampMs: 20_500,
        timestamp: new Date(20_500).toISOString(),
        measurements: { altitude: 1_000, speed: 200, fuel: 90 },
      }),
    ];
    expect(analyze(samples, [rule]).findings.some((finding) => finding.ruleId === rule.id)).toBe(
      true,
    );
  });
});

describe('timestamp and feed diagnostics', () => {
  it('detects a duplicate timestamp', () => {
    const samples = [
      makeSample(0),
      makeSample(1, { timestampMs: 0, timestamp: new Date(0).toISOString() }),
    ];
    expect(analyze(samples).findings[0]?.ruleId).toBe('time.timestamp.duplicate');
  });

  it('detects an out-of-order timestamp', () => {
    const samples = [
      makeSample(0, { timestampMs: 10_000 }),
      makeSample(1, { timestampMs: 9_999, timestamp: new Date(9_999).toISOString() }),
    ];
    expect(analyze(samples).findings[0]?.ruleId).toBe('time.timestamp.out-of-order');
  });

  it('detects a nonconsecutive duplicate timestamp as both duplicate and out of order', () => {
    const samples = [
      makeSample(0, { timestampMs: 0 }),
      makeSample(1, { timestampMs: 10_000 }),
      makeSample(2, { timestampMs: 0, timestamp: new Date(0).toISOString() }),
    ];
    const rules = countFindingsByRule(analyze(samples).findings);
    expect(rules['time.timestamp.duplicate']).toBe(1);
    expect(rules['time.timestamp.out-of-order']).toBe(1);
  });

  it('detects a cadence gap', () => {
    const samples = [
      makeSample(0),
      makeSample(1, { timestampMs: 15_000, timestamp: new Date(15_000).toISOString() }),
    ];
    expect(
      analyze(samples).findings.some((finding) => finding.ruleId === 'time.timestamp.gap'),
    ).toBe(true);
  });

  it('TC-RULE-020 detects both a gap and stale feed above the stale threshold', () => {
    const samples = [
      makeSample(0),
      makeSample(1, { timestampMs: 30_001, timestamp: new Date(30_001).toISOString() }),
    ];
    const rules = countFindingsByRule(analyze(samples).findings);
    expect(rules['time.timestamp.gap']).toBe(1);
    expect(rules['feed.source.stale']).toBe(1);
  });

  it('TC-RULE-021 allows the exact stale-feed threshold', () => {
    const samples = [
      makeSample(0),
      makeSample(1, { timestampMs: 30_000, timestamp: new Date(30_000).toISOString() }),
    ];
    const rules = countFindingsByRule(analyze(samples).findings);
    expect(rules['time.timestamp.gap']).toBe(1);
    expect(rules['feed.source.stale']).toBeUndefined();
  });

  it('accepts cadence within tolerance', () => {
    const samples = [
      makeSample(0),
      makeSample(1, { timestampMs: 11_000, timestamp: new Date(11_000).toISOString() }),
    ];
    expect(analyze(samples).findings).toHaveLength(0);
  });
});

describe('sequence diagnostics', () => {
  it('does not require sequence numbers for an optional all-absent stream', () => {
    expect(analyze().findings.some((finding) => finding.ruleId.startsWith('sequence.'))).toBe(
      false,
    );
  });

  it('detects a missing sequence once numbering is active', () => {
    const samples = [makeSample(0, { sequence: 0 }), makeSample(1), makeSample(2, { sequence: 2 })];
    expect(
      analyze(samples).findings.filter((finding) => finding.ruleId === 'sequence.value.missing'),
    ).toHaveLength(1);
  });

  it('detects a duplicate sequence', () => {
    const samples = [makeSample(0, { sequence: 7 }), makeSample(1, { sequence: 7 })];
    expect(
      analyze(samples).findings.some((finding) => finding.ruleId === 'sequence.value.duplicate'),
    ).toBe(true);
  });

  it('detects a sequence gap', () => {
    const samples = [makeSample(0, { sequence: 7 }), makeSample(1, { sequence: 10 })];
    const finding = analyze(samples).findings.find(
      (candidate) => candidate.ruleId === 'sequence.value.gap',
    );
    expect(finding?.evidence.missingCount).toBe(2);
  });

  it('requires all sequences when the profile policy is required', () => {
    const result = analyzeTelemetryRun(
      makeRun([makeSample(0)]),
      profileWith({ sequencePolicy: 'required', rules: [] }),
    );
    expect(result.findings[0]?.ruleId).toBe('sequence.value.missing');
  });
});

describe('sensor, schema, and profile diagnostics', () => {
  it('TC-RULE-018 reports once at the exact frozen-duration boundary', () => {
    const rule: DetectionRule = {
      id: 'test.frozen',
      kind: 'frozen',
      label: 'Frozen sensor',
      description: 'Test frozen sensor',
      severity: 'warning',
      enabled: true,
      channel: 'altitude',
      minimumDurationMs: 30_000,
      tolerance: 0,
    };
    const samples = [0, 1, 2, 3, 4].map((index) =>
      makeSample(index, {
        measurements: { altitude: 1_000, speed: 200 + index, fuel: 90 - index },
      }),
    );
    const findings = analyze(samples, [rule]).findings.filter(
      (finding) => finding.ruleId === rule.id,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.elapsedMs).toBe(30_000);
    expect(findings[0]?.evidence.sampleIndices).toEqual([0, 3]);
  });

  it('does not join frozen segments across a changed value', () => {
    const rule: DetectionRule = {
      id: 'test.frozen',
      kind: 'frozen',
      label: 'Frozen sensor',
      description: 'Test frozen sensor',
      severity: 'warning',
      enabled: true,
      channel: 'altitude',
      minimumDurationMs: 30_000,
      tolerance: 0,
    };
    const values = [1_000, 1_000, 1_100, 1_100, 1_100];
    const samples = values.map((altitude, index) =>
      makeSample(index, { measurements: { altitude, speed: 200 + index, fuel: 90 - index } }),
    );
    expect(analyze(samples, [rule]).findings).toHaveLength(0);
  });

  it('detects a missing required canonical measurement', () => {
    const sample = makeSample(0);
    delete sample.measurements.altitude;
    expect(analyze([sample]).findings[0]?.ruleId).toBe('data.value.missing');
  });

  it('detects a nonfinite canonical measurement', () => {
    const sample = makeSample(0, {
      measurements: { altitude: Number.POSITIVE_INFINITY, speed: 200, fuel: 90 },
    });
    expect(analyze([sample]).findings[0]?.ruleId).toBe('data.value.nonfinite');
  });

  it('detects a missing explicit unit', () => {
    const sample = makeSample(0, { units: { speed: 'kts', fuel: '%' } });
    expect(analyze([sample]).findings[0]?.ruleId).toBe('schema.unit.missing');
  });

  it('detects a profile unit mismatch', () => {
    const sample = makeSample(0, { units: { altitude: 'm', speed: 'kts', fuel: '%' } });
    expect(analyze([sample]).findings[0]?.ruleId).toBe('profile.unit.mismatch');
  });

  it('blocks rule execution on a fatal schema issue', () => {
    const run = makeRun();
    const issue: ValidationIssue = {
      code: 'SCHEMA_MISMATCH',
      disposition: 'fatal',
      message: 'bad schema',
    };
    run.validationIssues.push(issue);
    run.fatal = true;
    const result = analyzeTelemetryRun(run, includedBaselineProfile);
    expect(result.blocked).toBe(true);
    expect(result.analyzedRecords).toBe(0);
    expect(result.findings[0]?.origin).toBe('adapter');
  });

  it('blocks a run-declared profile mismatch', () => {
    const run = makeRun();
    run.profileId = 'other-profile';
    const result = analyzeTelemetryRun(run, includedBaselineProfile);
    expect(result.blocked).toBe(true);
    expect(result.findings.some((finding) => finding.ruleId === 'profile.selection.mismatch')).toBe(
      true,
    );
  });

  it('isolates cadence state by source', () => {
    const samples = [
      makeSample(0, { sampleIndex: 0, sourceId: 'source-a', timestampMs: 0 }),
      makeSample(0, { sampleIndex: 1, sourceId: 'source-b', timestampMs: 0 }),
      makeSample(1, { sampleIndex: 2, sourceId: 'source-a', timestampMs: 10_000 }),
      makeSample(1, { sampleIndex: 3, sourceId: 'source-b', timestampMs: 10_000 }),
    ];
    expect(analyze(samples).findings).toHaveLength(0);
  });

  it('records all required evidence fields on a finding', () => {
    const result = analyze(
      [makeSample(0, { measurements: { altitude: 1_000, speed: 600, fuel: 90 } })],
      [
        {
          id: 'test.evidence',
          kind: 'threshold',
          label: 'Evidence rule',
          description: 'Evidence test',
          severity: 'warning',
          enabled: true,
          channel: 'speed',
          operator: '>',
          threshold: 500,
        },
      ],
    );
    const finding = result.findings[0];
    expect(finding).toMatchObject({
      ruleId: 'test.evidence',
      severity: 'warning',
      sourceId: 'source-a',
      observedValue: 600,
      channel: 'speed',
    });
    expect(finding?.expectedCondition).toContain('<= 500');
    expect(finding?.evidence.message).toBeTruthy();
  });
});
