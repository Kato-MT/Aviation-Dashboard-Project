import { expect, type APIRequestContext } from '@playwright/test';

export async function expectNativeEgressDenied(request: APIRequestContext): Promise<void> {
  for (const target of ['worker', 'regional-feed', 'mock-provider']) {
    const response = await request.get(
      '/__live-test/native-egress?target=' + encodeURIComponent(target),
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      blocked: true,
      code: 'NATIVE_EGRESS_BLOCKED',
      target,
    });
  }
}
