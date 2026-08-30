import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureArtifactTreeIdentity,
  completeLoadArtifactInput,
  completeStagedLoadArtifactInput,
  disposeStagedLoadArtifactInput,
  resolveLoadArtifactInput,
  resolveLoadHarnessOutputPath,
  stageLoadArtifactInput,
} from '../../tools/live/loadArtifactInput';
import { loadGeneratedWorkerConfig } from '../../tools/live/loadHarness';
import type { RetainedCandidateProvenance, SourceIdentity } from '../../tools/live/retainCandidate';

const roots: string[] = [];
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const HEAD = '1'.repeat(40);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'load-artifact-'));
  roots.push(root);
  return root;
}

function sourceIdentity(overrides: Partial<SourceIdentity> = {}): SourceIdentity {
  return {
    schemaVersion: 'git-working-tree-content.v2',
    head: HEAD,
    dirty: true,
    gitStatus: { format: 'porcelain-v1-z', bytes: 1, sha256: SHA_A },
    trackedPatch: { format: 'git-diff-binary-full-index', bytes: 0, sha256: SHA_A },
    trackedContent: {
      format: 'git-index-worktree-inventory.v2',
      objectFormat: 'sha1',
      fileModeEnforced: false,
      fileCount: 1,
      missingFileCount: 0,
      totalBytes: 1,
      executableModeMismatchCount: 0,
      indexMismatchCount: 0,
      sha256: SHA_A,
    },
    untrackedContent: { fileCount: 0, totalBytes: 0, sha256: SHA_A },
    contentSha256: SHA_B,
    ...overrides,
  };
}

function validWorkerConfig() {
  return {
    name: 'flight-airspace-mock-staging',
    main: 'index.js',
    compatibility_date: '2026-08-27',
    compatibility_flags: [],
    vars: {
      LIVE_PROVIDER_MODE: 'mock',
      LIVE_BUILD_TARGET: 'mock-staging',
      LIVE_PROVIDER_BASE_URL: 'https://mock-provider.invalid',
      RELEASE_SHA: 'local-unreleased',
    },
    assets: {
      directory: '../client',
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: ['/api/*', '/map-assets/*'],
    },
    limits: { cpu_ms: 10, subrequests: 10 },
    durable_objects: {
      bindings: [{ name: 'REGION_FEEDS', class_name: 'RegionalFeedHub' }],
    },
    r2_buckets: [{ binding: 'MAP_ASSETS', bucket_name: 'mock-map-bucket' }],
    services: [{ binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' }],
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RegionalFeedHub'] }],
  };
}

async function writeArtifact(root: string): Promise<string> {
  const artifact = join(root, 'dist-mock-staging');
  await mkdir(join(artifact, 'airspace_worker'), { recursive: true });
  await mkdir(join(artifact, 'client'), { recursive: true });
  await mkdir(join(artifact, 'mock_provider'), { recursive: true });
  await writeFile(
    join(artifact, 'airspace_worker', 'wrangler.json'),
    JSON.stringify(validWorkerConfig()),
  );
  await writeFile(join(artifact, 'airspace_worker', 'index.js'), 'export default {};\n');
  await writeFile(join(artifact, 'client', 'index.html'), '<!doctype html><title>Live</title>');
  await writeFile(join(artifact, 'mock_provider', 'wrangler.json'), '{"main":"index.js"}\n');
  await writeFile(join(artifact, 'mock_provider', 'index.js'), 'export default {};\n');
  return artifact;
}

function retainedProvenance(
  source: SourceIdentity,
  artifactSha256: string,
  overrides: Record<string, unknown> = {},
): RetainedCandidateProvenance {
  return {
    candidateId: `mock-staging-${'2'.repeat(24)}`,
    source,
    application: {
      releaseSha: source.head,
      buildTarget: 'mock-staging',
      providerMode: 'mock',
    },
    retainedArtifact: { path: 'artifact', sha256: artifactSha256 },
    ...overrides,
  } as unknown as RetainedCandidateProvenance;
}

describe('load-harness artifact input', () => {
  it('resolves and hashes an explicit complete raw artifact without exposing absolute paths', async () => {
    const repository = await temporaryRepository();
    const artifact = await writeArtifact(repository);

    const resolved = await resolveLoadArtifactInput(
      { mode: 'artifact-root', path: 'dist-mock-staging' },
      repository,
      sourceIdentity(),
    );
    const secondIdentity = await captureArtifactTreeIdentity(artifact);

    expect(resolved).toMatchObject({
      mode: 'artifact-root',
      requestedPath: 'dist-mock-staging',
      artifactPath: 'dist-mock-staging',
      candidateBefore: null,
      candidateRoot: null,
    });
    expect(resolved.requestedPath).not.toContain(repository);
    expect(resolved.artifactPath).not.toContain(repository);
    expect(resolved.identityBefore).toEqual(secondIdentity);
    expect(resolved.identityBefore).toMatchObject({
      schemaVersion: 'sha256-file-inventory.v1',
      fileCount: 5,
    });

    await writeFile(
      join(artifact, 'client', 'index.html'),
      '<!doctype html><title>Changed</title>',
    );
    const changed = await captureArtifactTreeIdentity(artifact);
    const completed = await completeLoadArtifactInput(resolved, sourceIdentity());
    expect(changed.sha256).not.toBe(resolved.identityBefore.sha256);
    expect(completed).toMatchObject({
      unchanged: false,
      gate: { id: 'immutable-artifact-input', passed: false },
    });
  });

  it('executes from a private hash-matched snapshot and detects snapshot mutation', async () => {
    const repository = await temporaryRepository();
    const artifact = await writeArtifact(repository);
    const resolved = await resolveLoadArtifactInput(
      { mode: 'artifact-root', path: 'dist-mock-staging' },
      repository,
      sourceIdentity(),
    );
    const staged = await stageLoadArtifactInput(resolved);

    try {
      expect(staged.artifactRoot).not.toBe(artifact);
      expect(staged.identityBefore).toEqual(resolved.identityBefore);

      await writeFile(
        join(artifact, 'airspace_worker', 'wrangler.json'),
        JSON.stringify({ ...validWorkerConfig(), main: '../outside.js' }),
      );
      await expect(loadGeneratedWorkerConfig(staged)).resolves.toMatchObject({ main: 'index.js' });

      await writeFile(join(staged.clientRoot, 'index.html'), '<title>mutated snapshot</title>');
      await expect(completeStagedLoadArtifactInput(staged)).resolves.toMatchObject({
        unchanged: false,
        gate: { id: 'immutable-execution-snapshot', passed: false },
      });
    } finally {
      await disposeStagedLoadArtifactInput(staged);
    }
    await expect(lstat(staged.stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects roots outside the repository, the repository itself, and incomplete topology', async () => {
    const repository = await temporaryRepository();
    await writeArtifact(repository);

    await expect(
      resolveLoadArtifactInput({ mode: 'artifact-root', path: '..' }, repository, sourceIdentity()),
    ).rejects.toThrow('Artifact root must be a directory beneath the repository root.');
    await expect(
      resolveLoadArtifactInput({ mode: 'artifact-root', path: '.' }, repository, sourceIdentity()),
    ).rejects.toThrow('Artifact root must be a directory beneath the repository root.');

    await rm(join(repository, 'dist-mock-staging', 'client'), { recursive: true });
    await expect(
      resolveLoadArtifactInput(
        { mode: 'artifact-root', path: 'dist-mock-staging' },
        repository,
        sourceIdentity(),
      ),
    ).rejects.toThrow('Generated client root is missing');
  });

  it('rejects nested symbolic links or junctions in the selected tree', async () => {
    const repository = await temporaryRepository();
    const artifact = await writeArtifact(repository);
    const target = join(repository, 'link-target');
    await mkdir(target);
    await writeFile(join(target, 'payload.txt'), 'payload');
    await symlink(
      target,
      join(artifact, 'client', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      resolveLoadArtifactInput(
        { mode: 'artifact-root', path: 'dist-mock-staging' },
        repository,
        sourceIdentity(),
      ),
    ).rejects.toThrow('Load artifacts cannot contain symbolic links or junctions');
  });

  it('rejects selecting a retained artifact child as an unverified raw root', async () => {
    const repository = await temporaryRepository();
    const rawArtifact = await writeArtifact(repository);
    const candidate = join(repository, 'candidate');
    await mkdir(join(candidate, 'evidence'), { recursive: true });
    await writeFile(join(candidate, 'checksums.sha256'), `${SHA_A}  artifact/client/index.html\n`);
    await writeFile(join(candidate, 'evidence', 'provenance.json'), '{}\n');
    await cp(rawArtifact, join(candidate, 'artifact'), { recursive: true });

    await expect(
      resolveLoadArtifactInput(
        { mode: 'artifact-root', path: 'candidate/artifact' },
        repository,
        sourceIdentity(),
      ),
    ).rejects.toThrow(/symbolic link|candidate artifact must be selected/iu);
  });

  it('verifies a clean exact-source retained candidate before and after execution', async () => {
    const repository = await temporaryRepository();
    const rawArtifact = await writeArtifact(repository);
    const candidate = join(repository, 'candidate');
    await mkdir(candidate);
    await cp(rawArtifact, join(candidate, 'artifact'), { recursive: true });
    const cleanSource = sourceIdentity({
      dirty: false,
      gitStatus: { format: 'porcelain-v1-z', bytes: 0, sha256: SHA_A },
    });
    const identity = await captureArtifactTreeIdentity(rawArtifact);
    const provenance = retainedProvenance(cleanSource, identity.sha256);
    const verifyCandidate = vi.fn(async () => provenance);

    const resolved = await resolveLoadArtifactInput(
      { mode: 'retained-candidate', path: 'candidate' },
      repository,
      cleanSource,
      {
        verifyCandidate,
        selectionExpectation: { expectedSelectionRecordSha256: SHA_A },
      },
    );
    const completed = await completeLoadArtifactInput(resolved, cleanSource, { verifyCandidate });

    expect(verifyCandidate).toHaveBeenCalledTimes(2);
    expect(verifyCandidate).toHaveBeenCalledWith({
      candidateDirectory: candidate,
      expectedSourceHead: HEAD,
      expectedSourceIdentity: cleanSource,
      expectedTarget: 'mock-staging',
      expectedSelectionRecordSha256: SHA_A,
    });
    expect(resolved).toMatchObject({
      mode: 'retained-candidate',
      requestedPath: 'candidate',
      artifactPath: 'candidate/artifact',
      candidateBefore: {
        candidateId: provenance.candidateId,
        sourceHead: HEAD,
        releaseSha: HEAD,
        retainedArtifactSha256: identity.sha256,
      },
    });
    expect(completed).toMatchObject({
      unchanged: true,
      gate: { id: 'immutable-artifact-input', passed: true },
    });
  });

  it('rejects candidate-bound load execution without an external selection anchor', async () => {
    const repository = await temporaryRepository();
    const rawArtifact = await writeArtifact(repository);
    const candidate = join(repository, 'candidate');
    await mkdir(candidate);
    await cp(rawArtifact, join(candidate, 'artifact'), { recursive: true });
    const cleanSource = sourceIdentity({
      dirty: false,
      gitStatus: { format: 'porcelain-v1-z', bytes: 0, sha256: SHA_A },
    });

    await expect(
      resolveLoadArtifactInput(
        { mode: 'retained-candidate', path: 'candidate' },
        repository,
        cleanSource,
        { verifyCandidate: vi.fn() },
      ),
    ).rejects.toThrow('externally supplied selection-record SHA-256 or candidate id');
  });

  it('rejects dirty, content-mismatched, or unreleased candidate provenance', async () => {
    const repository = await temporaryRepository();
    const rawArtifact = await writeArtifact(repository);
    const candidate = join(repository, 'candidate');
    await mkdir(candidate);
    await cp(rawArtifact, join(candidate, 'artifact'), { recursive: true });
    const cleanSource = sourceIdentity({
      dirty: false,
      gitStatus: { format: 'porcelain-v1-z', bytes: 0, sha256: SHA_A },
    });
    const identity = await captureArtifactTreeIdentity(rawArtifact);

    for (const provenance of [
      retainedProvenance({ ...cleanSource, dirty: true }, identity.sha256),
      retainedProvenance({ ...cleanSource, contentSha256: SHA_A }, identity.sha256),
      retainedProvenance(cleanSource, identity.sha256, {
        application: {
          releaseSha: 'local-unreleased',
          buildTarget: 'mock-staging',
          providerMode: 'mock',
        },
      }),
    ]) {
      await expect(
        resolveLoadArtifactInput(
          { mode: 'retained-candidate', path: 'candidate' },
          repository,
          cleanSource,
          {
            verifyCandidate: async () => provenance,
            selectionExpectation: { expectedSelectionRecordSha256: SHA_A },
          },
        ),
      ).rejects.toThrow();
    }
  });

  it('validates generated Worker paths against the selected artifact root', async () => {
    const repository = await temporaryRepository();
    const artifact = await writeArtifact(repository);
    const resolved = await resolveLoadArtifactInput(
      { mode: 'artifact-root', path: 'dist-mock-staging' },
      repository,
      sourceIdentity(),
    );

    await expect(loadGeneratedWorkerConfig(resolved)).resolves.toMatchObject({ main: 'index.js' });

    await writeFile(
      join(artifact, 'airspace_worker', 'wrangler.json'),
      JSON.stringify({ ...validWorkerConfig(), main: '../outside.js' }),
    );
    await expect(loadGeneratedWorkerConfig(resolved)).rejects.toThrow(
      'Generated Worker entrypoint is outside the expected build topology.',
    );

    await writeFile(
      join(artifact, 'airspace_worker', 'wrangler.json'),
      JSON.stringify({
        ...validWorkerConfig(),
        assets: { ...validWorkerConfig().assets, directory: '../../outside-client' },
      }),
    );
    await expect(loadGeneratedWorkerConfig(resolved)).rejects.toThrow(
      'Generated Worker asset routing is not fail closed.',
    );
  });

  it('confines report output to a normalized file beneath the dedicated load-results root', async () => {
    const repository = await temporaryRepository();
    await writeArtifact(repository);
    const artifactRoot = join(repository, 'dist-mock-staging');

    await expect(
      resolveLoadHarnessOutputPath('dist-mock-staging/report.json', repository, [artifactRoot]),
    ).rejects.toThrow('Output path must be beneath test-results/live-load.');
    await expect(
      resolveLoadHarnessOutputPath('tools/live/loadHarness.ts', repository, [artifactRoot]),
    ).rejects.toThrow('Output path must be beneath test-results/live-load.');
    await expect(
      resolveLoadHarnessOutputPath('test-results/../dist-mock-staging/report.json', repository, [
        artifactRoot,
      ]),
    ).rejects.toThrow('Output path must be a normalized repository-relative file path.');
    await expect(
      resolveLoadHarnessOutputPath(resolve(repository, 'report.json'), repository, [artifactRoot]),
    ).rejects.toThrow('Output path must be repository-relative.');
    await expect(
      resolveLoadHarnessOutputPath('test-results/live-load/report.json.', repository, [
        artifactRoot,
      ]),
    ).rejects.toThrow('Output path must be a normalized repository-relative file path.');

    await expect(
      resolveLoadHarnessOutputPath('test-results/live-load/report.json', repository, [
        artifactRoot,
      ]),
    ).resolves.toMatchObject({ reportPath: 'test-results/live-load/report.json' });
  });

  it('rejects a symbolic-link or junction ancestor inside the dedicated output root', async () => {
    const repository = await temporaryRepository();
    await writeArtifact(repository);
    const artifactRoot = join(repository, 'dist-mock-staging');
    const outputRoot = join(repository, 'test-results', 'live-load');
    const realOutput = join(outputRoot, 'real-output');
    await mkdir(realOutput, { recursive: true });

    await symlink(
      realOutput,
      join(outputRoot, 'linked-output'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      resolveLoadHarnessOutputPath('test-results/live-load/linked-output/report.json', repository, [
        artifactRoot,
      ]),
    ).rejects.toThrow('Output path cannot traverse a symbolic link or junction.');
  });

  it('rejects output beneath a canonically resolved protected root', async () => {
    const repository = await temporaryRepository();
    const protectedRoot = join(repository, 'test-results', 'live-load', 'protected');
    const protectedAlias = join(repository, 'protected-output-alias');
    await mkdir(protectedRoot, { recursive: true });
    await symlink(protectedRoot, protectedAlias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      resolveLoadHarnessOutputPath('test-results/live-load/protected/report.json', repository, [
        protectedAlias,
      ]),
    ).rejects.toThrow('Output path must not modify the selected artifact or retained candidate.');
  });

  it('rejects a tracked file even inside the dedicated output root', async () => {
    const repository = await temporaryRepository();
    const outputDirectory = join(repository, 'test-results', 'live-load');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'tracked.json'), '{}\n');
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    execFileSync('git', ['add', '--', 'test-results/live-load/tracked.json'], {
      cwd: repository,
    });

    await expect(
      resolveLoadHarnessOutputPath('test-results/live-load/tracked.json', repository, []),
    ).rejects.toThrow('Output path must not overwrite a tracked repository file.');
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a Windows case-variant alias of a tracked output file',
    async () => {
      const repository = await temporaryRepository();
      const outputDirectory = join(repository, 'test-results', 'live-load');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'tracked.json'), '{}\n');
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      execFileSync('git', ['add', '--', 'test-results/live-load/tracked.json'], {
        cwd: repository,
      });

      await expect(
        resolveLoadHarnessOutputPath('test-results/live-load/TRACKED.json', repository, []),
      ).rejects.toThrow('Output path must not overwrite a tracked repository file.');
    },
  );
});
