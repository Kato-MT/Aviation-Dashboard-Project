import type {
  AnalysisResult,
  ComparisonOperator,
  DetectionProfile,
  DetectionRule,
  Finding,
  Severity,
  TelemetryRun,
  TelemetrySample,
  ValidationIssue,
} from './types';

export interface AnalysisOptions {
  generatedAt?: string;
}

const ISSUE_RULES: Record<
  ValidationIssue['code'],
  { id: string; label: string; severity: Severity }
> = {
  EMPTY_INPUT: { id: 'schema.input.empty', label: 'Empty input', severity: 'error' },
  UPLOAD_TOO_LARGE: {
    id: 'schema.input.byte-limit',
    label: 'Upload byte limit',
    severity: 'error',
  },
  SAMPLE_LIMIT_EXCEEDED: {
    id: 'schema.input.sample-limit',
    label: 'Sample limit',
    severity: 'error',
  },
  MALFORMED_CSV: { id: 'schema.csv.malformed', label: 'Malformed CSV', severity: 'error' },
  MISSING_HEADER: { id: 'schema.csv.missing-header', label: 'Missing header', severity: 'error' },
  UNSUPPORTED_SCHEMA_VERSION: {
    id: 'schema.version.unsupported',
    label: 'Unsupported schema version',
    severity: 'error',
  },
  SCHEMA_MISMATCH: { id: 'schema.document.mismatch', label: 'Schema mismatch', severity: 'error' },
  PROFILE_MISMATCH: {
    id: 'profile.selection.mismatch',
    label: 'Profile mismatch',
    severity: 'error',
  },
  DUPLICATE_SOURCE: { id: 'schema.source.duplicate', label: 'Duplicate source', severity: 'error' },
  MISSING_SOURCE: { id: 'schema.source.missing', label: 'Missing source', severity: 'error' },
  INVALID_TIMESTAMP: {
    id: 'data.timestamp.invalid',
    label: 'Invalid timestamp',
    severity: 'error',
  },
  BLANK_VALUE: { id: 'data.value.blank', label: 'Blank required value', severity: 'error' },
  MISSING_VALUE: { id: 'data.value.missing', label: 'Missing required value', severity: 'error' },
  NONNUMERIC_VALUE: { id: 'data.value.nonnumeric', label: 'Nonnumeric value', severity: 'error' },
  NONFINITE_VALUE: { id: 'data.value.nonfinite', label: 'Nonfinite value', severity: 'error' },
  MISSING_UNIT: { id: 'schema.unit.missing', label: 'Missing unit', severity: 'error' },
  INVALID_QUALITY_FLAG: {
    id: 'schema.quality-flag.invalid',
    label: 'Invalid quality flag',
    severity: 'warning',
  },
};

function safeObservedValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function createFingerprint(
  ruleId: string,
  sourceId: string,
  location: {
    timestamp?: string | undefined;
    rowNumber?: number | undefined;
    sampleIndex?: number | undefined;
    channel?: string | undefined;
  },
): string {
  return [
    ruleId,
    sourceId,
    location.timestamp ?? `row:${location.rowNumber ?? 'none'}`,
    location.sampleIndex ?? 'none',
    location.channel ?? 'run',
  ].join('|');
}

function buildFinding(input: Omit<Finding, 'findingId' | 'fingerprint'>): Finding {
  const fingerprint = createFingerprint(input.ruleId, input.sourceId, input);
  return { ...input, fingerprint, findingId: fingerprint };
}

function issueToFinding(issue: ValidationIssue, run: TelemetryRun): Finding {
  const mapped = ISSUE_RULES[issue.code];
  const sourceId = issue.sourceId ?? run.sources[0]?.sourceId ?? 'unknown-source';
  const sample = issue.sampleIndex === undefined ? undefined : run.samples[issue.sampleIndex];
  return buildFinding({
    ruleId: mapped.id,
    ruleLabel: mapped.label,
    severity: mapped.severity,
    sourceId,
    timestamp: sample?.timestamp,
    timestampMs: sample?.timestampMs,
    sampleIndex: issue.sampleIndex,
    rowNumber: issue.rowNumber,
    channel: issue.channel,
    observedValue: safeObservedValue(issue.observedValue),
    expectedCondition: issue.expectedCondition ?? issue.message,
    evidence: {
      message: issue.message,
      rowNumbers: issue.rowNumber === undefined ? undefined : [issue.rowNumber],
      sampleIndices: issue.sampleIndex === undefined ? undefined : [issue.sampleIndex],
      validationDisposition: issue.disposition,
      validationCode: issue.code,
    },
    origin: 'adapter',
  });
}

function compare(value: number, operator: ComparisonOperator, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
  }
}

function operatorText(operator: ComparisonOperator): string {
  return ({ '>': '<=', '>=': '<', '<': '>=', '<=': '>' } as const)[operator];
}

function findingForRule(
  rule: DetectionRule,
  sample: TelemetrySample,
  observedValue: unknown,
  expectedCondition: string,
  evidence: Finding['evidence'],
): Finding {
  return buildFinding({
    ruleId: rule.id,
    ruleLabel: rule.label,
    severity: rule.severity,
    sourceId: sample.sourceId,
    timestamp: sample.timestamp,
    timestampMs: sample.timestampMs,
    sampleIndex: sample.sampleIndex,
    rowNumber: sample.rowNumber,
    channel: 'channel' in rule ? rule.channel : undefined,
    observedValue: safeObservedValue(observedValue),
    expectedCondition,
    evidence,
    origin: 'rule-engine',
  });
}

function dataIntegrityFindings(run: TelemetryRun, profile: DetectionProfile): Finding[] {
  const findings: Finding[] = [];

  for (const sample of run.samples) {
    for (const channel of Object.values(profile.channels)) {
      if (!channel.required) continue;
      const value = sample.measurements[channel.channel];

      if (value === undefined || value === null) {
        const issue: ValidationIssue = {
          code: 'MISSING_VALUE',
          disposition: 'recoverable',
          message: `Required channel '${channel.channel}' is missing from the canonical sample.`,
          sampleIndex: sample.sampleIndex,
          rowNumber: sample.rowNumber,
          sourceId: sample.sourceId,
          channel: channel.channel,
          observedValue: value,
          expectedCondition: 'a present numeric channel value',
        };
        findings.push(issueToFinding(issue, run));
        continue;
      }

      if (typeof value !== 'number') {
        const issue: ValidationIssue = {
          code: 'NONNUMERIC_VALUE',
          disposition: 'recoverable',
          message: `Channel '${channel.channel}' is not numeric.`,
          sampleIndex: sample.sampleIndex,
          rowNumber: sample.rowNumber,
          sourceId: sample.sourceId,
          channel: channel.channel,
          observedValue: value,
          expectedCondition: 'a numeric channel value',
        };
        findings.push(issueToFinding(issue, run));
        continue;
      }

      if (!Number.isFinite(value)) {
        const issue: ValidationIssue = {
          code: 'NONFINITE_VALUE',
          disposition: 'recoverable',
          message: `Channel '${channel.channel}' is not finite.`,
          sampleIndex: sample.sampleIndex,
          rowNumber: sample.rowNumber,
          sourceId: sample.sourceId,
          channel: channel.channel,
          observedValue: value,
          expectedCondition: 'a finite numeric channel value',
        };
        findings.push(issueToFinding(issue, run));
      }

      const unit = sample.units[channel.channel];
      if (!unit) {
        const issue: ValidationIssue = {
          code: 'MISSING_UNIT',
          disposition: 'recoverable',
          message: `Channel '${channel.channel}' has no explicit unit.`,
          sampleIndex: sample.sampleIndex,
          rowNumber: sample.rowNumber,
          sourceId: sample.sourceId,
          channel: channel.channel,
          expectedCondition: `explicit unit '${channel.unit}'`,
        };
        findings.push(issueToFinding(issue, run));
      } else if (unit !== channel.unit) {
        findings.push(
          buildFinding({
            ruleId: 'profile.unit.mismatch',
            ruleLabel: 'Profile unit mismatch',
            severity: 'error',
            sourceId: sample.sourceId,
            timestamp: sample.timestamp,
            timestampMs: sample.timestampMs,
            sampleIndex: sample.sampleIndex,
            rowNumber: sample.rowNumber,
            channel: channel.channel,
            observedValue: unit,
            expectedCondition: `unit exactly '${channel.unit}'`,
            evidence: {
              message: `Channel '${channel.channel}' uses '${unit}' but profile '${profile.id}' requires '${channel.unit}'.`,
              sampleIndices: [sample.sampleIndex],
            },
            origin: 'rule-engine',
          }),
        );
      }
    }
  }

  return findings;
}

function timeAndSequenceFindings(samples: TelemetrySample[], profile: DetectionProfile): Finding[] {
  const findings: Finding[] = [];
  const sequenceExpected =
    profile.sequencePolicy === 'required' ||
    samples.some((sample) => sample.sequence !== undefined);
  const seenSequence = new Set<number>();
  const seenTimestamps = new Map<number, TelemetrySample>();

  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index]!;
    const previous = samples[index - 1];
    const repeatedTimestampSample = seenTimestamps.get(current.timestampMs);
    seenTimestamps.set(current.timestampMs, current);

    if (sequenceExpected) {
      if (current.sequence === undefined) {
        findings.push(
          buildFinding({
            ruleId: 'sequence.value.missing',
            ruleLabel: 'Missing sequence number',
            severity: 'warning',
            sourceId: current.sourceId,
            timestamp: current.timestamp,
            timestampMs: current.timestampMs,
            sampleIndex: current.sampleIndex,
            rowNumber: current.rowNumber,
            observedValue: null,
            expectedCondition: 'a present integer sequence number',
            evidence: {
              message:
                'Sequence numbering is active for this source, but this sample has no sequence number.',
            },
            origin: 'rule-engine',
          }),
        );
      } else if (seenSequence.has(current.sequence)) {
        findings.push(
          buildFinding({
            ruleId: 'sequence.value.duplicate',
            ruleLabel: 'Duplicate sequence number',
            severity: 'error',
            sourceId: current.sourceId,
            timestamp: current.timestamp,
            timestampMs: current.timestampMs,
            sampleIndex: current.sampleIndex,
            rowNumber: current.rowNumber,
            observedValue: current.sequence,
            expectedCondition: 'a unique sequence number per source',
            evidence: {
              message: `Sequence ${current.sequence} has already appeared for this source.`,
            },
            origin: 'rule-engine',
          }),
        );
      } else {
        seenSequence.add(current.sequence);
      }
    }

    if (!previous) continue;

    if (
      sequenceExpected &&
      previous.sequence !== undefined &&
      current.sequence !== undefined &&
      current.sequence > previous.sequence + 1
    ) {
      findings.push(
        buildFinding({
          ruleId: 'sequence.value.gap',
          ruleLabel: 'Sequence gap',
          severity: 'warning',
          sourceId: current.sourceId,
          timestamp: current.timestamp,
          timestampMs: current.timestampMs,
          sampleIndex: current.sampleIndex,
          rowNumber: current.rowNumber,
          observedValue: current.sequence,
          expectedCondition: `sequence ${previous.sequence + 1}`,
          evidence: {
            message: `Sequence advanced from ${previous.sequence} to ${current.sequence}.`,
            previousSequence: previous.sequence,
            missingCount: current.sequence - previous.sequence - 1,
          },
          origin: 'rule-engine',
        }),
      );
    }

    const elapsedMs = current.timestampMs - previous.timestampMs;
    if (elapsedMs === 0 || repeatedTimestampSample !== undefined) {
      findings.push(
        buildFinding({
          ruleId: 'time.timestamp.duplicate',
          ruleLabel: 'Duplicate timestamp',
          severity: 'error',
          sourceId: current.sourceId,
          timestamp: current.timestamp,
          timestampMs: current.timestampMs,
          sampleIndex: current.sampleIndex,
          rowNumber: current.rowNumber,
          observedValue: current.timestamp,
          expectedCondition: 'a unique, increasing timestamp per source',
          evidence: {
            message: 'This timestamp has already appeared in the source stream.',
            sampleIndices: [
              repeatedTimestampSample?.sampleIndex ?? previous.sampleIndex,
              current.sampleIndex,
            ],
          },
          origin: 'rule-engine',
        }),
      );
    }

    if (elapsedMs < 0) {
      findings.push(
        buildFinding({
          ruleId: 'time.timestamp.out-of-order',
          ruleLabel: 'Out-of-order timestamp',
          severity: 'error',
          sourceId: current.sourceId,
          timestamp: current.timestamp,
          timestampMs: current.timestampMs,
          sampleIndex: current.sampleIndex,
          rowNumber: current.rowNumber,
          observedValue: current.timestamp,
          expectedCondition: `timestamp later than ${previous.timestamp}`,
          evidence: {
            message: 'Timestamp moved backward within the source stream.',
            elapsedMs,
            sampleIndices: [previous.sampleIndex, current.sampleIndex],
          },
          origin: 'rule-engine',
        }),
      );
    } else if (elapsedMs > 0) {
      if (
        profile.expectedCadenceMs !== undefined &&
        elapsedMs > profile.expectedCadenceMs + (profile.cadenceToleranceMs ?? 0)
      ) {
        findings.push(
          buildFinding({
            ruleId: 'time.timestamp.gap',
            ruleLabel: 'Timestamp gap',
            severity: 'warning',
            sourceId: current.sourceId,
            timestamp: current.timestamp,
            timestampMs: current.timestampMs,
            sampleIndex: current.sampleIndex,
            rowNumber: current.rowNumber,
            observedValue: elapsedMs,
            expectedCondition: `elapsed time <= ${profile.expectedCadenceMs + (profile.cadenceToleranceMs ?? 0)} ms`,
            evidence: {
              message: `Elapsed time of ${elapsedMs} ms exceeds the configured cadence tolerance.`,
              elapsedMs,
              expectedCadenceMs: profile.expectedCadenceMs,
            },
            origin: 'rule-engine',
          }),
        );
      }

      if (profile.staleAfterMs !== undefined && elapsedMs > profile.staleAfterMs) {
        findings.push(
          buildFinding({
            ruleId: 'feed.source.stale',
            ruleLabel: 'Stale telemetry feed',
            severity: 'error',
            sourceId: current.sourceId,
            timestamp: current.timestamp,
            timestampMs: current.timestampMs,
            sampleIndex: current.sampleIndex,
            rowNumber: current.rowNumber,
            observedValue: elapsedMs,
            expectedCondition: `source interval <= ${profile.staleAfterMs} ms`,
            evidence: {
              message: 'The source exceeded the configured stale-feed interval.',
              elapsedMs,
            },
            origin: 'rule-engine',
          }),
        );
      }
    }
  }

  return findings;
}

function simpleRuleFindings(rule: DetectionRule, samples: TelemetrySample[]): Finding[] {
  if (!rule.enabled) return [];
  const findings: Finding[] = [];

  if (rule.kind === 'threshold' || rule.kind === 'range') {
    for (const sample of samples) {
      const value = sample.measurements[rule.channel];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      if (rule.kind === 'threshold' && compare(value, rule.operator, rule.threshold)) {
        findings.push(
          findingForRule(
            rule,
            sample,
            value,
            `${rule.channel} ${operatorText(rule.operator)} ${rule.threshold} ${sample.units[rule.channel] ?? 'units'}`,
            {
              message: `${rule.channel} value ${value} triggered ${rule.operator} ${rule.threshold}.`,
              currentValue: value,
              threshold: rule.threshold,
              operator: rule.operator,
              sampleIndices: [sample.sampleIndex],
            },
          ),
        );
      }

      if (rule.kind === 'range' && (value < rule.minimum || value > rule.maximum)) {
        findings.push(
          findingForRule(
            rule,
            sample,
            value,
            `${rule.minimum} <= ${rule.channel} <= ${rule.maximum} ${sample.units[rule.channel] ?? 'units'}`,
            {
              message: `${rule.channel} value ${value} is outside the configured inclusive range.`,
              currentValue: value,
              minimum: rule.minimum,
              maximum: rule.maximum,
              sampleIndices: [sample.sampleIndex],
            },
          ),
        );
      }
    }
    return findings;
  }

  if (rule.kind === 'frozen') {
    let segmentStart = 0;
    let reported = false;
    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]!;
      const previous = samples[index - 1]!;
      const currentValue = current.measurements[rule.channel];
      const previousValue = previous.measurements[rule.channel];
      const continuous =
        typeof currentValue === 'number' &&
        typeof previousValue === 'number' &&
        Number.isFinite(currentValue) &&
        Number.isFinite(previousValue) &&
        Math.abs(currentValue - previousValue) <= rule.tolerance &&
        current.timestampMs > previous.timestampMs;

      if (!continuous) {
        segmentStart = index;
        reported = false;
        continue;
      }

      const segmentStartSample = samples[segmentStart]!;
      const durationMs = current.timestampMs - segmentStartSample.timestampMs;
      if (durationMs >= rule.minimumDurationMs && !reported) {
        findings.push(
          findingForRule(
            rule,
            current,
            currentValue,
            `change greater than ${rule.tolerance} within ${rule.minimumDurationMs} ms`,
            {
              message: `${rule.channel} remained unchanged within tolerance for ${durationMs} ms.`,
              currentValue,
              elapsedMs: durationMs,
              sampleIndices: [segmentStartSample.sampleIndex, current.sampleIndex],
            },
          ),
        );
        reported = true;
      }
    }
    return findings;
  }

  if (rule.kind === 'window-decrease') {
    for (let index = 1; index < samples.length; index += 1) {
      const current = samples[index]!;
      const targetTimestamp = current.timestampMs - rule.windowMs;
      let nearest: TelemetrySample | undefined;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
        const candidate = samples[priorIndex]!;
        const distance = Math.abs(candidate.timestampMs - targetTimestamp);
        if (distance < nearestDistance) {
          nearest = candidate;
          nearestDistance = distance;
        }
        if (candidate.timestampMs < targetTimestamp - rule.toleranceMs) break;
      }

      if (!nearest || nearestDistance > rule.toleranceMs) continue;
      const previousValue = nearest.measurements[rule.channel];
      const currentValue = current.measurements[rule.channel];
      if (
        typeof previousValue !== 'number' ||
        typeof currentValue !== 'number' ||
        !Number.isFinite(previousValue) ||
        !Number.isFinite(currentValue)
      )
        continue;
      const decrease = previousValue - currentValue;
      if (decrease > rule.maximumDecrease) {
        findings.push(
          findingForRule(
            rule,
            current,
            decrease,
            `${rule.channel} decrease <= ${rule.maximumDecrease} ${current.units[rule.channel] ?? 'units'} in ${rule.windowMs} ms`,
            {
              message: `${rule.channel} decreased by ${decrease} within the configured time window.`,
              previousValue,
              currentValue,
              elapsedMs: current.timestampMs - nearest.timestampMs,
              sampleIndices: [nearest.sampleIndex, current.sampleIndex],
            },
          ),
        );
      }
    }
    return findings;
  }

  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]!;
    const previous = samples[index - 1]!;
    const elapsedMs = current.timestampMs - previous.timestampMs;
    if (elapsedMs <= 0) continue;
    const currentValue = current.measurements[rule.channel];
    const previousValue = previous.measurements[rule.channel];
    if (
      typeof currentValue !== 'number' ||
      typeof previousValue !== 'number' ||
      !Number.isFinite(currentValue) ||
      !Number.isFinite(previousValue)
    )
      continue;
    const elapsedSeconds = elapsedMs / 1_000;

    if (rule.kind === 'rate') {
      const rate = (currentValue - previousValue) / elapsedSeconds;
      if (Math.abs(rate) > rule.maximumAbsoluteRate) {
        findings.push(
          findingForRule(
            rule,
            current,
            rate,
            `absolute rate <= ${rule.maximumAbsoluteRate} ${current.units[rule.channel] ?? 'units'}/s`,
            {
              message: `${rule.channel} changed at ${rate} units per second.`,
              previousValue,
              currentValue,
              calculatedRate: rate,
              elapsedMs,
              sampleIndices: [previous.sampleIndex, current.sampleIndex],
            },
          ),
        );
      }
    } else if (rule.kind === 'decrease-rate') {
      const decreaseRate = (previousValue - currentValue) / elapsedSeconds;
      if (decreaseRate > rule.maximumDecreaseRate) {
        findings.push(
          findingForRule(
            rule,
            current,
            decreaseRate,
            `decrease rate <= ${rule.maximumDecreaseRate} ${current.units[rule.channel] ?? 'units'}/s`,
            {
              message: `${rule.channel} decreased at ${decreaseRate} units per second.`,
              previousValue,
              currentValue,
              calculatedRate: decreaseRate,
              elapsedMs,
              sampleIndices: [previous.sampleIndex, current.sampleIndex],
            },
          ),
        );
      }
    }
  }

  return findings;
}

export function analyzeTelemetryRun(
  run: TelemetryRun,
  profile: DetectionProfile,
  options: AnalysisOptions = {},
): AnalysisResult {
  const findings = run.validationIssues.map((issue) => issueToFinding(issue, run));

  const profileMismatch =
    (run.profileId !== undefined && run.profileId !== profile.id) ||
    (run.profileVersion !== undefined && run.profileVersion !== profile.version);

  if (profileMismatch && !run.validationIssues.some((issue) => issue.code === 'PROFILE_MISMATCH')) {
    findings.push(
      buildFinding({
        ruleId: 'profile.selection.mismatch',
        ruleLabel: 'Profile mismatch',
        severity: 'error',
        sourceId: run.sources[0]?.sourceId ?? 'unknown-source',
        observedValue: `${run.profileId ?? 'unspecified'}@${run.profileVersion ?? 'unspecified'}`,
        expectedCondition: `${profile.id}@${profile.version}`,
        evidence: {
          message: 'The run-declared profile does not match the active detection profile.',
          runProfileId: run.profileId,
          runProfileVersion: run.profileVersion,
          activeProfileId: profile.id,
          activeProfileVersion: profile.version,
        },
        origin: 'rule-engine',
      }),
    );
  }

  const blocked = run.fatal || profileMismatch;

  if (!blocked) {
    findings.push(...dataIntegrityFindings(run, profile));
    const samplesBySource = new Map<string, TelemetrySample[]>();
    for (const sample of run.samples) {
      const group = samplesBySource.get(sample.sourceId) ?? [];
      group.push(sample);
      samplesBySource.set(sample.sourceId, group);
    }

    for (const samples of samplesBySource.values()) {
      findings.push(...timeAndSequenceFindings(samples, profile));
      for (const rule of profile.rules) findings.push(...simpleRuleFindings(rule, samples));
    }
  }

  findings.sort((left, right) => {
    const leftTime = left.timestampMs ?? Number.NEGATIVE_INFINITY;
    const rightTime = right.timestampMs ?? Number.NEGATIVE_INFINITY;
    return (
      leftTime - rightTime ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.fingerprint.localeCompare(right.fingerprint)
    );
  });

  const findingCounts: Record<Severity, number> = { info: 0, warning: 0, error: 0, critical: 0 };
  for (const finding of findings) findingCounts[finding.severity] += 1;

  return {
    runId: run.runId,
    profileId: profile.id,
    profileVersion: profile.version,
    blocked,
    findings,
    findingCounts,
    analyzedRecords: blocked ? 0 : run.samples.length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

export function countFindingsByRule(findings: readonly Finding[]): Record<string, number> {
  return findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
    return counts;
  }, {});
}
