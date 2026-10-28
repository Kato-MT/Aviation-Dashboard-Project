import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_IDS } from '../../src/mission-evaluation';
import {
  assertSeedSeparation,
  canonical,
  casesForSeeds,
  hashObject,
  loadModelContext,
  PROTOCOL,
  REPOSITORY_ROOT,
  runMission,
  sourceIdentity,
} from '../../tools/mission-evaluation/protocol';
import {
  exists,
  parseArguments,
  readJson,
  runEvaluation,
  validateReport,
  writeJson,
  type RunManifest,
  type EvidenceReport,
} from '../../tools/mission-evaluation/run';
import { escapeHtml, writeReplayReport } from '../../tools/mission-evaluation/report';

async function temporary<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const parent = resolve(REPOSITORY_ROOT, '.tmp-tests');
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(resolve(parent, 'mission-evaluation-'));
  try {
    return await fn(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

describe('full-mission runner', () => {
  it('TC-FM-101 builds exactly the frozen 41-case matrix and disjoint partitions', async () => {
    const cases = casesForSeeds([12101]);
    expect(cases).toHaveLength(41);
    expect(new Set(cases.map((item) => item.caseId)).size).toBe(41);
    expect(cases.filter((item) => item.variantId === 'default')).toHaveLength(11);
    expect(cases[0]!.options).not.toHaveProperty('onsetPhase');
    const context = await loadModelContext();
    expect(context.historicalSeeds).toContain(4101);
    expect(() => assertSeedSeparation(context.historicalSeeds)).not.toThrow();
    expect(() => assertSeedSeparation([12101])).toThrow(/overlap/);
    expect(() => assertSeedSeparation([], [1], [1])).toThrow(/overlap/);
    expect(() => assertSeedSeparation([], [0], [2])).toThrow(/invalid/);
  });

  it('TC-FM-102 enforces registered bytes and replays default and variant predictions exactly', async () => {
    const context = await loadModelContext();
    const cases = casesForSeeds([12101]);
    for (const spec of [cases[0]!, cases[1]!, cases[2]!]) {
      const first = runMission(spec, context, POLICY_IDS);
      expect(runMission(spec, context, POLICY_IDS)).toEqual(first);
      expect(first.predictions).toHaveLength(180);
      expect(first.record.evaluation.policies['model-k1']!.warmupSamples).toBe(39);
    }
    expect(() =>
      runMission(cases[0]!, { ...context, artifactSha256: '0'.repeat(64) }, POLICY_IDS),
    ).toThrow(/unavailable/);
    expect(() =>
      runMission(
        { ...cases[0]!, options: { ...cases[0]!.options, sampleCount: 100000 } },
        context,
        POLICY_IDS,
      ),
    ).toThrow(/180/);
  });

  it('TC-FM-103 rejects ambiguous CLI inputs and invalid stages', () => {
    expect(parseArguments(['--stage', 'development']).stage).toBe('development');
    expect(
      parseArguments([
        '--stage',
        'replay',
        '--case-id',
        '12101:nominal:default',
        '--from',
        'development',
      ]).from,
    ).toBe('development');
    for (const args of [
      [],
      ['--stage', 'bad'],
      ['--stage', 'final', '--stage', 'final'],
      ['--stage', 'replay'],
      ['--stage', 'development', '--case-id', 'x'],
      ['--stage', 'final', '--from', 'development'],
      ['--wat', 'x'],
      ['--stage'],
      ['--stage', 'replay', '--case-id', 'x', '--from', 'bad'],
    ])
      expect(() => parseArguments(args)).toThrow();
  });

  it('TC-FM-104 refuses final evaluation without frozen evidence and development after final starts', async () =>
    temporary(async (path) => {
      await expect(runEvaluation('final', path)).rejects.toThrow();
      expect(await exists(resolve(path, 'final/report.json'))).toBe(false);
      await mkdir(resolve(path, 'final'), { recursive: true });
      await writeJson(resolve(path, 'final/manifest.json'), {});
      await expect(runEvaluation('development', path)).rejects.toThrow(/locked/);
    }));

  it('TC-FM-105 rejects corrupt cached batches with explicit failed status', async () =>
    temporary(async (path) => {
      const context = await loadModelContext();
      const source = await sourceIdentity();
      const manifest: RunManifest = {
        schemaVersion: 'full-mission-manifest.v1',
        stage: 'development',
        protocol: PROTOCOL,
        source,
        model: {
          artifactSha256: context.artifactSha256,
          configurationSha256: context.configurationSha256,
          historicalSeeds: context.historicalSeeds,
        },
        policyIds: [...POLICY_IDS],
        seeds: [...PROTOCOL.developmentSeeds],
        selectionSha256: null,
      };
      await mkdir(resolve(path, 'development/batches'), { recursive: true });
      await writeJson(resolve(path, 'development/manifest.json'), manifest);
      await writeJson(resolve(path, 'development/batches/12101-12108.json'), {
        manifestSha256: hashObject(manifest),
        resultsSha256: 'corrupt',
        results: [],
      });
      await expect(runEvaluation('development', path)).rejects.toThrow(/Invalid cached batch/);
      expect(await readJson(resolve(path, 'development/status.json'))).toMatchObject({
        status: 'failed',
        completed: 0,
      });
      expect(await exists(resolve(path, 'development/report.json'))).toBe(false);
    }));

  it('TC-FM-106 serializes stable identities, rejects partial reports, and escapes report values', async () =>
    temporary(async (path) => {
      expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
      expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]));
      expect(() => validateReport({ schemaVersion: 'bad' } as unknown as EvidenceReport)).toThrow();
      const manifest = {
        stage: 'development',
        seeds: PROTOCOL.developmentSeeds,
        protocol: PROTOCOL,
      };
      const content = {
        schemaVersion: 'full-mission-report.v1',
        status: 'completed',
        manifest,
        manifestSha256: hashObject(manifest),
        results: [],
        resultsSha256: hashObject([]),
        aggregates: [],
        selection: null,
        decision: null,
      };
      const sealed = {
        ...content,
        contentSha256: hashObject(content),
      } as unknown as EvidenceReport;
      expect(() => validateReport(sealed)).toThrow(/matrix/);
      expect(() =>
        validateReport({
          ...sealed,
          decision: { decision: 'improved' } as EvidenceReport['decision'],
        }),
      ).toThrow(/digest/);
      const file = resolve(path, 'evidence.json');
      await writeJson(file, { hello: 'world' });
      expect(await readJson(file)).toEqual({ hello: 'world' });
      expect(escapeHtml('<script>"&')).toBe('&lt;script&gt;&quot;&amp;');
      const context = await loadModelContext();
      const replay = runMission(casesForSeeds([12101])[0]!, context, POLICY_IDS);
      await writeReplayReport(replay.record, replay.predictions, resolve(path, 'replay.html'));
      const html = await readFile(resolve(path, 'replay.html'), 'utf8');
      expect(html).toContain('Exact synthetic mission replay');
      expect(html).toContain('new Chart');
      expect(html).not.toMatch(/<script[^>]+src=/);
      await writeFile(resolve(path, 'broken.json'), '{');
      await expect(readJson(resolve(path, 'broken.json'))).rejects.toThrow();
    }));
});
