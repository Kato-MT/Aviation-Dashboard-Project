import { describe, expect, it } from 'vitest';

import {
  BUNDLED_REPLAY_SCENARIOS,
  canonicalizeReplayManifest,
  computeReplayManifestDigest,
  loadBundledReplayScenario,
} from '../../src/replay';

describe('bundled synthetic airspace scenarios', () => {
  it.each(BUNDLED_REPLAY_SCENARIOS.map((scenario) => scenario.id))(
    'generates byte-identical canonical evidence for %s with the same seed',
    async (scenarioId) => {
      const left = await loadBundledReplayScenario(scenarioId, 123_456);
      const right = await loadBundledReplayScenario(scenarioId, 123_456);
      expect(canonicalizeReplayManifest(left)).toBe(canonicalizeReplayManifest(right));
      expect(left.provenance.canonicalSha256).toBe(right.provenance.canonicalSha256);
      expect(await computeReplayManifestDigest(left)).toBe(left.provenance.canonicalSha256);
    },
  );

  it('changes canonical identity when the stable integer seed changes', async () => {
    const left = await loadBundledReplayScenario('nominal-regional', 1);
    const right = await loadBundledReplayScenario('nominal-regional', 2);
    expect(left.provenance.canonicalSha256).not.toBe(right.provenance.canonicalSha256);
  });

  it('uses only reserved scenario-scoped identities and stable offset/index order', async () => {
    for (const metadata of BUNDLED_REPLAY_SCENARIOS) {
      expect(Object.isFrozen(metadata)).toBe(true);
      const manifest = await loadBundledReplayScenario(metadata.id);
      expect(manifest.durationMs).toBe(metadata.durationMs);
      expect(manifest.events.map((event) => event.index)).toEqual(
        manifest.events.map((_event, index) => index),
      );
      expect(manifest.events.map((event) => event.offsetMs)).toEqual(
        [...manifest.events].map((event) => event.offsetMs).sort((left, right) => left - right),
      );
      for (const event of manifest.events) {
        if (event.kind !== 'snapshot') continue;
        for (const aircraft of event.snapshot.aircraft) {
          expect(aircraft).toMatchObject({ synthetic: true, identifierKind: 'synthetic' });
          expect(aircraft.aircraftId).toMatch(
            new RegExp(`^demo:${metadata.id}:[1-9]\\d{0,3}$`, 'u'),
          );
        }
      }
    }
  });

  it('contains explicit nominal, quality, ordering, outage, expiry and recovery evidence', async () => {
    const nominal = await loadBundledReplayScenario('nominal-regional');
    expect(nominal.events.filter((event) => event.kind === 'snapshot')).toHaveLength(5);

    const quality = await loadBundledReplayScenario('data-quality-gaps');
    const qualityAircraft = quality.events.flatMap((event) =>
      event.kind === 'snapshot' ? event.snapshot.aircraft : [],
    );
    expect(qualityAircraft.some((item) => item.qualityFlags.includes('missing-position'))).toBe(
      true,
    );
    expect(qualityAircraft.some((item) => item.barometricAltitudeFeet === undefined)).toBe(true);
    expect(qualityAircraft.some((item) => item.groundSpeedKnots === undefined)).toBe(true);
    expect(quality.events.filter((event) => event.expectedDisposition === 'rejected')).toHaveLength(
      2,
    );

    const outage = await loadBundledReplayScenario('provider-outage-recovery');
    const health = outage.events.flatMap((event) =>
      event.kind === 'health' ? [event.health] : [],
    );
    expect(health.map((item) => item.status)).toEqual(['live', 'degraded', 'offline', 'live']);
    expect(outage.durationMs).toBeGreaterThan(15 * 60_000);
    const recovered = outage.events.filter((event) => event.kind === 'snapshot').at(-1);
    expect(
      recovered?.kind === 'snapshot' && recovered.snapshot.aircraft.map((item) => item.aircraftId),
    ).toContain('demo:provider-outage-recovery:1');
  });

  it('rejects unsupported scenario IDs and invalid seeds', async () => {
    await expect(loadBundledReplayScenario('unknown' as never)).rejects.toThrow('Unknown bundled');
    await expect(loadBundledReplayScenario('nominal-regional', 0)).rejects.toThrow('Replay seed');
    await expect(loadBundledReplayScenario('nominal-regional', 0x1_0000_0000)).rejects.toThrow(
      'Replay seed',
    );
  });
});
