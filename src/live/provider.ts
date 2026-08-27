import type { ProviderSnapshot, RegionConfig } from './types';

export interface LiveAircraftProvider {
  readonly id: string;
  readonly label: string;
  readonly attributionUrl: string;
  fetchRegion(region: RegionConfig, signal?: AbortSignal): Promise<ProviderSnapshot>;
}

export type LiveProviderErrorCode =
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'MALFORMED_JSON'
  | 'INVALID_PAYLOAD'
  | 'NETWORK_ERROR';

export class LiveProviderError extends Error {
  readonly code: LiveProviderErrorCode;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number | undefined;

  constructor(
    code: LiveProviderErrorCode,
    message: string,
    options: { retryAfterSeconds?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LiveProviderError';
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.status;
  }
}
