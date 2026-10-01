import { describe, expect, it } from 'vitest';
import {
  DECLARED_FAULT_SCENARIOS,
  createInjectedValidationIssue,
  getFaultScenario,
  injectFaultScenario,
  injectLegacyCsvFault,
  type FaultScenarioId,
} from '../../src/faults/scenarios';
import type { TelemetryRun } from '../../src/core/types';
import { makeRun, makeSample } from '../core/helpers';

describe('fault scenarios', () => {
  describe('DECLARED_FAULT_SCENARIOS', () => {
    it('declares 13 scenarios', () => {
      expect(DECLARED_FAULT_SCENARIOS.length).toBe(13);
    });

    it('has unique scenario IDs and valid target properties', () => {
      const ids = DECLARED_FAULT_SCENARIOS.map((scenario) => scenario.id);
      expect(new Set(ids).size).toBe(ids.length);

      for (const scenario of DECLARED_FAULT_SCENARIOS) {
        expect(scenario.id).toBeTruthy();
        expect(scenario.label).toBeTruthy();
        expect(scenario.description).toBeTruthy();
        expect(['canonical', 'legacy-csv']).toContain(scenario.target);
        expect(Array.isArray(scenario.expectedRuleIds)).toBe(true);
      }
    });
  });

  describe('getFaultScenario', () => {
    it('retrieves declared scenarios by ID', () => {
      const scenario = getFaultScenario('missing-altitude');
      expect(scenario).toBeDefined();
      expect(scenario?.id).toBe('missing-altitude');
      expect(scenario?.target).toBe('canonical');
    });

    it('returns undefined for non-existent scenario IDs', () => {
      expect(getFaultScenario('non-existent-id')).toBeUndefined();
    });
  });

  describe('createInjectedValidationIssue', () => {
    it('creates validation issues with expected attributes', () => {
      const issue = createInjectedValidationIssue('NONNUMERIC_VALUE', 2, 'altitude');
      expect(issue).toEqual({
        code: 'NONNUMERIC_VALUE',
        disposition: 'recoverable',
        message: 'Synthetic injected nonnumeric value for altitude.',
        sampleIndex: 2,
        channel: 'altitude',
        expectedCondition: 'a present finite numeric value',
      });
    });

    it('formats messages correctly for BLANK_VALUE and NONFINITE_VALUE', () => {
      const blankIssue = createInjectedValidationIssue('BLANK_VALUE', 0, 'speed');
      expect(blankIssue.message).toBe('Synthetic injected blank value for speed.');

      const nonfiniteIssue = createInjectedValidationIssue('NONFINITE_VALUE', 1, 'fuel');
      expect(nonfiniteIssue.message).toBe('Synthetic injected nonfinite value for fuel.');
    });
  });

  describe('injectFaultScenario', () => {
    function createTestRun(sampleCount = 10): TelemetryRun {
      return makeRun(
        Array.from({ length: sampleCount }, (_, index) =>
          makeSample(index, {
            measurements: { altitude: 1000 + index * 10, speed: 200, fuel: 80 - index },
            channelQualityFlags: {
              altitude: ['valid'],
              speed: ['valid'],
            },
          }),
        ),
      );
    }

    it('injects missing-altitude fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'missing-altitude', 1);
      const injectedSample = injected.samples.find(
        (sample) => sample.measurements.altitude === undefined,
      );
      expect(injectedSample).toBeDefined();
      expect(injectedSample?.qualityFlags).toContain('injected');
      expect(injectedSample?.qualityFlags).toContain('suspect');
    });

    it('injects nonfinite-speed fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'nonfinite-speed', 1);
      const injectedSample = injected.samples.find(
        (sample) => sample.measurements.speed === Number.POSITIVE_INFINITY,
      );
      expect(injectedSample).toBeDefined();
      expect(injectedSample?.qualityFlags).toContain('injected');
    });

    it('injects range-excursion fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'range-excursion', 1);
      const injectedSample = injected.samples.find((sample) => sample.measurements.fuel === 150);
      expect(injectedSample).toBeDefined();
      expect(injectedSample?.qualityFlags).toContain('injected');
    });

    it('injects duplicate-timestamp fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'duplicate-timestamp', 1);
      let duplicateFound = false;
      for (let index = 1; index < injected.samples.length; index += 1) {
        if (injected.samples[index]!.timestampMs === injected.samples[index - 1]!.timestampMs) {
          duplicateFound = true;
          break;
        }
      }
      expect(duplicateFound).toBe(true);
    });

    it('injects out-of-order-timestamp fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'out-of-order-timestamp', 1);
      let outOfOrderFound = false;
      for (let index = 1; index < injected.samples.length; index += 1) {
        if (injected.samples[index]!.timestampMs < injected.samples[index - 1]!.timestampMs) {
          outOfOrderFound = true;
          break;
        }
      }
      expect(outOfOrderFound).toBe(true);
    });

    it('injects timestamp-gap fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'timestamp-gap', 1);
      let gapFound = false;
      for (let index = 1; index < injected.samples.length; index += 1) {
        const delta =
          injected.samples[index]!.timestampMs - injected.samples[index - 1]!.timestampMs;
        if (delta >= 15_000) {
          gapFound = true;
          break;
        }
      }
      expect(gapFound).toBe(true);
    });

    it('injects stale-feed fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'stale-feed', 1);
      let staleFound = false;
      for (let index = 1; index < injected.samples.length; index += 1) {
        const delta =
          injected.samples[index]!.timestampMs - injected.samples[index - 1]!.timestampMs;
        if (delta >= 40_000) {
          staleFound = true;
          break;
        }
      }
      expect(staleFound).toBe(true);
    });

    it('injects missing-sequence fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'missing-sequence', 1);
      const missingSeqSample = injected.samples.find((sample) => sample.sequence === undefined);
      expect(missingSeqSample).toBeDefined();
      expect(missingSeqSample?.qualityFlags).toContain('injected');
    });

    it('injects duplicate-sequence fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'duplicate-sequence', 1);
      let duplicateFound = false;
      for (let index = 1; index < injected.samples.length; index += 1) {
        if (injected.samples[index]!.sequence === injected.samples[index - 1]!.sequence) {
          duplicateFound = true;
          break;
        }
      }
      expect(duplicateFound).toBe(true);
    });

    it('injects frozen-altitude fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'frozen-altitude', 1);
      let frozenCount = 0;
      for (let index = 1; index < injected.samples.length; index += 1) {
        if (
          injected.samples[index]!.measurements.altitude ===
          injected.samples[index - 1]!.measurements.altitude
        ) {
          frozenCount += 1;
        }
      }
      expect(frozenCount).toBeGreaterThanOrEqual(4);
    });

    it('injects profile-mismatch fault', async () => {
      const run = createTestRun();
      const injected = await injectFaultScenario(run, 'profile-mismatch', 1);
      expect(injected.profileId).toBe('generic-fixed-wing');
      expect(injected.profileVersion).toBe('99.0.0');
      expect(injected.provenance.profileId).toBe('generic-fixed-wing');
      expect(injected.provenance.profileVersion).toBe('99.0.0');
    });

    it('clones quarantinedRows and validationIssues when cloning run', async () => {
      const run = createTestRun();
      run.quarantinedRows = [
        {
          rowNumber: 2,
          sourceId: 'source-a',
          issues: [
            {
              code: 'BLANK_VALUE',
              disposition: 'recoverable',
              message: 'blank value',
            },
          ],
          raw: { altitude: '' },
        },
      ];
      run.validationIssues = [
        {
          code: 'BLANK_VALUE',
          disposition: 'recoverable',
          message: 'blank value',
        },
      ];

      const injected = await injectFaultScenario(run, 'missing-altitude', 1);
      expect(injected.quarantinedRows).toHaveLength(1);
      expect(injected.quarantinedRows[0]).not.toBe(run.quarantinedRows[0]);
      expect(injected.quarantinedRows[0]?.raw).not.toBe(run.quarantinedRows[0]?.raw);
      expect(injected.quarantinedRows[0]?.issues[0]).not.toBe(run.quarantinedRows[0]?.issues[0]);
      expect(injected.validationIssues[0]).not.toBe(run.validationIssues[0]);

      expect(injected.samples[0]?.channelQualityFlags).toBeDefined();
      expect(injected.samples[0]?.channelQualityFlags).not.toBe(
        run.samples[0]?.channelQualityFlags,
      );
      expect(injected.samples[0]?.channelQualityFlags?.altitude).toEqual(['valid']);
    });

    it('throws error for unknown fault scenario', async () => {
      const run = createTestRun();
      await expect(
        injectFaultScenario(run, 'unknown-scenario' as FaultScenarioId, 1),
      ).rejects.toThrow("Unknown fault scenario 'unknown-scenario'.");
    });

    it('throws error for legacy-csv targeted scenario passed to canonical injector', async () => {
      const run = createTestRun();
      await expect(injectFaultScenario(run, 'blank-csv-value', 1)).rejects.toThrow(
        "Scenario 'blank-csv-value' targets legacy-csv; use injectLegacyCsvFault instead.",
      );
    });

    it('throws error if run has fewer than required samples (general scenario)', async () => {
      const run = createTestRun(1);
      await expect(injectFaultScenario(run, 'missing-altitude', 1)).rejects.toThrow(
        'Fault injection requires at least 2 samples.',
      );
    });

    it('throws error if run has fewer than 5 samples for frozen-altitude', async () => {
      const run = createTestRun(4);
      await expect(injectFaultScenario(run, 'frozen-altitude', 1)).rejects.toThrow(
        'Fault injection requires at least 5 samples.',
      );
    });

    it('throws error if frozen-altitude target sample lacks altitude channel', async () => {
      const run = makeRun(
        Array.from({ length: 6 }, (_, index) =>
          makeSample(index, {
            measurements: { speed: 200, fuel: 80 },
          }),
        ),
      );
      await expect(injectFaultScenario(run, 'frozen-altitude', 1)).rejects.toThrow(
        'Frozen-altitude injection requires an altitude channel.',
      );
    });
  });

  describe('injectLegacyCsvFault', () => {
    const validCsv =
      'timestamp,altitude,speed,fuel\n00:00,1000,200,80\n00:10,1010,201,79\n00:20,1020,202,78';

    it('injects blank-csv-value', () => {
      const result = injectLegacyCsvFault(validCsv, 'blank-csv-value', 1);
      expect(result).not.toBe(validCsv);
      const lines = result.split('\n');
      expect(lines.length).toBe(4);
      expect(lines.some((line, index) => index > 0 && line.includes(',,'))).toBe(true);
    });

    it('injects nonnumeric-csv-value', () => {
      const result = injectLegacyCsvFault(validCsv, 'nonnumeric-csv-value', 1);
      expect(result).not.toBe(validCsv);
      expect(result).toContain('not-a-number');
    });

    it('throws error if CSV has fewer than 3 lines', () => {
      const shortCsv = 'timestamp,altitude,speed,fuel\n00:00,1000,200,80';
      expect(() => injectLegacyCsvFault(shortCsv, 'blank-csv-value', 1)).toThrow(
        'CSV fault injection requires a header and at least two data rows.',
      );
    });

    it('throws error if CSV selected row has fewer than 4 fields', () => {
      const invalidFieldsCsv = 'a,b,c\n1,2,3\n4,5,6';
      expect(() => injectLegacyCsvFault(invalidFieldsCsv, 'blank-csv-value', 1)).toThrow(
        'Legacy CSV fault injection requires four fields.',
      );
    });

    it('throws error if no non-empty data rows exist after header', () => {
      const emptyDataCsv = 'a,b,c,d\n   \n   ';
      expect(() => injectLegacyCsvFault(emptyDataCsv, 'blank-csv-value', 1)).toThrow(
        'Cannot select a fault location from an empty run.',
      );
    });
  });
});
