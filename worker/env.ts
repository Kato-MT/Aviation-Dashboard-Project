import type { RegionalFeedHub } from './regionalFeedHub';

export interface WorkerEnv {
  ASSETS: Fetcher;
  REGION_FEEDS: DurableObjectNamespace<RegionalFeedHub>;
  LIVE_PROVIDER_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  APP_VERSION: string;
  RELEASE_SHA: string;
}
