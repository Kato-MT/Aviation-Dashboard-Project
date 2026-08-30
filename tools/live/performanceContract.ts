import type { RuntimePolicyLimits } from '../../src/live/runtimePolicyLimits';

export interface PerformanceServerIdentity {
  readonly schemaVersion: 'airspace-performance-server.v1';
  readonly source: {
    readonly head: string;
    readonly dirty: boolean;
    readonly contentSha256: string;
  };
  readonly optimizedClient: {
    readonly schemaVersion: 'sha256-file-inventory.v1';
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sha256: string;
  };
  readonly map: {
    readonly id: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sha256: string;
  };
  readonly policy: {
    readonly limits: RuntimePolicyLimits;
    readonly limitsSha256: string;
  };
}

export interface PerformanceIdentityCapture {
  readonly schemaVersion: 'airspace-performance-identity-capture.v1';
  readonly source: PerformanceServerIdentity['source'];
  readonly optimizedClient: PerformanceServerIdentity['optimizedClient'];
}
