import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateTemporalScenario } from '../../src/temporal/generator';
import { evaluateMission, aggregateMissions } from '../../src/mission-evaluation';
import {
  casesForSeeds,
  hashObject,
  loadModelContext,
  REPOSITORY_ROOT,
  runMission,
  type MissionCase,
} from '../mission-evaluation/protocol';
import { exists, readJson, writeJson } from '../mission-evaluation/run';
import {
  correctPredictions,
  fitEnvelope,
  missionFeatures,
  validateEnvelope,
  type Envelope,
} from './core';
import { compareDetectors } from './compare';
import { identity, PROTOCOL } from './protocol';
import { writeReport, writeReplay } from './report';

export const DEFAULT_OUTPUT = resolve(REPOSITORY_ROOT, 'reports/nominal-correction');
export function seal<T extends object>(value: T): T & { contentSha256: string } {
  return { ...value, contentSha256: hashObject(value) };
}
export function verify<T extends { contentSha256: string }>(value: T): T {
  const { contentSha256, ...rest } = value;
  if (hashObject(rest) !== contentSha256) throw new Error('Evidence checksum mismatch.');
  return value;
}
type Source = Awaited<ReturnType<typeof identity>>;
interface Manifest {
  schemaVersion: 'nominal-correction-manifest.v1';
  protocol: typeof PROTOCOL;
  source: Source;
  createdAt: string;
}
interface Fit {
  envelope: Envelope;
  contentSha256: string;
}
interface Freeze {
  candidateId: string;
  developmentSha256: string;
  envelopeSha256: string;
  sourceSha256: string;
  protocolSha256: string;
  developmentPassed: boolean;
  frozenAt: string;
  contentSha256: string;
}

export function pairedMission(
  spec: MissionCase,
  context: Awaited<ReturnType<typeof loadModelContext>>,
  envelope: Envelope,
  ids: readonly string[],
) {
  const base = runMission(spec, context, ['model-k1', 'deterministic']);
  const scenario = generateTemporalScenario(spec.options);
  const features = missionFeatures(scenario);
  const traces = Object.fromEntries(
    ids.map((id) => [id, correctPredictions(base.predictions, features, envelope, id)]),
  );
  const evaluations = Object.fromEntries(
    ids.map((id) => [
      id,
      evaluateMission(
        {
          caseId: spec.caseId,
          seed: scenario.seed,
          family: spec.family,
          variantId: spec.variantId,
          cadenceMs: scenario.cadenceMs,
          faultTimeline: scenario.faultTimeline,
          predictions: traces[id]!,
        },
        ['model-k1'],
      ),
    ]),
  );
  return {
    record: {
      spec,
      scenarioSha256: base.record.scenarioSha256,
      baselinePredictionSha256: base.record.predictionsSha256,
      candidatePredictionSha256: Object.fromEntries(ids.map((id) => [id, hashObject(traces[id])])),
      baseline: base.record.evaluation,
      candidates: evaluations,
    },
    baselinePredictions: base.predictions,
    candidatePredictions: traces,
  };
}
export type PairRecord = ReturnType<typeof pairedMission>['record'];
export type Comparison = ReturnType<typeof compareDetectors>;
export interface Report {
  schemaVersion: 'nominal-correction-report.v1';
  status: 'completed';
  stage: 'development' | 'final';
  manifestSha256: string;
  sourceSha256: string;
  envelopeSha256: string;
  selectionSha256: string | null;
  results: PairRecord[];
  resultsSha256: string;
  comparisons: Comparison[];
  rules: ReturnType<typeof aggregateMissions>;
  selectedCandidateId: string;
  contentSha256: string;
}

async function checkedManifest(output: string) {
  const manifest = verify(
    await readJson<Manifest & { contentSha256: string }>(resolve(output, 'manifest.json')),
  );
  const current = await identity();
  if (
    manifest.source.sha256 !== current.sha256 ||
    hashObject(manifest.protocol) !== hashObject(PROTOCOL)
  )
    throw new Error(
      'Source/protocol changed: use a new experiment directory; never mutate frozen results.',
    );
  return manifest;
}

export async function run(stage: string, output = DEFAULT_OUTPUT, caseId?: string) {
  await mkdir(output, { recursive: true });
  const context = await loadModelContext();
  if (stage === 'fit') {
    if (
      (await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final', 'manifest.json')))
    )
      throw new Error('Cannot fit after selection/final evaluation.');
    if (!(await exists(resolve(output, 'manifest.json'))))
      await writeJson(
        resolve(output, 'manifest.json'),
        seal({
          schemaVersion: 'nominal-correction-manifest.v1',
          protocol: PROTOCOL,
          source: await identity(),
          createdAt: new Date().toISOString(),
        }),
      );
    await checkedManifest(output);
    if (await exists(resolve(output, 'envelope.json'))) {
      const fit = verify(await readJson<Fit>(resolve(output, 'envelope.json')));
      validateEnvelope(fit.envelope, context.artifactSha256);
      console.log('Reusing verified fitted envelope.');
      return;
    }
    const features = (seed: number) =>
      missionFeatures(generateTemporalScenario(casesForSeeds([seed])[0]!.options));
    const envelope = fitEnvelope(
      PROTOCOL.fitSeeds.map(features),
      PROTOCOL.calibrationSeeds.map(features),
      context.artifact,
      context.artifactSha256,
    );
    validateEnvelope(envelope, context.artifactSha256);
    await checkedManifest(output);
    await writeJson(resolve(output, 'envelope.json'), seal({ envelope }));
    console.log(JSON.stringify({ fit: 'completed', thresholds: envelope.thresholds }));
    return;
  }
  if (!['development', 'final', 'replay'].includes(stage))
    throw new Error('Stage must be fit, development, final, or replay.');
  const manifest = await checkedManifest(output);
  const fit = verify(await readJson<Fit>(resolve(output, 'envelope.json')));
  validateEnvelope(fit.envelope, context.artifactSha256);
  if (stage === 'replay') {
    if (!caseId) throw new Error('Replay requires --case-id.');
    const report = verify(await readJson<Report>(resolve(output, 'final', 'report.json')));
    const original = report.results.find((r) => r.spec.caseId === caseId);
    if (
      !original ||
      report.resultsSha256 !== hashObject(report.results) ||
      report.envelopeSha256 !== fit.contentSha256 ||
      report.sourceSha256 !== manifest.source.sha256
    )
      throw new Error('Replay evidence mismatch or unknown case.');
    const replay = pairedMission(
      original.spec,
      context,
      fit.envelope,
      Object.keys(original.candidates),
    );
    if (hashObject(replay.record) !== hashObject(original)) throw new Error('Replay is not exact.');
    await mkdir(resolve(output, 'replays'), { recursive: true });
    const stem = caseId.replaceAll(':', '-');
    await writeJson(
      resolve(output, 'replays', `${stem}.json`),
      seal({
        schemaVersion: 'nominal-correction-replay.v1',
        exactMatch: true,
        reportSha256: report.contentSha256,
        ...replay,
      }),
    );
    await writeReplay(replay, resolve(output, 'replays', `${stem}.html`));
    console.log(`Exact replay: ${caseId}`);
    return;
  }
  if (
    stage === 'development' &&
    ((await exists(resolve(output, 'selection.json'))) ||
      (await exists(resolve(output, 'final', 'manifest.json'))))
  )
    throw new Error('Development is frozen; use existing report.');
  const frozen =
    stage === 'final' ? verify(await readJson<Freeze>(resolve(output, 'selection.json'))) : null;
  if (frozen) {
    const development = verify(
      await readJson<Report>(resolve(output, 'development', 'report.json')),
    );
    if (
      frozen.developmentSha256 !== development.contentSha256 ||
      frozen.envelopeSha256 !== fit.contentSha256 ||
      frozen.sourceSha256 !== manifest.source.sha256 ||
      frozen.protocolSha256 !== hashObject(PROTOCOL) ||
      !PROTOCOL.candidates.includes(frozen.candidateId as (typeof PROTOCOL.candidates)[number])
    )
      throw new Error('Frozen selection does not match evidence.');
  }
  const seeds = stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds;
  const ids = frozen ? [frozen.candidateId] : PROTOCOL.candidates;
  const directory = resolve(output, stage);
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const stageManifest = {
    stage,
    seeds,
    candidateIds: ids,
    parentManifestSha256: manifest.contentSha256,
    envelopeSha256: fit.contentSha256,
    selectionSha256: frozen?.contentSha256 ?? null,
  };
  if (await exists(resolve(directory, 'manifest.json'))) {
    if (
      hashObject(await readJson(resolve(directory, 'manifest.json'))) !==
      hashObject(seal(stageManifest))
    )
      throw new Error('Stage manifest mismatch.');
  } else await writeJson(resolve(directory, 'manifest.json'), seal(stageManifest));
  const results: PairRecord[] = [];
  try {
    for (let i = 0; i < seeds.length; i += PROTOCOL.batchSeeds) {
      const specs = casesForSeeds(seeds.slice(i, i + PROTOCOL.batchSeeds));
      const path = resolve(directory, 'batches', `${i / PROTOCOL.batchSeeds}.json`);
      if (await exists(path)) {
        const cached = verify(
          await readJson<{ records: PairRecord[]; manifestSha256: string; contentSha256: string }>(
            path,
          ),
        );
        if (
          cached.manifestSha256 !== hashObject(stageManifest) ||
          hashObject(cached.records.map((r) => r.spec)) !== hashObject(specs) ||
          cached.records.some((r) => hashObject(Object.keys(r.candidates)) !== hashObject(ids))
        )
          throw new Error('Cached batch manifest/case mismatch.');
        results.push(...cached.records);
      } else {
        const records = specs.map((spec) => pairedMission(spec, context, fit.envelope, ids).record);
        await writeJson(path, seal({ manifestSha256: hashObject(stageManifest), records }));
        results.push(...records);
      }
      await writeJson(resolve(directory, 'status.json'), {
        status: 'running',
        completed: results.length,
        expected: seeds.length * 41,
      });
      console.log(`${stage}: ${results.length}/${seeds.length * 41}`);
    }
    if (hashObject(results.map((r) => r.spec)) !== hashObject(casesForSeeds(seeds)))
      throw new Error('Incomplete case matrix.');
    const comparisons = ids.map((id) => compareDetectors(results, id));
    if (frozen && !frozen.developmentPassed)
      for (const comparison of comparisons) comparison.decision = 'rejected';
    const ordered = [...comparisons].sort(
      (a, b) =>
        Number(b.constraints.passed) - Number(a.constraints.passed) ||
        (a.candidate.nominalFalseAlarmRate ?? Infinity) -
          (b.candidate.nominalFalseAlarmRate ?? Infinity) ||
        (b.candidate.activeRecall ?? -Infinity) - (a.candidate.activeRecall ?? -Infinity) ||
        fit.envelope.thresholds[a.candidateId]! - fit.envelope.thresholds[b.candidateId]!,
    );
    const selectedCandidateId = frozen?.candidateId ?? ordered[0]!.candidateId;
    const report = seal({
      schemaVersion: 'nominal-correction-report.v1' as const,
      status: 'completed' as const,
      stage: stage as 'development' | 'final',
      manifestSha256: manifest.contentSha256,
      sourceSha256: manifest.source.sha256,
      envelopeSha256: fit.contentSha256,
      selectionSha256: frozen?.contentSha256 ?? null,
      results,
      resultsSha256: hashObject(results),
      comparisons,
      rules: aggregateMissions(
        results.map((r) => r.baseline),
        'deterministic',
      ),
      selectedCandidateId,
    });
    await checkedManifest(output);
    await writeJson(resolve(directory, 'report.json'), report);
    await writeReport(report, fit.envelope, resolve(directory, 'report.html'));
    if (stage === 'development')
      await writeJson(
        resolve(output, 'selection.json'),
        seal({
          candidateId: selectedCandidateId,
          developmentSha256: report.contentSha256,
          envelopeSha256: fit.contentSha256,
          sourceSha256: manifest.source.sha256,
          protocolSha256: hashObject(PROTOCOL),
          developmentPassed: ordered[0]!.constraints.passed,
          frozenAt: new Date().toISOString(),
        }),
      );
    await writeJson(resolve(directory, 'status.json'), {
      status: 'completed',
      completed: results.length,
      expected: seeds.length * 41,
      reportSha256: report.contentSha256,
    });
    console.log(
      JSON.stringify(
        comparisons.map((c) => ({
          id: c.candidateId,
          decision: c.decision,
          nominalFalse: c.candidate.nominalFalseAlarmMissions,
          recall: c.candidate.activeRecall,
          constraints: c.constraints,
          confidence: c.confidence,
        })),
      ),
    );
  } catch (error) {
    await writeJson(resolve(directory, 'status.json'), {
      status: 'failed',
      completed: results.length,
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
      !['--stage', '--output', '--case-id'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      key in values
    )
      throw new Error('Invalid or duplicate CLI argument.');
    values[key] = value;
  }
  if (!values['--stage'] || !['fit', 'development', 'final', 'replay'].includes(values['--stage']))
    throw new Error('Specify a valid --stage.');
  if ((values['--stage'] === 'replay') !== Boolean(values['--case-id']))
    throw new Error('--case-id is required only for replay.');
  return {
    stage: values['--stage'],
    output: resolve(values['--output'] ?? DEFAULT_OUTPUT),
    caseId: values['--case-id'],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  await run(args.stage, args.output, args.caseId);
}
