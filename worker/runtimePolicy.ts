import { compileRuntimePolicyBindings, type RuntimePolicyV1 } from '../src/live/runtimePolicy';
import type { WorkerEnv } from './env';

const compiledPolicies = new WeakMap<object, Promise<Readonly<RuntimePolicyV1>>>();

/** Compiles and identity-checks the immutable policy once per Worker environment object. */
export function runtimePolicyForWorkerEnv(env: WorkerEnv): Promise<Readonly<RuntimePolicyV1>> {
  const key = env as object;
  const cached = compiledPolicies.get(key);
  if (cached) return cached;
  const pending = compileRuntimePolicyBindings(env, env.MOCK_PROVIDER !== undefined);
  compiledPolicies.set(key, pending);
  return pending;
}
