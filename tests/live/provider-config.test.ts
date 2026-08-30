import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGION_CONFIGS } from '../../src/live/regions';
import { compileRuntimePolicy, type RuntimePolicyInput } from '../../src/live/runtimePolicy';
import type { LiveBuildTarget, LiveProviderMode } from '../../src/live/source';
import {
  configuredLiveSource,
  configuredProvider,
  LIVE_PROVIDER_ORIGIN,
  MOCK_PROVIDER_ORIGIN,
  providerForRuntimePolicy,
  type ProviderConfiguration,
} from '../../worker/providerConfig';
import { createMockProvider } from '../support/mockProvider';

function configuration(overrides: ProviderConfiguration = {}): ProviderConfiguration {
  return overrides;
}

function mockConfiguration() {
  const mock = createMockProvider();
  const fetch = vi.fn(async (request: Request) => mock.fetch(request, {}));
  const env = configuration({
    LIVE_BUILD_TARGET: 'local-mock',
    LIVE_PROVIDER_MODE: 'mock',
    LIVE_PROVIDER_BASE_URL: MOCK_PROVIDER_ORIGIN,
    MOCK_PROVIDER: { fetch },
  });
  return { env, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function policyInput(
  target: LiveBuildTarget,
  providerMode: LiveProviderMode,
  mockBindingPresent: boolean,
): RuntimePolicyInput {
  const synthetic = target === 'local-mock' || target === 'mock-staging';
  const production = target === 'production';
  return {
    target,
    providerMode,
    providerBaseUrl: synthetic ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN,
    mockBindingPresent,
    allowedOrigins: production ? ['https://flight.test'] : ['http://127.0.0.1:4174'],
    deploymentClass: production ? 'public' : 'loopback',
    release: {
      applicationVersion: '3.0.0-test',
      releaseSha: production ? 'a'.repeat(40) : 'local-unreleased',
      releaseStatus: production ? 'exact-release' : 'unreleased',
      buildTarget: target,
    },
    policyEpoch: `provider-equivalence-${target}-${providerMode}`,
    providerGate:
      providerMode === 'live'
        ? { status: 'approved', receiptSha256: 'b'.repeat(64) }
        : { status: 'closed', reason: 'source-disabled' },
  };
}

function environment(
  target: LiveBuildTarget,
  providerMode: LiveProviderMode,
  mockFetch?: (request: Request) => Promise<Response>,
): ProviderConfiguration {
  return {
    LIVE_BUILD_TARGET: target,
    LIVE_PROVIDER_MODE: providerMode,
    LIVE_PROVIDER_BASE_URL:
      target === 'local-mock' || target === 'mock-staging'
        ? MOCK_PROVIDER_ORIGIN
        : LIVE_PROVIDER_ORIGIN,
    ...(mockFetch ? { MOCK_PROVIDER: { fetch: mockFetch } } : {}),
  };
}

describe('fail-closed provider selection', () => {
  it.each([
    ['local-mock', 'disabled'],
    ['local-mock', 'mock'],
    ['mock-staging', 'disabled'],
    ['mock-staging', 'mock'],
    ['live-staging', 'disabled'],
    ['live-staging', 'live'],
    ['production', 'disabled'],
    ['production', 'live'],
  ] as const)(
    'keeps legacy and compiled-policy provider selection equivalent for %s %s',
    async (target, mode) => {
      const mock = createMockProvider(() => 1_700_000_000_000);
      const mockFetch =
        mode === 'mock'
          ? async (request: Request) => Promise.resolve(mock.fetch(request, {}))
          : undefined;
      const env = environment(target, mode, mockFetch);
      const policy = await compileRuntimePolicy(policyInput(target, mode, mode === 'mock'));
      const legacy = configuredProvider(env);
      const compiled = providerForRuntimePolicy(policy, env);
      expect(compiled === undefined).toBe(legacy === undefined);
      if (legacy && compiled) {
        expect({
          id: compiled.id,
          label: compiled.label,
          attributionUrl: compiled.attributionUrl,
        }).toEqual({ id: legacy.id, label: legacy.label, attributionUrl: legacy.attributionUrl });
      }
    },
  );

  it.each([
    ['local-mock', 'mock'],
    ['live-staging', 'live'],
  ] as const)(
    'keeps legacy and compiled-policy request behavior equivalent for %s %s',
    async (target, mode) => {
      const now = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const mock = createMockProvider(() => now);
      const mockFetch = vi.fn(async (request: Request) => mock.fetch(request, {}));
      const external = vi.fn(async () =>
        Response.json({
          now,
          ac: [
            {
              hex: 'abc123',
              flight: 'LIVE01',
              lat: REGION_CONFIGS[0]!.center.latitude,
              lon: REGION_CONFIGS[0]!.center.longitude,
              alt_baro: 10_000,
              seen: 1,
              seen_pos: 1,
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', external);
      const env = environment(target, mode, mode === 'mock' ? mockFetch : undefined);
      const policy = await compileRuntimePolicy(policyInput(target, mode, mode === 'mock'));
      const legacy = configuredProvider(env)!;
      const compiled = providerForRuntimePolicy(policy, env)!;

      await expect(legacy.fetchRegion(REGION_CONFIGS[0]!)).resolves.toEqual(
        await compiled.fetchRegion(REGION_CONFIGS[0]!),
      );
      const selectedFetch = mode === 'mock' ? mockFetch : external;
      expect(selectedFetch).toHaveBeenCalledTimes(2);
      const requests = selectedFetch.mock.calls.map(([request]) => request as Request);
      expect(requests.map((request) => request.url)).toEqual([
        `${mode === 'mock' ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN}/v2/point/${REGION_CONFIGS[0]!.center.latitude}/${REGION_CONFIGS[0]!.center.longitude}/${REGION_CONFIGS[0]!.radiusNauticalMiles}`,
        `${mode === 'mock' ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN}/v2/point/${REGION_CONFIGS[0]!.center.latitude}/${REGION_CONFIGS[0]!.center.longitude}/${REGION_CONFIGS[0]!.radiusNauticalMiles}`,
      ]);
      expect(requests.every((request) => request.method === 'GET')).toBe(true);
      expect(requests.every((request) => !request.headers.has('authorization'))).toBe(true);
      expect(requests.every((request) => !request.headers.has('cookie'))).toBe(true);
    },
  );

  it('defaults to disabled and never constructs a fetching provider', () => {
    const external = vi.fn();
    vi.stubGlobal('fetch', external);
    expect(configuredLiveSource(configuration())).toMatchObject({
      mode: 'disabled',
      target: 'production',
    });
    expect(configuredProvider(configuration())).toBeUndefined();
    expect(external).not.toHaveBeenCalled();
  });

  it.each([
    { LIVE_PROVIDER_MODE: 'mock' },
    { LIVE_BUILD_TARGET: 'local-mock', LIVE_PROVIDER_MODE: 'live' },
    { LIVE_BUILD_TARGET: 'mock-staging', LIVE_PROVIDER_MODE: 'mock' },
    { LIVE_PROVIDER_MODE: 'live', LIVE_PROVIDER_BASE_URL: 'https://example.com' },
    { LIVE_PROVIDER_MODE: 'live', LIVE_PROVIDER_BASE_URL: 'https://api.adsb.lol?key=bad' },
    { LIVE_BUILD_TARGET: 'unknown' },
    { LIVE_PROVIDER_MODE: 'automatic' },
    { MOCK_PROVIDER: { fetch: vi.fn() } },
  ])('rejects an unsafe configuration before fetch: %j', (overrides) => {
    const external = vi.fn();
    vi.stubGlobal('fetch', external);
    expect(() => configuredProvider(configuration(overrides))).toThrow();
    expect(external).not.toHaveBeenCalled();
  });

  it('normalizes each fixed region through the mock binding without network fallback', async () => {
    const { env, fetch } = mockConfiguration();
    const external = vi.fn(() => {
      throw new Error('External fetch forbidden.');
    });
    vi.stubGlobal('fetch', external);
    const provider = configuredProvider(env)!;
    for (const region of REGION_CONFIGS) {
      const snapshot = await provider.fetchRegion(region);
      expect(snapshot.providerId).toBe('synthetic-test');
      expect(snapshot.aircraft).toHaveLength(3);
      expect(snapshot.aircraft[0]?.callsign).toBe('TEST01');
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(external).not.toHaveBeenCalled();
    expect(provider.attributionUrl).toBe('');
  });

  it('does not fall back to the real provider after a service-binding failure', async () => {
    const { env, fetch } = mockConfiguration();
    fetch.mockRejectedValue(new Error('Synthetic unavailable.'));
    const external = vi.fn();
    vi.stubGlobal('fetch', external);
    await expect(configuredProvider(env)!.fetchRegion(REGION_CONFIGS[0])).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(external).not.toHaveBeenCalled();
  });

  it('rejects arbitrary coordinates and a real-provider origin in mock mode', async () => {
    const { env, fetch } = mockConfiguration();
    await expect(
      configuredProvider(env)!.fetchRegion({
        ...REGION_CONFIGS[0],
        center: { latitude: 0, longitude: 0 },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      configuredProvider({ ...env, LIVE_PROVIDER_BASE_URL: 'https://api.adsb.lol' }),
    ).toThrow();
  });
});
