import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import { projectInvestigationScenario } from '../../src/investigation/modelProjection';
import { extractTemporalFeatures } from '../../src/ml/temporalModel';
import { generateTemporalScenario } from '../../src/temporal/generator';
import { loadModelContext, PROTOCOL } from '../mission-evaluation/protocol';

const { artifact } = await loadModelContext();
const phaseCounts: Record<string, { windows: number; alerts: number; abstained: number }> = {};
const labels: Record<string, number> = {};
const contributions: Record<string, number> = {};
const distances: number[] = [];
const examples = [];
for (const seed of PROTOCOL.developmentSeeds) {
  const scenario = generateTemporalScenario({
    seed,
    scenarioId: 'nominal',
    sampleCount: 180,
    cadenceMs: 1000,
  });
  const analysis = analyzeTemporalScenario(scenario, { modelEnabled: true });
  const samples = projectInvestigationScenario(scenario).map((p) => p.modelSample);
  for (const point of analysis.points) {
    const score = point.model.score;
    if (!score) continue;
    const index = point.sampleIndex;
    const phase = scenario.samples[index]!.phaseTruth;
    const counts = (phaseCounts[phase] ??= { windows: 0, alerts: 0, abstained: 0 });
    counts.windows++;
    if (score.abstained) counts.abstained++;
    distances.push(score.anomalyDistance!);
    if (!score.anomalous) continue;
    counts.alerts++;
    labels[score.predictedLabel] = (labels[score.predictedLabel] ?? 0) + 1;
    const features = extractTemporalFeatures(samples.slice(index - 39, index + 1));
    const z = features.values.map(
      (value, i) => (value - artifact.featureCenter[i]!) / artifact.featureScale[i]!,
    );
    const squared = artifact.nominalPrototypes!.map((p) =>
      z.map((value, i) => (value - p[i]!) ** 2),
    );
    const sums = squared.map((p) => p.reduce((a, b) => a + b, 0));
    const nearest = squared[sums.indexOf(Math.min(...sums))]!;
    nearest.forEach((value, i) => {
      contributions[features.names[i]!] =
        (contributions[features.names[i]!] ?? 0) + value / z.length;
    });
    if (seed === PROTOCOL.developmentSeeds[0])
      examples.push({
        index,
        phase,
        label: score.predictedLabel,
        anomalyDistance: score.anomalyDistance,
      });
  }
}
distances.sort((a, b) => a - b);
const diagnosis = {
  schemaVersion: 'nominal-diagnosis.v1',
  seeds: PROTOCOL.developmentSeeds,
  threshold: artifact.anomalyDistanceThreshold,
  nominalPrototypeCount: artifact.nominalPrototypes!.length,
  nominalTrainingWindows: (artifact.training.seeds as number[]).length,
  nominalCalibrationWindows: (artifact.calibration as { seeds: number[] }).seeds.length,
  phaseCounts,
  labels,
  distanceQuantiles: {
    p50: distances[Math.floor(distances.length * 0.5)],
    p95: distances[Math.floor(distances.length * 0.95)],
    max: distances.at(-1),
  },
  topAlertDistanceContributions: Object.entries(contributions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10),
  examples,
};
const output = resolve(process.argv[2] ?? 'reports/nominal-correction/diagnosis.json');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(diagnosis, null, 2) + '\n');
console.log(JSON.stringify(diagnosis));
