import { RUNTIME_POLICY_LIMITS } from '../src/live/runtimePolicyLimits';

export const MAX_REGIONAL_VIEWERS: number = RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers;
export const MAX_REGIONAL_DELIVERY_BYTES: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumRegionalBytes;
export const LIVE_DELIVERY_ACK_TIMEOUT_MS: number =
  RUNTIME_POLICY_LIMITS.delivery.acknowledgmentTimeoutMs;
export const MIN_LIVE_PING_INTERVAL_MS: number =
  RUNTIME_POLICY_LIMITS.delivery.minimumPingIntervalMs;
export const MAX_VIEWER_ATTACHMENT_BYTES: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumViewerAttachmentBytes;
export const LIVE_CONTROL_WINDOW_MS: number = RUNTIME_POLICY_LIMITS.delivery.controlWindowMs;
export const MAX_SOCKET_CONTROLS_PER_WINDOW: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumControlsPerWindow;
export const MAX_REGIONAL_CONTROL_BURST: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumRegionalControlBurst;
export const REGIONAL_CONTROL_REFILL_PER_SECOND: number =
  RUNTIME_POLICY_LIMITS.delivery.regionalControlRefillPerSecond;
