import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateMissions,
  evaluateMission,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import {
  casesForSeeds,
  hashObject,
  loadModelContext,
  REPOSITORY_ROOT,
  sha256,
} from '../mission-evaluation/protocol';
import { exists, readJson, writeJson } from '../mission-evaluation/run';
import { seal, verify } from '../nominal-correction/run';
import { validateArtifact, verifyParity, type Artifact } from '../full-mission-model/model';
import { identity as modelIdentity, PROTOCOL as TRAINING } from '../full-mission-model/protocol';
import {
  addControl,
  comparison,
  inferCase,
  type Comparison,
  type RecordResult,
  type Report,
  type Setting,
} from '../full-mission-model/run';
import { writeReport, writeReplay } from '../full-mission-model/report';

export const PROTOCOL = {
  schemaVersion: 'full-mission-refinement-protocol.v1',
  reason:
    'Development-guided refinement after the original calibration grid selected forest-1 with 19/40 nominal alarms. Final seeds remained unopened. Trained weights and acceptance limits are unchanged.',
  thresholds: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975],
  streaks: [1, 2, 3, 5],
  retainedIncumbentThreshold: 0.6322699583395381,
  developmentSeeds: TRAINING.developmentSeeds,
  finalSeeds: TRAINING.finalSeeds,
  batchSeeds: 5,
  selection:
    'Passing original ordinary and fault-specific gates first; lowest nominal mission false-alarm rate, shorter streak, higher specific recall, higher ordinary recall, lower threshold. No final-data tuning.',
  alerts:
    'Strict score > threshold for k consecutive available anomalous windows; clear or unknown resets; start at kth sample with no backdating.',
} as const;
export interface Policy extends Setting {
  streak: number;
}
export const policies = (): Policy[] => [
  ...PROTOCOL.thresholds.flatMap((threshold) =>
    PROTOCOL.streaks.map((streak) => ({
      id: `forest-t${threshold}-k${streak}`,
      modelId: 'forest',
      threshold,
      streak,
    })),
  ),
  {
    id: 'forest-incumbent-k1',
    modelId: 'forest',
    threshold: PROTOCOL.retainedIncumbentThreshold,
    streak: 1,
  },
];

export function applyPolicy(
  points: readonly PredictionPoint[],
  scores: readonly number[],
  policy: Policy,
): PredictionPoint[] {
  if (
    points.length !== 180 ||
    scores.length !== 141 ||
    scores.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
    !Number.isInteger(policy.streak) ||
    policy.streak < 1 ||
    !Number.isFinite(policy.threshold) ||
    policy.threshold < 0 ||
    policy.threshold > 1
  )
    throw new Error('Invalid policy input.');
  let streak = 0;
  return points.map((point, i) => {
    // The trained model answers every post-warmup endpoint. Baseline abstention is not its state.
    const state = i < 39 ? 'warmup' : scores[i - 39]! > policy.threshold ? 'anomalous' : 'nominal';
    streak = state === 'anomalous' ? streak + 1 : 0;
    return {
      ...point,
      modelState: state === 'anomalous' && streak < policy.streak ? 'nominal' : state,
    };
  });
}
export function select(comparisons: readonly Comparison[]) {
  if (!comparisons.length) throw new Error('No candidates.');
  const passing = comparisons.filter((c) => c.passed);
  return [...(passing.length ? passing : comparisons)].sort(
    (a, b) =>
      (a.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) -
        (b.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) ||
      (a.setting as Policy).streak - (b.setting as Policy).streak ||
      (b.specific.candidate.recall ?? -1) - (a.specific.candidate.recall ?? -1) ||
      (b.ordinary.candidate.activeRecall ?? -1) - (a.ordinary.candidate.activeRecall ?? -1) ||
      a.setting.threshold - b.setting.threshold,
  )[0]!;
}
async function identity() {
  const base = await modelIdentity(),
    files: Record<string, string> = {};
  for (const name of (
    await readdir(resolve(REPOSITORY_ROOT, 'tools/full-mission-refinement'))
  ).sort())
    if (name.endsWith('.ts'))
      files[name] = sha256(
        await readFile(resolve(REPOSITORY_ROOT, 'tools/full-mission-refinement', name)),
      );
  return { baseSourceSha256: base.sha256, files, sha256: hashObject({ base: base.sha256, files }) };
}
export function infer(
  spec: Parameters<typeof inferCase>[0],
  context: Awaited<ReturnType<typeof loadModelContext>>,
  artifact: Artifact,
  choices: readonly Policy[],
) {
  const result = inferCase(spec, context, artifact, [
    { id: 'raw', modelId: 'forest', threshold: 0.5 },
  ]);
  result.predictions = {};
  result.record.candidates = {};
  result.record.candidatePredictionSha256 = {};
  for (const policy of choices) {
    const predictions = applyPolicy(result.baselinePredictions, result.scores.forest!, policy);
    result.predictions[policy.id] = predictions;
    result.record.candidatePredictionSha256[policy.id] = hashObject(predictions);
    result.record.candidates[policy.id] = evaluateMission(
      {
        caseId: spec.caseId,
        seed: spec.options.seed!,
        family: spec.family,
        variantId: spec.variantId,
        cadenceMs: 1000,
        faultTimeline: result.record.baseline.faultTimeline,
        predictions,
      },
      ['model-k1'],
    );
  }
  return result;
}
type RefinementReport = Omit<Report, 'schemaVersion' | 'settings'> & {
  schemaVersion: 'full-mission-refinement-report.v1';
  settings: Policy[];
};
interface Batch {
  manifestSha256: string;
  records: RecordResult[];
  contentSha256: string;
}
interface Freeze {
  setting: Policy;
  developmentReportSha256: string;
  sourceSha256: string;
  modelSha256: string;
  protocolSha256: string;
  developmentPassed: boolean;
  frozenAt: string;
  contentSha256: string;
}
interface Manifest {
  schemaVersion: string;
  source: Awaited<ReturnType<typeof identity>>;
  protocol: typeof PROTOCOL;
  modelSha256: string;
  trainingManifestSha256: string;
  initialSelectionSha256: string;
  contentSha256: string;
}
async function readRecords(output: string, report: RefinementReport) {
  const records: RecordResult[] = [];
  for (const reference of report.batches) {
    const batch = verify(await readJson<Batch>(resolve(output, report.stage, reference.file)));
    if (batch.contentSha256 !== reference.sha256) throw new Error('Batch checksum mismatch.');
    records.push(...batch.records);
  }
  if (
    records.length !== report.missions ||
    hashObject(records) !== report.recordsSha256 ||
    hashObject(records.map((r) => r.spec)) !==
      hashObject(
        casesForSeeds(PROTOCOL[report.stage === 'final' ? 'finalSeeds' : 'developmentSeeds']),
      )
  )
    throw new Error('Incomplete records.');
  return records;
}
async function annotate(path: string, policy: Policy) {
  const html = await readFile(path, 'utf8');
  await writeFile(
    path,
    html
      .replace(
        '<main>',
        `<main><section><h2>Development-guided refinement</h2><p>Frozen forest weights, threshold ${policy.threshold}, ${policy.streak} consecutive anomalous windows. Alert starts at confirmation, without backdating. The original threshold-only development experiment is preserved. The bounded 48-policy refinement used development seeds only; final seeds were held back until this configuration was frozen.</p></section>`,
      )
      .replace(
        'All preregistered conventional and fault-specific gates pass.',
        'All conventional and fault-specific limits fixed before final evaluation pass.',
      )
      .replace(
        'Development selects the model and threshold before final seeds are accessed.',
        'The initial development run selected the forest; a recorded development-only grid then selected threshold and persistence before final seeds were accessed.',
      ),
  );
}

export async function run(
  stage: 'development' | 'final' | 'replay',
  output: string,
  parent: string,
  caseId?: string,
) {
  if (stage === 'development' && (await exists(resolve(parent, 'final/manifest.json'))))
    throw new Error('Development cannot resume after parent final access.');
  const source = await identity(),
    bytes = await readFile(resolve(parent, 'model.json')),
    modelSha256 = sha256(bytes),
    artifact = JSON.parse(bytes.toString('utf8')) as Artifact;
  validateArtifact(artifact, source.baseSourceSha256);
  verifyParity(artifact);
  const training = verify(
    await readJson<{ source: { sha256: string }; contentSha256: string }>(
      resolve(parent, 'manifest.json'),
    ),
  );
  const initial = verify(
    await readJson<{ contentSha256: string; modelSha256: string; setting: Setting }>(
      resolve(parent, 'selection.json'),
    ),
  );
  if (training.source.sha256 !== source.baseSourceSha256)
    throw new Error('Training source mismatch.');
  if (
    initial.modelSha256 !== modelSha256 ||
    initial.setting.modelId !== 'forest' ||
    initial.setting.threshold !== PROTOCOL.retainedIncumbentThreshold
  )
    throw new Error('Original development selection mismatch.');
  await mkdir(output, { recursive: true });
  const manifestPath = resolve(output, 'manifest.json');
  if (!(await exists(manifestPath))) {
    if (stage !== 'development' || (await exists(resolve(parent, 'final/manifest.json'))))
      throw new Error('Refinement requires development before final access.');
    await writeJson(
      manifestPath,
      seal({
        schemaVersion: 'full-mission-refinement-manifest.v1',
        source,
        protocol: PROTOCOL,
        modelSha256,
        trainingManifestSha256: training.contentSha256,
        initialSelectionSha256: initial.contentSha256,
        createdAt: new Date().toISOString(),
      }),
    );
    await copyFile(resolve(parent, 'model.json'), resolve(output, 'model.json'));
  }
  const manifest = verify(await readJson<Manifest>(manifestPath));
  if (
    manifest.source.sha256 !== source.sha256 ||
    manifest.modelSha256 !== modelSha256 ||
    manifest.trainingManifestSha256 !== training.contentSha256 ||
    manifest.initialSelectionSha256 !== initial.contentSha256 ||
    hashObject(manifest.protocol) !== hashObject(PROTOCOL) ||
    sha256(await readFile(resolve(output, 'model.json'))) !== modelSha256
  )
    throw new Error('Frozen source/model/protocol mismatch.');
  const context = await loadModelContext();
  if (stage === 'replay') {
    const report = verify(await readJson<RefinementReport>(resolve(output, 'final/report.json')));
    if (report.modelSha256 !== modelSha256 || report.sourceSha256 !== source.sha256)
      throw new Error('Replay provenance mismatch.');
    const records = await readRecords(output, report),
      original = records.find((r) => r.spec.caseId === caseId);
    if (!original) throw new Error('Unknown replay case.');
    const result = infer(original.spec, context, artifact, report.settings),
      control = infer(
        casesForSeeds([original.baseline.seed])[0]!,
        context,
        artifact,
        report.settings,
      );
    addControl(result, control, report.settings);
    if (hashObject(result.record) !== hashObject(original))
      throw new Error('Replay differs from frozen evidence.');
    const replay = {
        exactMatch: true,
        reportSha256: report.contentSha256,
        setting: report.settings[0]!,
        result,
        control,
      },
      stem = caseId!.replaceAll(':', '-');
    await mkdir(resolve(output, 'replays'), { recursive: true });
    await writeJson(resolve(output, 'replays', `${stem}.json`), seal(replay));
    const path = resolve(output, 'replays', `${stem}.html`);
    await writeReplay(replay, path);
    await annotate(path, report.settings[0]!);
    console.log(`Exact model/control replay: ${caseId}`);
    return;
  }
  if (
    stage === 'development' &&
    ((await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final/manifest.json'))))
  )
    throw new Error('Development is frozen.');
  const frozen =
    stage === 'final' ? verify(await readJson<Freeze>(resolve(output, 'selection.json'))) : null;
  if (frozen) {
    const development = verify(
      await readJson<RefinementReport>(resolve(output, 'development/report.json')),
    );
    if (
      frozen.sourceSha256 !== source.sha256 ||
      frozen.modelSha256 !== modelSha256 ||
      frozen.protocolSha256 !== hashObject(PROTOCOL) ||
      frozen.developmentReportSha256 !== development.contentSha256 ||
      !policies().some((p) => hashObject(p) === hashObject(frozen.setting))
    )
      throw new Error('Frozen selection mismatch.');
  }
  const choices = frozen ? [frozen.setting] : policies(),
    seeds = stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds,
    directory = resolve(output, stage);
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const stageManifest = seal({
    stage,
    seeds,
    choices,
    parentSha256: manifest.contentSha256,
    modelSha256,
    selectionSha256: frozen?.contentSha256 ?? null,
  });
  if (await exists(resolve(directory, 'manifest.json'))) {
    if (
      hashObject(await readJson(resolve(directory, 'manifest.json'))) !== hashObject(stageManifest)
    )
      throw new Error('Stage manifest mismatch.');
  } else await writeJson(resolve(directory, 'manifest.json'), stageManifest);
  const records: RecordResult[] = [],
    batches: { file: string; sha256: string }[] = [];
  try {
    for (let i = 0; i < seeds.length; i += PROTOCOL.batchSeeds) {
      const subset = seeds.slice(i, i + PROTOCOL.batchSeeds),
        file = `batches/${i / PROTOCOL.batchSeeds}.json`,
        path = resolve(directory, file);
      let batch: Batch;
      if (await exists(path)) {
        batch = verify(await readJson<Batch>(path));
        if (
          batch.manifestSha256 !== stageManifest.contentSha256 ||
          hashObject(batch.records.map((r) => r.spec)) !== hashObject(casesForSeeds(subset))
        )
          throw new Error('Batch provenance mismatch.');
      } else {
        const results: RecordResult[] = [];
        for (const seed of subset) {
          const specs = casesForSeeds([seed]),
            control = infer(specs[0]!, context, artifact, choices);
          results.push(control.record);
          for (const spec of specs.slice(1)) {
            const result = infer(spec, context, artifact, choices);
            addControl(result, control, choices);
            results.push(result.record);
          }
        }
        batch = seal({ manifestSha256: stageManifest.contentSha256, records: results });
        await writeJson(path, batch);
      }
      records.push(...batch.records);
      batches.push({ file, sha256: batch.contentSha256 });
      await writeJson(resolve(directory, 'status.json'), {
        status: 'running',
        completed: records.length,
        expected: seeds.length * 41,
      });
      console.log(`${stage}: ${records.length}/${seeds.length * 41}`);
    }
    if (hashObject(records.map((r) => r.spec)) !== hashObject(casesForSeeds(seeds)))
      throw new Error('Incomplete case matrix.');
    const comparisons = choices.map((c) => comparison(records, c));
    if (frozen && !frozen.developmentPassed)
      for (const c of comparisons) {
        c.passed = false;
        c.decision = 'rejected';
        c.reasons.push('Development failed; final cannot rescue it.');
      }
    const selected = select(comparisons),
      report: RefinementReport = seal({
        schemaVersion: 'full-mission-refinement-report.v1' as const,
        stage,
        status: 'completed' as const,
        sourceSha256: source.sha256,
        manifestSha256: manifest.contentSha256,
        modelSha256,
        selectionSha256: frozen?.contentSha256 ?? null,
        settings: choices,
        selectedId: frozen?.setting.id ?? selected.setting.id,
        comparisons,
        rules: aggregateMissions(
          records.map((r) => r.baseline),
          'deterministic',
        ),
        batches,
        recordsSha256: hashObject(records),
        missions: records.length,
      });
    if (
      (await identity()).sha256 !== source.sha256 ||
      sha256(await readFile(resolve(parent, 'model.json'))) !== modelSha256
    )
      throw new Error('Source/model changed during evaluation.');
    await writeJson(resolve(directory, 'report.json'), report);
    const htmlPath = resolve(directory, 'report.html');
    await writeReport(
      { ...report, schemaVersion: 'full-mission-trained-report.v1' },
      artifact,
      htmlPath,
    );
    await annotate(htmlPath, selected.setting as Policy);
    if (stage === 'development')
      await writeJson(
        resolve(output, 'selection.json'),
        seal({
          setting: selected.setting,
          developmentReportSha256: report.contentSha256,
          sourceSha256: source.sha256,
          modelSha256,
          protocolSha256: hashObject(PROTOCOL),
          developmentPassed: selected.passed,
          frozenAt: new Date().toISOString(),
        }),
      );
    await writeJson(resolve(directory, 'status.json'), {
      status: 'completed',
      completed: records.length,
      expected: seeds.length * 41,
      reportSha256: report.contentSha256,
    });
    console.log(
      JSON.stringify({
        selected: selected.setting,
        passed: selected.passed,
        reasons: selected.reasons,
        nominal: selected.ordinary.candidate.nominalFalseAlarmMissions,
        recall: selected.ordinary.candidate.activeRecall,
        specific: selected.specific.candidate.recall,
      }),
    );
  } catch (error) {
    await writeJson(resolve(directory, 'status.json'), {
      status: 'failed',
      completed: records.length,
      error: String(error),
    });
    throw error;
  }
}

export function parseArguments(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--stage', '--output', '--parent', '--case-id'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      key in values
    )
      throw new Error('Invalid CLI arguments.');
    values[key] = value;
  }
  const stage = values['--stage'];
  if (
    !stage ||
    !['development', 'final', 'replay'].includes(stage) ||
    (stage === 'replay') !== Boolean(values['--case-id'])
  )
    throw new Error('Invalid stage arguments.');
  return {
    stage: stage as 'development' | 'final' | 'replay',
    output: resolve(
      values['--output'] ?? resolve(REPOSITORY_ROOT, 'reports/full-mission-refinement-v1'),
    ),
    parent: resolve(
      values['--parent'] ?? resolve(REPOSITORY_ROOT, 'reports/full-mission-model-v1'),
    ),
    caseId: values['--case-id'],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  await run(args.stage, args.output, args.parent, args.caseId);
}
