import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LegacyCsvAdapter } from '../../src/adapters/legacy-csv';

const header = 'timestamp,altitude_ft,speed_kts,fuel_pct';
const adapter = new LegacyCsvAdapter();

function timestampAt(index: number): string {
  const totalSeconds = index * 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

describe('seeded parser properties and fuzzing', () => {
  it('TC-ADV-001 preserves row accounting and finite values for valid generated CSV', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            altitude: fc.integer({ min: 0, max: 60_000 }),
            speed: fc.integer({ min: 0, max: 900 }),
            fuel: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        async (records) => {
          const csv = [
            header,
            ...records.map(
              (record, index) =>
                `${timestampAt(index)},${record.altitude},${record.speed},${record.fuel}`,
            ),
          ].join('\n');
          const run = await adapter.parse(csv);

          expect(run.fatal).toBe(false);
          expect(run.samples).toHaveLength(records.length);
          expect(run.quarantinedRows).toHaveLength(0);
          expect(
            run.samples.every((sample) =>
              Object.values(sample.measurements).every(Number.isFinite),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 100, seed: 0x0f1a17 },
    );
  });

  it('TC-ADV-001 quarantines every generated invalid numeric row without dropping it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            token: fc.constantFrom('', '   ', 'NaN', 'Infinity', '-Infinity', 'not-a-number'),
            channel: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        async (records) => {
          const csv = [
            header,
            ...records.map(({ token, channel }, index) => {
              const values: Array<string | number> = [1_000, 200, 90];
              values[channel] = token;
              return `${timestampAt(index)},${values.join(',')}`;
            }),
          ].join('\n');
          const run = await adapter.parse(csv);

          expect(run.samples).toHaveLength(0);
          expect(run.quarantinedRows).toHaveLength(records.length);
          expect(run.provenance.acceptedRecords + run.provenance.quarantinedRecords).toBe(
            records.length,
          );
        },
      ),
      { numRuns: 100, seed: 0x0bad5eed },
    );
  });

  it('TC-ADV-001 returns structured validation for arbitrary parser input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 500 }), async (input) => {
        const run = await adapter.parse(input);
        expect(run.provenance.acceptedRecords).toBe(run.samples.length);
        expect(run.provenance.quarantinedRecords).toBe(run.quarantinedRows.length);
        expect(run.validationIssues).toBeInstanceOf(Array);
      }),
      { numRuns: 200, seed: 0x0c5bf00d },
    );
  });
});
