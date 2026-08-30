import './denyNativeEgress';
import worker, { RegionalFeedHub as RegionalFeedHubBase } from '../../worker/index';
import type { WorkerEnv } from '../../worker/env';
import { nativeEgressProbe } from './denyNativeEgress';

const probePath = '/__live-test/native-egress';

export class RegionalFeedHub extends RegionalFeedHubBase {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__live-test/native-egress') {
      return nativeEgressProbe('regional-feed');
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== probePath) return worker.fetch(request, env);
    if (url.searchParams.size !== 1) {
      return Response.json({ error: 'NATIVE_EGRESS_PROBE_INVALID' }, { status: 400 });
    }
    const target = url.searchParams.get('target');
    if (target === 'worker') return nativeEgressProbe('worker');
    if (target === 'mock-provider') {
      if (!env.MOCK_PROVIDER) {
        return Response.json({ error: 'MOCK_PROVIDER_UNAVAILABLE' }, { status: 503 });
      }
      return env.MOCK_PROVIDER.fetch(
        new Request('https://mock-provider.invalid/__live-test/native-egress'),
      );
    }
    if (target === 'regional-feed') {
      return env.REGION_FEEDS.getByName('native-egress-probe').fetch(
        new Request('https://regional-feed.internal/__live-test/native-egress', {
          headers: { 'x-region-id': 'atlanta' },
        }),
      );
    }
    return Response.json({ error: 'NATIVE_EGRESS_PROBE_INVALID' }, { status: 400 });
  },
} satisfies ExportedHandler<WorkerEnv>;
