import type { RegionalFeedHub } from './regionalFeedHub';

export interface WorkerEnv {
  ASSETS: Fetcher;
  REGION_FEEDS: DurableObjectNamespace<RegionalFeedHub>;
  LIVE_PROVIDER_BASE_URL?: string;
  LIVE_PROVIDER_MODE?: string;
  LIVE_BUILD_TARGET?: string;
  MOCK_PROVIDER?: Fetcher;
  MAP_ASSETS?: R2Bucket;
  ALLOWED_ORIGINS: string;
  APP_VERSION: string;
  RELEASE_SHA: string;
  RUNTIME_POLICY_EPOCH: string;
  RUNTIME_DEPLOYMENT_CLASS: string;
  RUNTIME_RELEASE_STATUS: string;
  RUNTIME_PROVIDER_GATE_STATUS: string;
  RUNTIME_PROVIDER_GATE_VALUE: string;
  RUNTIME_POLICY_ID: string;
}
