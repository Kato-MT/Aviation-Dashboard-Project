import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSelectedR3EvidenceManifest,
  selectedR3Contract,
  validateSelectedR3Contract,
  verifySelectedR3EvidenceManifest,
  writeSelectedR3EvidenceManifest,
} from '../../tools/live/selectedR3Evidence';

const roots: string[] = [];

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function fixtureFile(repositoryRoot: string, path: string, contents?: string): Promise<void> {
  const absolutePath = join(repositoryRoot, ...path.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents ?? `fixture:${path}\n`, 'utf8');
}

function requirementDocument(): string {
  const rows = selectedR3Contract.areas.flatMap((area) =>
    area.requirementIds.map((id) => `| ${id} | v3.0 | Fixture requirement. |`),
  );
  return `| ID | Version | Requirement |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
}

function testCaseDocument(): string {
  const rows = selectedR3Contract.areas.flatMap((area) =>
    area.testCases.map(
      (testCase) =>
        `| ${testCase.id} | Fixture test. | Linked: ${testCase.evidencePaths.map((path) => `\`${path}\``).join(', ')} |`,
    ),
  );
  return `| ID | Test | Evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
}

function traceabilityDocument(): string {
  return `${JSON.stringify(
    {
      schemaVersion: '1.0.0',
      mappings: selectedR3Contract.areas.map((area) => ({
        area: area.area,
        requirements: [...area.requirementIds],
        tests: area.testCases.map(({ id }) => id),
        evidencePaths: [
          ...new Set(area.testCases.flatMap(({ evidencePaths }) => [...evidencePaths])),
        ].sort(),
      })),
    },
    null,
    2,
  )}\n`;
}

async function repositoryFixture(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'selected-r3-evidence-'));
  roots.push(repositoryRoot);
  git(repositoryRoot, ['init', '--quiet']);
  git(repositoryRoot, ['config', 'core.autocrlf', 'false']);
  git(repositoryRoot, ['config', 'user.email', 'selected-r3@example.invalid']);
  git(repositoryRoot, ['config', 'user.name', 'Selected R3 Evidence Test']);

  const evidencePaths = new Set(
    selectedR3Contract.areas.flatMap((area) =>
      area.testCases.flatMap(({ evidencePaths }) => [...evidencePaths]),
    ),
  );
  for (const path of evidencePaths) await fixtureFile(repositoryRoot, path);
  for (const path of selectedR3Contract.selectionBasisPaths) {
    await fixtureFile(repositoryRoot, path);
  }
  await fixtureFile(repositoryRoot, 'requirements/requirements.md', requirementDocument());
  await fixtureFile(repositoryRoot, 'requirements/test-cases.md', testCaseDocument());
  await fixtureFile(repositoryRoot, 'requirements/traceability.json', traceabilityDocument());
  await fixtureFile(
    repositoryRoot,
    'hardening/r3/hardening.json',
    `${JSON.stringify(
      {
        selection: {
          status: 'approved_for_local_implementation',
          selectedOptionIds: [...selectedR3Contract.optionIds],
        },
        recommendedOptionIds: [...selectedR3Contract.optionIds],
      },
      null,
      2,
    )}\n`,
  );

  git(repositoryRoot, ['add', '--', '.']);
  git(repositoryRoot, ['commit', '--quiet', '-m', 'selected R3 fixture']);
  return repositoryRoot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('selected R3 evidence manifest', () => {
  it('makes strict traceability and selected-manifest verification mandatory', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '..', '..');
    const workingPackage = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(workingPackage.scripts).toMatchObject({
      'requirements:traceability':
        'node scripts/release/verify-traceability.mjs --require-evidence-paths',
      'r3:evidence:check': 'tsx tools/live/selectedR3EvidenceCli.ts check',
      'requirements:check': 'pnpm requirements:traceability && pnpm r3:evidence:check',
    });
  });

  it('binds the exact selected contract, regular files, collection digest, and source identity', async () => {
    const repositoryRoot = await repositoryFixture();

    const written = await writeSelectedR3EvidenceManifest(repositoryRoot);
    const verified = await verifySelectedR3EvidenceManifest(repositoryRoot);

    expect(verified).toEqual(written);
    expect(verified.contract.requirementIds).toHaveLength(16);
    expect(verified.contract.testCases).toHaveLength(16);
    expect(verified.selection.optionIds).toEqual([...selectedR3Contract.optionIds]);
    expect(verified.source).toMatchObject({ dirty: false });
    expect(verified.source.baseHead).toMatch(/^[0-9a-f]{40}$/u);
    expect(verified.source.content.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.evidence.collectionSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.evidence.files.every((file) => file.bytes > 0)).toBe(true);

    const changedPath = verified.contract.testCases[0]!.evidencePaths[0]!;
    await fixtureFile(repositoryRoot, changedPath, 'changed evidence\n');
    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('accepts only the exact clean child commit of a fully staged manifest source', async () => {
    const repositoryRoot = await repositoryFixture();
    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);

    const written = await writeSelectedR3EvidenceManifest(repositoryRoot);
    expect(written.source).toMatchObject({
      dirty: true,
      content: {
        indexDiffersFromHead: true,
        missingTrackedFileCount: 0,
        trackedWorktreeMismatchCount: 0,
        untrackedFileCount: 0,
      },
    });
    git(repositoryRoot, ['add', '--', 'hardening/r3/selected-evidence.manifest.json']);
    git(repositoryRoot, ['commit', '--quiet', '-m', 'commit selected R3 evidence']);

    const verified = await verifySelectedR3EvidenceManifest(repositoryRoot);
    expect(verified).toEqual(written);

    git(repositoryRoot, ['commit', '--quiet', '--allow-empty', '-m', 'later unrelated commit']);
    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('rejects a clean child commit containing source that was not in the staged manifest', async () => {
    const repositoryRoot = await repositoryFixture();
    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);
    await writeSelectedR3EvidenceManifest(repositoryRoot);

    await fixtureFile(repositoryRoot, 'src/unbound-feature.ts', 'export const unbound = true;\n');
    git(repositoryRoot, [
      'add',
      '--',
      'hardening/r3/selected-evidence.manifest.json',
      'src/unbound-feature.ts',
    ]);
    git(repositoryRoot, ['commit', '--quiet', '-m', 'commit drifted selected R3 evidence']);

    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('rejects a manifest left untracked when only its staged source is committed', async () => {
    const repositoryRoot = await repositoryFixture();
    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);
    await writeSelectedR3EvidenceManifest(repositoryRoot);

    git(repositoryRoot, ['commit', '--quiet', '-m', 'commit source without manifest']);
    expect(git(repositoryRoot, ['ls-files', '--others', '--exclude-standard'])).toContain(
      'hardening/r3/selected-evidence.manifest.json',
    );
    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('rejects a canonical worktree manifest that is not the blob sealed in HEAD', async () => {
    const repositoryRoot = await repositoryFixture();
    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);
    await writeSelectedR3EvidenceManifest(repositoryRoot);
    const manifestPath = join(repositoryRoot, 'hardening', 'r3', 'selected-evidence.manifest.json');
    const canonicalManifest = await readFile(manifestPath, 'utf8');

    await writeFile(manifestPath, '{}\n', 'utf8');
    git(repositoryRoot, ['add', '--', 'hardening/r3/selected-evidence.manifest.json']);
    git(repositoryRoot, ['commit', '--quiet', '-m', 'seal different manifest bytes']);
    await writeFile(manifestPath, canonicalManifest, 'utf8');

    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('accepts the sealed transition from a depth-two shallow checkout', async () => {
    const repositoryRoot = await repositoryFixture();
    git(repositoryRoot, ['commit', '--quiet', '--allow-empty', '-m', 'prior history']);
    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);
    await writeSelectedR3EvidenceManifest(repositoryRoot);
    git(repositoryRoot, ['add', '--', 'hardening/r3/selected-evidence.manifest.json']);
    git(repositoryRoot, ['commit', '--quiet', '-m', 'seal selected R3 evidence']);

    const cloneParent = await mkdtemp(join(tmpdir(), 'selected-r3-shallow-'));
    roots.push(cloneParent);
    const cloneRoot = join(cloneParent, 'repository');
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--depth',
        '2',
        '-c',
        'core.autocrlf=false',
        pathToFileURL(repositoryRoot).href,
        cloneRoot,
      ],
      { encoding: 'utf8', windowsHide: true },
    );

    expect(git(cloneRoot, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    await expect(verifySelectedR3EvidenceManifest(cloneRoot)).resolves.toBeDefined();
  }, 30_000);

  it('rejects a two-parent merge even when its tree matches the staged manifest source', async () => {
    const repositoryRoot = await repositoryFixture();
    const baseHead = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const baseTree = git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
    const sideHead = execFileSync('git', ['commit-tree', baseTree, '-p', baseHead], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: 'side parent\n',
      windowsHide: true,
    }).trim();

    await fixtureFile(repositoryRoot, 'src/staged-feature.ts', 'export const staged = true;\n');
    git(repositoryRoot, ['add', '--', 'src/staged-feature.ts']);
    await writeSelectedR3EvidenceManifest(repositoryRoot);
    git(repositoryRoot, ['add', '--', 'hardening/r3/selected-evidence.manifest.json']);
    const mergeTree = git(repositoryRoot, ['write-tree']).trim();
    const mergeHead = execFileSync(
      'git',
      ['commit-tree', mergeTree, '-p', baseHead, '-p', sideHead],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input: 'synthetic merge\n',
        windowsHide: true,
      },
    ).trim();
    git(repositoryRoot, ['reset', '--quiet', '--hard', mergeHead]);

    await expect(verifySelectedR3EvidenceManifest(repositoryRoot)).rejects.toThrow(
      /manifest is stale|does not match/u,
    );
  }, 30_000);

  it('rejects simultaneous deletion from requirements, tests, and traceability', async () => {
    const repositoryRoot = await repositoryFixture();
    const requirementsPath = join(repositoryRoot, 'requirements', 'requirements.md');
    const testsPath = join(repositoryRoot, 'requirements', 'test-cases.md');
    const traceabilityPath = join(repositoryRoot, 'requirements', 'traceability.json');
    await writeFile(
      requirementsPath,
      (await readFile(requirementsPath, 'utf8'))
        .split(/\r?\n/u)
        .filter((line) => !line.includes('FDW-OPS-008'))
        .join('\n'),
      'utf8',
    );
    await writeFile(
      testsPath,
      (await readFile(testsPath, 'utf8'))
        .split(/\r?\n/u)
        .filter((line) => !line.includes('TC-OPS-008'))
        .join('\n'),
      'utf8',
    );
    const matrix = JSON.parse(await readFile(traceabilityPath, 'utf8')) as {
      mappings: { requirements: string[]; tests: string[] }[];
    };
    matrix.mappings[0]!.requirements = matrix.mappings[0]!.requirements.filter(
      (id) => id !== 'FDW-OPS-008',
    );
    matrix.mappings[0]!.tests = matrix.mappings[0]!.tests.filter((id) => id !== 'TC-OPS-008');
    await writeFile(traceabilityPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');

    expect(() => createSelectedR3EvidenceManifest(repositoryRoot)).toThrow(
      /pinned selected-R3 contract/u,
    );
  });

  it('rejects a selected evidence path that is missing or is not a regular file', async () => {
    const repositoryRoot = await repositoryFixture();
    const evidencePath = selectedR3Contract.areas[0].testCases[0].evidencePaths[0];
    const absolutePath = join(repositoryRoot, ...evidencePath.split('/'));
    await rm(absolutePath);
    await mkdir(absolutePath);

    expect(() => validateSelectedR3Contract(repositoryRoot)).toThrow(/must be a regular file/u);
  });
});
