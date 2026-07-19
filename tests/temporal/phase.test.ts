import { describe, expect, it } from 'vitest';

import { MissionPhaseDetector } from '../../src/temporal/phase';
import type { PhaseObservation } from '../../src/temporal/types';

let sampleIndex = 0;

function observation(speed: number, altitude: number, verticalRate: number): PhaseObservation {
  const current = sampleIndex;
  sampleIndex += 1;
  return {
    sampleIndex: current,
    timestampMs: Date.parse('2026-01-01T00:00:00.000Z') + current * 1_000,
    speed,
    altitude,
    verticalRate,
  };
}

describe('deterministic mission phase state machine', () => {
  it('uses separate entry and maintain thresholds as explicit hysteresis', () => {
    sampleIndex = 0;
    const detector = new MissionPhaseDetector({ confirmationSamples: 3 });

    expect(detector.update(observation(65, 0, 300))).toMatchObject({
      phase: 'ground',
      candidatePhase: 'takeoff',
      candidateCount: 1,
    });
    expect(detector.update(observation(55, 0, 200))).toMatchObject({
      phase: 'ground',
      candidatePhase: 'takeoff',
      candidateCount: 2,
    });
    expect(detector.update(observation(49, 0, 200))).toMatchObject({
      phase: 'ground',
      candidatePhase: null,
      candidateCount: 0,
    });
  });

  it('advances through every declared flight phase with transition evidence', () => {
    sampleIndex = 0;
    const detector = new MissionPhaseDetector({ confirmationSamples: 2 });
    const pairs: Array<readonly [PhaseObservation, PhaseObservation]> = [
      [observation(70, 0, 400), observation(55, 0, 200)],
      [observation(110, 600, 600), observation(100, 450, 300)],
      [observation(140, 5_000, 100), observation(125, 3_900, 220)],
      [observation(140, 5_000, -400), observation(138, 4_900, -250)],
      [observation(110, 700, -500), observation(130, 900, -300)],
      [observation(20, 20, 0), observation(35, 50, 120)],
    ];

    for (const [entry, maintain] of pairs) {
      expect(detector.update(entry).transitioned).toBe(false);
      const result = detector.update(maintain);
      expect(result.transitioned).toBe(true);
      expect(result.transitionEvidence?.conditionEvidence.every((entry) => entry.satisfied)).toBe(
        true,
      );
      expect(result.transitionEvidence).toMatchObject({
        ruleId: 'temporal.phase.transition',
        confirmationSamples: 2,
        synthetic: true,
        dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      });
      expect(result.transitionEvidence?.expectedCondition.length).toBeGreaterThan(0);
      expect(result.transitionEvidence?.hysteresisCondition.length).toBeGreaterThan(0);
    }

    expect(detector.transitions.map(({ from, to }) => `${from}:${to}`)).toEqual([
      'ground:takeoff',
      'takeoff:climb',
      'climb:cruise',
      'cruise:descent',
      'descent:landing',
      'landing:ground',
    ]);
    expect(detector.phase).toBe('ground');
  });

  it('rejects invalid configuration and nonfinite observations', () => {
    expect(() => new MissionPhaseDetector({ confirmationSamples: 0 })).toThrow('positive integer');
    const detector = new MissionPhaseDetector();
    expect(() => detector.update(observation(Number.NaN, 0, 0))).toThrow('finite numeric values');
  });
});
