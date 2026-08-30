import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it, vi } from 'vitest';
import runtimePolicySchema from '../../schemas/runtime-policy-v1.schema.json';
import {
  compileRuntimePolicy,
  compileRuntimePolicyBindings,
  evaluateRuntimePolicyRequest,
  resolveRuntimePolicyRoute,
  RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN,
  RUNTIME_POLICY_MAX_ORIGINS,
  RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN,
  RUNTIME_POLICY_PROVIDER_MODES,
  RUNTIME_POLICY_REASON_CODES,
  runtimePolicyCanonicalJson,
  runtimePolicyInputFromBindings,
  type DeploymentClass,
  type RuntimePolicyInput,
  type RuntimePolicyProviderGate,
  type RuntimePolicyReleaseIdentity,
  type RuntimePolicyV1,
} from '../../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { LIVE_BUILD_TARGETS, parseLiveSource } from '../../src/live/source';
import type { LiveBuildTarget, LiveProviderMode } from '../../src/live/source';
import { renderConnectedHeaders } from '../../tools/live/runtimePolicyArtifact';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePolicy = ajv.compile(runtimePolicySchema);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactRelease(target: LiveBuildTarget): RuntimePolicyReleaseIdentity {
  return {
    applicationVersion: '3.0.0-test',
    releaseSha: 'a'.repeat(40),
    releaseStatus: 'unreleased',
    buildTarget: target,
  };
}

function localMockInput(overrides: Partial<RuntimePolicyInput> = {}): RuntimePolicyInput {
  return {
    target: 'local-mock',
    providerMode: 'mock',
    providerBaseUrl: RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN,
    mockBindingPresent: true,
    allowedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
    deploymentClass: 'loopback',
    release: {
      applicationVersion: '3.0.0-test',
      releaseSha: 'local-unreleased',
      releaseStatus: 'unreleased',
      buildTarget: 'local-mock',
    },
    policyEpoch: 'test-epoch-1',
    providerGate: { status: 'closed', reason: 'source-disabled' },
    ...overrides,
  };
}

function targetInput(target: LiveBuildTarget, providerMode: LiveProviderMode): RuntimePolicyInput {
  const synthetic = target === 'local-mock' || target === 'mock-staging';
  const deploymentClass: DeploymentClass =
    target === 'local-mock' ? 'loopback' : target === 'production' ? 'public' : 'isolated-cloud';
  const publicLike = deploymentClass !== 'loopback';
  return {
    target,
    providerMode,
    providerBaseUrl: synthetic
      ? RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN
      : RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN,
    mockBindingPresent: providerMode === 'mock',
    allowedOrigins: publicLike ? [`https://${target}.workbench.test`] : ['http://127.0.0.1:4173'],
    deploymentClass,
    release: publicLike
      ? exactRelease(target)
      : {
          applicationVersion: '3.0.0-test',
          releaseSha: 'local-unreleased',
          releaseStatus: 'unreleased',
          buildTarget: target,
        },
    policyEpoch: `test-${target}-${providerMode}`,
    providerGate:
      providerMode === 'live'
        ? { status: 'approved', receiptSha256: 'b'.repeat(64) }
        : { status: 'closed', reason: 'source-disabled' },
  };
}

function expectDeeplyFrozen(value: unknown, visited = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) return;
  visited.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child, visited);
}

function clonePolicy(policy: Readonly<RuntimePolicyV1>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
}

describe('runtime-policy.v1 compiler', () => {
  it('adapts the closed Worker binding vocabulary once and verifies its baked identity', async () => {
    const input = localMockInput();
    const expected = await compileRuntimePolicy(input, sha256);
    const bindings = {
      LIVE_BUILD_TARGET: input.target,
      LIVE_PROVIDER_MODE: input.providerMode,
      LIVE_PROVIDER_BASE_URL: input.providerBaseUrl,
      ALLOWED_ORIGINS: input.allowedOrigins.join(','),
      APP_VERSION: input.release.applicationVersion,
      RELEASE_SHA: input.release.releaseSha,
      RUNTIME_POLICY_EPOCH: input.policyEpoch,
      RUNTIME_DEPLOYMENT_CLASS: input.deploymentClass,
      RUNTIME_RELEASE_STATUS: input.release.releaseStatus,
      RUNTIME_PROVIDER_GATE_STATUS: input.providerGate.status,
      RUNTIME_PROVIDER_GATE_VALUE:
        input.providerGate.status === 'closed'
          ? input.providerGate.reason
          : input.providerGate.receiptSha256,
      RUNTIME_POLICY_ID: expected.policyId,
    };
    expect(runtimePolicyInputFromBindings(bindings, true)).toEqual(input);
    await expect(compileRuntimePolicyBindings(bindings, true, sha256)).resolves.toEqual(expected);

    await expect(
      compileRuntimePolicyBindings(
        { ...bindings, RUNTIME_POLICY_ID: '0'.repeat(64) },
        true,
        sha256,
      ),
    ).rejects.toThrow('does not match');
    await expect(
      compileRuntimePolicyBindings(
        { ...bindings, RUNTIME_PROVIDER_GATE_STATUS: 'mutable' },
        true,
        sha256,
      ),
    ).rejects.toThrow('provider-gate status');
    await expect(compileRuntimePolicyBindings(bindings, false, sha256)).rejects.toThrow(
      'Mock mode requires',
    );
  });

  it.each([
    ['local-mock', 'mock'],
    ['local-mock', 'disabled'],
    ['mock-staging', 'mock'],
    ['mock-staging', 'disabled'],
    ['live-staging', 'disabled'],
    ['production', 'disabled'],
  ] as const)('compiles a schema-valid deeply immutable %s %s policy', async (target, mode) => {
    const policy = await compileRuntimePolicy(targetInput(target, mode), sha256);
    expect(validatePolicy(policy), JSON.stringify(validatePolicy.errors)).toBe(true);
    expect(policy).toMatchObject({
      schemaVersion: 'runtime-policy.v1',
      target,
      policyEpoch: `test-${target}-${mode}`,
      admission: {
        scope: 'worker-isolate',
        exactGlobalAccounting: false,
        exactAccountAccounting: false,
      },
      artifact: {
        manifestMode: 'allowlist',
        rejectAbsolutePaths: true,
        rejectLocalIdentity: true,
        rejectSecrets: true,
        rejectSourceMaps: true,
        mutableControlPlane: false,
      },
    });
    expect(policy.reasonCodes).toEqual(RUNTIME_POLICY_REASON_CODES);
    expect(policy.limits).toBe(RUNTIME_POLICY_LIMITS);
    expect(parseLiveSource(policy.source.descriptor)).toEqual(policy.source.descriptor);
    expectDeeplyFrozen(policy);
  });

  it('exhaustively classifies the declared target, mode, binding, release, origin, and epoch matrix', async () => {
    const releaseCases = [
      { id: 'unreleased-local', releaseStatus: 'unreleased', releaseSha: 'local-unreleased' },
      { id: 'unreleased-exact', releaseStatus: 'unreleased', releaseSha: 'a'.repeat(40) },
      { id: 'exact-release-local', releaseStatus: 'exact-release', releaseSha: 'local-unreleased' },
      { id: 'exact-release-exact', releaseStatus: 'exact-release', releaseSha: 'a'.repeat(40) },
    ] as const;
    const originCases = [
      {
        id: 'loopback-http',
        deploymentClass: 'loopback',
        allowedOrigins: ['http://127.0.0.1:4173'],
        originCompatible: true,
      },
      {
        id: 'isolated-https',
        deploymentClass: 'isolated-cloud',
        allowedOrigins: ['https://isolated.workbench.test'],
        originCompatible: true,
      },
      {
        id: 'public-https',
        deploymentClass: 'public',
        allowedOrigins: ['https://public.workbench.test'],
        originCompatible: true,
      },
      {
        id: 'isolated-cleartext',
        deploymentClass: 'isolated-cloud',
        allowedOrigins: ['http://isolated.workbench.test'],
        originCompatible: false,
      },
      {
        id: 'public-loopback',
        deploymentClass: 'public',
        allowedOrigins: ['https://localhost:4173'],
        originCompatible: false,
      },
    ] as const;
    const epochCases = [
      { id: 'canonical', value: 'matrix-epoch:1', valid: true },
      { id: 'empty', value: '', valid: false },
      { id: 'uppercase', value: 'Matrix-Epoch', valid: false },
    ] as const;

    let caseCount = 0;
    let acceptedCount = 0;
    for (const target of LIVE_BUILD_TARGETS) {
      for (const providerMode of RUNTIME_POLICY_PROVIDER_MODES) {
        for (const mockBindingPresent of [false, true] as const) {
          for (const releaseCase of releaseCases) {
            for (const originCase of originCases) {
              for (const epochCase of epochCases) {
                caseCount += 1;
                const synthetic = target === 'local-mock' || target === 'mock-staging';
                const modeCompatible = synthetic
                  ? providerMode !== 'live'
                  : providerMode !== 'mock';
                const bindingCompatible = mockBindingPresent === (providerMode === 'mock');
                const deploymentCompatible =
                  (target === 'local-mock' && originCase.deploymentClass === 'loopback') ||
                  ((target === 'mock-staging' || target === 'live-staging') &&
                    (originCase.deploymentClass === 'loopback' ||
                      originCase.deploymentClass === 'isolated-cloud')) ||
                  (target === 'production' &&
                    (originCase.deploymentClass === 'loopback' ||
                      originCase.deploymentClass === 'public'));
                const exactSha = releaseCase.releaseSha !== 'local-unreleased';
                const releaseCompatible =
                  !(releaseCase.releaseStatus === 'exact-release' && !exactSha) &&
                  !(originCase.deploymentClass === 'public' && !exactSha);
                const expected =
                  modeCompatible &&
                  bindingCompatible &&
                  deploymentCompatible &&
                  originCase.originCompatible &&
                  releaseCompatible &&
                  epochCase.valid;
                const label = [
                  target,
                  providerMode,
                  mockBindingPresent ? 'binding' : 'no-binding',
                  releaseCase.id,
                  originCase.id,
                  epochCase.id,
                ].join('/');
                const input: RuntimePolicyInput = {
                  target,
                  providerMode,
                  providerBaseUrl: synthetic
                    ? RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN
                    : RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN,
                  mockBindingPresent,
                  allowedOrigins: originCase.allowedOrigins,
                  deploymentClass: originCase.deploymentClass,
                  release: {
                    applicationVersion: '3.0.0-matrix',
                    releaseSha: releaseCase.releaseSha,
                    releaseStatus: releaseCase.releaseStatus,
                    buildTarget: target,
                  },
                  policyEpoch: epochCase.value,
                  providerGate:
                    providerMode === 'live'
                      ? { status: 'approved', receiptSha256: 'b'.repeat(64) }
                      : { status: 'closed', reason: 'source-disabled' },
                };
                let compiled: Readonly<RuntimePolicyV1> | undefined;
                try {
                  compiled = await compileRuntimePolicy(input, sha256);
                } catch {
                  compiled = undefined;
                }
                expect(compiled !== undefined, label).toBe(expected);
                if (compiled !== undefined) {
                  acceptedCount += 1;
                  expect(
                    validatePolicy(compiled),
                    `${label}: ${JSON.stringify(validatePolicy.errors)}`,
                  ).toBe(true);
                  expect(compiled.routes).toHaveLength(7);
                  expect(compiled.routes.every((route) => route.body === 'forbidden')).toBe(true);
                  expect(
                    compiled.routes
                      .filter((route) => route.feature === 'live-source')
                      .every((route) => route.enabled === (providerMode !== 'disabled')),
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    }
    expect(caseCount).toBe(1_440);
    expect(acceptedCount).toBeGreaterThan(0);
  });

  it('resolves every declared route and keeps unknown reserved namespaces out of static assets', async () => {
    const policy = await compileRuntimePolicy(localMockInput(), sha256);
    const cases = [
      ['/api/v1/regions', 'api-regions', undefined],
      ['/api/v1/health', 'api-health', undefined],
      ['/api/v1/operations', 'api-operations', undefined],
      ['/api/v1/airspace/atlanta/snapshot', 'api-snapshot', 'atlanta'],
      ['/api/v1/airspace/central-georgia/stream', 'api-stream', 'central-georgia'],
      ['/map-assets', 'map-assets', undefined],
      ['/map-assets/basemap.pmtiles', 'map-assets', undefined],
      ['/', 'static-assets', undefined],
      ['/assets/application.js', 'static-assets', undefined],
      ['/map-assets-other', 'static-assets', undefined],
    ] as const;
    for (const [pathname, routeId, regionId] of cases) {
      const resolution = resolveRuntimePolicyRoute(policy, pathname);
      expect(resolution.kind, pathname).toBe('route');
      if (resolution.kind !== 'route') continue;
      expect(resolution.route.id, pathname).toBe(routeId);
      expect(resolution.parameters.regionId, pathname).toBe(regionId);
    }
    for (const pathname of [
      '/api',
      '/api/v1/unknown',
      '/api/v1/airspace/ATLANTA/snapshot',
      '/api/v1/airspace/atlanta/unknown',
      '/a%70i/v1/unknown',
      '/api%2fv1/unknown',
      '/api%252fv1/unknown',
      '/api%25252525252fv1/unknown',
      '/api%5cv1/unknown',
      '//api/v1/unknown',
      '/%2Fapi/v1/unknown',
    ]) {
      expect(resolveRuntimePolicyRoute(policy, pathname)).toMatchObject({
        kind: 'reserved',
        namespace: '/api',
      });
    }
    expect(resolveRuntimePolicyRoute(policy, '/map%2dassets/unlisted')).toMatchObject({
      kind: 'reserved',
      namespace: '/map-assets',
    });
    for (const pathname of ['//map-assets/unlisted', '/%2Fmap-assets/unlisted']) {
      expect(resolveRuntimePolicyRoute(policy, pathname)).toMatchObject({
        kind: 'reserved',
        namespace: '/map-assets',
      });
    }
    expect(resolveRuntimePolicyRoute(policy, '/assets/%invalid/client.js')).toMatchObject({
      kind: 'reserved',
      namespace: 'noncanonical-path',
    });
  });

  it('applies the closed request contract to every declared route', async () => {
    const policy = await compileRuntimePolicy(localMockInput(), sha256);
    for (const route of policy.routes) {
      const method = route.methods[0]!;
      const validUpgrade = route.upgrade === 'websocket-required' ? 'WebSocket' : null;
      expect(
        evaluateRuntimePolicyRequest(route, {
          method,
          hasQuery: false,
          hasBody: false,
          upgradeHeader: validUpgrade,
        }),
        route.id,
      ).toEqual({ ok: true });
      expect(
        evaluateRuntimePolicyRequest(route, {
          method,
          hasQuery: true,
          hasBody: false,
          upgradeHeader: validUpgrade,
        }),
      ).toEqual({ ok: false, violation: 'query-forbidden' });
      expect(
        evaluateRuntimePolicyRequest(route, {
          method: 'POST',
          hasQuery: false,
          hasBody: false,
          upgradeHeader: validUpgrade,
        }),
      ).toEqual({ ok: false, violation: 'method-forbidden' });
      expect(
        evaluateRuntimePolicyRequest(route, {
          method,
          hasQuery: false,
          hasBody: true,
          upgradeHeader: validUpgrade,
        }),
      ).toEqual({ ok: false, violation: 'body-forbidden' });
      if (route.upgrade === 'forbidden') {
        expect(
          evaluateRuntimePolicyRequest(route, {
            method,
            hasQuery: false,
            hasBody: false,
            upgradeHeader: 'websocket',
          }),
        ).toEqual({ ok: false, violation: 'upgrade-forbidden' });
      } else {
        expect(
          evaluateRuntimePolicyRequest(route, {
            method,
            hasQuery: false,
            hasBody: false,
            upgradeHeader: null,
          }),
        ).toEqual({ ok: false, violation: 'upgrade-required' });
        expect(
          evaluateRuntimePolicyRequest(route, {
            method: 'OPTIONS',
            hasQuery: false,
            hasBody: false,
            upgradeHeader: null,
          }),
        ).toEqual({ ok: true });
        expect(
          evaluateRuntimePolicyRequest(route, {
            method: 'OPTIONS',
            hasQuery: false,
            hasBody: false,
            upgradeHeader: 'websocket',
          }),
        ).toEqual({ ok: false, violation: 'upgrade-forbidden' });
      }
    }
  });

  it('builds one deterministic identity over canonical policy content', async () => {
    const digest = vi.fn(sha256);
    const first = await compileRuntimePolicy(localMockInput(), digest);
    const reversed = await compileRuntimePolicy(
      localMockInput({
        allowedOrigins: ['http://localhost:4173', 'http://127.0.0.1:4173'],
      }),
      sha256,
    );
    const nextEpoch = await compileRuntimePolicy(
      localMockInput({ policyEpoch: 'test-epoch-2' }),
      sha256,
    );
    const { policyId, ...body } = first;
    expect(policyId).toBe(sha256(runtimePolicyCanonicalJson(body)));
    expect(reversed.policyId).toBe(policyId);
    expect(nextEpoch.policyId).not.toBe(policyId);
    expect(digest).toHaveBeenCalledOnce();
    expect(digest.mock.calls[0]?.[0]).not.toContain('"policyId"');
    expect(first.origins.allowed).toEqual(['http://127.0.0.1:4173', 'http://localhost:4173']);
  });

  it('uses Web Crypto by default without changing the canonical result', async () => {
    const injected = await compileRuntimePolicy(localMockInput(), sha256);
    const crossRuntime = await compileRuntimePolicy(localMockInput());
    expect(crossRuntime.policyId).toBe(injected.policyId);
  });

  it.each(['mock-staging', 'live-staging'] as const)(
    'allows %s on loopback only for local workerd verification',
    async (target) => {
      const input = targetInput(target, target === 'mock-staging' ? 'mock' : 'disabled');
      const policy = await compileRuntimePolicy(
        {
          ...input,
          deploymentClass: 'loopback',
          allowedOrigins: ['http://127.0.0.1:4174'],
          release: {
            ...input.release,
            releaseSha: 'local-unreleased',
          },
        },
        sha256,
      );
      expect(policy.deploymentClass).toBe('loopback');
      expect(policy.origins.allowed).toEqual(['http://127.0.0.1:4174']);
      expect(validatePolicy(policy), JSON.stringify(validatePolicy.errors)).toBe(true);
    },
  );

  it('derives source capability, fixed paths, routes, and feature availability from the target', async () => {
    const mock = await compileRuntimePolicy(localMockInput(), sha256);
    expect(mock.source).toMatchObject({
      capability: 'mock-service',
      providerOrigin: RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN,
    });
    expect(mock.source.providerPaths).toHaveLength(3);
    expect(mock.artifact.allowedBindings).toContain('MOCK_PROVIDER');
    expect(mock.featureGates.live).toEqual({ enabled: true, reason: null });

    const disabled = await compileRuntimePolicy(targetInput('production', 'disabled'), sha256);
    expect(disabled.source).toMatchObject({ capability: 'none', providerOrigin: null });
    expect(disabled.source.providerPaths).toEqual([]);
    expect(disabled.artifact.allowedBindings).not.toContain('MOCK_PROVIDER');
    expect(disabled.featureGates.live).toEqual({
      enabled: false,
      reason: 'source-disabled',
    });
    expect(disabled.routes.map(({ id, enabled }) => [id, enabled])).toEqual([
      ['api-regions', true],
      ['api-health', true],
      ['api-operations', true],
      ['api-snapshot', false],
      ['api-stream', false],
      ['map-assets', true],
      ['static-assets', true],
    ]);
    expect(disabled.featureGates).toMatchObject({
      replay: { enabled: true, reason: null },
      lab: { enabled: true, reason: null },
      evidence: { enabled: true, reason: null },
      offline: { enabled: true, reason: null },
      maps: { enabled: true, reason: null },
      rollback: { enabled: true, reason: null },
    });
  });

  it('derives connected response policy without inventing HSTS', async () => {
    const loopback = await compileRuntimePolicy(localMockInput(), sha256);
    const renderedStaticHeaders = renderConnectedHeaders({
      vars: {
        ALLOWED_ORIGINS: 'http://127.0.0.1:4173,http://localhost:4173',
      },
    });
    expect(loopback.headers.static['content-security-policy']).toContain(
      "connect-src 'self' ws://127.0.0.1:4173 ws://localhost:4173",
    );
    expect(loopback.headers.static['content-security-policy']).toContain('ws://127.0.0.1:*');
    expect(loopback.headers.static['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(loopback.headers.static['content-security-policy']).toContain(
      "worker-src 'self' blob: data:",
    );
    expect(loopback.headers.static['content-security-policy']).toContain(
      "img-src 'self' data: blob:",
    );
    expect(loopback.headers.worker['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(loopback.headers.static['cross-origin-opener-policy']).toBe('same-origin');
    expect(loopback.headers.worker['cross-origin-opener-policy']).toBe('same-origin');
    expect(renderedStaticHeaders).toContain(
      `  Content-Security-Policy: ${loopback.headers.static['content-security-policy']}\n`,
    );
    expect(renderedStaticHeaders).toContain(
      `  Cross-Origin-Opener-Policy: ${loopback.headers.static['cross-origin-opener-policy']}\n`,
    );
    expect(loopback.headers.worker['x-content-type-options']).toBe('nosniff');
    expect(loopback.headers.worker['x-frame-options']).toBe('DENY');
    expect(loopback.headers.strictTransportSecurity).toBe('deferred-until-approved-https-target');
    expect(loopback.headers.worker).not.toHaveProperty('strict-transport-security');

    const publicPolicy = await compileRuntimePolicy(targetInput('production', 'disabled'), sha256);
    expect(publicPolicy.headers.static['content-security-policy']).toContain(
      'wss://production.workbench.test',
    );
    expect(publicPolicy.headers.static['content-security-policy']).not.toContain(
      'ws://127.0.0.1:*',
    );
  });

  it('represents provider holds as stable disabled reasons', async () => {
    for (const reason of ['source-disabled', 'terms-hold', 'quota-hold'] as const) {
      const input = targetInput('production', 'disabled');
      const policy = await compileRuntimePolicy(
        { ...input, providerGate: { status: 'closed', reason } },
        sha256,
      );
      expect(policy.featureGates.live).toEqual({ enabled: false, reason });
    }
  });

  it('supports an approved live capability only as an explicit receipt-bound contract', async () => {
    const input = targetInput('live-staging', 'live');
    const policy = await compileRuntimePolicy(input, sha256);
    expect(policy.source).toMatchObject({
      capability: 'fixed-https',
      providerOrigin: RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN,
    });
    expect(policy.providerGate).toEqual({
      status: 'approved',
      receiptSha256: 'b'.repeat(64),
    });
    expect(policy.featureGates.live).toEqual({ enabled: true, reason: null });
    expect(validatePolicy(policy), JSON.stringify(validatePolicy.errors)).toBe(true);
  });

  it('rejects mutation at every nested output boundary', async () => {
    const policy = await compileRuntimePolicy(localMockInput(), sha256);
    expect(() =>
      (policy.origins.allowed as unknown as string[]).push('http://localhost:9999'),
    ).toThrow(TypeError);
    expect(() => {
      (policy.source.descriptor as unknown as { mode: string }).mode = 'live';
    }).toThrow(TypeError);
    expect(() => {
      (policy.featureGates.live as unknown as { enabled: boolean }).enabled = false;
    }).toThrow(TypeError);
    expect(() => {
      (
        policy.limits.browser.bundle as unknown as { initialShellGzipBytes: number }
      ).initialShellGzipBytes = 1;
    }).toThrow(TypeError);
  });

  it.each([
    ['unknown target', { target: 'unknown' as LiveBuildTarget }],
    ['unknown provider mode', { providerMode: 'automatic' as LiveProviderMode }],
    ['unknown deployment class', { deploymentClass: 'internet' as DeploymentClass }],
    ['non-boolean mock binding declaration', { mockBindingPresent: 'yes' as unknown as boolean }],
    ['empty policy epoch', { policyEpoch: '' }],
    ['noncanonical policy epoch', { policyEpoch: 'Epoch One' }],
    ['oversized policy epoch', { policyEpoch: `e${'x'.repeat(64)}` }],
    ['live source in synthetic target', { providerMode: 'live' as LiveProviderMode }],
    [
      'mock source in production target',
      {
        target: 'production' as LiveBuildTarget,
        providerMode: 'mock' as LiveProviderMode,
        deploymentClass: 'public' as DeploymentClass,
        release: exactRelease('production'),
        allowedOrigins: ['https://workbench.test'],
      },
    ],
    ['missing mock binding', { mockBindingPresent: false }],
    ['real origin in synthetic target', { providerBaseUrl: RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN }],
    ['provider origin with path', { providerBaseUrl: 'https://mock-provider.invalid/path' }],
    [
      'disabled synthetic target retaining mock binding',
      { providerMode: 'disabled' as LiveProviderMode },
    ],
    [
      'approved real-provider gate in mock mode',
      {
        providerGate: {
          status: 'approved',
          receiptSha256: 'b'.repeat(64),
        } as RuntimePolicyProviderGate,
      },
    ],
    [
      'real-provider terms hold claimed by mock mode',
      {
        providerGate: {
          status: 'closed',
          reason: 'terms-hold',
        } as RuntimePolicyProviderGate,
      },
    ],
  ] as const)(
    'rejects target, mode, binding, and identity incompatibility: %s',
    async (_label, override) => {
      await expect(
        compileRuntimePolicy(localMockInput(override as Partial<RuntimePolicyInput>), sha256),
      ).rejects.toThrow();
    },
  );

  it.each([
    ['empty origin set', []],
    ['duplicate origins', ['http://localhost:4173', 'http://localhost:4173']],
    ['credential-bearing origin', ['http://user:secret@localhost:4173']],
    ['wildcard origin', ['http://*.localhost:4173']],
    ['path-bearing origin', ['http://localhost:4173/app']],
    ['query-bearing origin', ['http://localhost:4173?mode=live']],
    ['fragment-bearing origin', ['http://localhost:4173#live']],
    ['trailing slash origin', ['http://localhost:4173/']],
    ['uppercase host', ['http://LOCALHOST:4173']],
    ['canonicalized default port', ['http://localhost:80']],
    ['unsupported scheme', ['ftp://localhost:4173']],
    ['non-loopback host in loopback deployment', ['http://workbench.test:4173']],
    ['oversized origin', [`http://localhost.${'a'.repeat(256)}`]],
    [
      'oversized origin set',
      Array.from({ length: RUNTIME_POLICY_MAX_ORIGINS + 1 }, (_, index) =>
        index === 0 ? 'http://localhost:4173' : `http://127.0.0.1:${4200 + index}`,
      ),
    ],
  ])('rejects %s', async (_label, allowedOrigins) => {
    await expect(
      compileRuntimePolicy(localMockInput({ allowedOrigins }), sha256),
    ).rejects.toThrow();
  });

  it('rejects loopback, cleartext, and local identities from a public policy', async () => {
    const input = targetInput('production', 'disabled');
    await expect(
      compileRuntimePolicy({ ...input, allowedOrigins: ['https://localhost:4173'] }, sha256),
    ).rejects.toThrow();
    await expect(
      compileRuntimePolicy({ ...input, allowedOrigins: ['http://workbench.test'] }, sha256),
    ).rejects.toThrow();
    await expect(
      compileRuntimePolicy(
        {
          ...input,
          release: {
            ...input.release,
            releaseSha: 'local-unreleased',
          },
        },
        sha256,
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['local mock in isolated cloud', 'local-mock', 'isolated-cloud'],
    ['mock staging marked public', 'mock-staging', 'public'],
    ['live staging marked public', 'live-staging', 'public'],
    ['production marked isolated cloud', 'production', 'isolated-cloud'],
  ] as const)(
    'rejects incompatible deployment class: %s',
    async (_label, target, deploymentClass) => {
      const input = targetInput(target, target.includes('mock') ? 'mock' : 'disabled');
      await expect(
        compileRuntimePolicy(
          { ...input, deploymentClass: deploymentClass as DeploymentClass },
          sha256,
        ),
      ).rejects.toThrow();
    },
  );

  it('rejects malformed or mismatched release identities and provider gates', async () => {
    const base = localMockInput();
    const invalidReleases: unknown[] = [
      { ...base.release, buildTarget: 'production' },
      { ...base.release, applicationVersion: ' 3.0.0' },
      { ...base.release, releaseSha: 'A'.repeat(40) },
      { ...base.release, releaseStatus: 'exact-release' },
      { ...base.release, extra: true },
    ];
    for (const release of invalidReleases) {
      await expect(
        compileRuntimePolicy({ ...base, release: release as RuntimePolicyReleaseIdentity }, sha256),
      ).rejects.toThrow();
    }

    const realLive = targetInput('live-staging', 'live');
    await expect(
      compileRuntimePolicy(
        {
          ...realLive,
          providerGate: { status: 'closed', reason: 'source-disabled' },
        },
        sha256,
      ),
    ).rejects.toThrow('approved provider-gate receipt');
    await expect(
      compileRuntimePolicy(
        {
          ...realLive,
          providerGate: {
            status: 'approved',
            receiptSha256: 'not-a-receipt',
          } as RuntimePolicyProviderGate,
        },
        sha256,
      ),
    ).rejects.toThrow();
  });

  it('rejects a noncanonical digest from the injected SHA-256 boundary', async () => {
    await expect(compileRuntimePolicy(localMockInput(), () => 'A'.repeat(64))).rejects.toThrow(
      'noncanonical digest',
    );
    await expect(compileRuntimePolicy(localMockInput(), () => 'short')).rejects.toThrow(
      'noncanonical digest',
    );
  });

  it('keeps the JSON schema closed against forged routes, headers, sources, and reasons', async () => {
    const policy = await compileRuntimePolicy(localMockInput(), sha256);
    const forgeries = [
      { ...clonePolicy(policy), extra: true },
      { ...clonePolicy(policy), routes: [] },
      (() => {
        const forged = clonePolicy(policy);
        delete (forged.routes as Array<Record<string, unknown>>)[0]!.body;
        return forged;
      })(),
      {
        ...clonePolicy(policy),
        reasonCodes: [...RUNTIME_POLICY_REASON_CODES].reverse(),
      },
      (() => {
        const forged = clonePolicy(policy);
        const headers = forged.headers as Record<string, unknown>;
        headers.strictTransportSecurity = 'max-age=31536000';
        return forged;
      })(),
      (() => {
        const forged = clonePolicy(policy);
        const source = forged.source as Record<string, unknown>;
        source.capability = 'fixed-https';
        return forged;
      })(),
      (() => {
        const forged = clonePolicy(policy);
        const limits = forged.limits as {
          browser: { bundle: { initialShellGzipBytes: number } };
        };
        limits.browser.bundle.initialShellGzipBytes += 1;
        return forged;
      })(),
    ];
    for (const forged of forgeries) expect(validatePolicy(forged)).toBe(false);
  });
});
