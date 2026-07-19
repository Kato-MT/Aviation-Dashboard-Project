import { createSeededRandom } from '../faults/prng';
import {
  TEMPORAL_DATA_CLASSIFICATION,
  TEMPORAL_SCHEMA_VERSION,
  type MissionPhase,
  type ResolvedFaultTimeline,
  type TemporalFaultConfiguration,
  type TemporalFaultDefinition,
  type TemporalFaultId,
  type TemporalMeasurements,
  type TemporalQuality,
  type TemporalSample,
  type TemporalScenario,
  type TemporalSensorId,
  type TemporalTruth,
} from './types';

export const DECLARED_TEMPORAL_FAULTS = [
  {
    id: 'gradual-drift',
    label: 'Gradual altitude drift',
    description: 'Adds a progressively increasing bias to the synthetic barometric altitude.',
    targetSensors: ['barometricAltitude'],
    onsetFraction: 0.25,
    durationFraction: 0.18,
    recoveryFraction: 0.08,
  },
  {
    id: 'noise-growth',
    label: 'Growing vibration noise',
    description: 'Increases synthetic vibration noise over the declared active interval.',
    targetSensors: ['vibration'],
    onsetFraction: 0.32,
    durationFraction: 0.18,
    recoveryFraction: 0.08,
  },
  {
    id: 'oscillation',
    label: 'Vertical-rate oscillation',
    description: 'Adds a deterministic oscillation to the synthetic inertial vertical rate.',
    targetSensors: ['inertialVerticalRate'],
    onsetFraction: 0.35,
    durationFraction: 0.16,
    recoveryFraction: 0.08,
  },
  {
    id: 'lag',
    label: 'Airspeed response lag',
    description: 'Delays the synthetic indicated airspeed by three samples.',
    targetSensors: ['indicatedAirspeed'],
    onsetFraction: 0.14,
    durationFraction: 0.18,
    recoveryFraction: 0.08,
  },
  {
    id: 'intermittent-dropout',
    label: 'Intermittent GPS altitude dropout',
    description: 'Marks and removes recurring synthetic GPS altitude observations.',
    targetSensors: ['gpsAltitude'],
    onsetFraction: 0.42,
    durationFraction: 0.16,
    recoveryFraction: 0.07,
  },
  {
    id: 'stuck-value',
    label: 'Stuck barometric altitude',
    description: 'Holds synthetic barometric altitude at its onset value.',
    targetSensors: ['barometricAltitude'],
    onsetFraction: 0.48,
    durationFraction: 0.15,
    recoveryFraction: 0.08,
  },
  {
    id: 'gain-error',
    label: 'Ground-speed gain error',
    description: 'Applies an 18 percent gain error to synthetic GPS ground speed.',
    targetSensors: ['gpsGroundSpeed'],
    onsetFraction: 0.2,
    durationFraction: 0.2,
    recoveryFraction: 0.08,
  },
  {
    id: 'fuel-leak',
    label: 'Synthetic fuel leak',
    description: 'Adds declared fuel loss and excess flow before a simulated isolation recovery.',
    targetSensors: ['fuelQuantity', 'fuelFlow'],
    onsetFraction: 0.46,
    durationFraction: 0.18,
    recoveryFraction: 0.08,
  },
  {
    id: 'cross-sensor-decoupling',
    label: 'Altitude cross-sensor decoupling',
    description: 'Drives redundant synthetic altitude sensors apart with equal opposite biases.',
    targetSensors: ['barometricAltitude', 'gpsAltitude'],
    onsetFraction: 0.52,
    durationFraction: 0.16,
    recoveryFraction: 0.08,
  },
  {
    id: 'simultaneous-faults',
    label: 'Simultaneous multi-channel faults',
    description:
      'Combines altitude drift, vertical-rate oscillation, and fuel loss under one label.',
    targetSensors: ['barometricAltitude', 'inertialVerticalRate', 'fuelQuantity', 'fuelFlow'],
    onsetFraction: 0.38,
    durationFraction: 0.2,
    recoveryFraction: 0.1,
  },
] as const satisfies readonly TemporalFaultDefinition[];

export interface GenerateTemporalScenarioOptions {
  seed: number;
  scenarioId?: TemporalFaultId | 'nominal' | undefined;
  sampleCount?: number | undefined;
  cadenceMs?: number | undefined;
  startedAt?: string | undefined;
  severityScale?: number | undefined;
  durationScale?: number | undefined;
  onsetPhase?: MissionPhase | undefined;
}

export const TEMPORAL_SEVERITY_SCALE_RANGE = [0.5, 1.5] as const;
export const TEMPORAL_DURATION_SCALE_RANGE = [0.5, 1.5] as const;
export const MAX_TEMPORAL_SEED = 2_147_483_647;

const ONSET_FRACTION_BY_PHASE: Readonly<Record<MissionPhase, number>> = {
  ground: 0.02,
  takeoff: 0.1,
  climb: 0.2,
  cruise: 0.42,
  descent: 0.62,
  landing: 0.84,
};

const MISSION_PHASES = new Set<MissionPhase>([
  'ground',
  'takeoff',
  'climb',
  'cruise',
  'descent',
  'landing',
]);

export function temporalFaultOnsetFraction(
  definition: TemporalFaultDefinition,
  onsetPhase?: MissionPhase,
): number {
  return onsetPhase === undefined ? definition.onsetFraction : ONSET_FRACTION_BY_PHASE[onsetPhase];
}

const SENSOR_IDS: readonly TemporalSensorId[] = [
  'indicatedAirspeed',
  'gpsGroundSpeed',
  'barometricAltitude',
  'gpsAltitude',
  'inertialVerticalRate',
  'barometricVerticalRate',
  'fuelQuantity',
  'fuelFlow',
  'vibration',
];

function interpolate(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function segmentProgress(progress: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (progress - start) / (end - start)));
}

function roundFinite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Synthetic temporal output became nonfinite.');
  return Math.round(value * 1_000_000) / 1_000_000;
}

function missionTruth(progress: number): { phase: MissionPhase; truth: TemporalTruth } {
  let phase: MissionPhase;
  let speed: number;
  let altitude: number;
  let verticalRate: number;

  if (progress < 0.08) {
    phase = 'ground';
    speed = interpolate(0, 18, segmentProgress(progress, 0, 0.08));
    altitude = 0;
    verticalRate = 0;
  } else if (progress < 0.16) {
    const local = segmentProgress(progress, 0.08, 0.16);
    phase = 'takeoff';
    speed = interpolate(18, 112, local);
    altitude = interpolate(0, 500, local);
    verticalRate = interpolate(300, 900, local);
  } else if (progress < 0.4) {
    const local = segmentProgress(progress, 0.16, 0.4);
    phase = 'climb';
    speed = interpolate(112, 146, local);
    altitude = interpolate(500, 7_000, local);
    verticalRate = interpolate(1_600, 850, local);
  } else if (progress < 0.6) {
    const local = segmentProgress(progress, 0.4, 0.6);
    phase = 'cruise';
    speed = 146 + Math.sin(local * Math.PI * 2) * 1.5;
    altitude = 7_000 + Math.sin(local * Math.PI * 2) * 20;
    verticalRate = Math.cos(local * Math.PI * 2) * 25;
  } else if (progress < 0.82) {
    const local = segmentProgress(progress, 0.6, 0.82);
    phase = 'descent';
    speed = interpolate(146, 116, local);
    altitude = interpolate(7_000, 800, local);
    verticalRate = interpolate(-900, -1_300, local);
  } else if (progress < 0.92) {
    const local = segmentProgress(progress, 0.82, 0.92);
    phase = 'landing';
    speed = interpolate(116, 22, local);
    altitude = interpolate(800, 0, local);
    verticalRate = interpolate(-700, -80, local);
  } else {
    const local = segmentProgress(progress, 0.92, 1);
    phase = 'ground';
    speed = interpolate(22, 0, local);
    altitude = 0;
    verticalRate = 0;
  }

  const fuelFlowByPhase: Record<MissionPhase, number> = {
    ground: 0.45,
    takeoff: 1.45,
    climb: 1.1,
    cruise: 0.78,
    descent: 0.55,
    landing: 0.68,
  };
  return {
    phase,
    truth: {
      speed: roundFinite(speed),
      altitude: roundFinite(altitude),
      verticalRate: roundFinite(verticalRate),
      fuel: roundFinite(100 - 35 * progress),
      fuelFlow: fuelFlowByPhase[phase],
      vibration: roundFinite(0.2 + fuelFlowByPhase[phase] * 0.025),
    },
  };
}

function gaussian(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const first = Math.max(Number.EPSILON, random());
    const second = random();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    spare = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };
}

function nominalQuality(): Record<TemporalSensorId, TemporalQuality> {
  return Object.fromEntries(SENSOR_IDS.map((sensorId) => [sensorId, 'nominal'])) as Record<
    TemporalSensorId,
    TemporalQuality
  >;
}

function makeNominalSample(
  sampleIndex: number,
  sampleCount: number,
  timestampMs: number,
  noise: () => number,
): TemporalSample {
  const progress = sampleCount === 1 ? 0 : sampleIndex / (sampleCount - 1);
  const { phase, truth } = missionTruth(progress);
  const measurements: TemporalMeasurements = {
    indicatedAirspeed: roundFinite(Math.max(0, truth.speed + noise() * 0.7)),
    gpsGroundSpeed: roundFinite(Math.max(0, truth.speed + noise())),
    barometricAltitude: roundFinite(Math.max(0, truth.altitude + noise() * 8)),
    gpsAltitude: roundFinite(Math.max(0, truth.altitude + noise() * 15)),
    inertialVerticalRate: roundFinite(truth.verticalRate + noise() * 15),
    barometricVerticalRate: roundFinite(truth.verticalRate + noise() * 25),
    fuelQuantity: roundFinite(Math.max(0, truth.fuel + noise() * 0.03)),
    fuelFlow: roundFinite(Math.max(0, truth.fuelFlow + noise() * 0.02)),
    vibration: roundFinite(Math.max(0, truth.vibration + noise() * 0.004)),
  };
  return {
    sampleIndex,
    sourceId: 'synthetic-fixed-wing-1',
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    phaseTruth: phase,
    truth,
    measurements,
    quality: nominalQuality(),
    faultLabels: [],
    synthetic: true,
    dataClassification: TEMPORAL_DATA_CLASSIFICATION,
  };
}

function cloneSample(sample: TemporalSample): TemporalSample {
  return {
    ...sample,
    truth: { ...sample.truth },
    measurements: { ...sample.measurements },
    quality: { ...sample.quality },
    faultLabels: sample.faultLabels.map((label) => ({ ...label })),
  };
}

export function getTemporalFaultDefinition(id: string): TemporalFaultDefinition | undefined {
  return DECLARED_TEMPORAL_FAULTS.find((definition) => definition.id === id);
}

function resolveTimeline(
  definition: TemporalFaultDefinition,
  sampleCount: number,
  durationScale: number,
  onsetPhase?: MissionPhase,
): ResolvedFaultTimeline {
  const onsetIndex = Math.floor(sampleCount * temporalFaultOnsetFraction(definition, onsetPhase));
  const requestedRecovery = Math.max(1, Math.floor(sampleCount * definition.recoveryFraction));
  const availableAfterOnset = sampleCount - onsetIndex;
  const recoverySamples = Math.min(requestedRecovery, Math.max(1, availableAfterOnset - 2));
  const requestedDuration = Math.max(
    2,
    Math.floor(sampleCount * definition.durationFraction * durationScale),
  );
  const durationSamples = Math.min(
    requestedDuration,
    Math.max(2, availableAfterOnset - recoverySamples),
  );
  const activeEndIndex = onsetIndex + durationSamples - 1;
  return {
    faultId: definition.id,
    onsetIndex,
    durationSamples,
    recoverySamples,
    activeEndIndex,
    recoveryEndIndex: activeEndIndex + recoverySamples,
  };
}

function requiredMeasurement(sample: TemporalSample, sensorId: TemporalSensorId): number {
  const value = sample.measurements[sensorId];
  if (value === null) throw new Error(`Synthetic sensor ${sensorId} was unexpectedly missing.`);
  return value;
}

function setMeasurement(sample: TemporalSample, sensorId: TemporalSensorId, value: number): void {
  sample.measurements[sensorId] = roundFinite(value);
}

function activeProgress(index: number, timeline: ResolvedFaultTimeline): number {
  return Math.min(1, (index - timeline.onsetIndex + 1) / timeline.durationSamples);
}

function recoveryEnvelope(index: number, timeline: ResolvedFaultTimeline): number {
  if (index <= timeline.activeEndIndex) return 1;
  return Math.max(0, 1 - (index - timeline.activeEndIndex) / timeline.recoverySamples);
}

function retainedLoss(index: number, timeline: ResolvedFaultTimeline, maximumLoss: number): number {
  if (index <= timeline.activeEndIndex) return maximumLoss * activeProgress(index, timeline);
  return maximumLoss * recoveryEnvelope(index, timeline);
}

function applyFuelLoss(
  sample: TemporalSample,
  index: number,
  timeline: ResolvedFaultTimeline,
  maximumLoss: number,
  flowIncrease: number,
): void {
  const loss = retainedLoss(index, timeline, maximumLoss);
  sample.truth.fuel = roundFinite(Math.max(0, sample.truth.fuel - loss));
  setMeasurement(
    sample,
    'fuelQuantity',
    Math.max(0, requiredMeasurement(sample, 'fuelQuantity') - loss),
  );
  setMeasurement(
    sample,
    'fuelFlow',
    Math.max(
      0,
      requiredMeasurement(sample, 'fuelFlow') + flowIncrease * recoveryEnvelope(index, timeline),
    ),
  );
}

function applyFaultEffect(
  sample: TemporalSample,
  baseline: readonly TemporalSample[],
  definition: TemporalFaultDefinition,
  timeline: ResolvedFaultTimeline,
  noise: () => number,
  severityScale: number,
): void {
  const index = sample.sampleIndex;
  const envelope = recoveryEnvelope(index, timeline);
  const progress = activeProgress(Math.min(index, timeline.activeEndIndex), timeline);

  switch (definition.id) {
    case 'gradual-drift':
      setMeasurement(
        sample,
        'barometricAltitude',
        requiredMeasurement(sample, 'barometricAltitude') +
          220 * severityScale * progress * envelope,
      );
      break;
    case 'noise-growth':
      setMeasurement(
        sample,
        'vibration',
        requiredMeasurement(sample, 'vibration') +
          noise() * (0.01 + 0.08 * progress) * severityScale * envelope,
      );
      break;
    case 'oscillation':
      setMeasurement(
        sample,
        'inertialVerticalRate',
        requiredMeasurement(sample, 'inertialVerticalRate') +
          Math.sin((index - timeline.onsetIndex) * (Math.PI / 3)) * 180 * severityScale * envelope,
      );
      break;
    case 'lag': {
      const delayedSamples = Math.max(1, Math.round(3 * severityScale));
      const delayedIndex = Math.max(0, index - delayedSamples);
      const delayed = requiredMeasurement(baseline[delayedIndex]!, 'indicatedAirspeed');
      const current = requiredMeasurement(sample, 'indicatedAirspeed');
      setMeasurement(sample, 'indicatedAirspeed', delayed * envelope + current * (1 - envelope));
      break;
    }
    case 'intermittent-dropout':
      if (
        index <= timeline.activeEndIndex &&
        (index - timeline.onsetIndex) % 3 < Math.max(1, Math.min(3, Math.round(2 * severityScale)))
      ) {
        sample.measurements.gpsAltitude = null;
        sample.quality.gpsAltitude = 'missing';
      }
      break;
    case 'stuck-value': {
      const stuck = requiredMeasurement(baseline[timeline.onsetIndex]!, 'barometricAltitude');
      const current = requiredMeasurement(sample, 'barometricAltitude');
      const holdStrength = Math.min(1, severityScale * envelope);
      setMeasurement(
        sample,
        'barometricAltitude',
        stuck * holdStrength + current * (1 - holdStrength),
      );
      break;
    }
    case 'gain-error':
      setMeasurement(
        sample,
        'gpsGroundSpeed',
        requiredMeasurement(sample, 'gpsGroundSpeed') * (1 + 0.18 * severityScale * envelope),
      );
      break;
    case 'fuel-leak':
      applyFuelLoss(sample, index, timeline, 7 * severityScale, 0.7 * severityScale);
      break;
    case 'cross-sensor-decoupling':
      setMeasurement(
        sample,
        'barometricAltitude',
        requiredMeasurement(sample, 'barometricAltitude') + 140 * severityScale * envelope,
      );
      setMeasurement(
        sample,
        'gpsAltitude',
        requiredMeasurement(sample, 'gpsAltitude') - 140 * severityScale * envelope,
      );
      break;
    case 'simultaneous-faults':
      setMeasurement(
        sample,
        'barometricAltitude',
        requiredMeasurement(sample, 'barometricAltitude') +
          180 * severityScale * progress * envelope,
      );
      setMeasurement(
        sample,
        'inertialVerticalRate',
        requiredMeasurement(sample, 'inertialVerticalRate') +
          Math.sin((index - timeline.onsetIndex) * (Math.PI / 2)) * 150 * severityScale * envelope,
      );
      applyFuelLoss(sample, index, timeline, 5 * severityScale, 0.5 * severityScale);
      break;
  }
}

function injectFault(
  samples: TemporalSample[],
  definition: TemporalFaultDefinition,
  timeline: ResolvedFaultTimeline,
  noise: () => number,
  severityScale: number,
): void {
  const baseline = samples.map(cloneSample);
  for (let index = timeline.onsetIndex; index <= timeline.recoveryEndIndex; index += 1) {
    const sample = samples[index]!;
    const lifecycle = index <= timeline.activeEndIndex ? 'active' : 'recovering';
    for (const sensorId of definition.targetSensors) {
      sample.quality[sensorId] = lifecycle === 'active' ? 'injected' : 'recovering';
    }
    sample.faultLabels.push({
      ...timeline,
      label: definition.label,
      lifecycle,
      targetSensors: definition.targetSensors,
      synthetic: true,
    });
    applyFaultEffect(sample, baseline, definition, timeline, noise, severityScale);
  }
}

function validatedScale(value: number, name: string, range: readonly [number, number]): number {
  if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
    throw new Error(`${name} must be finite and between ${range[0]} and ${range[1]}.`);
  }
  return value;
}

export function generateTemporalScenario(
  options: GenerateTemporalScenarioOptions,
): TemporalScenario {
  const sampleCount = options.sampleCount ?? 180;
  const cadenceMs = options.cadenceMs ?? 1_000;
  const scenarioId = options.scenarioId ?? 'nominal';
  const startedAt = options.startedAt ?? '2026-01-01T00:00:00.000Z';
  const hasFaultOverride =
    options.severityScale !== undefined ||
    options.durationScale !== undefined ||
    options.onsetPhase !== undefined;
  const severityScale = validatedScale(
    options.severityScale ?? 1,
    'Temporal severityScale',
    TEMPORAL_SEVERITY_SCALE_RANGE,
  );
  const durationScale = validatedScale(
    options.durationScale ?? 1,
    'Temporal durationScale',
    TEMPORAL_DURATION_SCALE_RANGE,
  );
  if (!Number.isInteger(options.seed) || options.seed < 1 || options.seed > MAX_TEMPORAL_SEED) {
    throw new Error(
      `Temporal seed must be a positive integer no greater than ${MAX_TEMPORAL_SEED}.`,
    );
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 60) {
    throw new Error('Temporal scenarios require at least 60 samples.');
  }
  if (!Number.isInteger(cadenceMs) || cadenceMs < 100) {
    throw new Error('Temporal scenario cadence must be an integer of at least 100 ms.');
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error('Temporal scenario start time must be valid.');
  const definition = scenarioId === 'nominal' ? undefined : getTemporalFaultDefinition(scenarioId);
  if (scenarioId !== 'nominal' && definition === undefined) {
    throw new Error(`Unknown temporal fault scenario '${scenarioId}'.`);
  }
  if (options.onsetPhase !== undefined && !MISSION_PHASES.has(options.onsetPhase)) {
    throw new Error(`Unsupported temporal onset phase '${String(options.onsetPhase)}'.`);
  }
  if (definition === undefined && hasFaultOverride) {
    throw new Error('Nominal temporal scenarios cannot declare fault variation parameters.');
  }

  const random = createSeededRandom(options.seed);
  const noise = gaussian(random);
  const samples = Array.from({ length: sampleCount }, (_, sampleIndex) =>
    makeNominalSample(sampleIndex, sampleCount, startedAtMs + sampleIndex * cadenceMs, noise),
  );
  const faultTimeline =
    definition === undefined
      ? null
      : resolveTimeline(definition, sampleCount, durationScale, options.onsetPhase);
  if (definition !== undefined && faultTimeline !== null) {
    injectFault(samples, definition, faultTimeline, noise, severityScale);
  }

  const faultConfiguration: TemporalFaultConfiguration | undefined = hasFaultOverride
    ? {
        severityScale,
        durationScale,
        onsetPhase: options.onsetPhase ?? null,
      }
    : undefined;

  return {
    schemaVersion: TEMPORAL_SCHEMA_VERSION,
    profileId: 'generic-fixed-wing',
    scenarioId,
    seed: options.seed,
    cadenceMs,
    startedAt: new Date(startedAtMs).toISOString(),
    synthetic: true,
    dataClassification: TEMPORAL_DATA_CLASSIFICATION,
    ...(faultConfiguration === undefined ? {} : { faultConfiguration }),
    faultTimeline,
    samples,
  };
}
