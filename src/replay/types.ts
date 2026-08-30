import type { LiveSessionState } from '../live/session';
import type {
  AircraftState,
  AirspaceSnapshot,
  LiveFeedHealth,
  LiveFeedStatus,
} from '../live/types';

export const AIRSPACE_REPLAY_SCHEMA_VERSION = 'airspace-replay.v1' as const;
export const AIRSPACE_REPLAY_GENERATOR_ID = 'fdw-airspace-replay' as const;
export const AIRSPACE_REPLAY_GENERATOR_VERSION = '1.0.0' as const;
export const REPLAY_PROVIDER_ID = 'synthetic-replay' as const;
export const REPLAY_MAX_BYTES = 1024 * 1024;
export const REPLAY_MAX_EVENTS = 256;
export const REPLAY_MAX_DURATION_MS = 30 * 60 * 1_000;
export const REPLAY_MAX_AIRCRAFT = 100;
export const REPLAY_SPEEDS = [1, 2, 4] as const;

export type AirspaceReplaySchemaVersion = typeof AIRSPACE_REPLAY_SCHEMA_VERSION;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export type ReplayScenarioId =
  'nominal-regional' | 'data-quality-gaps' | 'provider-outage-recovery';
export type ReplayAircraftId = `demo:${ReplayScenarioId}:${number}`;
export type ReplayEventDisposition = 'accepted' | 'rejected';
export type ReplayEventKind = 'snapshot' | 'health';

export interface ReplayUnits {
  altitude: 'feet';
  groundSpeed: 'knots';
  verticalRate: 'feet-per-minute';
  track: 'degrees';
  time: 'UTC ISO-8601';
}

export interface ReplayProvenance {
  synthetic: true;
  classification: 'SYNTHETIC_UNCLASSIFIED';
  generatorId: typeof AIRSPACE_REPLAY_GENERATOR_ID;
  generatorVersion: typeof AIRSPACE_REPLAY_GENERATOR_VERSION;
  canonicalSha256: string;
  units: ReplayUnits;
}

export type ReplayAircraftState = Omit<AircraftState, 'aircraftId' | 'identifierKind'> & {
  aircraftId: ReplayAircraftId;
  identifierKind: 'synthetic';
  synthetic: true;
};

export type ReplaySnapshot = Omit<AirspaceSnapshot, 'aircraft'> & {
  aircraft: ReplayAircraftState[];
};

interface ReplayEventBase {
  index: number;
  offsetMs: number;
  label: string;
  description: string;
  expectedDisposition: ReplayEventDisposition;
}

export interface ReplaySnapshotEvent extends ReplayEventBase {
  kind: 'snapshot';
  snapshot: ReplaySnapshot;
}

export interface ReplayHealthEvent extends ReplayEventBase {
  kind: 'health';
  health: LiveFeedHealth;
}

export type ReplayEvent = ReplaySnapshotEvent | ReplayHealthEvent;

export interface ReplayManifest {
  schemaVersion: AirspaceReplaySchemaVersion;
  scenarioId: ReplayScenarioId;
  title: string;
  description: string;
  seed: number;
  synthetic: true;
  startAt: string;
  durationMs: number;
  provenance: ReplayProvenance;
  events: ReplayEvent[];
}

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ReadonlyReplaySnapshot = DeepReadonly<ReplaySnapshot>;
export type ReadonlyReplayEvent = DeepReadonly<ReplayEvent>;

/** Produced only by the replay parser after digest and transition verification. */
export type ValidatedReplayManifest = DeepReadonly<ReplayManifest>;

export type ReplayParseResult =
  { ok: true; manifest: ValidatedReplayManifest; errors: [] } | { ok: false; errors: string[] };

export interface ReplayScenarioMetadata {
  id: ReplayScenarioId;
  title: string;
  description: string;
  defaultSeed: number;
  durationMs: number;
}

export interface ReplayClockState {
  positionMs: number;
  durationMs: number;
  speed: ReplaySpeed;
  playing: boolean;
  disposed: boolean;
}

export type ReplayClockChangeReason =
  'play' | 'pause' | 'seek' | 'speed' | 'tick' | 'end' | 'dispose';

export interface ReplayClockChange {
  state: ReplayClockState;
  reason: ReplayClockChangeReason;
}

export interface ReplayTranscriptEntry {
  eventIndex: number;
  offsetMs: number;
  kind: ReplayEventKind;
  label: string;
  description: string;
  expectedDisposition: ReplayEventDisposition;
  outcome: ReplayEventDisposition;
  matchesExpectation: boolean;
  phaseAfter: LiveFeedStatus | 'loading' | 'error';
  snapshotSequence?: number | undefined;
}

export interface ReplayRuntimeState {
  manifest: ValidatedReplayManifest;
  positionMs: number;
  speed: ReplaySpeed;
  playing: boolean;
  ended: boolean;
  session: LiveSessionState;
  transcript: readonly ReplayTranscriptEntry[];
  currentEvent?: ReplayTranscriptEntry | undefined;
}
