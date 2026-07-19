import {
  TEMPORAL_DATA_CLASSIFICATION,
  type MissionPhase,
  type PhaseConditionEvidence,
  type PhaseEvaluation,
  type PhaseObservation,
  type PhaseTransitionEvidence,
} from './types';

type Metric = PhaseConditionEvidence['metric'];
type Comparator = PhaseConditionEvidence['comparator'];

interface Condition {
  metric: Metric;
  comparator: Comparator;
  threshold: number;
}

interface TransitionRule {
  from: MissionPhase;
  to: MissionPhase;
  enter: readonly Condition[];
  maintain: readonly Condition[];
}

export interface MissionPhaseDetectorConfig {
  confirmationSamples: number;
  initialPhase: MissionPhase;
}

const DEFAULT_CONFIG: MissionPhaseDetectorConfig = {
  confirmationSamples: 2,
  initialPhase: 'ground',
};

const TRANSITION_RULES: Record<MissionPhase, TransitionRule> = {
  ground: {
    from: 'ground',
    to: 'takeoff',
    enter: [
      { metric: 'speed', comparator: '>=', threshold: 60 },
      { metric: 'verticalRate', comparator: '>=', threshold: 250 },
    ],
    maintain: [
      { metric: 'speed', comparator: '>=', threshold: 50 },
      { metric: 'verticalRate', comparator: '>=', threshold: 150 },
    ],
  },
  takeoff: {
    from: 'takeoff',
    to: 'climb',
    enter: [
      { metric: 'altitude', comparator: '>=', threshold: 500 },
      { metric: 'verticalRate', comparator: '>=', threshold: 350 },
    ],
    maintain: [
      { metric: 'altitude', comparator: '>=', threshold: 400 },
      { metric: 'verticalRate', comparator: '>=', threshold: 250 },
    ],
  },
  climb: {
    from: 'climb',
    to: 'cruise',
    enter: [
      { metric: 'altitude', comparator: '>=', threshold: 4_000 },
      { metric: 'speed', comparator: '>=', threshold: 130 },
      { metric: 'absoluteVerticalRate', comparator: '<=', threshold: 180 },
    ],
    maintain: [
      { metric: 'altitude', comparator: '>=', threshold: 3_800 },
      { metric: 'speed', comparator: '>=', threshold: 120 },
      { metric: 'absoluteVerticalRate', comparator: '<=', threshold: 250 },
    ],
  },
  cruise: {
    from: 'cruise',
    to: 'descent',
    enter: [{ metric: 'verticalRate', comparator: '<=', threshold: -300 }],
    maintain: [{ metric: 'verticalRate', comparator: '<=', threshold: -200 }],
  },
  descent: {
    from: 'descent',
    to: 'landing',
    enter: [
      { metric: 'altitude', comparator: '<=', threshold: 800 },
      { metric: 'speed', comparator: '<=', threshold: 120 },
    ],
    maintain: [
      { metric: 'altitude', comparator: '<=', threshold: 1_000 },
      { metric: 'speed', comparator: '<=', threshold: 135 },
    ],
  },
  landing: {
    from: 'landing',
    to: 'ground',
    enter: [
      { metric: 'altitude', comparator: '<=', threshold: 40 },
      { metric: 'speed', comparator: '<=', threshold: 30 },
      { metric: 'absoluteVerticalRate', comparator: '<=', threshold: 100 },
    ],
    maintain: [
      { metric: 'altitude', comparator: '<=', threshold: 60 },
      { metric: 'speed', comparator: '<=', threshold: 40 },
      { metric: 'absoluteVerticalRate', comparator: '<=', threshold: 150 },
    ],
  },
};

function metricValue(observation: PhaseObservation, metric: Metric): number {
  if (metric === 'absoluteVerticalRate') return Math.abs(observation.verticalRate);
  return observation[metric];
}

function evaluateConditions(
  observation: PhaseObservation,
  conditions: readonly Condition[],
): PhaseConditionEvidence[] {
  return conditions.map((condition) => {
    const observedValue = metricValue(observation, condition.metric);
    return {
      ...condition,
      observedValue,
      satisfied:
        condition.comparator === '>='
          ? observedValue >= condition.threshold
          : observedValue <= condition.threshold,
    };
  });
}

function allSatisfied(evidence: readonly PhaseConditionEvidence[]): boolean {
  return evidence.every((condition) => condition.satisfied);
}

function describe(conditions: readonly Condition[]): string {
  return conditions
    .map((condition) => `${condition.metric} ${condition.comparator} ${condition.threshold}`)
    .join(' and ');
}

function requireFiniteObservation(observation: PhaseObservation): void {
  const values = [
    observation.sampleIndex,
    observation.timestampMs,
    observation.speed,
    observation.altitude,
    observation.verticalRate,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error('Mission phase observations must contain only finite numeric values.');
  }
}

/**
 * Deterministic forward-only mission phase state machine.
 *
 * Entry thresholds start a transition candidate. Wider maintain thresholds keep
 * the candidate alive while it is confirmed, which prevents boundary noise from
 * repeatedly resetting or advancing the phase.
 */
export class MissionPhaseDetector {
  readonly config: MissionPhaseDetectorConfig;
  readonly transitions: PhaseTransitionEvidence[] = [];
  private currentPhase: MissionPhase;
  private candidatePhase: MissionPhase | null = null;
  private candidateCount = 0;

  constructor(config: Partial<MissionPhaseDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!Number.isInteger(this.config.confirmationSamples) || this.config.confirmationSamples < 1) {
      throw new Error('confirmationSamples must be a positive integer.');
    }
    this.currentPhase = this.config.initialPhase;
  }

  get phase(): MissionPhase {
    return this.currentPhase;
  }

  update(observation: PhaseObservation): PhaseEvaluation {
    requireFiniteObservation(observation);
    const rule = TRANSITION_RULES[this.currentPhase];
    const enterEvidence = evaluateConditions(observation, rule.enter);
    const maintainEvidence = evaluateConditions(observation, rule.maintain);
    const beginsCandidate = this.candidatePhase === null && allSatisfied(enterEvidence);
    const maintainsCandidate = this.candidatePhase === rule.to && allSatisfied(maintainEvidence);

    if (beginsCandidate) {
      this.candidatePhase = rule.to;
      this.candidateCount = 1;
    } else if (maintainsCandidate) {
      this.candidateCount += 1;
    } else {
      this.candidatePhase = null;
      this.candidateCount = 0;
    }

    if (this.candidatePhase === rule.to && this.candidateCount >= this.config.confirmationSamples) {
      const evidence: PhaseTransitionEvidence = {
        evidenceVersion: 'phase-transition.v1',
        ruleId: 'temporal.phase.transition',
        from: rule.from,
        to: rule.to,
        sampleIndex: observation.sampleIndex,
        timestampMs: observation.timestampMs,
        confirmationSamples: this.candidateCount,
        observed: {
          speed: observation.speed,
          altitude: observation.altitude,
          verticalRate: observation.verticalRate,
        },
        expectedCondition: describe(rule.enter),
        hysteresisCondition: describe(rule.maintain),
        conditionEvidence: maintainEvidence,
        synthetic: true,
        dataClassification: TEMPORAL_DATA_CLASSIFICATION,
      };
      this.currentPhase = rule.to;
      this.candidatePhase = null;
      this.candidateCount = 0;
      this.transitions.push(evidence);
      return {
        phase: this.currentPhase,
        candidatePhase: null,
        candidateCount: 0,
        transitioned: true,
        transitionEvidence: evidence,
      };
    }

    return {
      phase: this.currentPhase,
      candidatePhase: this.candidatePhase,
      candidateCount: this.candidateCount,
      transitioned: false,
    };
  }
}
