import './denyNativeEgress';
import mockProvider from './mockProvider';
import { nativeEgressProbe } from './denyNativeEgress';

export default {
  fetch(
    request: Request,
    env: Parameters<typeof mockProvider.fetch>[1],
  ): Response | Promise<Response> {
    if (new URL(request.url).pathname === '/__live-test/native-egress') {
      return nativeEgressProbe('mock-provider');
    }
    return mockProvider.fetch(request, env);
  },
};
