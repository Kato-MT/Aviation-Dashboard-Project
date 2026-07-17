import { sha256Hex } from '../core/hash';
import { utf8ByteLength } from '../core/limits';
import type { QualityFlag, TelemetryRun, TelemetrySample, ValidationIssue } from '../core/types';
import { stableStringify } from '../adapters/shared';
import { deterministicIndex } from './prng';

export type FaultTarget = 'canonical' | 'legacy-csv';

export interface FaultScenarioDefinition {
  id: string;
  label: string;
  description: string;
  target: FaultTarget;
  expectedRuleIds: readonly string[];
}

export const DECLARED_FAULT_SCENARIOS = [
  {
    id: 'missing-altitude',
    label: 'Missing altitude value',
    description: 'Removes one required canonical measurement.',
    target: 'canonical',
    expectedRuleIds: ['data.value.missing'],
  },
  {
    id: 'nonfinite-speed',
    label: 'Nonfinite speed value',
    description: 'Replaces one speed sample with positive infinity.',
    target: 'canonical',
    expectedRuleIds: ['data.value.nonfinite'],
  },
  {
    id: 'range-excursion',
    label: 'Range excursion',
    description: 'Places one fuel measurement above the profile range.',
    target: 'canonical',
    expectedRuleIds: ['core.range.fuel', 'core.rate.fuel', 'baseline.fuel-change'],
  },
  {
    id: 'duplicate-timestamp',
    label: 'Duplicate timestamp',
    description: 'Copies the preceding timestamp onto a later sample.',
    target: 'canonical',
    expectedRuleIds: ['time.timestamp.duplicate'],
  },
  {
    id: 'out-of-order-timestamp',
    label: 'Out-of-order timestamp',
    description: 'Moves a sample timestamp one millisecond before its predecessor.',
    target: 'canonical',
    expectedRuleIds: ['time.timestamp.out-of-order'],
  },
  {
    id: 'timestamp-gap',
    label: 'Timestamp gap',
    description: 'Creates a cadence gap without crossing the stale-feed threshold.',
    target: 'canonical',
    expectedRuleIds: ['time.timestamp.gap'],
  },
  {
    id: 'stale-feed',
    label: 'Stale feed',
    description: 'Creates a source interval beyond the stale-feed threshold.',
    target: 'canonical',
    expectedRuleIds: ['time.timestamp.gap', 'feed.source.stale'],
  },
  {
    id: 'missing-sequence',
    label: 'Missing sequence number',
    description: 'Activates sequence tracking and removes one sequence number.',
    target: 'canonical',
    expectedRuleIds: ['sequence.value.missing'],
  },
  {
    id: 'duplicate-sequence',
    label: 'Duplicate sequence number',
    description: 'Copies a preceding sequence number onto a later sample.',
    target: 'canonical',
    expectedRuleIds: ['sequence.value.duplicate'],
  },
  {
    id: 'frozen-altitude',
    label: 'Frozen altitude sensor',
    description: "Holds altitude constant long enough to trigger the profile's frozen-sensor rule.",
    target: 'canonical',
    expectedRuleIds: ['sensor.altitude.frozen'],
  },
  {
    id: 'profile-mismatch',
    label: 'Profile mismatch',
    description: 'Declares a different synthetic profile version on the run.',
    target: 'canonical',
    expectedRuleIds: ['profile.selection.mismatch'],
  },
  {
    id: 'blank-csv-value',
    label: 'Blank CSV value',
    description: 'Blanks one required value before adapter validation.',
    target: 'legacy-csv',
    expectedRuleIds: ['data.value.blank'],
  },
  {
    id: 'nonnumeric-csv-value',
    label: 'Nonnumeric CSV value',
    description: 'Places text in one numeric field before adapter validation.',
    target: 'legacy-csv',
    expectedRuleIds: ['data.value.nonnumeric'],
  },
] as const satisfies readonly FaultScenarioDefinition[];

export type FaultScenarioId = (typeof DECLARED_FAULT_SCENARIOS)[number]['id'];

function cloneSample(sample: TelemetrySample): TelemetrySample {
  return {
    ...sample,
    measurements: { ...sample.measurements },
    units: { ...sample.units },
    qualityFlags: [...sample.qualityFlags],
    channelQualityFlags: sample.channelQualityFlags
      ? Object.fromEntries(
          Object.entries(sample.channelQualityFlags).map(([channel, flags]) => [
            channel,
            [...flags],
          ]),
        )
      : undefined,
  };
}

function cloneRun(run: TelemetryRun): TelemetryRun {
  return {
    ...run,
    sources: run.sources.map((source) => ({
      ...source,
      units: { ...source.units },
      metadata: { ...source.metadata },
    })),
    samples: run.samples.map(cloneSample),
    quarantinedRows: run.quarantinedRows.map((row) => ({
      ...row,
      raw: { ...row.raw },
      issues: row.issues.map((issue) => ({ ...issue })),
    })),
    validationIssues: run.validationIssues.map((issue) => ({ ...issue })),
    provenance: { ...run.provenance },
    metadata: { ...run.metadata },
  };
}

function markInjected(sample: TelemetrySample): void {
  const flags = new Set<QualityFlag>(sample.qualityFlags);
  flags.add('injected');
  flags.add('suspect');
  sample.qualityFlags = [...flags];
}

function setTimestamp(sample: TelemetrySample, timestampMs: number): void {
  sample.timestampMs = timestampMs;
  sample.timestamp = new Date(timestampMs).toISOString();
  sample.originalTimestamp = sample.timestamp;
  markInjected(sample);
}

function requireSamples(run: TelemetryRun, count: number): void {
  if (run.samples.length < count)
    throw new Error(`Fault injection requires at least ${count} samples.`);
}

export function getFaultScenario(id: string): FaultScenarioDefinition | undefined {
  return DECLARED_FAULT_SCENARIOS.find((scenario) => scenario.id === id);
}

export async function injectFaultScenario(
  run: TelemetryRun,
  id: FaultScenarioId,
  seed = 1,
): Promise<TelemetryRun> {
  const scenario = getFaultScenario(id);
  if (!scenario) throw new Error(`Unknown fault scenario '${id}'.`);
  if (scenario.target !== 'canonical') {
    throw new Error(
      `Scenario '${id}' targets ${scenario.target}; use injectLegacyCsvFault instead.`,
    );
  }

  const injected = cloneRun(run);
  requireSamples(injected, id === 'frozen-altitude' ? 5 : 2);
  const index = deterministicIndex(seed, injected.samples.length, id === 'frozen-altitude' ? 4 : 1);
  const sample = injected.samples[index]!;
  markInjected(sample);

  switch (id) {
    case 'missing-altitude':
      delete sample.measurements.altitude;
      break;
    case 'nonfinite-speed':
      sample.measurements.speed = Number.POSITIVE_INFINITY;
      break;
    case 'range-excursion':
      sample.measurements.fuel = 150;
      break;
    case 'duplicate-timestamp': {
      const delta = injected.samples[index - 1]!.timestampMs - sample.timestampMs;
      for (let cursor = index; cursor < injected.samples.length; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        setTimestamp(candidate, candidate.timestampMs + delta);
      }
      break;
    }
    case 'out-of-order-timestamp': {
      const target = injected.samples[index - 1]!.timestampMs - 1;
      const delta = target - sample.timestampMs;
      for (let cursor = index; cursor < injected.samples.length; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        setTimestamp(candidate, candidate.timestampMs + delta);
      }
      break;
    }
    case 'timestamp-gap': {
      const target = injected.samples[index - 1]!.timestampMs + 15_000;
      const delta = target - sample.timestampMs;
      for (let cursor = index; cursor < injected.samples.length; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        setTimestamp(candidate, candidate.timestampMs + delta);
      }
      break;
    }
    case 'stale-feed': {
      const target = injected.samples[index - 1]!.timestampMs + 40_000;
      const delta = target - sample.timestampMs;
      for (let cursor = index; cursor < injected.samples.length; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        setTimestamp(candidate, candidate.timestampMs + delta);
      }
      break;
    }
    case 'missing-sequence':
      injected.samples.forEach((candidate, sequence) => {
        candidate.sequence = sequence;
      });
      sample.sequence = undefined;
      break;
    case 'duplicate-sequence':
      injected.samples.forEach((candidate, sequence) => {
        candidate.sequence = sequence;
      });
      sample.sequence = injected.samples[index - 1]!.sequence;
      for (let cursor = index + 1; cursor < injected.samples.length; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        candidate.sequence = cursor - 1;
      }
      break;
    case 'frozen-altitude': {
      const start = Math.max(0, index - 4);
      const frozenValue = injected.samples[start]!.measurements.altitude;
      if (frozenValue === undefined)
        throw new Error('Frozen-altitude injection requires an altitude channel.');
      for (let cursor = start; cursor <= index; cursor += 1) {
        const candidate = injected.samples[cursor]!;
        candidate.measurements.altitude = frozenValue;
        markInjected(candidate);
      }
      break;
    }
    case 'profile-mismatch':
      injected.profileId = 'generic-fixed-wing';
      injected.profileVersion = '99.0.0';
      injected.provenance.profileId = injected.profileId;
      injected.provenance.profileVersion = injected.profileVersion;
      break;
    case 'blank-csv-value':
    case 'nonnumeric-csv-value':
      throw new Error(`Scenario '${id}' targets legacy CSV input.`);
  }

  injected.runId = `${run.runId}-fault-${id}-seed-${seed}`;
  injected.metadata = {
    ...injected.metadata,
    injectedFault: { scenarioId: id, seed, synthetic: true },
  };
  const digestInput = stableStringify({
    schemaVersion: injected.schemaVersion,
    profileId: injected.profileId,
    profileVersion: injected.profileVersion,
    sources: injected.sources,
    samples: injected.samples,
    validationIssues: injected.validationIssues,
    injectedFault: injected.metadata.injectedFault,
  });
  injected.provenance = {
    ...injected.provenance,
    datasetSha256: await sha256Hex(digestInput),
    inputBytes: utf8ByteLength(digestInput),
    totalRows: injected.samples.length + injected.quarantinedRows.length,
    acceptedRecords: injected.samples.length,
    quarantinedRecords: injected.quarantinedRows.length,
  };
  return injected;
}

/** Injects row-level adapter faults without attempting to parse or reinterpret the CSV. */
export function injectLegacyCsvFault(
  csv: string,
  id: 'blank-csv-value' | 'nonnumeric-csv-value',
  seed = 1,
): string {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 3)
    throw new Error('CSV fault injection requires a header and at least two data rows.');
  const nonemptyDataIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > 0 && line.trim() !== '')
    .map(({ index }) => index);
  const selected = nonemptyDataIndices[deterministicIndex(seed, nonemptyDataIndices.length)];
  if (selected === undefined) throw new Error('CSV fault injection could not select a data row.');
  const fields = lines[selected]!.split(',');
  if (fields.length < 4) throw new Error('Legacy CSV fault injection requires four fields.');
  fields[1] = id === 'blank-csv-value' ? '' : 'not-a-number';
  lines[selected] = fields.join(',');
  return lines.join('\n');
}

export function createInjectedValidationIssue(
  code: Extract<ValidationIssue['code'], 'BLANK_VALUE' | 'NONNUMERIC_VALUE' | 'NONFINITE_VALUE'>,
  sampleIndex: number,
  channel: string,
): ValidationIssue {
  return {
    code,
    disposition: 'recoverable',
    message: `Synthetic injected ${code.toLowerCase().replaceAll('_', ' ')} for ${channel}.`,
    sampleIndex,
    channel,
    expectedCondition: 'a present finite numeric value',
  };
}
