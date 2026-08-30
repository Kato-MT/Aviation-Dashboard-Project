import type { OperationsProjection } from '../operations/contract';

export type EvidenceReleaseStatus = 'unreleased' | 'exact-release';

export interface EvidenceBuildIdentity {
  applicationVersion: string;
  releaseSha: string;
  releaseStatus: EvidenceReleaseStatus;
  buildTarget: string;
}

export interface MapEvidenceSummary {
  manifestSchemaVersion: 'map-assets.v1';
  mapId: string;
  sourceUrl: string;
  sourceDate: string;
  tilesetVersion: string;
  bounds: readonly [west: number, south: number, east: number, north: number];
  minZoom: number;
  maxZoom: number;
  cliVersion: string;
  styleVersion: string;
  styleCommit: string;
  assetsCommit: string;
  osmReplicationTime: string;
  totalBytes: number;
  assetCount: number;
  addressedTiles: number;
  basemapBytes: number;
  basemapSha256: string;
}

export type GateImplementationStatus = 'implemented' | 'in-progress' | 'not-applicable';
export type GateExecutionStatus =
  'executed-local' | 'passed-historical' | 'not-executed' | 'external-evidence-needed';
export type GateReleaseStatus = 'pending' | 'passed';

export interface ReleaseGateEvidence {
  id: string;
  gate: string;
  implementation: GateImplementationStatus;
  execution: GateExecutionStatus;
  release: GateReleaseStatus;
  evidence: string;
}

export type EvidenceOperations = Readonly<OperationsProjection>;
export type EvidenceOperationsLoader = (signal?: AbortSignal) => Promise<EvidenceOperations>;
