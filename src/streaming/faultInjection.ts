import type { StreamMessage } from './protocol';

export type CommunicationFaultId =
  | 'disconnect'
  | 'latency'
  | 'jitter'
  | 'dropped-packet'
  | 'duplicate'
  | 'reorder'
  | 'stale-heartbeat'
  | 'schema-mismatch'
  | 'queue-pressure';

export interface CommunicationFaultScenario {
  id: CommunicationFaultId;
  enabled: boolean;
  startAtMessage: number;
  endAtMessage?: number;
  every?: number;
  probability?: number;
  value?: number;
}

export interface CommunicationFaultPlan {
  seed: number;
  scenarios: CommunicationFaultScenario[];
}

export interface ScheduledStreamDelivery {
  message: StreamMessage;
  delayMs: number;
  injectedFaults: CommunicationFaultId[];
}

export interface FaultInjectionResult {
  deliveries: ScheduledStreamDelivery[];
  disconnect: boolean;
  injectedFaults: CommunicationFaultId[];
}

export const DECLARED_COMMUNICATION_FAULTS: ReadonlyArray<CommunicationFaultId> = [
  'disconnect',
  'latency',
  'jitter',
  'dropped-packet',
  'duplicate',
  'reorder',
  'stale-heartbeat',
  'schema-mismatch',
  'queue-pressure',
];

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function applies(
  scenario: CommunicationFaultScenario,
  ordinal: number,
  random: () => number,
): boolean {
  if (!scenario.enabled || ordinal < scenario.startAtMessage) {
    return false;
  }
  if (scenario.endAtMessage !== undefined && ordinal > scenario.endAtMessage) {
    return false;
  }
  if (scenario.every !== undefined && scenario.every > 0) {
    if ((ordinal - scenario.startAtMessage) % scenario.every !== 0) {
      return false;
    }
  }
  return scenario.probability === undefined || random() < scenario.probability;
}

function scenarioValue(
  scenarios: CommunicationFaultScenario[],
  id: CommunicationFaultId,
  fallback: number,
): number {
  return scenarios.find((scenario) => scenario.id === id)?.value ?? fallback;
}

export class CommunicationFaultInjector {
  private readonly random: () => number;
  private readonly plan: CommunicationFaultPlan;
  private readonly reordered = new Map<string, ScheduledStreamDelivery>();
  private ordinal = 0;
  private disconnectInjected = false;

  constructor(plan: CommunicationFaultPlan) {
    this.plan = {
      seed: plan.seed,
      scenarios: plan.scenarios.map((scenario) => ({ ...scenario })),
    };
    this.random = createSeededRandom(plan.seed);
  }

  transform(message: StreamMessage): FaultInjectionResult {
    const ordinal = this.ordinal;
    this.ordinal += 1;
    const active = this.plan.scenarios
      .filter((scenario) => applies(scenario, ordinal, this.random))
      .map((scenario) => scenario.id);

    if (active.includes('stale-heartbeat') && message.type === 'heartbeat') {
      return {
        deliveries: [],
        disconnect: false,
        injectedFaults: ['stale-heartbeat'],
      };
    }

    if (active.includes('dropped-packet') && message.type === 'telemetry') {
      return {
        deliveries: [],
        disconnect: false,
        injectedFaults: ['dropped-packet'],
      };
    }

    let transformed = message;
    if (active.includes('schema-mismatch') && message.type === 'hello') {
      transformed = {
        ...message,
        schemaVersion: 'unsupported.synthetic.v999',
      };
    }

    let delayMs = 0;
    if (active.includes('latency')) {
      delayMs += Math.max(0, scenarioValue(this.plan.scenarios, 'latency', 750));
    }
    if (active.includes('jitter')) {
      const maximumJitter = Math.max(0, scenarioValue(this.plan.scenarios, 'jitter', 250));
      delayMs += Math.round(this.random() * maximumJitter);
    }

    const delivery: ScheduledStreamDelivery = {
      message: transformed,
      delayMs,
      injectedFaults: [...active],
    };
    let deliveries = [delivery];

    if (active.includes('reorder') && message.type === 'telemetry') {
      const held = this.reordered.get(message.sourceId);
      if (!held) {
        this.reordered.set(message.sourceId, delivery);
        deliveries = [];
      } else {
        this.reordered.delete(message.sourceId);
        deliveries = [delivery, { ...held, delayMs: delivery.delayMs + 1 }];
      }
    }

    if (active.includes('duplicate') && deliveries.length > 0) {
      deliveries = deliveries.flatMap((entry) => [
        entry,
        {
          ...entry,
          delayMs: entry.delayMs + 1,
          injectedFaults: [...new Set([...entry.injectedFaults, 'duplicate' as const])],
        },
      ]);
    }

    if (active.includes('queue-pressure') && deliveries.length > 0) {
      const burstSize = Math.max(
        2,
        Math.floor(scenarioValue(this.plan.scenarios, 'queue-pressure', 32)),
      );
      const first = deliveries[0]!;
      deliveries = Array.from({ length: burstSize }, (_, index) => ({
        ...first,
        delayMs: first.delayMs + index,
        injectedFaults: [...new Set([...first.injectedFaults, 'queue-pressure' as const])],
      }));
    }

    const disconnect =
      !this.disconnectInjected && active.includes('disconnect') && message.type === 'telemetry';
    if (disconnect) {
      this.disconnectInjected = true;
      deliveries = [];
    }

    return { deliveries, disconnect, injectedFaults: active };
  }

  flush(): ScheduledStreamDelivery[] {
    const deliveries = [...this.reordered.values()];
    this.reordered.clear();
    return deliveries;
  }
}

export function createDefaultFaultPlan(seed = 1_337): CommunicationFaultPlan {
  return {
    seed,
    scenarios: DECLARED_COMMUNICATION_FAULTS.map((id, index) => ({
      id,
      enabled: false,
      startAtMessage: 20 + index * 10,
      ...(id === 'latency' || id === 'jitter' ? { every: 1 } : {}),
    })),
  };
}
