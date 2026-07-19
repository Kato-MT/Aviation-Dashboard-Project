import { describe, expect, it } from 'vitest';

import recordedBenchmark from '../../benchmark/temporal-latest.json';
import {
  assertTemporalBenchmarkConfiguration,
  assertTemporalBenchmarkDocument,
  runTemporalBenchmark,
  temporalBenchmarkMarkdown,
  type TemporalBenchmarkConfiguration,
  type TemporalBenchmarkRuntime,
} from '../../tools/benchmarks/temporal';

const TEST_CONFIGURATION: TemporalBenchmarkConfiguration = {
  warmupIterations: 0,
  measuredRepetitions: 1,
  inferenceSampleCounts: [60],
  investigationSampleCounts: [60],
  campaignSeedCounts: [1],
  campaignScenarioIds: ['nominal'],
};

function deterministicRuntime(): TemporalBenchmarkRuntime {
  let clock = 0;
  return {
    now: () => {
      clock += 5;
      return clock;
    },
    heapUsed: () => 12_345_678,
    recordedAt: '2026-07-17T12:34:56.000Z',
    sourceRevision: 'test-revision',
    environment: {
      runtime: 'node-proxy',
      node: 'v-test',
      v8: 'v8-test',
      platform: 'test-platform',
      release: 'test-release',
      architecture: 'test-architecture',
      logicalCpuCount: 4,
      cpuModel: 'Synthetic test CPU',
      ci: true,
    },
  };
}

describe('temporal benchmark evidence generator', () => {
  it('keeps the checked-in local evidence schema-valid and explicitly non-browser', () => {
    expect(() => assertTemporalBenchmarkDocument(recordedBenchmark)).not.toThrow();
    expect(recordedBenchmark.evidenceKind).toBe('node-proxy');
    expect(recordedBenchmark.results).toHaveLength(8);
    expect(recordedBenchmark.results.every(({ outputDigestStable }) => outputDigestStable)).toBe(
      true,
    );
  });

  it('produces schema-valid deterministic evidence without a timing gate', async () => {
    const first = await runTemporalBenchmark({
      configuration: TEST_CONFIGURATION,
      runtime: deterministicRuntime(),
    });
    const second = await runTemporalBenchmark({
      configuration: TEST_CONFIGURATION,
      runtime: deterministicRuntime(),
    });

    expect(second).toEqual(first);
    expect(() => assertTemporalBenchmarkDocument(first)).not.toThrow();
    expect(first).toMatchObject({
      schemaVersion: 'temporal-benchmark.v1',
      evidenceKind: 'node-proxy',
      syntheticDataOnly: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      reproducibility: {
        model: {
          role: 'integrated-production-advisory',
          modelVersion: '2.0.0',
          artifactPath: 'models/temporal_fault_model_v2.json',
          projection: {
            id: 'investigation-model-projection',
            version: '1.0.0',
          },
          authority: 'deterministic-rules',
        },
      },
    });
    expect(first.results.map(({ operation }) => operation)).toEqual([
      'temporal-model-inference',
      'temporal-investigation',
      'temporal-campaign',
    ]);
    expect(first.reproducibility.model.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const result of first.results) {
      expect(result.durationsMs).toEqual([5]);
      expect(result.outputDigestStable).toBe(true);
      expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.configurationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.maximumObservedHeapBytes).toBe(12_345_678);
    }
    expect(first.results[0]?.outputSummary).toMatchObject({
      modelVersion: '2.0.0',
      modelRole: 'integrated-production-advisory',
      scoreCount: 21,
    });
    expect(first.results[1]?.outputSummary).toMatchObject({
      modelVersion: '2.0.0',
      modelRole: 'integrated-production-advisory',
      pointCount: 60,
    });
    expect(first.results[2]?.outputSummary).toMatchObject({
      status: 'completed',
      plannedCases: 1,
      completedCases: 1,
      failedCases: 0,
    });
  });

  it('rejects malformed evidence and invalid benchmark plans', async () => {
    expect(() =>
      assertTemporalBenchmarkConfiguration({
        ...TEST_CONFIGURATION,
        measuredRepetitions: 0,
      }),
    ).toThrow('measuredRepetitions');
    expect(() =>
      assertTemporalBenchmarkConfiguration({
        ...TEST_CONFIGURATION,
        investigationSampleCounts: [59],
      }),
    ).toThrow('investigation sample count');

    const document = await runTemporalBenchmark({
      configuration: TEST_CONFIGURATION,
      runtime: deterministicRuntime(),
    });
    const malformed = structuredClone(document) as unknown as {
      results: Array<{ durationsMs: number[] }>;
    };
    malformed.results[0]!.durationsMs = [0];
    expect(() => assertTemporalBenchmarkDocument(malformed)).toThrow('timing fields');
  });

  it('generates a report that clearly limits measurements to a local Node proxy', async () => {
    const document = await runTemporalBenchmark({
      configuration: TEST_CONFIGURATION,
      runtime: deterministicRuntime(),
    });
    const markdown = temporalBenchmarkMarkdown(document);

    expect(markdown).toContain('Node.js proxy evidence');
    expect(markdown).toContain('does not measure browser rendering');
    expect(markdown).toContain('Timing values are descriptive, not pass or fail gates.');
    expect(markdown).toContain('generated synthetic and unclassified');
    expect(markdown).toContain('test-revision');
  });
});
