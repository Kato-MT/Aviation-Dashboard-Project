import type { LiveAircraftProvider } from '../src/live/provider';
import { ADSB_LOL_USER_AGENT, createAdsbLolProvider } from '../src/live/providers/adsbLol';
import { regionConfigsForLiveSource } from '../src/live/regions';
import type { RuntimePolicyV1 } from '../src/live/runtimePolicy';
import { RUNTIME_POLICY_LIMITS, type RuntimePolicyLimits } from '../src/live/runtimePolicyLimits';
import { describeLiveSource, type LiveSourceDescriptor } from '../src/live/source';

export interface ProviderConfiguration {
  LIVE_BUILD_TARGET?: string;
  LIVE_PROVIDER_MODE?: string;
  LIVE_PROVIDER_BASE_URL?: string;
  MOCK_PROVIDER?: { fetch(request: Request): Promise<Response> };
}

export const MOCK_PROVIDER_ORIGIN = 'https://mock-provider.invalid';
export const LIVE_PROVIDER_ORIGIN = 'https://api.adsb.lol';
function fixedProviderPaths(source: Readonly<LiveSourceDescriptor>): readonly string[] {
  return regionConfigsForLiveSource(source).map(
    (region) =>
      `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
  );
}

export class LiveConfigurationError extends Error {}

export function configuredLiveSource(env: ProviderConfiguration): Readonly<LiveSourceDescriptor> {
  let source: Readonly<LiveSourceDescriptor>;
  try {
    source = describeLiveSource(
      env.LIVE_BUILD_TARGET ?? 'production',
      env.LIVE_PROVIDER_MODE ?? 'disabled',
    );
  } catch {
    throw new LiveConfigurationError('The server live-source configuration is invalid.');
  }
  const expectedOrigin = source.synthetic ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN;
  if (env.LIVE_PROVIDER_BASE_URL !== undefined && env.LIVE_PROVIDER_BASE_URL !== expectedOrigin) {
    throw new LiveConfigurationError('Only the configured fixed provider origin is allowed.');
  }
  if (!source.synthetic && env.MOCK_PROVIDER) {
    throw new LiveConfigurationError('A mock binding is not permitted in a real-source target.');
  }
  if (source.mode === 'mock' && !env.MOCK_PROVIDER) {
    throw new LiveConfigurationError('Mock mode requires its isolated service binding.');
  }
  return source;
}

export function configuredProvider(env: ProviderConfiguration): LiveAircraftProvider | undefined {
  const source = configuredLiveSource(env);
  return providerForSource(
    source,
    source.synthetic ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN,
    fixedProviderPaths(source),
    env,
    RUNTIME_POLICY_LIMITS.provider,
  );
}

function providerForSource(
  source: Readonly<LiveSourceDescriptor>,
  origin: string,
  providerPaths: readonly string[],
  env: ProviderConfiguration,
  limits: RuntimePolicyLimits['provider'],
): LiveAircraftProvider | undefined {
  if (source.mode === 'disabled') return undefined;
  const provider = createAdsbLolProvider({
    baseUrl: origin,
    maxResponseBytes: limits.maximumResponseBytes,
    maxAircraft: limits.maximumAircraft,
    timeoutMs: limits.requestTimeoutMs,
    fetcher: async (input, init) => {
      // workerd does not implement redirect: 'error'. The adapter rejects all non-2xx responses.
      const request = new Request(input, { ...init, redirect: 'manual' });
      const url = new URL(request.url);
      if (
        request.method !== 'GET' ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !providerPaths.includes(url.pathname) ||
        request.headers.get('accept') !== 'application/json' ||
        request.headers.get('user-agent') !== ADSB_LOL_USER_AGENT ||
        request.headers.has('authorization') ||
        request.headers.has('cookie')
      ) {
        throw new LiveConfigurationError(
          'The provider request is outside its fixed regional boundary.',
        );
      }
      // Service-binding dispatch has no DNS lookup or network-fetch fallback.
      return source.mode === 'mock' ? env.MOCK_PROVIDER!.fetch(request) : globalThis.fetch(request);
    },
  });
  return {
    id: source.providerId,
    label: source.label,
    attributionUrl: source.synthetic ? '' : provider.attributionUrl,
    async fetchRegion(region, signal) {
      const snapshot = await provider.fetchRegion(region, signal);
      return { ...snapshot, providerId: source.providerId };
    },
  };
}

/** Constructs the only provider capability described by the already-compiled policy. */
export function providerForRuntimePolicy(
  policy: Readonly<RuntimePolicyV1>,
  env: ProviderConfiguration,
): LiveAircraftProvider | undefined {
  const { descriptor, providerOrigin, providerPaths } = policy.source;
  if (descriptor.mode === 'disabled') return undefined;
  const expectedProviderPaths = fixedProviderPaths(descriptor);
  if (providerOrigin === null || providerPaths.length !== expectedProviderPaths.length) {
    throw new LiveConfigurationError('The compiled provider capability is incomplete.');
  }
  if (
    !providerPaths.every((path, index) => path === expectedProviderPaths[index]) ||
    providerOrigin !== (descriptor.synthetic ? MOCK_PROVIDER_ORIGIN : LIVE_PROVIDER_ORIGIN)
  ) {
    throw new LiveConfigurationError('The compiled provider capability is outside its boundary.');
  }
  return providerForSource(descriptor, providerOrigin, providerPaths, env, policy.limits.provider);
}
