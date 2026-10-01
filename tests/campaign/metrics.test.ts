import { describe, expect, it } from 'vitest';

import {
  addConfusionMatrices,
  computeBootstrapIntervals,
  computeCalibrationStatistics,
  computeCampaignMetrics,
  computeEpisodeMetrics,
  emptyConfusionMatrix,
  summarizeDistribution,
} from '../../src/campaign/metrics';
import type { CampaignCaseResult, CampaignSpec, ConfusionMatrix } from '../../src/campaign/types';

describe('campaign metrics', () => {
  describe('emptyConfusionMatrix', () => {
    it('returns a confusion matrix initialized with zeros', () => {
      const matrix = emptyConfusionMatrix();
      expect(matrix).toEqual({
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 0,
        falseNegatives: 0,
      });
    });
  });

  describe('addConfusionMatrices', () => {
    it('adds elements of two confusion matrices element-wise', () => {
      const left: ConfusionMatrix = {
        truePositives: 1,
        falsePositives: 2,
        trueNegatives: 3,
        falseNegatives: 4,
      };
      const right: ConfusionMatrix = {
        truePositives: 10,
        falsePositives: 20,
        trueNegatives: 30,
        falseNegatives: 40,
      };

      const result = addConfusionMatrices(left, right);
      expect(result).toEqual({
        truePositives: 11,
        falsePositives: 22,
        trueNegatives: 33,
        falseNegatives: 44,
      });
    });
  });

  describe('computeEpisodeMetrics', () => {
    it('computes precision, recall, and f1 correctly for standard non-zero values', () => {
      const confusion: ConfusionMatrix = {
        truePositives: 6,
        falsePositives: 2,
        trueNegatives: 10,
        falseNegatives: 2,
      };
      // precision = 6 / (6 + 2) = 0.75
      // recall = 6 / (6 + 2) = 0.75
      // f1 = 2 * 0.75 * 0.75 / 1.5 = 0.75
      const metrics = computeEpisodeMetrics(confusion);
      expect(metrics.precision).toBe(0.75);
      expect(metrics.recall).toBe(0.75);
      expect(metrics.f1).toBe(0.75);
    });

    it('returns null for precision and/or recall when denominators are zero', () => {
      const zeroPositives: ConfusionMatrix = {
        truePositives: 0,
        falsePositives: 0,
        trueNegatives: 5,
        falseNegatives: 0,
      };
      const metrics = computeEpisodeMetrics(zeroPositives);
      expect(metrics.precision).toBeNull();
      expect(metrics.recall).toBeNull();
      expect(metrics.f1).toBeNull();
    });

    it('returns f1 = 0 when both precision and recall are explicitly 0', () => {
      const zeroPrecisionAndRecall: ConfusionMatrix = {
        truePositives: 0,
        falsePositives: 5,
        trueNegatives: 5,
        falseNegatives: 5,
      };
      // precision = 0 / 5 = 0
      // recall = 0 / 5 = 0
      const metrics = computeEpisodeMetrics(zeroPrecisionAndRecall);
      expect(metrics.precision).toBe(0);
      expect(metrics.recall).toBe(0);
      expect(metrics.f1).toBe(0);
    });

    it('returns f1 = null when one metric is 0 and the other is null', () => {
      const zeroPrecisionNullRecall: ConfusionMatrix = {
        truePositives: 0,
        falsePositives: 5,
        trueNegatives: 5,
        falseNegatives: 0,
      };
      // precision = 0 / 5 = 0
      // recall = 0 / 0 = null
      const metrics = computeEpisodeMetrics(zeroPrecisionNullRecall);
      expect(metrics.precision).toBe(0);
      expect(metrics.recall).toBeNull();
      expect(metrics.f1).toBeNull();
    });
  });

  describe('summarizeDistribution', () => {
    it('returns nulls and 0 count for empty array', () => {
      expect(summarizeDistribution([])).toEqual({
        count: 0,
        minimum: null,
        maximum: null,
        mean: null,
        median: null,
        p95: null,
      });
    });

    it('filters out non-finite values (NaN, Infinity, -Infinity)', () => {
      const input = [10, NaN, Infinity, -Infinity, 20];
      const summary = summarizeDistribution(input);
      expect(summary.count).toBe(2);
      expect(summary.minimum).toBe(10);
      expect(summary.maximum).toBe(20);
      expect(summary.mean).toBe(15);
      expect(summary.median).toBe(15);
    });

    it('computes summary for single element', () => {
      const summary = summarizeDistribution([42]);
      expect(summary).toEqual({
        count: 1,
        minimum: 42,
        maximum: 42,
        mean: 42,
        median: 42,
        p95: 42,
      });
    });

    it('computes median and statistics correctly for odd number of elements', () => {
      const summary = summarizeDistribution([30, 10, 20]);
      expect(summary.count).toBe(3);
      expect(summary.minimum).toBe(10);
      expect(summary.maximum).toBe(30);
      expect(summary.mean).toBe(20);
      expect(summary.median).toBe(20);
    });

    it('computes median and statistics correctly for even number of elements', () => {
      const summary = summarizeDistribution([40, 10, 30, 20]);
      expect(summary.count).toBe(4);
      expect(summary.minimum).toBe(10);
      expect(summary.maximum).toBe(40);
      expect(summary.mean).toBe(25);
      expect(summary.median).toBe(25);
    });
  });

  describe('computeCalibrationStatistics', () => {
    it('returns empty calibration stats when no cases or observations exist', () => {
      const stats = computeCalibrationStatistics([]);
      expect(stats).toEqual({
        observations: 0,
        answered: 0,
        abstained: 0,
        abstentionRate: null,
        meanConfidence: null,
        meanConfidenceCorrect: null,
        meanConfidenceIncorrect: null,
        brierScore: null,
        expectedCalibrationError: null,
      });
    });

    it('ignores non-completed cases', () => {
      const failedCase: CampaignCaseResult = {
        caseId: 'case-1',
        caseIndex: 0,
        profile: { profileId: 'p1', profileVersion: '1' },
        scenarioId: 's1',
        phase: 'p1',
        seed: 1,
        status: 'failed',
        syntheticDurationMs: 1000,
        expectedDetections: [],
        negativeRuleIds: [],
        detections: [],
        matchedDetections: [],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [{ confidence: 0.9, correct: true, abstained: false }],
        confusion: emptyConfusionMatrix(),
      };

      const stats = computeCalibrationStatistics([failedCase]);
      expect(stats.observations).toBe(0);
    });

    it('computes abstention, confidence averages, Brier score, and ECE for completed cases', () => {
      const completedCase: CampaignCaseResult = {
        caseId: 'case-1',
        caseIndex: 0,
        profile: { profileId: 'p1', profileVersion: '1' },
        scenarioId: 's1',
        phase: 'p1',
        seed: 1,
        status: 'completed',
        syntheticDurationMs: 1000,
        expectedDetections: [],
        negativeRuleIds: [],
        detections: [],
        matchedDetections: [],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [
          { confidence: 0.9, correct: true, abstained: false },
          { confidence: 0.8, correct: false, abstained: false },
          { confidence: 0.5, correct: true, abstained: true },
        ],
        confusion: emptyConfusionMatrix(),
      };

      const stats = computeCalibrationStatistics([completedCase]);
      expect(stats.observations).toBe(3);
      expect(stats.answered).toBe(2);
      expect(stats.abstained).toBe(1);
      expect(stats.abstentionRate).toBeCloseTo(1 / 3);
      expect(stats.meanConfidence).toBeCloseTo(0.85);
      expect(stats.meanConfidenceCorrect).toBeCloseTo(0.9);
      expect(stats.meanConfidenceIncorrect).toBeCloseTo(0.8);
      // Brier score: ((0.9-1)^2 + (0.8-0)^2) / 2 = (0.01 + 0.64) / 2 = 0.325
      expect(stats.brierScore).toBeCloseTo(0.325);
      expect(stats.expectedCalibrationError).not.toBeNull();
    });

    it('handles bin 9 edge case (confidence = 1.0)', () => {
      const caseWithPerfectConfidence: CampaignCaseResult = {
        caseId: 'case-1',
        caseIndex: 0,
        profile: { profileId: 'p1', profileVersion: '1' },
        scenarioId: 's1',
        phase: 'p1',
        seed: 1,
        status: 'completed',
        syntheticDurationMs: 1000,
        expectedDetections: [],
        negativeRuleIds: [],
        detections: [],
        matchedDetections: [],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [{ confidence: 1.0, correct: true, abstained: false }],
        confusion: emptyConfusionMatrix(),
      };

      const stats = computeCalibrationStatistics([caseWithPerfectConfidence]);
      expect(stats.answered).toBe(1);
      expect(stats.expectedCalibrationError).toBe(0);
    });
  });

  describe('computeBootstrapIntervals', () => {
    const specBootstrap = { iterations: 20, confidenceLevel: 0.95, seed: 12345 };

    it('returns null estimates and bounds when no completed cases exist', () => {
      const result = computeBootstrapIntervals([], specBootstrap);
      expect(result.precision.estimate).toBeNull();
      expect(result.precision.lower).toBeNull();
      expect(result.precision.upper).toBeNull();
      expect(result.recall.estimate).toBeNull();
      expect(result.f1.estimate).toBeNull();
    });

    it('computes deterministic confidence intervals for completed cases', () => {
      const case1: CampaignCaseResult = {
        caseId: 'case-1',
        caseIndex: 0,
        profile: { profileId: 'p1', profileVersion: '1' },
        scenarioId: 's1',
        phase: 'p1',
        seed: 1,
        status: 'completed',
        syntheticDurationMs: 1000,
        expectedDetections: [],
        negativeRuleIds: [],
        detections: [],
        matchedDetections: [],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [],
        confusion: { truePositives: 5, falsePositives: 1, trueNegatives: 10, falseNegatives: 1 },
      };

      const case2: CampaignCaseResult = {
        caseId: 'case-2',
        caseIndex: 1,
        profile: { profileId: 'p1', profileVersion: '1' },
        scenarioId: 's1',
        phase: 'p1',
        seed: 2,
        status: 'completed',
        syntheticDurationMs: 1000,
        expectedDetections: [],
        negativeRuleIds: [],
        detections: [],
        matchedDetections: [],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [],
        confusion: { truePositives: 8, falsePositives: 2, trueNegatives: 10, falseNegatives: 0 },
      };

      const res1 = computeBootstrapIntervals([case1, case2], specBootstrap);
      const res2 = computeBootstrapIntervals([case1, case2], specBootstrap);

      expect(res1).toEqual(res2);
      expect(res1.precision.estimate).not.toBeNull();
      expect(res1.recall.estimate).not.toBeNull();
      expect(res1.f1.estimate).not.toBeNull();
      expect(res1.precision.confidenceLevel).toBe(0.95);
      expect(res1.precision.iterations).toBe(20);
    });
  });

  describe('computeCampaignMetrics', () => {
    const spec: CampaignSpec = {
      schemaVersion: 'campaign.v1',
      campaignId: 'camp-1',
      createdAt: '2026-01-01T00:00:00Z',
      profiles: [{ profileId: 'p1', profileVersion: '1.0' }],
      scenarios: [
        {
          scenarioId: 's1',
          label: 'Scenario 1',
          phase: 'phase-a',
          expectedDetections: [{ ruleId: 'r1', episodeStartMs: 0 }],
          negativeRuleIds: [],
          syntheticDurationMs: 3600000,
        },
      ],
      seeds: [100],
      bootstrap: { iterations: 10, confidenceLevel: 0.9, seed: 42 },
      metadata: {
        synthetic: true,
        dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      },
    };

    it('computes metrics with zero cases completed', () => {
      const metrics = computeCampaignMetrics(spec, []);
      expect(metrics.confusion).toEqual(emptyConfusionMatrix());
      expect(metrics.falseAlarmsPerRun).toBeNull();
      expect(metrics.falseAlarmsPerSyntheticHour).toBeNull();
      expect(metrics.syntheticHours).toBe(0);
      expect(metrics.scenarioCoverage[0]).toMatchObject({
        scenarioId: 's1',
        plannedCases: 1,
        completedCases: 0,
        coverage: null,
      });
    });

    it('computes full metrics for completed cases', () => {
      const caseResult: CampaignCaseResult = {
        caseId: 'c-1',
        caseIndex: 0,
        profile: { profileId: 'p1', profileVersion: '1.0' },
        scenarioId: 's1',
        phase: 'phase-a',
        seed: 100,
        status: 'completed',
        syntheticDurationMs: 3600000,
        expectedDetections: [{ ruleId: 'r1', episodeStartMs: 0 }],
        negativeRuleIds: [],
        detections: [{ ruleId: 'r1', detectedAtMs: 150 }],
        matchedDetections: [
          {
            expected: { ruleId: 'r1', episodeStartMs: 0 },
            detection: { ruleId: 'r1', detectedAtMs: 150 },
            timeToDetectionMs: 150,
          },
        ],
        missingDetections: [],
        unexpectedDetections: [],
        calibration: [],
        confusion: { truePositives: 1, falsePositives: 2, trueNegatives: 5, falseNegatives: 0 },
      };

      const metrics = computeCampaignMetrics(spec, [caseResult]);
      expect(metrics.confusion).toEqual({
        truePositives: 1,
        falsePositives: 2,
        trueNegatives: 5,
        falseNegatives: 0,
      });
      expect(metrics.syntheticHours).toBe(1);
      expect(metrics.falseAlarmsPerRun).toBe(2);
      expect(metrics.falseAlarmsPerSyntheticHour).toBe(2);
      expect(metrics.timeToDetection.mean).toBe(150);
      expect(metrics.confusionByProfile).toHaveLength(1);
      expect(metrics.confusionByProfile[0]?.groupId).toBe('p1@1.0');
      expect(metrics.confusionByPhase[0]?.groupId).toBe('phase-a');
      expect(metrics.confusionByFault[0]?.groupId).toBe('s1');
      expect(metrics.scenarioCoverage[0]).toEqual({
        scenarioId: 's1',
        plannedCases: 1,
        completedCases: 1,
        casesWithAllExpected: 1,
        expectedEpisodes: 1,
        detectedExpectedEpisodes: 1,
        coverage: 1,
      });
    });
  });
});
