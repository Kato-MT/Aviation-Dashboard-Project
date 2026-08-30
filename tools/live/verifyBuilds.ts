import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { describeLiveSource } from '../../src/live/source';
import { evidenceBuildIdentity } from './buildConfig';
import {
  auditPrivacyTree,
  privacyTreeExpectedIdentity,
  type PrivacyTreeFileRule,
} from './operationsPrivacyAudit';
import {
  assertLiveArtifactPolicy,
  compileGeneratedRuntimePolicy,
  renderRuntimePolicyHeaders,
} from './runtimePolicyArtifact';

async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : [path];
    }),
  );
  return files.flat();
}

async function config(directory: string) {
  return JSON.parse(await readFile(join(directory, 'airspace_worker/wrangler.json'), 'utf8'));
}

async function auditSelectedBuildTree(directory: string): Promise<void> {
  const files: PrivacyTreeFileRule[] = await Promise.all(
    (await filesIn(directory)).map(async (path) => {
      const contents = await readFile(path);
      return {
        path: relative(directory, path).replaceAll('\\', '/'),
        bytes: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      };
    }),
  );
  const selectedIdentity = privacyTreeExpectedIdentity(files);
  await auditPrivacyTree({ root: directory, files }, selectedIdentity);
}

const productionDirectory = resolve('dist-live');
const stagingDirectory = resolve('dist-mock-staging');
await assertLiveArtifactPolicy(productionDirectory, 'production');
await assertLiveArtifactPolicy(stagingDirectory, 'mock-staging');
await auditSelectedBuildTree(productionDirectory);
await auditSelectedBuildTree(stagingDirectory);
const production = await config(productionDirectory);
const staging = await config(stagingDirectory);
assert.equal(production.name, 'flight-airspace-production');
assert.equal(staging.name, 'flight-airspace-mock-staging');
assert.notEqual(production.name, staging.name);

for (const [target, artifact] of [
  ['production', production],
  ['mock-staging', staging],
] as const) {
  const source = describeLiveSource(
    artifact.vars.LIVE_BUILD_TARGET,
    artifact.vars.LIVE_PROVIDER_MODE,
  );
  assert.equal(source.target, target);
  assert.equal(source.mode, target === 'production' ? 'disabled' : 'mock');
  const buildIdentity = evidenceBuildIdentity(target);
  assert.equal(artifact.vars.APP_VERSION, buildIdentity.applicationVersion);
  assert.equal(artifact.vars.RELEASE_SHA, buildIdentity.releaseSha);
  assert.equal(artifact.observability.enabled, false);
  assert.equal(artifact.observability.logs.enabled, false);
  assert.equal(artifact.observability.logs.invocation_logs, false);
  assert.deepEqual(artifact.compatibility_flags, []);
  assert.equal(artifact.compatibility_date, '2026-08-27');
  assert.deepEqual(artifact.limits, { cpu_ms: 10, subrequests: 10 });
  assert.deepEqual(artifact.migrations, [{ tag: 'v1', new_sqlite_classes: ['RegionalFeedHub'] }]);
  assert.equal(artifact.assets.html_handling, 'none');
  assert.equal(artifact.assets.not_found_handling, 'none');
  assert.deepEqual(artifact.assets.run_worker_first, ['/*']);
  assert.equal(artifact.vars.LIVE_TEST_SCENARIO, undefined);
  assert.equal(artifact.vars.MOCK_SCENARIO, undefined);
  assert.deepEqual(artifact.r2_buckets, [
    { binding: 'MAP_ASSETS', bucket_name: `flight-airspace-${target}-maps` },
  ]);
  assert.deepEqual(artifact.durable_objects.bindings, [
    { name: 'REGION_FEEDS', class_name: 'RegionalFeedHub' },
  ]);
}
assert.deepEqual(production.services, []);
assert.equal(production.vars.LIVE_PROVIDER_BASE_URL, 'https://api.adsb.lol');
assert.deepEqual(staging.services, [
  { binding: 'MOCK_PROVIDER', service: 'flight-airspace-mock-provider' },
]);
assert.equal(staging.vars.LIVE_PROVIDER_BASE_URL, 'https://mock-provider.invalid');

const productionFiles = await filesIn(productionDirectory);
assert(productionFiles.length > 0);
for (const path of productionFiles) {
  assert(!relative(productionDirectory, path).includes('mock_provider'));
  if (!/\.(?:js|json|map|html)$/.test(path)) continue;
  const text = await readFile(path, 'utf8');
  for (const forbidden of [
    'tests/support/mockProvider',
    'SYNTHETIC_OUTAGE',
    'MOCK_SCENARIO',
    'MOCK_REQUEST_REJECTED',
    'flight-airspace-mock-provider',
    'NATIVE_EGRESS_BLOCKED',
    'guardedAirspaceWorker',
    'guardedMockProvider',
    'denyNativeEgress',
  ]) {
    assert(
      !text.includes(forbidden),
      `${relative(productionDirectory, path)} contains ${forbidden}`,
    );
  }
}

for (const directory of [productionDirectory, stagingDirectory]) {
  const files = await filesIn(directory);
  assert(
    files.every((path) => !path.endsWith('.map')),
    `${relative('.', directory)} contains a publicly retrievable source map`,
  );
  const clientDirectory = join(directory, 'client');
  const rootHtml = await readFile(join(clientDirectory, 'index.html'), 'utf8');
  const compatibilityHtml = await readFile(join(clientDirectory, 'live.html'), 'utf8');
  const redirects = await readFile(join(clientDirectory, '_redirects'), 'utf8');
  const headers = await readFile(join(clientDirectory, '_headers'), 'utf8');
  assert(rootHtml.includes('id="live-root"'));
  assert(compatibilityHtml.includes('id="live-root"'));
  for (const html of [rootHtml, compatibilityHtml]) {
    assert(html.includes("worker-src 'self' blob: data:"));
    assert(html.includes("img-src 'self' data: blob:"));
    assert(html.includes("media-src 'none'"));
    assert(html.includes("frame-src 'none'"));
  }
  assert.equal(
    redirects,
    '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n',
  );
  const generatedConfiguration = directory === productionDirectory ? production : staging;
  const policy = await compileGeneratedRuntimePolicy(
    generatedConfiguration,
    directory === productionDirectory ? 'production' : 'mock-staging',
  );
  const policyManifest = JSON.parse(
    await readFile(join(clientDirectory, 'runtime-policy.json'), 'utf8'),
  );
  assert.deepEqual(policyManifest, policy);
  assert.equal(generatedConfiguration.vars.RUNTIME_POLICY_ID, policy.policyId);
  assert.equal(headers, renderRuntimePolicyHeaders(policy));
  assert(!rootHtml.includes('id="workspace"'));
  assert(!compatibilityHtml.includes('id="workspace"'));
  assert(
    !files.some((path) => relative(clientDirectory, path) === 'v2.html'),
    `${relative('.', directory)} contains a source-built rollback entry`,
  );
}

const mockDirectory = join(stagingDirectory, 'mock_provider');
const mock = JSON.parse(await readFile(join(mockDirectory, 'wrangler.json'), 'utf8'));
assert.equal(mock.name, 'flight-airspace-mock-provider');
assert.equal(mock.vars.MOCK_SCENARIO, 'nominal');
assert.equal(mock.observability.enabled, false);
assert.equal(mock.observability.logs.enabled, false);
assert.equal(mock.observability.logs.invocation_logs, false);
assert.deepEqual(mock.compatibility_flags, []);
assert.deepEqual(mock.services, []);
const mockCode = await readFile(join(mockDirectory, mock.main), 'utf8');
assert(mockCode.includes('SYNTHETIC_OUTAGE'));
assert(!mockCode.includes('https://api.adsb.lol'));
assert(!mockCode.includes('globalThis.fetch'));

console.log(
  'Live artifact isolation passed: v3 root/live entries present, source-built rollback absent; production disabled, mock service absent; separately named mock staging includes its deployable synthetic service. No deployment was performed.',
);
