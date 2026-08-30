import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/live/runtimePolicyArtifact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/live/runtimePolicyArtifact')>();
  const { cp, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, relative } = await import('node:path');
  return {
    ...actual,
    async assertLiveArtifactPolicy(
      artifactRoot: string,
      target: 'production' | 'mock-staging',
      options: Readonly<{ allowSourceMaps?: boolean }> = {},
    ) {
      const scratch = await mkdtemp(join(tmpdir(), 'retention-policy-fixture-'));
      const isolatedArtifact = join(scratch, 'artifact');
      try {
        await cp(artifactRoot, isolatedArtifact, {
          recursive: true,
          filter(source) {
            const path = relative(artifactRoot, source).replaceAll('\\', '/');
            return path !== 'map_assets' && !path.startsWith('map_assets/');
          },
        });
        await actual.assertLiveArtifactPolicy(isolatedArtifact, target, options);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
});

import { compileRuntimePolicy } from '../../src/live/runtimePolicy';
import {
  candidateCommitmentSha256,
  candidateIdForProvenance,
  candidateSelectionRecordPath,
  retainMockStagingCandidate,
  type GitRunner,
  type RetainedCandidateSelection,
  type RetainedCandidateProvenance,
  type VerifyCandidateOptions,
} from '../../tools/live/retainCandidate';
import { verifyRetainedCandidate } from '../../tools/live/verifyCandidate';
import {
  renderConnectedHeaders,
  renderRuntimePolicyMetaCsp,
} from '../../tools/live/runtimePolicyArtifact';

const HEAD = 'a'.repeat(40);
const roots: string[] = [];

function digest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function filesIn(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await filesIn(root, path)));
    else paths.push(path);
  }
  return paths.sort();
}

async function candidateBytes(root: string): Promise<Map<string, Buffer>> {
  return new Map(
    await Promise.all(
      (await filesIn(root)).map(async (path) => [path, await readFile(join(root, path))] as const),
    ),
  );
}

async function directoryIdentity(root: string): Promise<{
  schemaVersion: 'sha256-file-inventory.v1';
  fileCount: number;
  totalBytes: number;
  sha256: string;
}> {
  const files = await Promise.all(
    (await filesIn(root)).map(async (path) => {
      const contents = await readFile(join(root, path));
      return { path, bytes: contents.byteLength, sha256: digest(contents) };
    }),
  );
  const hash = createHash('sha256');
  hash.update('sha256-file-inventory.v1\0');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return {
    schemaVersion: 'sha256-file-inventory.v1',
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: hash.digest('hex'),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

async function rewriteSelectionRecord(candidateDirectory: string): Promise<string> {
  const selectionPath = candidateSelectionRecordPath(candidateDirectory);
  const selection = JSON.parse(await readFile(selectionPath, 'utf8')) as Record<string, unknown>;
  const provenancePath = join(candidateDirectory, 'evidence', 'provenance.json');
  const checksumsPath = join(candidateDirectory, 'checksums.sha256');
  const provenance = JSON.parse(
    await readFile(provenancePath, 'utf8'),
  ) as RetainedCandidateProvenance;
  const provenanceContents = await readFile(provenancePath);
  const checksumContents = await readFile(checksumsPath);
  selection.candidateId = provenance.candidateId;
  selection.candidateCommitmentSha256 = candidateCommitmentSha256(provenance);
  selection.candidate = await directoryIdentity(candidateDirectory);
  selection.provenance = {
    path: 'evidence/provenance.json',
    bytes: provenanceContents.byteLength,
    sha256: digest(provenanceContents),
  };
  selection.checksums = {
    path: 'checksums.sha256',
    bytes: checksumContents.byteLength,
    sha256: digest(checksumContents),
  };
  const encoded = `${JSON.stringify(canonicalJsonValue(selection), null, 2)}\n`;
  await writeFile(selectionPath, encoded, 'utf8');
  return digest(encoded);
}

async function rewriteChecksums(root: string): Promise<void> {
  const paths = (await filesIn(root)).filter((path) => path !== 'checksums.sha256');
  const lines = await Promise.all(
    paths.map(async (path) => `${digest(await readFile(join(root, path)))}  ${path}`),
  );
  await writeFile(join(root, 'checksums.sha256'), `${lines.join('\n')}\n`, 'utf8');
}

async function anchoredVerification(
  candidateDirectory: string,
  overrides: Partial<VerifyCandidateOptions> = {},
): Promise<VerifyCandidateOptions> {
  const selectionRecordPath = candidateSelectionRecordPath(candidateDirectory);
  return {
    candidateDirectory,
    selectionRecordPath,
    expectedSelectionRecordSha256: digest(await readFile(selectionRecordPath)),
    ...overrides,
  };
}

function stableGitRunner(
  statuses: readonly Buffer[] = [Buffer.from('?? src/new.ts\0')],
): GitRunner {
  let statusCalls = 0;
  return vi.fn(async (arguments_) => {
    const command = arguments_.join(' ');
    if (command === 'rev-parse --verify HEAD') return Buffer.from(`${HEAD}\n`);
    if (command === 'rev-parse --show-object-format') return Buffer.from('sha1\n');
    if (command === 'config --type=bool --default=true core.fileMode') {
      return Buffer.from('false\n');
    }
    if (command === 'status --porcelain=v1 -z --untracked-files=all') {
      const value = statuses[Math.min(statusCalls, statuses.length - 1)];
      statusCalls += 1;
      return Buffer.from(value ?? Buffer.alloc(0));
    }
    if (command === 'diff --binary --full-index --no-ext-diff HEAD --') {
      return Buffer.from('tracked patch\n');
    }
    if (command === 'ls-files --others --exclude-standard -z') {
      return Buffer.from('src/new.ts\0');
    }
    if (command === 'ls-files --stage -z') return Buffer.alloc(0);
    throw new Error(`Unexpected Git command: ${command}`);
  });
}

async function fixture(): Promise<{ repositoryRoot: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'retained-candidate-test-'));
  roots.push(parent);
  const repositoryRoot = join(parent, 'repository');
  await mkdir(join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(join(repositoryRoot, 'src', 'new.ts'), 'export const evidence = true;\n');
  await writeJson(join(repositoryRoot, 'package.json'), {
    name: 'flight-diagnostics-workbench',
    version: '2.2.0',
  });
  const rollbackSource = resolve('rollback', 'v2.2.0');
  const rollbackDestination = join(repositoryRoot, 'rollback', 'v2.2.0');
  await mkdir(rollbackDestination, { recursive: true });
  for (const name of ['manifest.json', 'pages-build.tar.gz', 'release-checksums.sha256']) {
    await copyFile(join(rollbackSource, name), join(rollbackDestination, name));
  }

  const artifact = join(repositoryRoot, 'dist-mock-staging');
  await mkdir(join(artifact, 'client', 'assets'), { recursive: true });
  await mkdir(join(artifact, 'airspace_worker'), { recursive: true });
  await mkdir(join(artifact, 'mock_provider'), { recursive: true });
  await writeFile(
    join(artifact, 'client', 'assets', 'app.js'),
    'globalThis.dashboard = true;\n//# sourceMappingURL=app.js.map\n',
  );
  await writeJson(join(artifact, 'client', 'assets', 'app.js.map'), {
    version: 3,
    file: 'app.js',
    sources: ['src/app.ts'],
    names: [],
    mappings: '',
  });
  await writeFile(
    join(artifact, 'airspace_worker', 'index.js'),
    'export default {};\n//# sourceMappingURL=index.js.map\n',
  );
  await writeJson(join(artifact, 'airspace_worker', 'index.js.map'), {
    version: 3,
    file: 'index.js',
    sources: ['worker/index.ts'],
    names: [],
    mappings: '',
  });
  await writeFile(
    join(artifact, 'mock_provider', 'index.js'),
    "export const scenario = 'SYNTHETIC_OUTAGE';\n//# sourceMappingURL=index.js.map\n",
  );
  await writeJson(join(artifact, 'mock_provider', 'index.js.map'), {
    version: 3,
    file: 'index.js',
    sources: ['worker/mockProvider.ts'],
    names: [],
    mappings: '',
  });
  const workerConfiguration = {
    name: 'flight-airspace-mock-staging',
    main: 'index.js',
    compatibility_date: '2026-08-27',
    compatibility_flags: [],
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    assets: {
      directory: '../client',
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: ['/*'],
    },
    limits: { cpu_ms: 10, subrequests: 10 },
    vars: {
      LIVE_PROVIDER_MODE: 'mock',
      LIVE_BUILD_TARGET: 'mock-staging',
      LIVE_PROVIDER_BASE_URL: 'https://mock-provider.invalid',
      ALLOWED_ORIGINS: 'http://127.0.0.1:4174',
      APP_VERSION: '3.0.0-dev',
      RELEASE_SHA: 'local-unreleased',
      RUNTIME_POLICY_EPOCH: 'r3-local-1',
      RUNTIME_DEPLOYMENT_CLASS: 'loopback',
      RUNTIME_RELEASE_STATUS: 'unreleased',
      RUNTIME_PROVIDER_GATE_STATUS: 'closed',
      RUNTIME_PROVIDER_GATE_VALUE: 'source-disabled',
      RUNTIME_POLICY_ID: '',
    },
    durable_objects: {
      bindings: [{ name: 'REGION_FEEDS', class_name: 'RegionalFeedHub' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RegionalFeedHub'] }],
    r2_buckets: [{ binding: 'MAP_ASSETS', bucket_name: 'flight-airspace-mock-staging-maps' }],
    services: [{ binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' }],
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
    no_bundle: true,
  };
  const runtimePolicy = await compileRuntimePolicy({
    target: 'mock-staging',
    providerMode: 'mock',
    providerBaseUrl: 'https://mock-provider.invalid',
    mockBindingPresent: true,
    allowedOrigins: ['http://127.0.0.1:4174'],
    deploymentClass: 'loopback',
    release: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'local-unreleased',
      releaseStatus: 'unreleased',
      buildTarget: 'mock-staging',
    },
    policyEpoch: 'r3-local-1',
    providerGate: { status: 'closed', reason: 'source-disabled' },
  });
  workerConfiguration.vars.RUNTIME_POLICY_ID = runtimePolicy.policyId;
  const metaCsp = renderRuntimePolicyMetaCsp(runtimePolicy);
  await writeFile(
    join(artifact, 'client', 'index.html'),
    `<meta http-equiv="Content-Security-Policy" content="${metaCsp}"><main>v3 root</main>\n`,
  );
  await writeFile(
    join(artifact, 'client', 'live.html'),
    `<meta http-equiv="Content-Security-Policy" content="${metaCsp}"><main>v3 live</main>\n`,
  );
  await writeJson(join(artifact, 'airspace_worker', 'wrangler.json'), workerConfiguration);
  await writeJson(join(artifact, 'client', 'runtime-policy.json'), runtimePolicy);
  await writeFile(join(artifact, 'client', '.assetsignore'), 'wrangler.json\n.dev.vars\n');
  await writeFile(
    join(artifact, 'client', '_redirects'),
    '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n',
  );
  await writeFile(
    join(artifact, 'client', '_headers'),
    renderConnectedHeaders(workerConfiguration),
    'utf8',
  );
  await writeJson(join(artifact, 'mock_provider', 'wrangler.json'), {
    name: 'flight-airspace-mock-provider',
    main: 'index.js',
    compatibility_date: '2026-08-27',
    compatibility_flags: [],
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    vars: { MOCK_SCENARIO: 'nominal' },
    services: [],
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
    no_bundle: true,
  });

  const basemapSha256 = digest('basemap');
  const fontSha256 = digest('font');
  await writeJson(join(repositoryRoot, 'maps', 'manifest.json'), {
    schemaVersion: 'map-assets.v1',
    id: 'test-map-z12',
    totalBytes: 11,
    assets: [
      { path: 'basemap.pmtiles', bytes: 7, sha256: basemapSha256 },
      { path: 'fonts/test.pbf', bytes: 4, sha256: fontSha256 },
    ],
  });
  const mapPayload = join(repositoryRoot, '.map-data', 'test-map-z12');
  await mkdir(join(mapPayload, 'fonts'), { recursive: true });
  await writeFile(join(mapPayload, 'basemap.pmtiles'), 'basemap');
  await writeFile(join(mapPayload, 'fonts', 'test.pbf'), 'font');
  await writeJson(join(repositoryRoot, 'dist', 'sbom.cdx.json'), {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components: [],
  });
  return { repositoryRoot, parent };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('mock-staging retained candidate', () => {
  it('creates the same source-map-free candidate twice with complete provenance and checksums', async () => {
    const { repositoryRoot, parent } = await fixture();
    const fetcher = vi.fn(() => {
      throw new Error('Retained-candidate assembly must not fetch.');
    });
    vi.stubGlobal('fetch', fetcher);
    const first = join(parent, 'candidate-one');
    const second = join(parent, 'candidate-two');
    let firstSelectionEmission: RetainedCandidateSelection | undefined;
    let secondSelectionEmission: RetainedCandidateSelection | undefined;
    const firstProvenance = await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: first,
      gitRunner: stableGitRunner(),
      selectionObserver: (selection) => {
        firstSelectionEmission = selection;
      },
    });
    const secondProvenance = await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: second,
      gitRunner: stableGitRunner(),
      selectionObserver: (selection) => {
        secondSelectionEmission = selection;
      },
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(firstProvenance).toEqual(secondProvenance);
    expect(firstProvenance).toMatchObject({
      schemaVersion: 'airspace-retained-candidate.v1',
      deterministic: true,
      buildPerformed: false,
      deploymentPerformed: false,
      source: {
        head: HEAD,
        dirty: true,
        gitStatus: { format: 'porcelain-v1-z' },
      },
      application: {
        applicationName: 'flight-diagnostics-workbench',
        packageVersion: '2.2.0',
        applicationVersion: '3.0.0-dev',
        releaseSha: 'local-unreleased',
        buildTarget: 'mock-staging',
        providerMode: 'mock',
      },
      mapManifest: {
        id: 'test-map-z12',
        assetCount: 2,
        totalBytes: 11,
        payload: {
          sourcePath: '.map-data/test-map-z12',
          candidatePath: 'artifact/map_assets/test-map-z12',
          fileCount: 2,
          totalBytes: 11,
        },
      },
      rollback: {
        schemaVersion: 'fdw-approved-rollback.v1',
        releaseTag: 'v2.2.0',
        sourceRevision: 'd29e87e07586ca7790f86a65e55b2ce6e2fcc1c7',
        archive: {
          sha256: '5c0558fc4818d5f4b152d1348ac0d19cc30a2e30560ffa1f779921012dab0348',
        },
      },
      sbom: {
        candidatePath: 'evidence/sbom.cdx.json',
        format: 'CycloneDX',
        specVersion: '1.6',
      },
    });
    expect(firstProvenance.replayScenarios).toHaveLength(3);
    expect(firstProvenance.rollback.excludedPublicSourceMaps.map((file) => file.path)).toEqual([
      'assets/index-CroX61GT.js.map',
      'assets/temporalCampaign.worker-C3xl_0Ah.js.map',
    ]);
    expect(firstProvenance.replayScenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenarioId: 'nominal-regional', seed: 20_260_828 }),
        expect.objectContaining({ scenarioId: 'data-quality-gaps', seed: 20_260_829 }),
        expect.objectContaining({ scenarioId: 'provider-outage-recovery', seed: 20_260_830 }),
      ]),
    );
    for (const replay of firstProvenance.replayScenarios) {
      expect(replay.canonicalSha256).toMatch(/^[a-f0-9]{64}$/u);
    }

    const firstFiles = await filesIn(first);
    const secondFiles = await filesIn(second);
    expect(firstFiles).toEqual(secondFiles);
    expect(firstFiles).toContain('artifact/client/index.html');
    expect(firstFiles).toContain('artifact/client/live.html');
    expect(firstFiles).toContain('artifact/airspace_worker/index.js');
    expect(firstFiles).toContain('artifact/mock_provider/index.js');
    expect(firstFiles).toContain('artifact/map_assets/test-map-z12/basemap.pmtiles');
    expect(firstFiles).toContain('artifact/map_assets/test-map-z12/fonts/test.pbf');
    expect(firstFiles).toContain('artifact/client/v2.html');
    expect(firstFiles).toContain('artifact/client/Aviation-Dashboard-Project/index.html');
    expect(firstFiles).toContain('evidence/map-manifest.json');
    expect(firstFiles).toContain('evidence/rollback-v2.2.0/pages-build.tar.gz');
    expect(firstFiles).toContain('evidence/sbom.cdx.json');
    expect(firstFiles).toContain('evidence/provenance.json');
    expect(firstFiles).toContain('checksums.sha256');
    expect(firstFiles.some((path) => /\.map$/iu.test(path))).toBe(false);
    expect(await readFile(join(first, 'artifact', 'client', 'v2.html'))).toEqual(
      await readFile(join(first, 'artifact', 'client', 'Aviation-Dashboard-Project', 'index.html')),
    );
    for (const path of firstFiles) {
      expect(await readFile(join(first, path))).toEqual(await readFile(join(second, path)));
    }
    const firstSelection = await readFile(candidateSelectionRecordPath(first), 'utf8');
    const secondSelection = await readFile(candidateSelectionRecordPath(second), 'utf8');
    expect(firstSelection).toBe(secondSelection);
    expect(firstSelectionEmission).toEqual({
      candidateId: firstProvenance.candidateId,
      selectionRecordPath: candidateSelectionRecordPath(first),
      selectionRecordSha256: digest(firstSelection),
    });
    expect(secondSelectionEmission).toEqual({
      candidateId: secondProvenance.candidateId,
      selectionRecordPath: candidateSelectionRecordPath(second),
      selectionRecordSha256: digest(secondSelection),
    });
    expect(JSON.parse(firstSelection)).toMatchObject({
      schemaVersion: 'airspace-candidate-selection.v1',
      candidateId: firstProvenance.candidateId,
      candidateCommitmentSha256: candidateCommitmentSha256(firstProvenance),
      candidate: { schemaVersion: 'sha256-file-inventory.v1' },
    });
    for (const path of [
      'artifact/client/assets/app.js',
      'artifact/airspace_worker/index.js',
      'artifact/mock_provider/index.js',
    ]) {
      expect(await readFile(join(first, path), 'utf8')).not.toContain('sourceMappingURL');
    }

    const checksumLines = (await readFile(join(first, 'checksums.sha256'), 'utf8'))
      .trim()
      .split('\n');
    const retainedWithoutManifest = firstFiles.filter((path) => path !== 'checksums.sha256');
    expect(checksumLines).toHaveLength(retainedWithoutManifest.length);
    for (const path of retainedWithoutManifest) {
      const contents = await readFile(join(first, path));
      expect(checksumLines).toContain(`${digest(contents)}  ${path}`);
    }

    const beforeVerification = await candidateBytes(first);
    await expect(
      verifyRetainedCandidate(
        await anchoredVerification(first, {
          expectedSourceHead: HEAD,
          expectedTarget: 'mock-staging',
        }),
      ),
    ).resolves.toEqual(firstProvenance);
    expect(await candidateBytes(first)).toEqual(beforeVerification);
  }, 90_000);

  it('fails closed when the supported SBOM has not been generated', async () => {
    const { repositoryRoot, parent } = await fixture();
    await rm(join(repositoryRoot, 'dist', 'sbom.cdx.json'));
    const outputDirectory = join(parent, 'candidate');
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory,
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('pnpm sbom:generate');
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a mismatched mock-staging build identity', async () => {
    const { repositoryRoot, parent } = await fixture();
    const configPath = join(
      repositoryRoot,
      'dist-mock-staging',
      'airspace_worker',
      'wrangler.json',
    );
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.vars = {
      ...(config.vars as Record<string, unknown>),
      LIVE_BUILD_TARGET: 'production',
      LIVE_PROVIDER_MODE: 'disabled',
    };
    await writeJson(configPath, config);
    const outputDirectory = join(parent, 'candidate');
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory,
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow(/closed generated deployment policy|explicit mock-staging\/mock build/u);
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on a map-manifest byte-count mismatch', async () => {
    const { repositoryRoot, parent } = await fixture();
    const manifestPath = join(repositoryRoot, 'maps', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.totalBytes = 12;
    await writeJson(manifestPath, manifest);
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('totalBytes mismatch');
  });

  it.each([
    ['maps/manifest.json', { metadata: { workspace: 'C:\\Users\\local-user\\maps' } }],
    [
      'dist/sbom.cdx.json',
      { metadata: { supplier: { download: 'https://user:secret@example.test/archive' } } },
    ],
  ] as const)('rejects nested private evidence before retention: %s', async (path, addition) => {
    const { repositoryRoot, parent } = await fixture();
    const evidencePath = join(repositoryRoot, ...path.split('/'));
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Record<string, unknown>;
    Object.assign(evidence, addition);
    await writeJson(evidencePath, evidence);

    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('forbidden local path, file URL, or credential-bearing URL');
  });

  it('fails closed when the local map payload has an unmanifested asset', async () => {
    const { repositoryRoot, parent } = await fixture();
    await writeFile(
      join(repositoryRoot, '.map-data', 'test-map-z12', 'unexpected.bin'),
      'unexpected',
    );
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('does not match map manifest');
  });

  it('fails closed when the pinned approved rollback archive is altered', async () => {
    const { repositoryRoot, parent } = await fixture();
    await writeFile(
      join(repositoryRoot, 'rollback', 'v2.2.0', 'pages-build.tar.gz'),
      'not the approved archive',
    );
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('pinned SHA-256');
  });

  it('fails closed if source identity changes during assembly', async () => {
    const { repositoryRoot, parent } = await fixture();
    const gitRunner = stableGitRunner([
      Buffer.from('?? src/new.ts\0'),
      Buffer.from('?? src/new.ts\0?? src/changed.ts\0'),
    ]);
    const outputDirectory = join(parent, 'candidate');
    await expect(
      retainMockStagingCandidate({ repositoryRoot, outputDirectory, gitRunner }),
    ).rejects.toThrow('Git source identity changed');
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('refuses to overwrite an existing candidate directory', async () => {
    const { repositoryRoot, parent } = await fixture();
    const outputDirectory = join(parent, 'candidate');
    await mkdir(outputDirectory);
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory,
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow('already exists');
  });

  it('treats a child named ..retained as contained but a real parent escape as outside', async () => {
    const { repositoryRoot } = await fixture();
    const artifactRoot = join(repositoryRoot, 'dist-mock-staging');
    const misleadingChild = join(artifactRoot, '..retained');
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: misleadingChild,
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow(/dedicated evidence root|protected source or build input/u);
    await expect(readdir(misleadingChild)).rejects.toMatchObject({ code: 'ENOENT' });

    const actualParentEscape = resolve(artifactRoot, '..', '..', 'retained-parent-escape');
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: actualParentEscape,
        gitRunner: stableGitRunner(),
      }),
    ).resolves.toMatchObject({ schemaVersion: 'airspace-retained-candidate.v1' });
  }, 15_000);

  it('rejects candidate and selection outputs under repository inputs', async () => {
    const { repositoryRoot, parent } = await fixture();
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(repositoryRoot, 'src', 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow(/dedicated evidence root|protected source or build input/u);
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        selectionRecordPath: join(
          repositoryRoot,
          'dist-mock-staging',
          'client',
          'assets',
          'selection.js',
        ),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow(/dedicated evidence root|protected source or build input/u);
  });

  it('requires a trusted selection anchor and an exact checkout identity', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    const provenance = await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });

    await expect(verifyRetainedCandidate({ candidateDirectory })).rejects.toThrow(
      'externally supplied selection-record SHA-256 or candidate id',
    );
    await expect(
      verifyRetainedCandidate({
        candidateDirectory,
        expectedCandidateId: provenance.candidateId,
        expectedSourceIdentity: provenance.source,
      }),
    ).resolves.toEqual(provenance);
    await expect(
      verifyRetainedCandidate(
        await anchoredVerification(candidateDirectory, {
          expectedSourceIdentity: {
            ...provenance.source,
            contentSha256: 'b'.repeat(64),
          },
        }),
      ),
    ).rejects.toThrow('does not exactly match the expected checkout');
  });

  it('rejects a fully recomputed candidate, provenance, and checksum rewrite under the unchanged anchor', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    const anchored = await anchoredVerification(candidateDirectory);
    const originalSelection = await readFile(candidateSelectionRecordPath(candidateDirectory));
    await writeFile(
      join(candidateDirectory, 'artifact', 'client', 'index.html'),
      '<main>fully recomputed tamper</main>\n',
    );
    const provenancePath = join(candidateDirectory, 'evidence', 'provenance.json');
    const provenance = JSON.parse(
      await readFile(provenancePath, 'utf8'),
    ) as RetainedCandidateProvenance;
    const artifact = await directoryIdentity(join(candidateDirectory, 'artifact'));
    provenance.retainedArtifact = {
      path: 'artifact',
      fileCount: artifact.fileCount,
      totalBytes: artifact.totalBytes,
      sha256: artifact.sha256,
    };
    provenance.candidateId = candidateIdForProvenance(provenance);
    await writeJson(provenancePath, provenance);
    await rewriteChecksums(candidateDirectory);

    expect(provenance.candidateId).toBe(candidateIdForProvenance(provenance));
    expect(await readFile(candidateSelectionRecordPath(candidateDirectory))).toEqual(
      originalSelection,
    );
    await expect(verifyRetainedCandidate(anchored)).rejects.toThrow(
      'does not match the trusted selection record',
    );
  });

  it('read-only verification rejects a public source map before trusting checksums', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    await writeFile(
      join(candidateDirectory, 'artifact', 'client', 'assets', 'public.js.map'),
      '{}',
    );
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('exposes a public source map');
  });

  it('read-only verification rejects a missing checksummed artifact', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    await rm(join(candidateDirectory, 'artifact', 'client', 'live.html'));
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('checksum allowlist has an extra, missing, reordered, or mismatched file');
  });

  it('read-only verification rejects altered rollback route bytes even if checksummed', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    await writeFile(join(candidateDirectory, 'artifact', 'client', 'v2.html'), 'altered rollback');
    await rewriteChecksums(candidateDirectory);
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('rollback runtime bytes do not match');
  });

  it('read-only verification rejects changed retained map bytes even if checksummed', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    await writeFile(
      join(candidateDirectory, 'artifact', 'map_assets', 'test-map-z12', 'basemap.pmtiles'),
      'tamper!',
    );
    await rewriteChecksums(candidateDirectory);
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('mismatched map asset');
  });

  it('read-only verification rejects a source-map reference even if it is checksummed', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    const appPath = join(candidateDirectory, 'artifact', 'client', 'assets', 'app.js');
    await writeFile(appPath, 'globalThis.dashboard = true;\n//# sourceMappingURL=public.js.map\n');
    await rewriteChecksums(candidateDirectory);
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('exposes a source-map reference');
  });

  it('rejects forbidden generated deployment metadata before candidate copying', async () => {
    const { repositoryRoot, parent } = await fixture();
    const workerPath = join(
      repositoryRoot,
      'dist-mock-staging',
      'airspace_worker',
      'wrangler.json',
    );
    const worker = JSON.parse(await readFile(workerPath, 'utf8')) as Record<string, unknown>;
    worker.userConfigPath = 'C:\\Users\\local-user\\workspace\\wrangler.jsonc';
    await writeJson(workerPath, worker);
    await expect(
      retainMockStagingCandidate({
        repositoryRoot,
        outputDirectory: join(parent, 'candidate'),
        gitRunner: stableGitRunner(),
      }),
    ).rejects.toThrow(/forbidden/u);
  });

  it('rejects semantic path leakage after copy even when checksums are recomputed', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    const workerPath = join(candidateDirectory, 'artifact', 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(workerPath, 'utf8')) as {
      vars: Record<string, unknown>;
    };
    worker.vars.SENTINEL = '/home/local-user/private-workspace';
    await writeJson(workerPath, worker);
    await rewriteChecksums(candidateDirectory);
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow(/forbidden/u);
  });

  it('rejects nested private evidence during verification even under a recomputed record', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    const manifestPath = join(candidateDirectory, 'evidence', 'map-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.metadata = { workspace: '/home/local-user/private-map-cache' };
    await writeJson(manifestPath, manifest);
    const provenancePath = join(candidateDirectory, 'evidence', 'provenance.json');
    const provenance = JSON.parse(
      await readFile(provenancePath, 'utf8'),
    ) as RetainedCandidateProvenance;
    provenance.mapManifest.sha256 = digest(await readFile(manifestPath));
    provenance.candidateId = candidateIdForProvenance(provenance);
    await writeJson(provenancePath, provenance);
    await rewriteChecksums(candidateDirectory);
    const expectedSelectionRecordSha256 = await rewriteSelectionRecord(candidateDirectory);

    await expect(
      verifyRetainedCandidate({
        candidateDirectory,
        expectedSelectionRecordSha256,
      }),
    ).rejects.toThrow('forbidden local path, file URL, or credential-bearing URL');
  });

  it('read-only verification enforces expected source and recomputed replay identities', async () => {
    const { repositoryRoot, parent } = await fixture();
    const candidateDirectory = join(parent, 'candidate');
    await retainMockStagingCandidate({
      repositoryRoot,
      outputDirectory: candidateDirectory,
      gitRunner: stableGitRunner(),
    });
    await expect(
      verifyRetainedCandidate(
        await anchoredVerification(candidateDirectory, {
          expectedSourceHead: 'b'.repeat(40),
        }),
      ),
    ).rejects.toThrow('does not match expected');

    const provenancePath = join(candidateDirectory, 'evidence', 'provenance.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as {
      replayScenarios: Array<{ canonicalSha256: string }>;
    };
    const firstReplay = provenance.replayScenarios[0];
    if (firstReplay === undefined) throw new Error('Fixture candidate has no replay evidence.');
    firstReplay.canonicalSha256 = 'b'.repeat(64);
    await writeJson(provenancePath, provenance);
    await rewriteChecksums(candidateDirectory);
    await rewriteSelectionRecord(candidateDirectory);
    await expect(
      verifyRetainedCandidate(await anchoredVerification(candidateDirectory)),
    ).rejects.toThrow('replay scenario identities do not match');
  });
});
