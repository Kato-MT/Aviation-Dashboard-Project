import { describe, expect, it } from 'vitest';

import { buildFaultPlan, parseSimulatorArgs, simulatorHelp } from '../../simulator/config';

describe('simulator command configuration', () => {
  it('uses safe deterministic defaults', () => {
    expect(parseSimulatorArgs([])).toEqual({
      port: 8080,
      seed: 2021,
      sourceCount: 2,
      sampleIntervalMs: 250,
      samplesPerSource: 240,
      queueCapacity: 128,
      enabledFaults: [],
    });
  });

  it('parses explicit source, timing, queue, and fault settings', () => {
    expect(
      parseSimulatorArgs([
        '--port',
        '9090',
        '--seed',
        '7',
        '--sources',
        '3',
        '--interval-ms',
        '50',
        '--samples',
        '12',
        '--queue-capacity',
        '16',
        '--faults',
        'latency,duplicate',
      ]),
    ).toMatchObject({
      port: 9090,
      seed: 7,
      sourceCount: 3,
      sampleIntervalMs: 50,
      samplesPerSource: 12,
      queueCapacity: 16,
      enabledFaults: ['latency', 'duplicate'],
    });
  });

  it.each([
    ['--port', '0'],
    ['--sources', '1.5'],
    ['--interval-ms', '9'],
    ['--samples', 'NaN'],
    ['--queue-capacity', '-1'],
  ])('rejects invalid numeric option %s %s', (name, value) => {
    expect(() => parseSimulatorArgs([name, value])).toThrow(name);
  });

  it('rejects undeclared communications faults', () => {
    expect(() => parseSimulatorArgs(['--faults', 'latency,teleport'])).toThrow(
      'Unknown fault scenarios: teleport.',
    );
  });

  it('builds a bounded, deterministic schedule for enabled faults', () => {
    const config = parseSimulatorArgs([
      '--seed',
      '11',
      '--queue-capacity',
      '8',
      '--faults',
      'schema-mismatch,latency,queue-pressure',
    ]);
    const plan = buildFaultPlan(config);
    expect(plan.seed).toBe(11);
    expect(plan.scenarios.find((scenario) => scenario.id === 'schema-mismatch')).toMatchObject({
      enabled: true,
      startAtMessage: 0,
    });
    expect(plan.scenarios.find((scenario) => scenario.id === 'latency')).toMatchObject({
      enabled: true,
      value: 600,
      every: 1,
    });
    expect(plan.scenarios.find((scenario) => scenario.id === 'queue-pressure')?.value).toBe(24);
  });

  it('documents every declared communications-fault ID', () => {
    const help = simulatorHelp();
    for (const id of [
      'disconnect',
      'latency',
      'jitter',
      'dropped-packet',
      'duplicate',
      'reorder',
      'stale-heartbeat',
      'schema-mismatch',
      'queue-pressure',
    ]) {
      expect(help).toContain(id);
    }
  });
});
