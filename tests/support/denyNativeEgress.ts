export const NATIVE_EGRESS_BLOCKED = 'NATIVE_EGRESS_BLOCKED';
const guardMarker = '__flightNativeEgressGuardInstalled__';
const probeUrl = 'http://127.0.0.1:1/__flight_native_egress_probe__';

type GuardedGlobal = typeof globalThis & {
  [guardMarker]?: boolean;
};

const scope = globalThis as GuardedGlobal;
if (!scope[guardMarker]) {
  const deniedFetch: typeof fetch = async () => {
    const error = new Error(
      'Native fetch is disabled in the controlled Live test runtime.',
    ) as Error & { code: string };
    error.code = NATIVE_EGRESS_BLOCKED;
    throw error;
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: false,
    enumerable: true,
    value: deniedFetch,
    writable: false,
  });
  Object.defineProperty(scope, guardMarker, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

export async function nativeEgressProbe(target: string): Promise<Response> {
  try {
    await globalThis.fetch(probeUrl);
    return Response.json(
      { error: 'NATIVE_EGRESS_GUARD_BYPASSED', target },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === NATIVE_EGRESS_BLOCKED) {
      return Response.json(
        { blocked: true, code: NATIVE_EGRESS_BLOCKED, target },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    return Response.json(
      { error: 'NATIVE_EGRESS_GUARD_NOT_INSTALLED', target },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
