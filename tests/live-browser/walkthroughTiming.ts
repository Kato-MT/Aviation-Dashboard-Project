import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';

const WALKTHROUGH_PROVIDER_STATE_COUNT = 5;

export const WALKTHROUGH_STEP_TIMEOUT_MS =
  RUNTIME_POLICY_LIMITS.provider.pollIntervalMs +
  RUNTIME_POLICY_LIMITS.provider.requestTimeoutMs +
  RUNTIME_POLICY_LIMITS.delivery.acknowledgmentTimeoutMs;

export const WALKTHROUGH_TEST_TIMEOUT_MS =
  WALKTHROUGH_STEP_TIMEOUT_MS * WALKTHROUGH_PROVIDER_STATE_COUNT;
