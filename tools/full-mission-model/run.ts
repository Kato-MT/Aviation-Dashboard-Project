import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateMissions,
  evaluateMission,
  type MissionEvaluationResult,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { generateTemporalScenario } from '../../src/temporal/generator';
import {
  casesForSeeds,
  hashObject,
  loadModelContext,
  REPOSITORY_ROOT,
  runMission,
  sha256,
  type MissionCase,
} from '../mission-evaluation/protocol';
import { exists, readJson, writeJson } from '../mission-evaluation/run';
import { compareDetectors } from '../nominal-correction/compare';
import { seal, verify } from '../nominal-correction/run';
import { exportCorpus } from './corpus';
import { fullMissionFeatures } from './features';
import { scoreFeatures, validateArtifact, verifyParity, type Artifact } from './model';
import { identity, PROTOCOL } from './protocol';
import { compareSpecific, faultSpecific, type SpecificResult } from './specificity';
import { writeReport, writeReplay } from './report';

export interface Setting {
  id: string;
  modelId: string;
  threshold: number;
}
export interface RecordResult {
  spec: MissionCase;
  scenarioSha256: string;
  baselinePredictionSha256: string;
  candidatePredictionSha256: Record<string, string>;
  baseline: MissionEvaluationResult;
  candidates: Record<string, MissionEvaluationResult>;
  specific: Record<string, { baseline: SpecificResult; candidate: SpecificResult }>;
}
type Source = Awaited<ReturnType<typeof identity>>;
interface Manifest {
  schemaVersion: 'full-mission-training-manifest.v1';
  protocol: typeof PROTOCOL;
  source: Source;
  createdAt: string;
  contentSha256: string;
}
interface Freeze {
  setting: Setting;
  developmentReportSha256: string;
  sourceSha256: string;
  modelSha256: string;
  protocolSha256: string;
  developmentPassed: boolean;
  frozenAt: string;
  contentSha256: string;
}
interface Batch {
  manifestSha256: string;
  records: RecordResult[];
  contentSha256: string;
}
export type Comparison = ReturnType<typeof comparison>;
export interface Report {
  schemaVersion: 'full-mission-trained-report.v1';
  stage: 'development' | 'final';
  status: 'completed';
  sourceSha256: string;
  manifestSha256: string;
  modelSha256: string;
  selectionSha256: string | null;
  settings: Setting[];
  selectedId: string;
  comparisons: Comparison[];
  rules: ReturnType<typeof aggregateMissions>;
  batches: { file: string; sha256: string }[];
  recordsSha256: string;
  missions: number;
  contentSha256: string;
}

export function settings(artifact: Artifact): Setting[] {
  return Object.entries(artifact.models).flatMap(([modelId, m]) =>
    m.thresholds.map((threshold, i) => ({ id: `${modelId}-${i}`, modelId, threshold })),
  );
}
export function predict(
  rows: readonly number[][],
  baseline: readonly PredictionPoint[],
  artifact: Artifact,
  setting: Setting,
  scores?: readonly number[],
): PredictionPoint[] {
  if (rows.length !== 141 || baseline.length !== 180)
    throw new Error('Full mission dimensions must be180/141.');
  const values = scores ?? rows.map((row) => scoreFeatures(row, artifact, setting.modelId));
  if (values.length !== 141 || values.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    throw new Error('Invalid model scores.');
  return baseline.map((p, i) => ({
    ...p,
    modelState: i < 39 ? 'warmup' : values[i - 39]! > setting.threshold ? 'anomalous' : 'nominal',
  }));
}

export function inferCase(
  spec: MissionCase,
  context: Awaited<ReturnType<typeof loadModelContext>>,
  artifact: Artifact,
  choices: readonly Setting[],
) {
  const base = runMission(spec, context, ['model-k1', 'deterministic']);
  const scenario = generateTemporalScenario(spec.options),
    features = fullMissionFeatures(scenario);
  if (hashObject(features.names) !== hashObject(artifact.featureNames))
    throw new Error('Feature contract mismatch.');
  const scores = Object.fromEntries(
    [...new Set(choices.map((c) => c.modelId))].map((id) => [
      id,
      features.rows.map((row) => scoreFeatures(row, artifact, id)),
    ]),
  );
  const predictions = Object.fromEntries(
    choices.map((c) => [
      c.id,
      predict(features.rows, base.predictions, artifact, c, scores[c.modelId]),
    ]),
  );
  const candidates = Object.fromEntries(
    choices.map((c) => [
      c.id,
      evaluateMission(
        {
          caseId: spec.caseId,
          seed: scenario.seed,
          family: spec.family,
          variantId: spec.variantId,
          cadenceMs: 1000,
          faultTimeline: scenario.faultTimeline,
          predictions: predictions[c.id]!,
        },
        ['model-k1'],
      ),
    ]),
  );
  const record: RecordResult = {
    spec,
    scenarioSha256: base.record.scenarioSha256,
    baselinePredictionSha256: hashObject(base.predictions),
    candidatePredictionSha256: Object.fromEntries(
      choices.map((c) => [c.id, hashObject(predictions[c.id])]),
    ),
    baseline: base.record.evaluation,
    candidates,
    specific: {},
  };
  return { record, baselinePredictions: base.predictions, predictions, scores };
}
export function addControl(
  fault: ReturnType<typeof inferCase>,
  control: ReturnType<typeof inferCase>,
  choices: readonly Setting[],
) {
  const timeline = fault.record.baseline.faultTimeline;
  if (!timeline) return;
  if (
    control.record.baseline.faultTimeline !== null ||
    fault.record.baseline.seed !== control.record.baseline.seed ||
    fault.record.spec.options.startedAt !== control.record.spec.options.startedAt
  )
    throw new Error('Mismatched nominal control.');
  for (const setting of choices)
    fault.record.specific[setting.id] = {
      baseline: faultSpecific(fault.baselinePredictions, control.baselinePredictions, timeline),
      candidate: faultSpecific(
        fault.predictions[setting.id]!,
        control.predictions[setting.id]!,
        timeline,
      ),
    };
}
export function comparison(records: readonly RecordResult[], setting: Setting) {
  const ordinary = compareDetectors(records, setting.id);
  const specific = compareSpecific(
    records
      .filter((r) => r.baseline.faultTimeline !== null)
      .map((r) => ({
        seed: r.baseline.seed,
        family: r.baseline.family,
        variantId: r.baseline.variantId,
        ...r.specific[setting.id]!,
      })),
  );
  const reasons = [...ordinary.constraints.reasons, ...specific.reasons];
  if (
    ordinary.confidence.nominalFalseAlarmRateDelta!.upper === null ||
    ordinary.confidence.nominalFalseAlarmRateDelta!.upper >= 0
  )
    reasons.push('Nominal false-alarm reduction lacks a negative paired confidence bound.');
  return {
    setting,
    ordinary,
    specific,
    passed: reasons.length === 0,
    reasons,
    decision: reasons.length ? 'rejected' : 'improved',
  };
}
export function select(comparisons: readonly Comparison[]) {
  const passing = comparisons.filter((c) => c.passed);
  if (passing.length)
    return [...passing].sort(
      (a, b) =>
        (a.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) -
          (b.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) ||
        (b.specific.candidate.recall ?? -1) - (a.specific.candidate.recall ?? -1) ||
        (b.ordinary.candidate.activeRecall ?? -1) - (a.ordinary.candidate.activeRecall ?? -1) ||
        a.setting.modelId.localeCompare(b.setting.modelId) * -1 ||
        a.setting.threshold - b.setting.threshold,
    )[0]!;
  const reducing = comparisons.filter(
    (c) =>
      (c.ordinary.candidate.nominalFalseAlarmRate ?? 1) <
      (c.ordinary.baseline.nominalFalseAlarmRate ?? 0),
  );
  return [...(reducing.length ? reducing : comparisons)].sort(
    (a, b) =>
      (b.specific.candidate.recall ?? -1) - (a.specific.candidate.recall ?? -1) ||
      (a.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) -
        (b.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) ||
      a.setting.id.localeCompare(b.setting.id),
  )[0]!;
}

async function checkedManifest(output: string) {
  const manifest = verify(await readJson<Manifest>(resolve(output, 'manifest.json')));
  if (
    manifest.source.sha256 !== (await identity()).sha256 ||
    hashObject(manifest.protocol) !== hashObject(PROTOCOL)
  )
    throw new Error(
      'Experiment source/protocol changed. Use a new directory; frozen evidence cannot be rewritten.',
    );
  return manifest;
}
async function readArtifact(output: string, source: string) {
  const bytes = await readFile(resolve(output, 'model.json')),
    artifact = JSON.parse(bytes.toString('utf8')) as Artifact;
  validateArtifact(artifact, source);
  const parity = verifyParity(artifact);
  return { artifact, sha256: sha256(bytes), parity };
}
async function trainPython(python: string, output: string) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      python,
      [resolve(REPOSITORY_ROOT, 'tools/full-mission-model/train.py'), '--output', output],
      {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          OMP_NUM_THREADS: '2',
          OPENBLAS_NUM_THREADS: '2',
          MKL_NUM_THREADS: '2',
        },
      },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`Training exited${code}`)),
    );
  });
}

async function readRecords(output: string, report: Report) {
  const records: RecordResult[] = [];
  for (const reference of report.batches) {
    const batch = verify(await readJson<Batch>(resolve(output, report.stage, reference.file)));
    if (batch.contentSha256 !== reference.sha256)
      throw new Error('Report batch checksum mismatch.');
    records.push(...batch.records);
  }
  if (hashObject(records) !== report.recordsSha256 || records.length !== report.missions)
    throw new Error('Incomplete report records.');
  return records;
}
export async function run(stage: string, output: string, python?: string, caseId?: string) {
  await mkdir(output, { recursive: true });
  if (stage === 'train') {
    if (!python)
      throw new Error('Training requires --python pointing to the isolated pinned environment.');
    if (
      (await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final/manifest.json')))
    )
      throw new Error('Training frozen after selection.');
    if (!(await exists(resolve(output, 'manifest.json'))))
      await writeJson(
        resolve(output, 'manifest.json'),
        seal({
          schemaVersion: 'full-mission-training-manifest.v1',
          protocol: PROTOCOL,
          source: await identity(),
          createdAt: new Date().toISOString(),
        }),
      );
    const manifest = await checkedManifest(output);
    await writeJson(resolve(output, 'training-status.json'), { status: 'running' });
    try {
      await exportCorpus(output, 'fit', manifest.source.sha256);
      await exportCorpus(output, 'calibration', manifest.source.sha256);
      if (!(await exists(resolve(output, 'model.json')))) await trainPython(python, output);
      const model = await readArtifact(output, manifest.source.sha256);
      await checkedManifest(output);
      await writeJson(resolve(output, 'training-status.json'), {
        status: 'completed',
        modelSha256: model.sha256,
        parity: model.parity,
      });
    } catch (error) {
      await writeJson(resolve(output, 'training-status.json'), {
        status: 'failed',
        error: String(error),
      });
      throw error;
    }
    return;
  }
  if (!['development', 'final', 'replay'].includes(stage))
    throw new Error('Invalid experiment stage.');
  const manifest = await checkedManifest(output),
    model = await readArtifact(output, manifest.source.sha256),
    context = await loadModelContext();
  if (stage === 'replay') {
    const report = verify(await readJson<Report>(resolve(output, 'final/report.json')));
    if (report.sourceSha256 !== manifest.source.sha256 || report.modelSha256 !== model.sha256)
      throw new Error('Replay model/source mismatch.');
    const records = await readRecords(output, report),
      original = records.find((r) => r.spec.caseId === caseId);
    if (!original) throw new Error('Unknown replay case.');
    const result = inferCase(original.spec, context, model.artifact, report.settings);
    const control = inferCase(
      casesForSeeds([original.baseline.seed])[0]!,
      context,
      model.artifact,
      report.settings,
    );
    addControl(result, control, report.settings);
    if (hashObject(result.record) !== hashObject(original))
      throw new Error('Replay differs from frozen evidence.');
    await mkdir(resolve(output, 'replays'), { recursive: true });
    const stem = caseId!.replaceAll(':', '-');
    const replay = {
      exactMatch: true,
      reportSha256: report.contentSha256,
      setting: report.settings[0]!,
      result,
      control,
    };
    await writeJson(resolve(output, 'replays', `${stem}.json`), seal(replay));
    await writeReplay(replay, resolve(output, 'replays', `${stem}.html`));
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
    const development = verify(await readJson<Report>(resolve(output, 'development/report.json')));
    if (
      frozen.sourceSha256 !== manifest.source.sha256 ||
      frozen.modelSha256 !== model.sha256 ||
      frozen.protocolSha256 !== hashObject(PROTOCOL) ||
      frozen.developmentReportSha256 !== development.contentSha256 ||
      !settings(model.artifact).some((s) => hashObject(s) === hashObject(frozen.setting))
    )
      throw new Error('Frozen candidate mismatch.');
  }
  const choices = frozen ? [frozen.setting] : settings(model.artifact),
    seeds = stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds;
  const directory = resolve(output, stage);
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const stageManifest = seal({
    stage,
    seeds,
    choices,
    parentSha256: manifest.contentSha256,
    modelSha256: model.sha256,
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
          throw new Error('Batch source/case mismatch.');
      } else {
        const results: RecordResult[] = [];
        for (const seed of subset) {
          const specs = casesForSeeds([seed]),
            control = inferCase(specs[0]!, context, model.artifact, choices);
          results.push(control.record);
          for (const spec of specs.slice(1)) {
            const result = inferCase(spec, context, model.artifact, choices);
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
        c.reasons.push('Candidate failed development acceptance; final data cannot rescue it.');
      }
    const selected = select(comparisons);
    const report = seal({
      schemaVersion: 'full-mission-trained-report.v1' as const,
      stage: stage as 'development' | 'final',
      status: 'completed' as const,
      sourceSha256: manifest.source.sha256,
      manifestSha256: manifest.contentSha256,
      modelSha256: model.sha256,
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
    await checkedManifest(output);
    await writeJson(resolve(directory, 'report.json'), report);
    await writeReport(report, model.artifact, resolve(directory, 'report.html'));
    if (stage === 'development')
      await writeJson(
        resolve(output, 'selection.json'),
        seal({
          setting: selected.setting,
          developmentReportSha256: report.contentSha256,
          sourceSha256: manifest.source.sha256,
          modelSha256: model.sha256,
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
      JSON.stringify(
        comparisons.map((c) => ({
          id: c.setting.id,
          threshold: c.setting.threshold,
          nominalFalse: c.ordinary.candidate.nominalFalseAlarmMissions,
          recall: c.ordinary.candidate.activeRecall,
          specificRecall: c.specific.candidate.recall,
          p95AddedDelay: c.ordinary.constraints.pairedP95AddedDelayMs,
          p95AddedSpecificDelay: c.specific.p95AddedDelayMs,
          passed: c.passed,
          reasons: c.reasons,
        })),
      ),
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
      !['--stage', '--output', '--python', '--case-id'].includes(key) ||
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
    !['train', 'development', 'final', 'replay'].includes(stage) ||
    (stage === 'train') !== Boolean(values['--python']) ||
    (stage === 'replay') !== Boolean(values['--case-id'])
  )
    throw new Error('Invalid stage-specific arguments.');
  return {
    stage,
    output: resolve(
      values['--output'] ?? resolve(REPOSITORY_ROOT, 'reports/full-mission-model-v1'),
    ),
    python: values['--python'],
    caseId: values['--case-id'],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  await run(args.stage, args.output, args.python, args.caseId);
}
