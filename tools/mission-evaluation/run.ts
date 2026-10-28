import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  aggregateMissions,
  pairedBootstrap,
  evaluateFinalPolicy,
  selectDevelopmentPolicy,
  POLICY_IDS,
  type DevelopmentSelection,
  type FinalPolicyDecision,
  type PolicyId,
} from '../../src/mission-evaluation';
import {
  casesForSeeds,
  hashObject,
  loadModelContext,
  PROTOCOL,
  REPOSITORY_ROOT,
  runMission,
  sourceIdentity,
  type MissionRecord,
} from './protocol';
import { writeEvidenceReport, writeReplayReport } from './report';

export interface RunManifest {
  schemaVersion: 'full-mission-manifest.v1';
  stage: 'development' | 'final';
  protocol: typeof PROTOCOL;
  source: Awaited<ReturnType<typeof sourceIdentity>>;
  model: { artifactSha256: string; configurationSha256: string; historicalSeeds: number[] };
  policyIds: PolicyId[];
  seeds: number[];
  selectionSha256: string | null;
}

export interface EvidenceReport {
  schemaVersion: 'full-mission-report.v1';
  status: 'completed';
  contentSha256: string;
  manifest: RunManifest;
  manifestSha256: string;
  resultsSha256: string;
  results: MissionRecord[];
  aggregates: ReturnType<typeof aggregateMissions>[];
  selection: DevelopmentSelection | null;
  decision: FinalPolicyDecision | null;
  confidence: ReturnType<typeof pairedBootstrap>;
}

export interface FrozenSelection {
  schemaVersion: 'full-mission-selection.v1';
  developmentReportSha256: string;
  protocolSha256: string;
  sourceSha256: string;
  modelSha256: string;
  frozenAt: string;
  integritySha256: string;
  selection: DevelopmentSelection;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error(`Evidence file exceeds 64 MiB: ${path}`);
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
    throw new Error(`Evidence exceeds 64 MiB: ${path}`);
  await writeFile(`${path}.tmp`, serialized, 'utf8');
  await rename(`${path}.tmp`, path);
}

export function validateReport(report: EvidenceReport): void {
  const { contentSha256, ...content } = report;
  if (
    report.schemaVersion !== 'full-mission-report.v1' ||
    report.status !== 'completed' ||
    hashObject(content) !== contentSha256 ||
    hashObject(report.manifest) !== report.manifestSha256 ||
    hashObject(report.results) !== report.resultsSha256
  )
    throw new Error('Evidence report is incomplete or its digest does not match.');
  const seeds =
    report.manifest.stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds;
  if (
    hashObject(report.manifest.seeds) !== hashObject(seeds) ||
    hashObject(report.manifest.protocol) !== hashObject(PROTOCOL)
  )
    throw new Error('Evidence report does not match the frozen protocol.');
  const expected = casesForSeeds(report.manifest.seeds);
  if (
    expected.length !== report.results.length ||
    expected.some((spec, i) => hashObject(spec) !== hashObject(report.results[i]?.spec))
  )
    throw new Error('Evidence report mission matrix mismatch.');
}

async function checkedSelection(
  output: string,
  sourceHash: string,
  modelHash: string,
): Promise<FrozenSelection> {
  const path = resolve(output, 'selection.json');
  const selection = await readJson<FrozenSelection>(path);
  const { integritySha256, ...selectionContent } = selection;
  const development = await readJson<EvidenceReport>(resolve(output, 'development/report.json'));
  validateReport(development);
  if (
    selection.schemaVersion !== 'full-mission-selection.v1' ||
    hashObject(selectionContent) !== integritySha256 ||
    hashObject(development) !== selection.developmentReportSha256 ||
    selection.sourceSha256 !== sourceHash ||
    selection.modelSha256 !== modelHash ||
    selection.protocolSha256 !== hashObject(PROTOCOL) ||
    hashObject(development.selection) !== hashObject(selection.selection)
  )
    throw new Error(
      'Frozen selection or its development/source evidence has changed. Final evaluation is refused.',
    );
  return selection;
}

export async function runEvaluation(
  stage: 'development' | 'final',
  output: string,
): Promise<EvidenceReport> {
  if (stage === 'development' && (await exists(resolve(output, 'final/manifest.json'))))
    throw new Error(
      'Final evaluation has started. Development tuning in this experiment directory is locked.',
    );
  await mkdir(output, { recursive: true });
  const context = await loadModelContext();
  const source = await sourceIdentity();
  const frozen =
    stage === 'final'
      ? await checkedSelection(output, source.sha256, context.artifactSha256)
      : null;
  const directory = resolve(output, stage);
  await mkdir(resolve(directory, 'batches'), { recursive: true });
  const seeds = [...(stage === 'development' ? PROTOCOL.developmentSeeds : PROTOCOL.finalSeeds)];
  const policyIds: PolicyId[] =
    stage === 'development'
      ? [...POLICY_IDS]
      : [...new Set<PolicyId>(['model-k1', frozen!.selection.selectedPolicyId, 'deterministic'])];
  const manifest: RunManifest = {
    schemaVersion: 'full-mission-manifest.v1',
    stage,
    protocol: PROTOCOL,
    source,
    model: {
      artifactSha256: context.artifactSha256,
      configurationSha256: context.configurationSha256,
      historicalSeeds: context.historicalSeeds,
    },
    seeds,
    policyIds,
    selectionSha256: frozen ? hashObject(frozen) : null,
  };
  const manifestPath = resolve(directory, 'manifest.json');
  if (await exists(manifestPath)) {
    const previous = await readJson<RunManifest>(manifestPath);
    // Git metadata may change after committing byte-identical source. Preserve the original capture.
    if (
      hashObject({ ...previous, source: { ...previous.source, gitHead: source.gitHead } }) !==
      hashObject(manifest)
    )
      throw new Error(
        'Existing manifest differs. Resume requires the exact original protocol, source, runtime, model, and selection.',
      );
    manifest.source = previous.source;
  } else await writeJson(manifestPath, manifest);
  const manifestSha256 = hashObject(manifest);
  const reportPath = resolve(directory, 'report.json');
  if (await exists(reportPath)) {
    const report = await readJson<EvidenceReport>(reportPath);
    validateReport(report);
    if (report.manifestSha256 !== manifestSha256)
      throw new Error('Saved report has different provenance.');
    console.log(`${stage}: using verified complete report (${report.results.length} missions).`);
    await finishReport(report, output);
    await writeJson(resolve(directory, 'status.json'), {
      status: 'completed',
      completed: report.results.length,
      planned: seeds.length * 41,
      reportSha256: hashObject(report),
    });
    return report;
  }
  const results: MissionRecord[] = [];
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once('SIGINT', interrupt);
  try {
    await writeJson(resolve(directory, 'status.json'), {
      status: 'running',
      completed: 0,
      planned: seeds.length * 41,
      manifestSha256,
    });
    for (let offset = 0; offset < seeds.length; offset += PROTOCOL.batchSeeds) {
      const batchSeeds = seeds.slice(offset, offset + PROTOCOL.batchSeeds);
      const specs = casesForSeeds(batchSeeds);
      const path = resolve(directory, 'batches', `${batchSeeds[0]}-${batchSeeds.at(-1)}.json`);
      if (await exists(path)) {
        const batch = await readJson<{
          manifestSha256: string;
          resultsSha256: string;
          results: MissionRecord[];
        }>(path);
        if (
          batch.manifestSha256 !== manifestSha256 ||
          hashObject(batch.results) !== batch.resultsSha256 ||
          batch.results.length !== specs.length ||
          specs.some((spec, i) => hashObject(spec) !== hashObject(batch.results[i]?.spec))
        )
          throw new Error(`Invalid cached batch: ${path}`);
        results.push(...batch.results);
      } else {
        const batch: MissionRecord[] = [];
        for (const spec of specs) {
          if (interrupted) throw new Error('Interrupted; complete batches remain resumable.');
          batch.push(runMission(spec, context, policyIds).record);
          await new Promise<void>((done) => setTimeout(done, 0));
        }
        await writeJson(path, { manifestSha256, resultsSha256: hashObject(batch), results: batch });
        results.push(...batch);
      }
      console.log(`${stage}: ${results.length}/${seeds.length * 41} missions verified`);
      await writeJson(resolve(directory, 'status.json'), {
        status: 'running',
        completed: results.length,
        planned: seeds.length * 41,
        manifestSha256,
      });
    }
    const evaluations = results.map((record) => record.evaluation);
    if ((await sourceIdentity()).sha256 !== manifest.source.sha256) {
      throw new Error('Source changed during evaluation; no completed report will be published.');
    }
    const selection = stage === 'development' ? selectDevelopmentPolicy(evaluations) : null;
    const decision = frozen
      ? evaluateFinalPolicy(evaluations, frozen.selection.selectedPolicyId)
      : null;
    const content: Omit<EvidenceReport, 'contentSha256'> = {
      schemaVersion: 'full-mission-report.v1',
      status: 'completed',
      manifest,
      manifestSha256,
      resultsSha256: hashObject(results),
      results,
      aggregates: policyIds.map((policy) => aggregateMissions(evaluations, policy)),
      selection,
      decision,
      confidence:
        decision?.comparison?.confidence ??
        pairedBootstrap(
          evaluations,
          selection?.selectedPolicyId ?? frozen!.selection.selectedPolicyId,
        ),
    };
    const report: EvidenceReport = { ...content, contentSha256: hashObject(content) };
    validateReport(report);
    await writeJson(reportPath, report);
    await finishReport(report, output);
    await writeJson(resolve(directory, 'status.json'), {
      status: 'completed',
      completed: results.length,
      planned: seeds.length * 41,
      reportSha256: hashObject(report),
    });
    return report;
  } catch (error) {
    await writeJson(resolve(directory, 'status.json'), {
      status: interrupted ? 'interrupted' : 'failed',
      completed: results.length,
      planned: seeds.length * 41,
      error: error instanceof Error ? error.message : String(error),
      manifestSha256,
    });
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}

async function finishReport(report: EvidenceReport, output: string): Promise<void> {
  if (report.selection) {
    const path = resolve(output, 'selection.json');
    if (await exists(path))
      await checkedSelection(
        output,
        report.manifest.source.sha256,
        report.manifest.model.artifactSha256,
      );
    else {
      const content: Omit<FrozenSelection, 'integritySha256'> = {
        schemaVersion: 'full-mission-selection.v1',
        developmentReportSha256: hashObject(report),
        protocolSha256: hashObject(PROTOCOL),
        sourceSha256: report.manifest.source.sha256,
        modelSha256: report.manifest.model.artifactSha256,
        frozenAt: new Date().toISOString(),
        selection: report.selection,
      };
      const frozen: FrozenSelection = { ...content, integritySha256: hashObject(content) };
      await writeJson(path, frozen);
    }
  }
  await writeEvidenceReport(report, resolve(output, report.manifest.stage, 'report.html'));
  console.log(
    `${report.manifest.stage}: ${report.selection?.selectedPolicyId ?? report.decision?.decision}; report complete.`,
  );
}

export async function replayCase(
  output: string,
  caseId: string,
  from: 'development' | 'final' = 'final',
) {
  const report = await readJson<EvidenceReport>(resolve(output, from, 'report.json'));
  validateReport(report);
  const context = await loadModelContext();
  const source = await sourceIdentity();
  if (
    source.sha256 !== report.manifest.source.sha256 ||
    context.artifactSha256 !== report.manifest.model.artifactSha256
  )
    throw new Error('Replay requires identical source and model bytes.');
  const record = report.results.find((item) => item.spec.caseId === caseId);
  if (!record) throw new Error(`Case was not evaluated in ${from}: ${caseId}`);
  const replay = runMission(record.spec, context, report.manifest.policyIds);
  if (hashObject(replay.record) !== hashObject(record)) throw new Error('Exact replay mismatch.');
  const directory = resolve(output, 'replays');
  await mkdir(directory, { recursive: true });
  const name = caseId.replaceAll(/[^a-zA-Z0-9.-]/g, '_');
  const evidence = {
    schemaVersion: 'full-mission-replay.v1',
    exactMatch: true,
    sourceReportSha256: hashObject(report),
    ...replay,
  };
  await writeJson(resolve(directory, `${name}.json`), evidence);
  await writeReplayReport(replay.record, replay.predictions, resolve(directory, `${name}.html`));
  console.log(`replay: exact match for ${caseId}`);
  return evidence;
}

export function parseArguments(args: string[]) {
  const options = new Map<string, string>();
  const allowed = new Set(['--stage', '--output', '--case-id', '--from']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!allowed.has(key) || !value || value.startsWith('--') || options.has(key))
      throw new Error(
        `Invalid argument: ${key}. Use --stage development|final|replay --output DIRECTORY [--case-id ID --from development|final].`,
      );
    options.set(key, value);
  }
  const stage = options.get('--stage');
  if (stage !== 'development' && stage !== 'final' && stage !== 'replay')
    throw new Error('--stage must be development, final, or replay.');
  const from = options.get('--from') ?? 'final';
  if (from !== 'development' && from !== 'final')
    throw new Error('--from must be development or final.');
  const caseId = options.get('--case-id');
  if (stage === 'replay' ? !caseId : options.has('--case-id') || options.has('--from'))
    throw new Error('Replay requires --case-id; --case-id and --from are replay-only.');
  return {
    stage,
    output: resolve(
      options.get('--output') ?? resolve(REPOSITORY_ROOT, 'reports/mission-evaluation'),
    ),
    from,
    caseId,
  } as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.stage === 'replay') await replayCase(options.output, options.caseId!, options.from);
    else await runEvaluation(options.stage, options.output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
