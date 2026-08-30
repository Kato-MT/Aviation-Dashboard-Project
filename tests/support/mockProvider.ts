import { REGION_CONFIGS } from '../../src/live/regions';

export const MOCK_SCENARIOS = [
  'nominal',
  'empty',
  'stale',
  'unavailable',
  'recovery',
  'walkthrough',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

interface MockProviderEnv {
  MOCK_SCENARIO?: string;
}
const origin = 'https://mock-provider.invalid';
const paths = REGION_CONFIGS.map(
  (region) =>
    `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
);

export function createMockProvider(now: () => number = Date.now) {
  const started = new Map<string, number>();
  const walkthroughSteps = new Map<string, number>();
  return {
    fetch(request: Request, env: MockProviderEnv): Response {
      const url = new URL(request.url);
      const index = paths.indexOf(url.pathname);
      if (
        request.method !== 'GET' ||
        url.origin !== origin ||
        url.search ||
        url.hash ||
        index < 0 ||
        request.headers.has('authorization') ||
        request.headers.has('cookie')
      ) {
        return Response.json({ error: 'MOCK_REQUEST_REJECTED' }, { status: 400 });
      }
      const configured = env.MOCK_SCENARIO ?? 'nominal';
      if (!MOCK_SCENARIOS.includes(configured as MockScenario)) {
        return Response.json({ error: 'MOCK_SCENARIO_INVALID' }, { status: 503 });
      }
      const timestamp = now();
      if (!started.has(url.pathname)) started.set(url.pathname, timestamp);
      const elapsed = timestamp - started.get(url.pathname)!;
      let scenario = configured;
      if (configured === 'recovery') scenario = elapsed < 15_000 ? 'unavailable' : 'nominal';
      if (configured === 'walkthrough') {
        // Attempt-start cadence need not align with this service's receipt clock.
        // Advance on actual upstream requests so timing jitter cannot skip a state.
        const steps = ['nominal', 'empty', 'stale', 'unavailable', 'nominal'] as const;
        const step = walkthroughSteps.get(url.pathname) ?? 0;
        scenario = steps[step]!;
        walkthroughSteps.set(url.pathname, Math.min(step + 1, steps.length - 1));
      }
      if (scenario === 'unavailable') {
        return Response.json(
          { error: 'SYNTHETIC_OUTAGE' },
          { status: 503, headers: { 'retry-after': '20' } },
        );
      }
      const region = REGION_CONFIGS[index]!;
      const age = scenario === 'stale' ? 60 : 1;
      const phase = Math.sin(elapsed / 90_000) * 0.08;
      const ac =
        scenario === 'empty'
          ? []
          : [
              {
                hex: '000001',
                flight: 'TEST01',
                t: 'TEST',
                lat: region.center.latitude + 0.18 + phase,
                lon: region.center.longitude - 0.12,
                alt_baro: 12_000,
                gs: 320,
                track: 45,
                baro_rate: 500,
                seen: age,
                seen_pos: age + 1,
              },
              {
                hex: '000002',
                flight: 'TEST02',
                t: 'TEST',
                lat: region.center.latitude - 0.2,
                lon: region.center.longitude + 0.24 + phase,
                alt_baro: 26_500,
                gs: 410,
                track: 210,
                baro_rate: -300,
                seen: age,
                seen_pos: age + 1,
              },
              { hex: '000003', flight: 'TEST03', seen: age },
            ];
      return Response.json({ now: timestamp, ac }, { headers: { 'cache-control': 'no-store' } });
    },
  };
}

// Auxiliary service only. The public-production build never imports this module.
export default createMockProvider();
