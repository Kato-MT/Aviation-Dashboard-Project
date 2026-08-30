import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertLiveArtifactPolicy,
  assertPrivacySafeTextArtifact,
  finalizeLiveBuildArtifact,
  renderConnectedHeaders,
  renderRuntimePolicyMetaCsp,
  renderRuntimePolicyHeaders,
  sanitizeGeneratedWrangler,
} from '../../tools/live/runtimePolicyArtifact';
import { compileRuntimePolicy } from '../../src/live/runtimePolicy';

const roots: string[] = [];

function airspaceWorker(target: 'production' | 'mock-staging') {
  const synthetic = target === 'mock-staging';
  return {
    configPath: 'C:\\Users\\local-user\\workspace\\wrangler.jsonc',
    userConfigPath: 'C:\\Users\\local-user\\workspace\\wrangler.jsonc',
    topLevelName: 'plugin-only-metadata',
    name: `flight-airspace-${target}`,
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
      LIVE_PROVIDER_MODE: synthetic ? 'mock' : 'disabled',
      LIVE_BUILD_TARGET: target,
      LIVE_PROVIDER_BASE_URL: synthetic ? 'https://mock-provider.invalid' : 'https://api.adsb.lol',
      ALLOWED_ORIGINS: 'http://127.0.0.1:4174',
      APP_VERSION: '3.0.0-dev',
      RELEASE_SHA: 'local-unreleased',
      RUNTIME_POLICY_EPOCH: 'r3-local-1',
      RUNTIME_DEPLOYMENT_CLASS: 'loopback',
      RUNTIME_RELEASE_STATUS: 'unreleased',
      RUNTIME_PROVIDER_GATE_STATUS: 'closed',
      RUNTIME_PROVIDER_GATE_VALUE: 'source-disabled',
      RUNTIME_POLICY_ID: 'a'.repeat(64),
    },
    durable_objects: {
      bindings: [{ name: 'REGION_FEEDS', class_name: 'RegionalFeedHub' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RegionalFeedHub'] }],
    r2_buckets: [{ binding: 'MAP_ASSETS', bucket_name: `flight-airspace-${target}-maps` }],
    services: synthetic
      ? [{ binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' }]
      : [],
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
    no_bundle: true,
    workflows: [],
  };
}

function mockProvider() {
  return {
    topLevelName: 'plugin-only-metadata',
    name: 'flight-airspace-mock-provider',
    main: 'index.js',
    compatibility_date: '2026-08-27',
    compatibility_flags: [],
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    vars: { MOCK_SCENARIO: 'nominal' },
    services: [],
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
    no_bundle: true,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function artifact(target: 'production' | 'mock-staging'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'live-artifact-policy-'));
  roots.push(root);
  await mkdir(join(root, 'client', 'assets'), { recursive: true });
  await mkdir(join(root, 'airspace_worker'), { recursive: true });
  await writeFile(join(root, 'airspace_worker', 'index.js'), 'export default {};\n', 'utf8');
  const worker = airspaceWorker(target);
  const policy = await compileRuntimePolicy({
    target,
    providerMode: target === 'mock-staging' ? 'mock' : 'disabled',
    providerBaseUrl:
      target === 'mock-staging' ? 'https://mock-provider.invalid' : 'https://api.adsb.lol',
    mockBindingPresent: target === 'mock-staging',
    allowedOrigins: ['http://127.0.0.1:4174'],
    deploymentClass: 'loopback',
    release: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'local-unreleased',
      releaseStatus: 'unreleased',
      buildTarget: target,
    },
    policyEpoch: 'r3-local-1',
    providerGate: { status: 'closed', reason: 'source-disabled' },
  });
  const html = `<meta http-equiv="Content-Security-Policy" content="${renderRuntimePolicyMetaCsp(policy)}"><main>Live</main>\n`;
  await writeFile(join(root, 'client', 'index.html'), html, 'utf8');
  await writeFile(join(root, 'client', 'live.html'), html, 'utf8');
  (worker.vars as Record<string, unknown>).RUNTIME_POLICY_ID = policy.policyId;
  await writeJson(join(root, 'airspace_worker', 'wrangler.json'), worker);
  await writeJson(join(root, 'client', 'runtime-policy.json'), policy);
  await writeFile(join(root, 'client', '_headers'), renderRuntimePolicyHeaders(policy), 'utf8');
  await writeFile(join(root, 'client', '.assetsignore'), 'wrangler.json\n.dev.vars\n', 'utf8');
  await writeFile(
    join(root, 'client', '_redirects'),
    '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n',
    'utf8',
  );
  if (target === 'mock-staging') {
    await mkdir(join(root, 'mock_provider'), { recursive: true });
    await writeFile(
      join(root, 'mock_provider', 'index.js'),
      "export const scenario = 'SYNTHETIC_OUTAGE';\n",
      'utf8',
    );
    await writeJson(join(root, 'mock_provider', 'wrangler.json'), mockProvider());
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('connected artifact policy', () => {
  it('reconstructs generated Wrangler metadata from an explicit allowlist', () => {
    const sanitized = sanitizeGeneratedWrangler(airspaceWorker('production'), 'airspace-worker');
    expect(sanitized).not.toHaveProperty('configPath');
    expect(sanitized).not.toHaveProperty('userConfigPath');
    expect(sanitized).not.toHaveProperty('topLevelName');
    expect(sanitized).not.toHaveProperty('workflows');
    expect(Object.keys(sanitized)).toEqual([
      'name',
      'main',
      'compatibility_date',
      'compatibility_flags',
      'rules',
      'assets',
      'limits',
      'vars',
      'durable_objects',
      'migrations',
      'r2_buckets',
      'services',
      'observability',
      'no_bundle',
    ]);
  });

  it.each(['production', 'mock-staging'] as const)(
    'finalizes and verifies a sanitized %s artifact',
    async (target) => {
      const root = await artifact(target);
      await finalizeLiveBuildArtifact(root, target);
      await expect(assertLiveArtifactPolicy(root, target)).resolves.toBeUndefined();
      const worker = JSON.parse(
        await readFile(join(root, 'airspace_worker', 'wrangler.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(worker).not.toHaveProperty('configPath');
      expect(worker).not.toHaveProperty('userConfigPath');
      expect((worker.assets as { run_worker_first: string[] }).run_worker_first).toEqual(['/*']);
      const headers = await readFile(join(root, 'client', '_headers'), 'utf8');
      expect(headers).toBe(renderConnectedHeaders(worker));
      expect(headers).toContain("frame-ancestors 'none'");
      expect(headers).toContain("worker-src 'self' blob: data:");
      expect(headers).toContain("img-src 'self' data: blob:");
      expect(headers).toContain('ws://127.0.0.1:*');
      expect(headers).toContain('X-Frame-Options: DENY');
      expect(headers).toContain('Permissions-Policy:');
      expect(headers).not.toContain('Strict-Transport-Security');
    },
  );

  it('rejects a retained artifact whose canonical runtime limits drift after finalization', async () => {
    const root = await artifact('mock-staging');
    await finalizeLiveBuildArtifact(root, 'mock-staging');
    const policyPath = join(root, 'client', 'runtime-policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
      limits: { browser: { bundle: { initialShellGzipBytes: number } } };
    };
    policy.limits.browser.bundle.initialShellGzipBytes += 1;
    await writeJson(policyPath, policy);

    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(
      /runtime-policy|exact compiled policy|manifest/u,
    );
  });

  it.each([
    ['Windows backslash path', 'C:\\Users\\local-user\\workspace'],
    ['Windows forward path', 'C:/Users/local-user/workspace'],
    ['UNC path', '\\\\server\\share\\workspace'],
    ['extended Windows path', '\\\\?\\C:\\Users\\local-user\\workspace'],
    ['extended UNC path', '\\\\?\\UNC\\server\\share\\workspace'],
    ['Windows device path', '\\\\.\\C:\\Users\\local-user\\workspace'],
    ['forward-slash UNC path', '//server/share/workspace'],
    ['POSIX home path', '/home/local-user/workspace'],
    ['macOS home path', '/Users/local-user/workspace'],
    ['POSIX root path', '/root/private-workspace'],
    ['mounted Windows home path', '/mnt/c/Users/local-user/workspace'],
    ['uppercase mounted Windows home path', '/mnt/C/Users/local-user/workspace'],
    ['wrapped UNC path', 'webpack:////server/share/workspace'],
    ['bundler container root', 'webpack:///usr/src/app/workspace'],
    ['POSIX temp path', '/tmp/local-user/workspace'],
    ['file URL', 'file:///C:/Users/local-user/workspace'],
    ['percent-encoded file URL', 'file%3A%2F%2F%2FC%3A%2FUsers%2Flocal-user%2Fworkspace'],
    ['credential URL', 'https://user:password@example.invalid/path'],
    ['prefixed credential URL', 'upstream=https://user:password@example.invalid/path'],
    ['protocol-relative credential URL', '//alice:password@example.invalid/path'],
  ])('rejects a nested %s sentinel before use', async (_label, sentinel) => {
    const root = await artifact('mock-staging');
    const path = join(root, 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete worker.configPath;
    delete worker.userConfigPath;
    delete worker.topLevelName;
    delete worker.workflows;
    (worker.vars as Record<string, unknown>).SENTINEL = sentinel;
    await writeJson(path, worker);
    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(/forbidden/u);
  });

  it('rejects nested aliases and unknown top-level deployment fields', async () => {
    const root = await artifact('mock-staging');
    await finalizeLiveBuildArtifact(root, 'mock-staging');
    const path = join(root, 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    worker.futurePluginMetadata = { userConfigPath: '\\u0043:\\u005cUsers\\u005clocal-user' };
    await writeJson(path, worker);
    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(/forbidden/u);
  });

  it.each([
    ['main', '../../tests/support/mockProvider.ts'],
    ['assets', { directory: '../..', binding: 'ASSETS' }],
    ['rules', [{ type: 'ESModule', globs: ['../../**/*.ts'] }]],
  ])('rejects an out-of-root generated Worker %s before Wrangler use', async (field, value) => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    const path = join(root, 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    worker[field] = value;
    await writeJson(path, worker);
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /closed generated deployment policy/u,
    );
  });

  it('rejects public source maps and source-map references', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(join(root, 'client', 'app.js.map'), '{}\n', 'utf8');
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(/source map/u);
    await rm(join(root, 'client', 'app.js.map'));
    await writeFile(
      join(root, 'client', 'assets', 'app.js'),
      'globalThis.app = true;\n//# sourceMappingURL=app.js.map\n',
      'utf8',
    );
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /source-map reference/u,
    );
  });

  it('permits only expected adjacent raw source maps during the private pre-retention scan', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(join(root, 'client', 'assets', 'app.js'), 'export const app = true;\n', 'utf8');
    await writeJson(join(root, 'client', 'assets', 'app.js.map'), {
      version: 3,
      file: 'app.js',
      sources: ['src/app.ts'],
      names: [],
      mappings: '',
    });
    await expect(
      assertLiveArtifactPolicy(root, 'production', { allowSourceMaps: true }),
    ).resolves.toBeUndefined();
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(/source map/u);
  });

  it('rejects private source maps that disclose nested local paths', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeJson(join(root, 'client', 'assets', 'app.js.map'), {
      version: 3,
      file: 'app.js',
      sources: ['C:\\Users\\local-user\\workspace\\src\\app.ts'],
      names: [],
      mappings: '',
    });
    await expect(
      assertLiveArtifactPolicy(root, 'production', { allowSourceMaps: true }),
    ).rejects.toThrow(/forbidden path|source-map reference/u);
  });

  it.each(['app.js.map.gz', 'app.js.map.br'])(
    'rejects compressed source maps even during the private pre-retention scan: %s',
    async (name) => {
      const root = await artifact('production');
      await finalizeLiveBuildArtifact(root, 'production');
      await writeFile(join(root, 'client', 'assets', name), '{}\n', 'utf8');
      await expect(
        assertLiveArtifactPolicy(root, 'production', { allowSourceMaps: true }),
      ).rejects.toThrow(/source-map representation/u);
    },
  );

  it.each([
    ['migrations', [{ tag: 'v2', deleted_classes: ['RegionalFeedHub'] }]],
    ['limits', { cpu_ms: 60_000, subrequests: 1_000 }],
    ['compatibility_flags', ['nodejs_compat']],
    ['observability', { enabled: false, logs: { enabled: true, invocation_logs: true } }],
  ])('rejects an extra generated deployment capability in %s', async (field, value) => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    const path = join(root, 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    worker[field] = value;
    await writeJson(path, worker);
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /closed generated deployment policy/u,
    );
  });

  it('rejects generated Worker and mock-provider vars outside the exact keyset', async () => {
    const root = await artifact('mock-staging');
    await finalizeLiveBuildArtifact(root, 'mock-staging');
    const workerPath = join(root, 'airspace_worker', 'wrangler.json');
    const worker = JSON.parse(await readFile(workerPath, 'utf8')) as Record<string, unknown>;
    (worker.vars as Record<string, unknown>).EXTRA = 'enabled';
    await writeJson(workerPath, worker);
    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(
      /closed generated deployment policy/u,
    );

    delete (worker.vars as Record<string, unknown>).EXTRA;
    await writeJson(workerPath, worker);
    const mockPath = join(root, 'mock_provider', 'wrangler.json');
    const mock = JSON.parse(await readFile(mockPath, 'utf8')) as Record<string, unknown>;
    (mock.vars as Record<string, unknown>).EXTRA = 'enabled';
    await writeJson(mockPath, mock);
    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(
      /closed generated deployment policy/u,
    );
  });

  it.each(['leak.bin', 'app.js.map.gz', 'app.js.map.br'])(
    'rejects an undeclared or compressed source-map deployable role: %s',
    async (name) => {
      const root = await artifact('production');
      await finalizeLiveBuildArtifact(root, 'production');
      await writeFile(
        join(root, 'client', 'assets', name),
        'C:\\Users\\local-user\\private-workspace',
      );
      await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
        /undeclared deployable file role|source-map representation/u,
      );
    },
  );

  it('rejects an undeclared or byte-mismatched client font role', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(
      join(root, 'client', 'assets', 'inter-latin-400-normal-forged.woff2'),
      'C:\\Users\\local-user\\private-workspace',
    );
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /client font bytes|undeclared deployable file role/u,
    );

    await rm(join(root, 'client', 'assets', 'inter-latin-400-normal-forged.woff2'));
    await writeFile(
      join(root, 'client', 'assets', 'leak.woff2'),
      'C:\\Users\\local-user\\private-workspace',
    );
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /undeclared deployable file role/u,
    );
  });

  it.each([
    'file://server/share/work',
    'file:///opt/build/repo',
    '/workspace/team/repo',
    '/opt/build/repo',
    'https://token@example.invalid/path',
    'https://example.invalid/path?api_key=secret-value',
    'https://example.invalid/path#access_token=supersecret',
    'https://example.invalid/path?client_secret=supersecret',
    'https://example.invalid/path?password=supersecret',
    'https://example.invalid/path?X-Amz-Credential=AKIA123&X-Amz-Signature=abcdef',
    'Authorization: Bearer abcdefghijklmnop',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Authorization: Digest username=alice,response=abcdef',
    'Proxy-Authorization: Negotiate abcdefghijklmnop',
    'Cookie: session=supersecret',
    '/var/lib/jenkins/workspace/private-repo',
    '/srv/runner/work/private-repo',
    '/github/workspace/private-repo',
    '/__w/private-repo/private-repo',
    '/Volumes/build/private-repo',
    'webpack:///home/alice/private-repo/a.ts',
    'webpack:////server/share/private-repo/a.ts',
    'webpack:///usr/src/app/private-repo/a.ts',
    'webpack:///D:/projects/private-repo/a.ts',
    'file:/D:/projects/private-repo/a.ts',
    'file://[::1]/share/private-repo/a.ts',
    'file:/private-repo/config.json',
    'file:/etc/passwd',
    'file:private-repo/config.json',
    '/home//alice/private-repo',
    '/opt/../home/alice/private-repo',
    String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\private-repo`,
    '/var/lib/buildkite-agent/builds/private-repo',
    '/var/lib/gitlab-runner/builds/private-repo',
    '/drone/src/private-repo',
    '/go/src/private-repo',
    '/vercel/path0/private-repo',
    '[/home/alice/private-repo]',
    '/mnt/C/Users/alice/private-repo',
    '//alice:password@example.invalid/path',
    '//alice:\tpassword@example.invalid/path',
    'https://alice:\npassword@example.invalid/path',
    'https://ali(ce:password@example.invalid/path',
    'authorization: bearer abcdefghijklmnop',
    'https://example.invalid/path?access_token[]=supersecret',
    'const apiKey="supersecret";',
    'const token="supersecret";',
    'githubToken="supersecret";',
    String.raw`/opt/\
build/private-repo`,
    '&#x66;&#x69;&#x6c;&#x65;&#x3a;&#x2f;&#x2f;&#x2f;opt&#x2f;build&#x2f;private-repo',
    String.raw`body { background: url("\66 ile\3a \2f \2f \2f opt\2f build\2f private-repo"); }`,
    'file%25253A%25252F%25252F%25252Fopt%25252Fbuild%25252Frepo',
    String.raw`const root = "\x43\x3a\x5cUsers\x5clocal-user\x5cworkspace";`,
  ])('rejects encoded or credential-bearing textual artifact content: %s', (sentinel) => {
    expect(() => assertPrivacySafeTextArtifact(sentinel, 'client/assets/app.js')).toThrow(
      /forbidden/u,
    );
  });

  it.each([
    [
      'client/index.html',
      '&#x66;&#x69;&#x6c;&#x65;&#x3a;&#x2f;&#x2f;&#x2f;opt&#x2f;build&#x2f;private-repo',
    ],
    [
      'client/assets/leak.css',
      String.raw`body { background: url("\66 ile\3a \2f \2f \2f opt\2f build\2f private-repo"); }`,
    ],
    ['client/index.html', 'https://example.invalid/path#access_token=supersecret'],
    ['client/index.html', 'https://example.invalid/path?client_secret=supersecret'],
    [
      'client/index.html',
      'https://example.invalid/path?X-Amz-Credential=AKIA123&X-Amz-Signature=abcdef',
    ],
    ['client/index.html', 'Authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['client/index.html', 'Authorization: Digest username=alice,response=abcdef'],
    ['client/index.html', 'Cookie: session=supersecret'],
    ['client/assets/leak.js', '/var/lib/jenkins/workspace/private-repo'],
    ['client/assets/leak.js', '/srv/runner/work/private-repo'],
    ['client/assets/leak.js', '/github/workspace/private-repo'],
    ['client/assets/leak.js', '/__w/private-repo/private-repo'],
    ['client/assets/leak.js', '/Volumes/build/private-repo'],
    ['client/assets/leak.js', 'webpack:////server/share/private-repo/a.ts'],
    ['client/assets/leak.js', 'webpack:///usr/src/app/private-repo/a.ts'],
    ['client/assets/leak.js', '/mnt/C/Users/alice/private-repo'],
    ['client/assets/leak.js', '//alice:password@example.invalid/path'],
    ['client/assets/leak.js', '//alice:\tpassword@example.invalid/path'],
    ['client/assets/leak.js', 'https://alice:\npassword@example.invalid/path'],
    ['client/assets/leak.js', 'authorization: bearer abcdefghijklmnop'],
    ['client/assets/leak.js', 'https://example.invalid/path?access_token[]=supersecret'],
    [
      'client/assets/leak.js',
      String.raw`/opt/\
build/private-repo`,
    ],
  ])('rejects an end-to-end encoded artifact sentinel in %s', async (artifactPath, sentinel) => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    const path = join(root, ...artifactPath.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    const retainedHtml = artifactPath.endsWith('.html') ? await readFile(path, 'utf8') : '';
    await writeFile(path, `${retainedHtml}${sentinel}`, 'utf8');
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /forbidden path|source-map reference/u,
    );
  });

  it.each([
    ['UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('/home/alice', 'utf16le')])],
    ['NUL-interleaved UTF-8', Buffer.from('/\0h\0o\0m\0e\0/\0a\0l\0i\0c\0e', 'utf8')],
  ])('rejects a %s textual artifact before privacy scanning', async (_label, bytes) => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(join(root, 'client', 'assets', 'encoded.js'), bytes);
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /strict BOM-free UTF-8/u,
    );
  });

  it('rejects residual over-encoding instead of stopping at a fixed decode depth', () => {
    let sentinel = 'file:///opt/build/private-repo';
    for (let pass = 0; pass < 33; pass += 1) sentinel = encodeURIComponent(sentinel);
    expect(() => assertPrivacySafeTextArtifact(sentinel, 'client/assets/app.js')).toThrow(
      /over-encoded|forbidden/u,
    );
  });

  it('privacy-scans deployable filenames before accepting their role', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(
      join(root, 'client', 'assets', '%2Fhome%2Falice%2Fprivate-repo.js'),
      'export const safe = true;\n',
      'utf8',
    );
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /Connected artifact path/u,
    );
  });

  it.each([
    ['client/_redirects', '/unused/* https://attacker.example/:splat 302\n'],
    ['client/.assetsignore', 'wrangler.json\n.dev.vars\n_redirects\n'],
  ])('pins the exact generated semantics of %s', async (artifactPath, replacement) => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(join(root, ...artifactPath.split('/')), replacement, 'utf8');
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /exclusion policy|redirect policy/u,
    );
  });

  it.each([
    [
      'stale restrictive connect-src',
      (csp: string) => csp.replace(/connect-src [^;]+/u, "connect-src 'self'"),
    ],
    [
      'added permissive script source',
      (csp: string) => csp.replace("script-src 'self'", "script-src 'self' https://evil.invalid"),
    ],
    [
      'additional unquoted CSP meta',
      (html: string) =>
        html.replace(
          '<main>',
          `<meta http-equiv=Content-Security-Policy content="default-src 'none'"><main>`,
        ),
    ],
  ])('rejects a %s in either built HTML meta policy', async (_label, mutate) => {
    for (const name of ['index.html', 'live.html'] as const) {
      const root = await artifact('production');
      await finalizeLiveBuildArtifact(root, 'production');
      const path = join(root, 'client', name);
      const html = await readFile(path, 'utf8');
      await writeFile(path, mutate(html), 'utf8');
      await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
        /Content-Security-Policy/u,
      );
    }
  });

  it('accepts non-credential operational keys while rejecting exact credential keys', () => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        'const localProtocols = ["file:/", "file://"]; const check = /^file:/.test(value);',
        'client/assets/app.js',
      ),
    ).not.toThrow();
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ TOKEN_BUCKET_CAPACITY: 100 }),
        'operations.json',
      ),
    ).not.toThrow();
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ clientSecret: 'do-not-retain' }),
        'operations.json',
      ),
    ).toThrow(/credential-shaped|credential-bearing/u);
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ auth: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'do-not-retain' } }),
        'operations.json',
      ),
    ).toThrow(/credential-shaped|credential-bearing/u);
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ auth: { api_token: 'do-not-retain' } }),
        'operations.json',
      ),
    ).toThrow(/credential-shaped|credential-bearing/u);
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ auth_token: 'do-not-retain' }),
        'operations.json',
      ),
    ).toThrow(/credential-shaped|credential-bearing/u);
    expect(() =>
      assertPrivacySafeTextArtifact('ghp_123456789012345678901234567890', 'client/assets/app.js'),
    ).toThrow(/credential-bearing/u);
    expect(() =>
      assertPrivacySafeTextArtifact(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJlMTIzNDU2',
        'client/assets/app.js',
      ),
    ).toThrow(/credential-bearing/u);
  });

  it('rejects duplicate JSON fields before lossy parsing', () => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        '{"token":"supersecret","token":""}',
        'client/runtime-policy.json',
      ),
    ).toThrow(/duplicate JSON field/u);
  });

  it('normalizes forbidden JSON metadata keys before inspection', () => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ version: 3, workspace_root: 'private-repo', sources: ['src/app.ts'] }),
        'client/assets/app.js.map',
      ),
    ).toThrow(/forbidden deployment metadata key/u);
  });

  it('parses source-map JSON recursively and rejects escaped nested paths', () => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ version: 3, sources: [String.raw`\u0043:\\Users\\local-user\\app.ts`] }),
        'client/assets/app.js.map',
      ),
    ).toThrow(/forbidden/u);
  });

  it.each([
    '/var/lib/buildkite-agent/builds/private-repo/a.ts',
    '/drone/src/private-repo/a.ts',
    '/go/src/private-repo/a.ts',
    '[/home/alice/private-repo/app.ts]',
  ])('requires private source-map sources to remain relative: %s', (source) => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({ version: 3, sources: [source], names: [], mappings: '' }),
        'client/assets/app.js.map',
      ),
    ).toThrow(/relative source paths|forbidden/u);
  });

  it('allows an empty sourceRoot with bounded relative source entries', () => {
    expect(() =>
      assertPrivacySafeTextArtifact(
        JSON.stringify({
          version: 3,
          sourceRoot: '',
          sources: ['src/app.ts'],
          names: [],
          mappings: '',
        }),
        'client/assets/app.js.map',
      ),
    ).not.toThrow();
  });

  it('intentionally rejects embedded sourcesContent in private pre-retention maps', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await writeFile(join(root, 'client', 'assets', 'app.js'), 'export const app = true;\n', 'utf8');
    await writeJson(join(root, 'client', 'assets', 'app.js.map'), {
      version: 3,
      file: 'app.js',
      sources: ['src/app.ts'],
      sourcesContent: ['export const app = true;'],
      names: [],
      mappings: '',
    });
    await expect(
      assertLiveArtifactPolicy(root, 'production', { allowSourceMaps: true }),
    ).rejects.toThrow(/forbidden path|source-map reference/u);
  });

  it('rejects target-incompatible mock-provider files in production', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    await mkdir(join(root, 'mock_provider'), { recursive: true });
    await writeFile(join(root, 'mock_provider', 'index.js'), 'export default {};\n', 'utf8');
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(/mock-provider/u);
  });

  it('requires both isolated mock-provider files in mock staging', async () => {
    const root = await artifact('mock-staging');
    await finalizeLiveBuildArtifact(root, 'mock-staging');
    await rm(join(root, 'mock_provider', 'index.js'));
    await expect(assertLiveArtifactPolicy(root, 'mock-staging')).rejects.toThrow(
      /missing its isolated mock provider/u,
    );
  });

  it.each(['client/Aviation-Dashboard-Project/leak.bin', 'map_assets/unapproved/leak.pbf'])(
    'rejects an open-ended retained binary role: %s',
    async (artifactPath) => {
      const root = await artifact('production');
      await finalizeLiveBuildArtifact(root, 'production');
      const path = join(root, ...artifactPath.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'not-approved', 'utf8');
      await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
        /undeclared deployable file role/u,
      );
    },
  );

  it('rejects modified bytes at an exact approved retained path', async () => {
    const root = await artifact('production');
    await finalizeLiveBuildArtifact(root, 'production');
    const path = join(root, 'map_assets', 'georgia-20260828-z12', 'basemap.pmtiles');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'forged-map', 'utf8');
    await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
      /do not match the approved identity/u,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a permitted deployable path when it is a filesystem symlink',
    async () => {
      const root = await artifact('production');
      await finalizeLiveBuildArtifact(root, 'production');
      const outside = join(root, '..', 'outside-worker.js');
      await writeFile(outside, 'export default {};\n', 'utf8');
      await rm(join(root, 'airspace_worker', 'index.js'));
      await symlink(outside, join(root, 'airspace_worker', 'index.js'));
      try {
        await expect(assertLiveArtifactPolicy(root, 'production')).rejects.toThrow(
          /symbolic link/u,
        );
      } finally {
        await rm(outside, { force: true });
      }
    },
  );
});
