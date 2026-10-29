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
import { validateArtifact, verifyParity, type Artifact } from '../residual-lag/model';
import {
  addControl,
  cases,
  compare,
  infer,
  select,
  type Comparison,
  type RecordResult,
} from './evaluate';
import { SETTINGS, validateSetting, type Setting } from './policy';
import { identity, PROTOCOL } from './protocol';
import { writeReport, writeReplay } from './report';

type Stage = 'development' | 'final';
interface Manifest {
  schemaVersion: 'alarm-preservation-manifest.v1';
  source: Awaited<ReturnType<typeof identity>>;
  protocol: typeof PROTOCOL;
  modelSha256: string;
  incumbentSha256: string;
  parentReportSha256: string;
  contentSha256: string;
}
interface Batch {
  manifestSha256: string;
  records: RecordResult[];
  contentSha256: string;
}
interface Freeze {
  setting: Setting;
  developmentPassed: boolean;
  developmentReportSha256: string;
  sourceSha256: string;
  modelSha256: string;
  incumbentSha256: string;
  protocolSha256: string;
  frozenAt: string;
  contentSha256: string;
}
export interface Report {
  schemaVersion: 'alarm-preservation-report.v1';
  stage: Stage;
  status: 'completed';
  sourceSha256: string;
  modelSha256: string;
  incumbentSha256: string;
  manifestSha256: string;
  selectionSha256: string | null;
  settings: readonly Setting[];
  selectedId: string;
  comparisons: Comparison[];
  references: Record<string, ReturnType<typeof aggregateMissions>>;
  primaryMissions: number;
  challengeMissions: number;
  batches: { file: string; sha256: string }[];
  recordsSha256: string;
  contentSha256: string;
}
async function checkedManifest(output: string) {
  const manifest = verify(await readJson<Manifest>(resolve(output, 'manifest.json')));
  const current = await identity();
  if (
    manifest.schemaVersion !== 'alarm-preservation-manifest.v1' ||
    manifest.source.sha256 !== current.sha256 ||
    hashObject(manifest.protocol) !== hashObject(PROTOCOL) ||
    manifest.modelSha256 !== PROTOCOL.modelSha256 ||
    manifest.incumbentSha256 !== PROTOCOL.incumbentSha256 ||
    manifest.parentReportSha256 !== PROTOCOL.parentReportSha256
  )
    throw new Error(
      'Frozen experiment source/protocol/model identity changed. Use a new output directory.',
    );
  return manifest;
}
async function initialize(output: string, parent: string) {
  if (await exists(resolve(output, 'manifest.json'))) return checkedManifest(output);
  const source = await identity();
  const report = verify(
    await readJson<{
      status: string;
      sourceSha256: string;
      modelSha256: string;
      incumbentSha256: string;
      contentSha256: string;
    }>(resolve(parent, 'final/report.json')),
  );
  if (
    report.status !== 'completed' ||
    report.contentSha256 !== PROTOCOL.parentReportSha256 ||
    report.sourceSha256 !== source.parentResidualSha256 ||
    report.modelSha256 !== PROTOCOL.modelSha256 ||
    report.incumbentSha256 !== PROTOCOL.incumbentSha256
  )
    throw new Error('Expected the completed, frozen residual-lag parent.');
  await mkdir(output, { recursive: true });
  for (const [name, expected] of [
    ['model.json', PROTOCOL.modelSha256],
    ['incumbent.json', PROTOCOL.incumbentSha256],
  ] as const) {
    if (sha256(await readFile(resolve(parent, name))) !== expected)
      throw new Error('Parent model bytes changed.');
    const target = resolve(output, name);
    if (await exists(target)) {
      if (sha256(await readFile(target)) !== expected)
        throw new Error('Unexpected existing model artifact.');
    } else await copyFile(resolve(parent, name), target);
  }
  await writeJson(
    resolve(output, 'manifest.json'),
    seal({
      schemaVersion: 'alarm-preservation-manifest.v1',
      source,
      protocol: PROTOCOL,
      modelSha256: PROTOCOL.modelSha256,
      incumbentSha256: PROTOCOL.incumbentSha256,
      parentReportSha256: PROTOCOL.parentReportSha256,
      createdAt: new Date().toISOString(),
    }),
  );
  return checkedManifest(output);
}
async function readModels(output: string, manifest: Manifest) {
  const modelBytes = await readFile(resolve(output, 'model.json')),
    incumbentBytes = await readFile(resolve(output, 'incumbent.json'));
  if (
    sha256(modelBytes) !== manifest.modelSha256 ||
    sha256(incumbentBytes) !== manifest.incumbentSha256
  )
    throw new Error('Frozen model bytes changed.');
  const artifact = JSON.parse(modelBytes.toString('utf8')) as Artifact,
    incumbent = JSON.parse(incumbentBytes.toString('utf8')) as Incumbent;
  validateArtifact(artifact, manifest.source.parentResidualSha256);
  validateIncumbent(incumbent, manifest.source.parentSourceSha256);
  return { artifact, incumbent, parity: verifyParity(artifact) };
}
async function readSelection(output: string, manifest: Manifest) {
  const frozen = verify(await readJson<Freeze>(resolve(output, 'selection.json')));
  const development = verify(await readJson<Report>(resolve(output, 'development/report.json')));
  validateSetting(frozen.setting);
  const selected = development.comparisons.find((c) => c.setting.id === frozen.setting.id);
  if (
    frozen.sourceSha256 !== manifest.source.sha256 ||
    frozen.modelSha256 !== manifest.modelSha256 ||
    frozen.incumbentSha256 !== manifest.incumbentSha256 ||
    frozen.protocolSha256 !== hashObject(PROTOCOL) ||
    frozen.developmentReportSha256 !== development.contentSha256 ||
    development.status !== 'completed' ||
    development.stage !== 'development' ||
    development.sourceSha256 !== manifest.source.sha256 ||
    development.modelSha256 !== manifest.modelSha256 ||
    development.incumbentSha256 !== manifest.incumbentSha256 ||
    development.selectedId !== frozen.setting.id ||
    !selected ||
    hashObject(selected.setting) !== hashObject(frozen.setting) ||
    frozen.developmentPassed !== selected.passed ||
    !Number.isFinite(Date.parse(frozen.frozenAt))
  )
    throw new Error('Frozen selection mismatch.');
  return frozen;
}
async function readRecords(output: string, report: Report) {
  const records: RecordResult[] = [];
  for (const ref of report.batches) {
    const batch = verify(await readJson<Batch>(resolve(output, report.stage, ref.file)));
    if (batch.contentSha256 !== ref.sha256) throw new Error('Report batch checksum mismatch.');
    records.push(...batch.records);
  }
  if (
    hashObject(records) !== report.recordsSha256 ||
    hashObject(records.map((r) => r.spec)) !==
      hashObject(cases(report.stage === 'final' ? PROTOCOL.finalSeeds : PROTOCOL.developmentSeeds))
  )
    throw new Error('Incomplete frozen case matrix.');
  return records;
}
export async function run(
  stage: Stage | 'replay',
  output: string,
  options: { parentPath?: string | undefined; caseId?: string | undefined } = {},
) {
  if (
    stage === 'development' &&
    ((await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final/manifest.json'))))
  )
    throw new Error('Development is frozen.');
  const manifest =
    stage === 'development'
      ? await initialize(
          output,
          options.parentPath ?? resolve(REPOSITORY_ROOT, 'reports/residual-lag-v1'),
        )
      : await checkedManifest(output);
  const model = await readModels(output, manifest);
  await loadModelContext();
  const frozen = stage === 'development' ? null : await readSelection(output, manifest);
  if (stage === 'replay') {
    const report = verify(await readJson<Report>(resolve(output, 'final/report.json')));
    if (
      report.stage !== 'final' ||
      report.status !== 'completed' ||
      report.sourceSha256 !== manifest.source.sha256 ||
      report.modelSha256 !== manifest.modelSha256 ||
      report.incumbentSha256 !== manifest.incumbentSha256 ||
      report.selectionSha256 !== frozen!.contentSha256 ||
      hashObject(report.settings) !== hashObject([frozen!.setting]) ||
      report.selectedId !== frozen!.setting.id
    )
      throw new Error('Replay provenance mismatch.');
    const records = await readRecords(output, report),
      original = records.find((r) => r.spec.caseId === options.caseId);
    if (!original) throw new Error('Unknown replay case.');
    const result = infer(original.spec, model.artifact, model.incumbent, report.settings);
    const control = infer(
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
      setting: frozen!.setting,
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
  const choices = frozen ? [frozen.setting] : SETTINGS;
  const seeds = stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds;
  const directory = resolve(output, stage),
    manifestPath = resolve(directory, 'manifest.json');
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const existing = (await exists(manifestPath))
    ? verify(await readJson<{ startedAt: string; contentSha256: string }>(manifestPath))
    : null;
  const startedAt = existing?.startedAt ?? new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(startedAt)) ||
    (frozen && Date.parse(startedAt) < Date.parse(frozen.frozenAt))
  )
    throw new Error('Invalid stage start or final began before selection.');
  const stageManifest = seal({
    stage,
    seeds,
    choices,
    parentSha256: manifest.contentSha256,
    selectionSha256: frozen?.contentSha256 ?? null,
    startedAt,
  });
  if (existing) {
    if (hashObject(existing) !== hashObject(stageManifest))
      throw new Error('Stage manifest mismatch.');
  } else await writeJson(manifestPath, stageManifest);
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
    if (frozen && !frozen.developmentPassed)
      for (const c of comparisons) {
        c.passed = false;
        c.decision = 'rejected';
        c.reasons.push('Development failed; final cannot rescue this setting.');
      }
    const selected = select(comparisons),
      primary = records.filter((r) => r.spec.stream === 'primary');
    const references = Object.fromEntries(
      ['registered', 'incumbent', 'lag-baseline', 'strict-high'].map((id) => [
        id,
        aggregateMissions(
          primary.map((r) => r.evaluations[id]!),
          'model-k1',
        ),
      ]),
    );
    references.rules = aggregateMissions(
      primary.map((r) => r.evaluations.registered!),
      'deterministic',
    );
    const report: Report = seal({
      schemaVersion: 'alarm-preservation-report.v1' as const,
      stage,
      status: 'completed' as const,
      sourceSha256: manifest.source.sha256,
      modelSha256: manifest.modelSha256,
      incumbentSha256: manifest.incumbentSha256,
      manifestSha256: manifest.contentSha256,
      selectionSha256: frozen?.contentSha256 ?? null,
      settings: choices,
      selectedId: selected.setting.id,
      comparisons,
      references,
      primaryMissions: primary.length,
      challengeMissions: records.length - primary.length,
      batches,
      recordsSha256: hashObject(records),
    });
    await checkedManifest(output);
    await readModels(output, manifest);
    await writeJson(resolve(directory, 'report.json'), report);
    await writeReport(report, records, resolve(directory, 'report.html'));
    if (stage === 'development')
      await writeJson(
        resolve(output, 'selection.json'),
        seal({
          setting: selected.setting,
          developmentPassed: selected.passed,
          developmentReportSha256: report.contentSha256,
          sourceSha256: manifest.source.sha256,
          modelSha256: manifest.modelSha256,
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
        nominal: selected.versusTarget.ordinary.candidate.nominalFalseAlarmMissions,
        baselineNominal: selected.versusTarget.ordinary.baseline.nominalFalseAlarmMissions,
        cruise: selected.versusTarget.cruise.candidate.detected,
        baselineCruise: selected.versusTarget.cruise.baseline.detected,
        challenge: selected.versusTarget.challenge.candidate.detected,
        baselineChallenge: selected.versusTarget.challenge.baseline.detected,
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
    (stage !== 'development' && values['--parent']) ||
    (stage === 'replay') !== Boolean(values['--case-id'])
  )
    throw new Error('Invalid stage-specific arguments.');
  return {
    stage: stage as Stage | 'replay',
    output: resolve(
      values['--output'] ?? resolve(REPOSITORY_ROOT, 'reports/alarm-preservation-v1'),
    ),
    options: { parentPath: values['--parent'], caseId: values['--case-id'] },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  await run(args.stage, args.output, args.options);
}
