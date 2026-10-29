import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateMissions } from '../../src/mission-evaluation';
import {
  hashObject,
  loadModelContext,
  REPOSITORY_ROOT,
  sha256,
} from '../mission-evaluation/protocol';
import { exists, readJson, writeJson } from '../mission-evaluation/run';
import { seal, verify } from '../nominal-correction/run';
import {
  validateArtifact as validateIncumbent,
  type Artifact as Incumbent,
} from '../full-mission-model/model';
import { exportCorpus } from './corpus';
import {
  addControl,
  cases,
  compare,
  infer,
  select,
  settings,
  type Comparison,
  type RecordResult,
  type Setting,
} from './evaluate';
import { validateArtifact, verifyParity, type Artifact } from './model';
import { identity, PROTOCOL } from './protocol';
import { writeReport, writeReplay } from './report';

interface Manifest {
  schemaVersion: string;
  source: Awaited<ReturnType<typeof identity>>;
  protocol: typeof PROTOCOL;
  incumbentSha256: string;
  contentSha256: string;
}
interface Batch {
  manifestSha256: string;
  records: RecordResult[];
  contentSha256: string;
}
interface Freeze {
  settings: Setting[];
  selectedId: string;
  developmentPassed: Record<string, boolean>;
  developmentReportSha256: string;
  sourceSha256: string;
  modelSha256: string;
  incumbentSha256: string;
  protocolSha256: string;
  frozenAt: string;
  contentSha256: string;
}
export interface Report {
  schemaVersion: 'residual-lag-report.v1';
  stage: 'development' | 'final';
  status: 'completed';
  sourceSha256: string;
  modelSha256: string;
  incumbentSha256: string;
  manifestSha256: string;
  selectionSha256: string | null;
  settings: Setting[];
  selectedId: string;
  comparisons: Comparison[];
  ablation: Comparison;
  registered: ReturnType<typeof aggregateMissions>;
  incumbent: ReturnType<typeof aggregateMissions>;
  rules: ReturnType<typeof aggregateMissions>;
  primaryMissions: number;
  challengeMissions: number;
  batches: { file: string; sha256: string }[];
  recordsSha256: string;
  contentSha256: string;
}
async function checkedManifest(output: string) {
  const manifest = verify(await readJson<Manifest>(resolve(output, 'manifest.json'))),
    current = await identity();
  if (
    manifest.source.sha256 !== current.sha256 ||
    hashObject(manifest.protocol) !== hashObject(PROTOCOL)
  )
    throw new Error('Frozen experiment source/protocol changed. Use a new output directory.');
  return manifest;
}
function checkIncumbent(a: Incumbent, parentSource: string) {
  validateIncumbent(a, parentSource);
  const forest = a.models.forest!;
  if (
    hashObject({
      featureNames: a.featureNames,
      scaler: a.scaler,
      trees: forest.type === 'random-forest' ? forest.trees : [],
    }) !== PROTOCOL.incumbentInferenceSha256
  )
    throw new Error('Incumbent inference identity differs from the completed experiment.');
}
async function readModels(output: string, manifest: Manifest) {
  const bytes = await readFile(resolve(output, 'model.json')),
    artifact = JSON.parse(bytes.toString('utf8')) as Artifact;
  validateArtifact(artifact, manifest.source.sha256);
  const parity = verifyParity(artifact),
    incumbentBytes = await readFile(resolve(output, 'incumbent.json')),
    incumbent = JSON.parse(incumbentBytes.toString('utf8')) as Incumbent;
  checkIncumbent(incumbent, manifest.source.parentSourceSha256);
  if (sha256(incumbentBytes) !== manifest.incumbentSha256)
    throw new Error('Frozen incumbent bytes changed.');
  return { artifact, incumbent, modelSha256: sha256(bytes), parity };
}
async function trainPython(python: string, output: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      python,
      [resolve(REPOSITORY_ROOT, 'tools/residual-lag/train.py'), '--output', output],
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
      code === 0 ? done() : reject(new Error(`Training exited${code}.`)),
    );
  });
}
async function readRecords(output: string, report: Report) {
  const records: RecordResult[] = [];
  for (const ref of report.batches) {
    const batch = verify(await readJson<Batch>(resolve(output, report.stage, ref.file)));
    if (batch.contentSha256 !== ref.sha256) throw new Error('Report batch checksum mismatch.');
    records.push(...batch.records);
  }
  const seeds = report.stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds;
  if (
    hashObject(records) !== report.recordsSha256 ||
    hashObject(records.map((r) => r.spec)) !== hashObject(cases(seeds))
  )
    throw new Error('Incomplete frozen report matrix.');
  return records;
}
export async function run(
  stage: 'train' | 'development' | 'final' | 'replay',
  output: string,
  options: {
    python?: string | undefined;
    incumbentPath?: string | undefined;
    caseId?: string | undefined;
  } = {},
) {
  if (stage === 'train') {
    if (!options.python || !options.incumbentPath)
      throw new Error('Training requires isolated --python and --incumbent artifact paths.');
    if (
      (await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final/manifest.json')))
    )
      throw new Error('Training is frozen.');
    const source = await identity(),
      bytes = await readFile(options.incumbentPath),
      incumbent = JSON.parse(bytes.toString('utf8')) as Incumbent;
    checkIncumbent(incumbent, source.parentSourceSha256);
    await loadModelContext();
    await mkdir(output, { recursive: true });
    if (!(await exists(resolve(output, 'manifest.json')))) {
      await copyFile(options.incumbentPath, resolve(output, 'incumbent.json'));
      await writeJson(
        resolve(output, 'manifest.json'),
        seal({
          schemaVersion: 'residual-lag-manifest.v1',
          source,
          protocol: PROTOCOL,
          incumbentSha256: sha256(bytes),
          createdAt: new Date().toISOString(),
        }),
      );
    }
    const manifest = await checkedManifest(output);
    if (manifest.incumbentSha256 !== sha256(bytes)) throw new Error('Training incumbent changed.');
    await writeJson(resolve(output, 'training-status.json'), { status: 'running' });
    try {
      await exportCorpus(output, 'fit', source.sha256);
      await exportCorpus(output, 'calibration', source.sha256);
      if (!(await exists(resolve(output, 'model.json')))) await trainPython(options.python, output);
      const model = await readModels(output, manifest);
      await checkedManifest(output);
      await writeJson(resolve(output, 'training-status.json'), {
        status: 'completed',
        modelSha256: model.modelSha256,
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
  const manifest = await checkedManifest(output),
    model = await readModels(output, manifest);
  await loadModelContext();
  if (stage === 'replay') {
    const report = verify(await readJson<Report>(resolve(output, 'final/report.json')));
    if (
      report.sourceSha256 !== manifest.source.sha256 ||
      report.modelSha256 !== model.modelSha256 ||
      report.incumbentSha256 !== manifest.incumbentSha256
    )
      throw new Error('Replay provenance mismatch.');
    const records = await readRecords(output, report),
      original = records.find((r) => r.spec.caseId === options.caseId);
    if (!original) throw new Error('Unknown replay case.');
    const result = infer(original.spec, model.artifact, model.incumbent, report.settings),
      control = infer(
        cases([original.spec.options.seed])[0]!,
        model.artifact,
        model.incumbent,
        report.settings,
      );
    addControl(result, control);
    if (hashObject(result.record) !== hashObject(original))
      throw new Error('Replay differs from frozen evidence.');
    const replay = seal({
      exactMatch: true,
      reportSha256: report.contentSha256,
      selectedId: report.selectedId,
      settings: report.settings,
      result,
      control,
    });
    await mkdir(resolve(output, 'replays'), { recursive: true });
    const stem = original.spec.caseId.replaceAll(':', '-');
    await writeJson(resolve(output, 'replays', `${stem}.json`), replay);
    await writeReplay(replay, resolve(output, 'replays', `${stem}.html`));
    console.log(`Exact replay: ${original.spec.caseId}`);
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
    const development = verify(await readJson<Report>(resolve(output, 'development/report.json'))),
      allowed = settings(model.artifact);
    if (
      frozen.sourceSha256 !== manifest.source.sha256 ||
      frozen.modelSha256 !== model.modelSha256 ||
      frozen.incumbentSha256 !== manifest.incumbentSha256 ||
      frozen.protocolSha256 !== hashObject(PROTOCOL) ||
      frozen.developmentReportSha256 !== development.contentSha256 ||
      frozen.settings.length !== 2 ||
      new Set(frozen.settings.map((s) => s.modelId)).size !== 2 ||
      frozen.settings.some((s) => !allowed.some((a) => hashObject(a) === hashObject(s))) ||
      !frozen.settings.some((s) => s.id === frozen.selectedId && s.modelId === 'targeted')
    )
      throw new Error('Frozen selection mismatch.');
  }
  const choices = frozen?.settings ?? settings(model.artifact),
    seeds = stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds,
    directory = resolve(output, stage);
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const stageManifest = seal({
    stage,
    seeds,
    choices,
    parentSha256: manifest.contentSha256,
    modelSha256: model.modelSha256,
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
          hashObject(batch.records.map((r) => r.spec)) !== hashObject(cases(subset))
        )
          throw new Error('Batch provenance mismatch.');
      } else {
        const rows: RecordResult[] = [];
        for (const seed of subset) {
          const specs = cases([seed]),
            control = infer(specs[0]!, model.artifact, model.incumbent, choices);
          rows.push(control.record);
          for (const spec of specs.slice(1)) {
            const result = infer(spec, model.artifact, model.incumbent, choices);
            addControl(result, control);
            rows.push(result.record);
          }
        }
        batch = seal({ manifestSha256: stageManifest.contentSha256, records: rows });
        await writeJson(path, batch);
      }
      records.push(...batch.records);
      batches.push({ file, sha256: batch.contentSha256 });
      await writeJson(resolve(directory, 'status.json'), {
        status: 'running',
        completed: records.length,
        expected: seeds.length * 42,
      });
      console.log(`${stage}: ${records.length}/${seeds.length * 42}`);
    }
    if (hashObject(records.map((r) => r.spec)) !== hashObject(cases(seeds)))
      throw new Error('Incomplete case matrix.');
    const comparisons = choices.map((c) => compare(records, c));
    if (frozen)
      for (const c of comparisons)
        if (!frozen.developmentPassed[c.setting.id]) {
          c.passed = false;
          c.decision = 'rejected';
          c.reasons.push('Development failed; final cannot rescue this setting.');
        }
    const selected = select(comparisons, 'targeted'),
      control = select(comparisons, 'control'),
      primary = records.filter((r) => r.spec.stream === 'primary');
    const report: Report = seal({
      schemaVersion: 'residual-lag-report.v1' as const,
      stage,
      status: 'completed' as const,
      sourceSha256: manifest.source.sha256,
      modelSha256: model.modelSha256,
      incumbentSha256: manifest.incumbentSha256,
      manifestSha256: manifest.contentSha256,
      selectionSha256: frozen?.contentSha256 ?? null,
      settings: choices,
      selectedId: frozen?.selectedId ?? selected.setting.id,
      comparisons,
      ablation: compare(records, selected.setting, control.setting.id),
      registered: aggregateMissions(
        primary.map((r) => r.evaluations.registered!),
        'model-k1',
      ),
      incumbent: aggregateMissions(
        primary.map((r) => r.evaluations.incumbent!),
        'model-k1',
      ),
      rules: aggregateMissions(
        primary.map((r) => r.evaluations.registered!),
        'deterministic',
      ),
      primaryMissions: primary.length,
      challengeMissions: records.length - primary.length,
      batches,
      recordsSha256: hashObject(records),
    });
    await checkedManifest(output);
    if (sha256(await readFile(resolve(output, 'model.json'))) !== model.modelSha256)
      throw new Error('Model changed during evaluation.');
    await writeJson(resolve(directory, 'report.json'), report);
    await writeReport(report, records, resolve(directory, 'report.html'));
    if (stage === 'development')
      await writeJson(
        resolve(output, 'selection.json'),
        seal({
          settings: [selected.setting, control.setting],
          selectedId: selected.setting.id,
          developmentPassed: {
            [selected.setting.id]: selected.passed,
            [control.setting.id]: control.passed,
          },
          developmentReportSha256: report.contentSha256,
          sourceSha256: manifest.source.sha256,
          modelSha256: model.modelSha256,
          incumbentSha256: manifest.incumbentSha256,
          protocolSha256: hashObject(PROTOCOL),
          frozenAt: new Date().toISOString(),
        }),
      );
    await writeJson(resolve(directory, 'status.json'), {
      status: 'completed',
      completed: records.length,
      expected: seeds.length * 42,
      reportSha256: report.contentSha256,
    });
    console.log(
      JSON.stringify({
        selected: selected.setting,
        passed: selected.passed,
        reasons: selected.reasons,
        nominal: selected.ordinary.candidate.nominalFalseAlarmMissions,
        recall: selected.ordinary.candidate.activeRecall,
        specific: selected.confirmed.candidate.recall,
        cruise: selected.cruise.candidate.recall,
        challenge: selected.challenge.candidate.recall,
        control: control.setting,
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
      !['--stage', '--output', '--python', '--incumbent', '--case-id'].includes(key) ||
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
    (stage === 'train') !== Boolean(values['--incumbent']) ||
    (stage === 'replay') !== Boolean(values['--case-id'])
  )
    throw new Error('Invalid stage-specific arguments.');
  return {
    stage: stage as 'train' | 'development' | 'final' | 'replay',
    output: resolve(values['--output'] ?? resolve(REPOSITORY_ROOT, 'reports/residual-lag-v1')),
    options: {
      python: values['--python'],
      incumbentPath: values['--incumbent'],
      caseId: values['--case-id'],
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  await run(args.stage, args.output, args.options);
}
