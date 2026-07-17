import { TELEMETRY_SCHEMA_VERSION, type DetectionProfile } from '../core';

function nominalValue(channel: string, index: number): number {
  const time = index / 10;
  switch (channel) {
    case 'altitude':
      return 5_200 + 145 * Math.sin(time / 2.8) + index * 0.15;
    case 'airspeed':
    case 'speed':
      return 128 + 7 * Math.sin(time / 1.9);
    case 'fuel':
      return Math.max(0, 91 - index * 0.025 + 0.03 * Math.sin(time));
    case 'verticalRate':
      return 305 * Math.cos(time / 2.8);
    case 'rotorSpeed':
      return 418 + 7 * Math.sin(time / 1.5);
    case 'vibration':
      return 0.24 + 0.018 * Math.sin(time * 1.7);
    default:
      return 10 + Math.sin(time);
  }
}

export function generateSyntheticDocument(profile: DetectionProfile, sampleCount = 240): string {
  const sourceId = `demo-${profile.platformCategory}`;
  const cadence = profile.expectedCadenceMs ?? 1_000;
  const start = Date.parse('2026-07-17T12:00:00.000Z');
  const units = Object.fromEntries(
    Object.values(profile.channels).map((definition) => [definition.channel, definition.unit]),
  );

  if (profile.platformCategory === 'generic-fixed-wing') units.vibration = 'g';

  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const measurements = Object.fromEntries(
      Object.keys(units).map((channel) => [channel, nominalValue(channel, index)]),
    );
    return {
      sourceId,
      sequence: index,
      timestamp: new Date(start + index * cadence).toISOString(),
      measurements,
      units,
      qualityFlags: ['valid'],
    };
  });

  return JSON.stringify({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: `generated-${profile.id}-seed-20260717`,
    title: `${profile.label} generated nominal run`,
    profile: { id: profile.id, version: profile.version },
    sources: [
      {
        sourceId,
        label: `${profile.label} synthetic source`,
        units,
      },
    ],
    samples,
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      generatorVersion: '1.0.0',
      seed: 20260717,
    },
  });
}
