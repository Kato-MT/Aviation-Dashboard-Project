import {
  DECLARED_COMMUNICATION_FAULTS,
  type CommunicationFaultId,
  type CommunicationFaultPlan,
} from '../src/streaming/faultInjection';

export interface SimulatorConfig {
  port: number;
  seed: number;
  sourceCount: number;
  sampleIntervalMs: number;
  samplesPerSource: number;
  queueCapacity: number;
  enabledFaults: CommunicationFaultId[];
}

const DEFAULT_CONFIG: SimulatorConfig = {
  port: 8_080,
  seed: 2_021,
  sourceCount: 2,
  sampleIntervalMs: 250,
  samplesPerSource: 240,
  queueCapacity: 128,
  enabledFaults: [],
};

function readInteger(args: string[], name: string, fallback: number, minimum: number): number {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const raw = args[index + 1];
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

export function parseSimulatorArgs(args: string[]): SimulatorConfig {
  const faultsIndex = args.indexOf('--faults');
  const enabledFaults =
    faultsIndex === -1
      ? []
      : ((args[faultsIndex + 1] ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean) as CommunicationFaultId[]);
  const unknown = enabledFaults.filter((fault) => !DECLARED_COMMUNICATION_FAULTS.includes(fault));
  if (unknown.length > 0) {
    throw new Error(`Unknown fault scenarios: ${unknown.join(', ')}.`);
  }

  return {
    port: readInteger(args, '--port', DEFAULT_CONFIG.port, 1),
    seed: readInteger(args, '--seed', DEFAULT_CONFIG.seed, 0),
    sourceCount: readInteger(args, '--sources', DEFAULT_CONFIG.sourceCount, 1),
    sampleIntervalMs: readInteger(args, '--interval-ms', DEFAULT_CONFIG.sampleIntervalMs, 10),
    samplesPerSource: readInteger(args, '--samples', DEFAULT_CONFIG.samplesPerSource, 1),
    queueCapacity: readInteger(args, '--queue-capacity', DEFAULT_CONFIG.queueCapacity, 1),
    enabledFaults,
  };
}

export function buildFaultPlan(config: SimulatorConfig): CommunicationFaultPlan {
  const starts: Record<CommunicationFaultId, number> = {
    'schema-mismatch': 0,
    latency: 8,
    jitter: 8,
    'dropped-packet': 35,
    duplicate: 50,
    reorder: 65,
    'stale-heartbeat': 75,
    disconnect: 90,
    'queue-pressure': 110,
  };
  return {
    seed: config.seed,
    scenarios: DECLARED_COMMUNICATION_FAULTS.map((id) => {
      const sustained = id === 'latency' || id === 'jitter' || id === 'stale-heartbeat';
      const scenario: CommunicationFaultPlan['scenarios'][number] = {
        id,
        enabled: config.enabledFaults.includes(id),
        startAtMessage: starts[id],
        endAtMessage: starts[id] + (sustained ? 20 : 1),
      };
      if (sustained) scenario.every = 1;
      if (id === 'latency') scenario.value = 600;
      if (id === 'jitter') scenario.value = 350;
      if (id === 'queue-pressure') scenario.value = config.queueCapacity + 16;
      return scenario;
    }),
  };
}

export function simulatorHelp(): string {
  return [
    'Flight Diagnostics Workbench synthetic WebSocket simulator',
    '',
    'Options:',
    '  --port <number>            WebSocket port (default: 8080)',
    '  --seed <number>            Deterministic seed (default: 2021)',
    '  --sources <number>         Synthetic source count (default: 2)',
    '  --interval-ms <number>     Sample interval (default: 250)',
    '  --samples <number>         Samples per source (default: 240)',
    '  --queue-capacity <number>  Bounded outbound queue (default: 128)',
    '  --faults <csv>             Enabled fault IDs',
    '  --help                     Show this help',
    '',
    `Fault IDs: ${DECLARED_COMMUNICATION_FAULTS.join(', ')}`,
    '',
    'All emitted telemetry is synthetic and unclassified.',
  ].join('\n');
}
