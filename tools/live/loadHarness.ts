import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  convertV4MiniflareOptions,
  Miniflare,
  type Json,
  type V4MiniflareOptions,
  type V4WorkerOptions,
  type V4WorkerdStructuredLog,
} from 'miniflare';
import WebSocket, { type RawData } from 'ws';

import {
  parseLiveServerFrame,
  serializeLiveAcknowledgment,
  type LiveDeliveryMessage,
} from '../../src/live/delivery';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import { REGION_CONFIGS } from '../../src/live/regions';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import {
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  MAX_REGIONAL_VIEWERS,
  MIN_LIVE_PING_INTERVAL_MS,
} from '../../worker/deliveryPolicy';
import { POLL_INTERVAL_MS } from '../../worker/polling';
import {
  LOAD_HARNESS_HELP,
  LOAD_HARNESS_SCHEMA_VERSION,
  PROVIDER_EARLY_TOLERANCE_MS,
  PROVIDER_LATE_TOLERANCE_MS,
  assessProviderCadence,
  assessSoakMemoryPlateau,
  attemptAccountingIsComplete,
  measuredOutcome,
  parseLoadHarnessCli,
  summarizeSamples,
  validateAckReceiptTiming,
  type AckReceiptTiming,
  type HardGate,
  type LoadHarnessScenario,
  type SoakMemoryPlateauAssessment,
} from './loadHarnessReport';
import {
  completeStagedLoadArtifactInput,
  completeLoadArtifactInput,
  disposeStagedLoadArtifactInput,
  revalidateLoadHarnessOutputPath,
  resolveLoadArtifactInput,
  resolveLoadHarnessOutputPath,
  stageLoadArtifactInput,
  type CandidateSelectionExpectation,
  type LoadArtifactRuntimePaths,
  type ResolvedLoadHarnessOutput,
} from './loadArtifactInput';
import { captureSourceIdentity, type SourceIdentity } from './retainCandidate';
import {
  createWorkerdMemorySampler,
  type WorkerdMemoryCloseResult,
  type WorkerdMemoryDiscovery,
  type WorkerdMemorySampler,
} from './workerdMemorySampler';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONNECTION_TIMEOUT_MS = 8_000;
const EXPECTED_STALL_CLOSE_CODE = 1008;
const EXPECTED_STALL_CLOSE_REASON = 'Live delivery acknowledgment timed out.';
const ACK_PROBE_TIMEOUT_MS = 5_000;
const ACK_PROBE_SETTLE_MS = 2_000;
const WATERMARK_DRAIN_TIMEOUT_MS = 15_000;
const POST_DEADLINE_WAKE_SLACK_MS = 250;
const POST_DEADLINE_CLOSE_TIMEOUT_MS = 3_000;
const RECONNECT_SETTLE_TIMEOUT_MS = 3_000;
const RECONNECT_PROVIDER_OBSERVATION_TIMEOUT_MS = POLL_INTERVAL_MS + 5_000;
const MIN_RECONNECT_PROVIDER_GAP_MS = POLL_INTERVAL_MS - PROVIDER_EARLY_TOLERANCE_MS;
const MAX_RECONNECT_PROVIDER_GAP_MS = POLL_INTERVAL_MS + PROVIDER_LATE_TOLERANCE_MS;

function loadCandidateSelectionExpectation(): CandidateSelectionExpectation {
  const expectedSelectionRecordSha256 = process.env.M34_EXPECTED_SELECTION_SHA256?.trim();
  const expectedCandidateId = process.env.M34_EXPECTED_CANDIDATE_ID?.trim();
  if (!expectedSelectionRecordSha256 && !expectedCandidateId) {
    throw new Error(
      'Candidate-bound load execution requires M34_EXPECTED_SELECTION_SHA256 or M34_EXPECTED_CANDIDATE_ID.',
    );
  }
  const selectionRecordPath = process.env.M34_SELECTION_RECORD_PATH?.trim();
  return {
    ...(selectionRecordPath ? { selectionRecordPath } : {}),
    ...(expectedSelectionRecordSha256 ? { expectedSelectionRecordSha256 } : {}),
    ...(expectedCandidateId ? { expectedCandidateId } : {}),
  };
}
const MAX_REJECTION_BODY_BYTES = 64 * 1_024;
const MAX_RECORDED_ERRORS = 32;
const MEMORY_TIMING_TOLERANCE_MS = 2;
const REGION_IDS = ['atlanta', 'savannah-statesboro', 'central-georgia'] as const;

export type RegionId = (typeof REGION_IDS)[number];

const PROVIDER_PATH_TO_REGION = new Map<string, RegionId>(
  REGION_CONFIGS.map((region) => [
    `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
    region.id,
  ]),
);

export interface GeneratedWorkerConfig {
  name: string;
  main: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  vars: Record<string, Json>;
  assets: {
    directory: string;
    binding: string;
    runWorkerFirst: boolean | string[];
    htmlHandling: 'none';
    notFoundHandling: 'none';
  };
  limits: { cpuMs: number; subrequests: number };
  durableObjectClassName: 'RegionalFeedHub';
  r2BucketName: string;
  mockProviderServiceName: 'flight-airspace-mock-provider';
  sqliteMigrationTag: string;
}

interface RunDefinition {
  id: string;
  regionIds: readonly RegionId[];
  viewersPerRegion: number;
  overflowAttempts: number;
  durationMs: number;
  recordsPerSnapshot: number;
  stalledPerRegion: boolean;
}

interface Rejection {
  status: number;
  code: string;
  bodyBytes: number;
}

type PingPurpose = 'ack-proof' | 'post-deadline-wake';
type ProbeOutcome = 'pending' | 'matched' | 'timed-out' | 'send-failed' | 'unresolved';

export interface ProbeObservation {
  requestId: string;
  clientIndex: number;
  purpose: PingPurpose;
  precedingAcknowledgment: {
    deliveryId: string;
    regionId: RegionId;
    snapshotSequence: number;
    callbackMonotonicMs: number;
  } | null;
  sentAtMonotonicMs: number;
  outcome: ProbeOutcome;
  completedAtMonotonicMs?: number | undefined;
  roundTripMs?: number | undefined;
}

interface PendingPing {
  requestId: string;
  sentAt: number;
  purpose: PingPurpose;
  timeout: ReturnType<typeof setTimeout>;
  observation: ProbeObservation;
}

export interface SnapshotReceipt {
  regionId: RegionId;
  sequence: number;
  clientIndex: number;
  deliveryId: string;
  receivedAtMonotonicMs: number;
  bytes: number;
}

export interface DeliveryFrameReceipt {
  clientIndex: number;
  regionId: RegionId;
  deliveryId: string;
  snapshotSequence: number | null;
  receivedAtMonotonicMs: number;
  bytes: number;
}

export interface RecordedAckTiming extends AckReceiptTiming {
  regionId: RegionId;
  snapshotSequence: number | null;
  succeeded: boolean;
}

interface ClientState {
  index: number;
  regionId: RegionId;
  socket: WebSocket;
  stalled: boolean;
  closingByHarness: boolean;
  replacement: boolean;
  openedAtMonotonicMs: number;
  deliveryFrames: number;
  ackSendCallbacks: number;
  pendingAcknowledgments: number;
  acceptingAcknowledgments: boolean;
  ackProofSchedulingEnabled: boolean;
  ackProbeMatches: number;
  snapshots: number;
  snapshotSequences: Set<number>;
  lastSnapshotSequence?: number | undefined;
  pendingPing?: PendingPing | undefined;
  pingCounter: number;
  lastPingAt: number;
  firstStalledReceiptAt?: number;
  expectedClose?: {
    code: number;
    reason: string;
    observedAtMonotonicMs: number;
    elapsedFromReceiptMs: number;
  };
}

export interface MemorySample {
  scheduledAtOffsetMs: number;
  startedAtOffsetMs: number;
  completedAtOffsetMs: number;
  pollDurationMs: number;
  driverRssBytes: number;
  driverHeapUsedBytes: number;
  workerdStatus: 'available' | 'unavailable' | 'error' | 'closed';
  workerdRssBytes: number | null;
  workerdProcessCount: number | null;
  workerdPids: number[] | null;
  workerdError: { code: string; message: string } | null;
}

interface MemoryRunEvidence {
  discovery: WorkerdMemoryDiscovery;
  close: WorkerdMemoryCloseResult;
  configuredIntervalMs: number;
  configuredDurationMs: number;
  missedScheduledSlots: number;
}

export interface MutableMetrics {
  offered: number;
  admitted: number;
  rejectedViewerCapacity: number;
  rejectedAdmission: number;
  unexpectedRejections: number;
  connectionFailures: number;
  reconnectAttempts: number;
  reconnectAdmitted: number;
  reconnectViewerCapacityRejections: number;
  reconnectAdmissionRejections: number;
  reconnectUnexpectedRejections: number;
  reconnectFailures: number;
  helloFrames: number;
  deliveryFrames: number;
  ackSendCallbacks: number;
  snapshotMessages: number;
  healthMessages: number;
  pongMessages: number;
  providerErrorMessages: number;
  receivedBytes: number;
  maximumEnvelopeBytes: number;
  maximumAircraftRecords: number;
  invalidSnapshotRecordCounts: number;
  sequenceRegressions: number;
  invalidFrames: number;
  sendErrors: number;
  unexpectedCloses: number;
  ackProbesSent: number;
  ackProbeMatches: number;
  ackProbeSendFailures: number;
  ackProbeTimeouts: number;
  ackProbeUnresolvedAtEnd: number;
  runtimeRestarts: number;
  runtimeErrors: string[];
  clientErrors: string[];
  rejections: Rejection[];
  ackTimings: RecordedAckTiming[];
  ackProbeRttMs: number[];
  probeObservations: ProbeObservation[];
  snapshotReceipts: SnapshotReceipt[];
  deliveryFrameReceipts: DeliveryFrameReceipt[];
  fanoutBySequence: Map<string, Map<number, number>>;
  memory: MemorySample[];
}

interface ExpiryWakeObservation {
  regionId: RegionId;
  stalledClientIndex: number;
  expectedDeadlineOffsetMs: number | null;
  wakeSentAtOffsetMs: number | null;
  wakeToCloseMs: number | null;
  closeObservedBeforeTeardown: boolean;
}

interface ReconnectProviderRegionObservation {
  regionId: RegionId;
  callsBeforeReconnect: number;
  callsAtReplacementOpen: number;
  callsDuringReconnect: number;
  callsAfterReplacementOpen: number;
  callsDuringObservation: number;
  offsetsFromPreviousCallMs: readonly number[];
  gapsMs: readonly number[];
}

interface ReconnectProviderObservation {
  startedAtOffsetMs: number | null;
  finishedAtOffsetMs: number | null;
  nextScheduledPublicationObserved: boolean;
  regions: readonly ReconnectProviderRegionObservation[];
}

export interface SequenceCoverage {
  regionId: RegionId;
  startSequence: number;
  endSequence: number;
  expectedSequences: number;
  completeSequences: number;
  expectedReceipts: number;
  coveredReceipts: number;
  duplicateReceipts: number;
}

export interface MeasurementEvidence {
  startedAtMonotonicMs: number;
  finishedAtMonotonicMs: number;
  startSequenceByRegion: ReadonlyMap<RegionId, number>;
  endSequenceByRegion: ReadonlyMap<RegionId, number>;
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>;
  sequenceCoverage: readonly SequenceCoverage[];
  snapshotReceipts: readonly SnapshotReceipt[];
  ackTimings: readonly RecordedAckTiming[];
  probes: readonly ProbeObservation[];
  fanoutSpreadMs: readonly number[];
  duplicateAckTimings: number;
  drain: {
    snapshotReceiptsAfterBoundary: number;
    ackCallbacksAfterBoundary: number;
    probeMatchesAfterBoundary: number;
  };
  postBoundary: {
    providerCalls: number;
    deliveryFrames: number;
    snapshotReceipts: number;
    receivedBytes: number;
    lateInWindowDeliveryFrames: number;
    controlDeliveryFramesAfterBoundary: number;
  };
}

export interface MeasurementClient {
  index: number;
  regionId: RegionId;
  stalled: boolean;
  openedAtMonotonicMs: number;
}

export interface MeasurementMetricInputs {
  snapshotReceipts: readonly SnapshotReceipt[];
  ackTimings: readonly RecordedAckTiming[];
  probeObservations: readonly ProbeObservation[];
  deliveryFrameReceipts: readonly DeliveryFrameReceipt[];
}

interface GateInputs {
  definition: RunDefinition;
  scenario: LoadHarnessScenario;
  clients: readonly ClientState[];
  metrics: MutableMetrics;
  measurement: MeasurementEvidence;
  invalidProviderCalls: number;
  representativeProviderResponseBytes: number;
  expiryWakeObservations: readonly ExpiryWakeObservation[];
  providerCallsBeforeReconnect: number | null;
  providerCallsAfterReconnect: number | null;
  reconnectProviderObservation: ReconnectProviderObservation;
  egressAttempts: number;
  hashesUnchanged: boolean;
  clockDriftMs: number;
  measurementDurationMs: number;
  soakMemory: SoakMemoryPlateauAssessment | null;
  memoryRun: MemoryRunEvidence;
  ackTimersDrainedBeforeTeardown: boolean;
}

function recordBounded(target: string[], message: string): void {
  if (target.length < MAX_RECORDED_ERRORS) target.push(message.slice(0, 512));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}

export function loadHarnessClientOrigin(config: Pick<GeneratedWorkerConfig, 'vars'>): string {
  const encoded = requiredString(config.vars.ALLOWED_ORIGINS, 'Generated Worker allowed origins');
  const origins = encoded.split(',');
  if (origins.some((origin) => origin.length === 0)) {
    throw new Error('Generated Worker allowed origins are invalid.');
  }
  const selected = origins[0]!;
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch {
    throw new Error('Generated Worker allowed origins are invalid.');
  }
  if (parsed.origin !== selected || parsed.username || parsed.password) {
    throw new Error('Generated Worker allowed origins are invalid.');
  }
  return selected;
}

function requiredNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>[];
}

function jsonBindings(value: unknown): Record<string, Json> {
  if (!isRecord(value)) throw new Error('Generated Worker variables are invalid.');
  return value as Record<string, Json>;
}

export async function loadGeneratedWorkerConfig(
  artifact: LoadArtifactRuntimePaths,
): Promise<GeneratedWorkerConfig> {
  const parsed = JSON.parse(await readFile(artifact.workerConfigPath, 'utf8')) as unknown;
  if (!isRecord(parsed)) throw new Error('Generated mock-staging Worker config is invalid.');
  const vars = jsonBindings(parsed.vars);
  if (
    vars.LIVE_PROVIDER_MODE !== 'mock' ||
    vars.LIVE_BUILD_TARGET !== 'mock-staging' ||
    vars.LIVE_PROVIDER_BASE_URL !== 'https://mock-provider.invalid'
  ) {
    throw new Error('The load harness requires the generated mock-staging Worker artifact.');
  }
  const assets = parsed.assets;
  if (!isRecord(assets)) throw new Error('Generated Worker assets configuration is invalid.');
  const limits = parsed.limits;
  if (!isRecord(limits)) throw new Error('Generated Worker limits are missing.');
  const durableObjects = parsed.durable_objects;
  if (!isRecord(durableObjects)) throw new Error('Generated Durable Object config is invalid.');
  const durableBinding = objectArray(
    durableObjects.bindings,
    'Generated Durable Object bindings',
  ).find((entry) => entry.name === 'REGION_FEEDS');
  const r2Binding = objectArray(parsed.r2_buckets, 'Generated R2 bindings').find(
    (entry) => entry.binding === 'MAP_ASSETS',
  );
  const mockProviderService = objectArray(parsed.services, 'Generated service bindings').find(
    (entry) => entry.binding === 'MOCK_PROVIDER',
  );
  const sqliteMigration = objectArray(
    parsed.migrations,
    'Generated Durable Object migrations',
  ).find(
    (entry) =>
      typeof entry.tag === 'string' &&
      Array.isArray(entry.new_sqlite_classes) &&
      entry.new_sqlite_classes.includes('RegionalFeedHub'),
  );
  if (
    durableBinding?.class_name !== 'RegionalFeedHub' ||
    r2Binding === undefined ||
    mockProviderService?.service !== 'flight-airspace-mock-provider' ||
    sqliteMigration === undefined
  ) {
    throw new Error('Generated Worker runtime bindings do not match the Live service.');
  }
  const runWorkerFirst = assets.run_worker_first;
  if (
    typeof runWorkerFirst !== 'boolean' &&
    (!Array.isArray(runWorkerFirst) || runWorkerFirst.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('Generated Worker-first routes are invalid.');
  }
  if (
    assets.binding !== 'ASSETS' ||
    assets.html_handling !== 'none' ||
    assets.not_found_handling !== 'none' ||
    resolve(artifact.workerRoot, requiredString(assets.directory, 'Generated client directory')) !==
      artifact.clientRoot
  ) {
    throw new Error('Generated Worker asset routing is not fail closed.');
  }
  const main = requiredString(parsed.main, 'Generated Worker entrypoint');
  if (
    main !== 'index.js' ||
    resolve(artifact.workerRoot, main) !== resolve(artifact.workerRoot, 'index.js')
  ) {
    throw new Error('Generated Worker entrypoint is outside the expected build topology.');
  }
  return {
    name: requiredString(parsed.name, 'Generated Worker name'),
    main,
    compatibilityDate: requiredString(parsed.compatibility_date, 'Compatibility date'),
    compatibilityFlags: Array.isArray(parsed.compatibility_flags)
      ? parsed.compatibility_flags.map((flag) => requiredString(flag, 'Compatibility flag'))
      : [],
    vars,
    assets: {
      directory: requiredString(assets.directory, 'Generated client directory'),
      binding: requiredString(assets.binding, 'Generated asset binding'),
      runWorkerFirst: runWorkerFirst as boolean | string[],
      htmlHandling: 'none',
      notFoundHandling: 'none',
    },
    limits: {
      cpuMs: requiredNumber(limits.cpu_ms, 'Generated CPU limit'),
      subrequests: requiredNumber(limits.subrequests, 'Generated subrequest limit'),
    },
    durableObjectClassName: 'RegionalFeedHub',
    r2BucketName: requiredString(r2Binding.bucket_name, 'Generated R2 bucket name'),
    mockProviderServiceName: 'flight-airspace-mock-provider',
    sqliteMigrationTag: requiredString(sqliteMigration.tag, 'Generated SQLite migration tag'),
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function packageVersion(packageDirectory: string, label: string): Promise<string> {
  const parsed = JSON.parse(
    await readFile(
      resolve(REPOSITORY_ROOT, 'node_modules', packageDirectory, 'package.json'),
      'utf8',
    ),
  ) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} package metadata is invalid.`);
  return requiredString(parsed.version, `${label} package version`);
}

function sameSourceIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function syntheticAircraft(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    hex: index.toString(16).padStart(6, '0'),
    flight: `LOAD${index.toString().padStart(6, '0')}`,
    r: `N${index.toString().padStart(6, '0')}`,
    t: 'TST500',
    category: 'A3',
    type: 'adsb_icao',
    lat: 32.5 + (index % 200) / 1_000,
    lon: -83.8 + (index % 250) / 1_000,
    alt_baro: 10_000 + (index % 300) * 100,
    alt_geom: 10_125 + (index % 300) * 100,
    gs: 250 + (index % 200),
    track: index % 360,
    baro_rate: (index % 21) * 100 - 1_000,
    seen: 1,
    seen_pos: 1,
  }));
}

function syntheticProvider(
  records: number,
  onRequest: (regionId: RegionId | null, responseBytes: number | null) => void,
): {
  aircraftCorpusSha256: string;
  representativeResponseBytes: number;
  fetch: (request: Request) => Promise<Response>;
} {
  const aircraft = syntheticAircraft(records);
  const aircraftCorpus = JSON.stringify(aircraft);
  const representativeResponse = JSON.stringify({ now: 9_999_999_999_999, ac: aircraft });
  const representativeResponseBytes = Buffer.byteLength(representativeResponse);
  if (representativeResponseBytes > MAX_LIVE_MESSAGE_BYTES) {
    throw new Error(`Synthetic provider fixture exceeds ${MAX_LIVE_MESSAGE_BYTES} bytes.`);
  }
  return {
    aircraftCorpusSha256: sha256Text(aircraftCorpus),
    representativeResponseBytes,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const regionId = PROVIDER_PATH_TO_REGION.get(url.pathname) ?? null;
      if (
        request.method !== 'GET' ||
        url.origin !== 'https://mock-provider.invalid' ||
        regionId === null ||
        url.search !== '' ||
        request.headers.has('authorization') ||
        request.headers.has('cookie')
      ) {
        onRequest(null, null);
        return Response.json({ error: 'LOAD_PROVIDER_REQUEST_REJECTED' }, { status: 400 });
      }
      const body = JSON.stringify({ now: Date.now(), ac: aircraft });
      onRequest(regionId, Buffer.byteLength(body));
      return new Response(body, {
        headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
      });
    },
  };
}

function caseDefinitions(scenario: LoadHarnessScenario): RunDefinition[] {
  if (scenario.profile === 'soak') {
    return [
      {
        id: 'three-hub-soak',
        regionIds: REGION_IDS,
        viewersPerRegion: 10,
        overflowAttempts: 0,
        durationMs: scenario.durationMs,
        recordsPerSnapshot: scenario.recordsPerSnapshot,
        stalledPerRegion: false,
      },
    ];
  }
  return [
    {
      id: 'one-hub-capacity',
      regionIds: ['atlanta'],
      viewersPerRegion: MAX_REGIONAL_VIEWERS,
      overflowAttempts: 1,
      durationMs: scenario.durationMs,
      recordsPerSnapshot: scenario.recordsPerSnapshot,
      stalledPerRegion: true,
    },
    {
      id: 'three-hub-transport',
      regionIds: REGION_IDS,
      viewersPerRegion: 10,
      overflowAttempts: 0,
      durationMs: scenario.durationMs,
      recordsPerSnapshot: scenario.recordsPerSnapshot,
      stalledPerRegion: false,
    },
  ];
}

export function freshMetrics(): MutableMetrics {
  return {
    offered: 0,
    admitted: 0,
    rejectedViewerCapacity: 0,
    rejectedAdmission: 0,
    unexpectedRejections: 0,
    connectionFailures: 0,
    reconnectAttempts: 0,
    reconnectAdmitted: 0,
    reconnectViewerCapacityRejections: 0,
    reconnectAdmissionRejections: 0,
    reconnectUnexpectedRejections: 0,
    reconnectFailures: 0,
    helloFrames: 0,
    deliveryFrames: 0,
    ackSendCallbacks: 0,
    snapshotMessages: 0,
    healthMessages: 0,
    pongMessages: 0,
    providerErrorMessages: 0,
    receivedBytes: 0,
    maximumEnvelopeBytes: 0,
    maximumAircraftRecords: 0,
    invalidSnapshotRecordCounts: 0,
    sequenceRegressions: 0,
    invalidFrames: 0,
    sendErrors: 0,
    unexpectedCloses: 0,
    ackProbesSent: 0,
    ackProbeMatches: 0,
    ackProbeSendFailures: 0,
    ackProbeTimeouts: 0,
    ackProbeUnresolvedAtEnd: 0,
    runtimeRestarts: 0,
    runtimeErrors: [],
    clientErrors: [],
    rejections: [],
    ackTimings: [],
    ackProbeRttMs: [],
    probeObservations: [],
    snapshotReceipts: [],
    deliveryFrameReceipts: [],
    fanoutBySequence: new Map(),
    memory: [],
  };
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function pingWire(requestId: string): string {
  return JSON.stringify({
    type: 'ping',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    requestId,
  });
}

function clearPendingPing(client: ClientState): PendingPing | undefined {
  const pending = client.pendingPing;
  if (pending === undefined) return undefined;
  clearTimeout(pending.timeout);
  client.pendingPing = undefined;
  return pending;
}

function sendPingProbe(
  client: ClientState,
  purpose: PingPurpose,
  metrics: MutableMetrics,
  precedingAcknowledgment: ProbeObservation['precedingAcknowledgment'] = null,
): boolean {
  if (purpose === 'ack-proof' && precedingAcknowledgment === null) return false;
  if (client.socket.readyState !== WebSocket.OPEN || client.pendingPing !== undefined) return false;
  client.pingCounter += 1;
  const requestId = `${purpose}-${client.index}-${client.pingCounter}`;
  const sentAt = performance.now();
  const observation: ProbeObservation = {
    requestId,
    clientIndex: client.index,
    purpose,
    precedingAcknowledgment,
    sentAtMonotonicMs: sentAt,
    outcome: 'pending',
  };
  metrics.probeObservations.push(observation);
  const timeout = setTimeout(() => {
    if (client.pendingPing?.requestId !== requestId) return;
    client.pendingPing = undefined;
    observation.outcome = 'timed-out';
    observation.completedAtMonotonicMs = performance.now();
    metrics.ackProbeTimeouts += 1;
    recordBounded(metrics.clientErrors, `${purpose} probe timed out for client ${client.index}.`);
  }, ACK_PROBE_TIMEOUT_MS);
  client.pendingPing = { requestId, sentAt, purpose, timeout, observation };
  client.lastPingAt = sentAt;
  metrics.ackProbesSent += 1;
  const sendFailed = (error: unknown) => {
    if (observation.outcome !== 'pending') return;
    if (client.pendingPing?.requestId === requestId) clearPendingPing(client);
    observation.outcome = 'send-failed';
    observation.completedAtMonotonicMs = performance.now();
    metrics.ackProbeSendFailures += 1;
    metrics.sendErrors += 1;
    recordBounded(metrics.clientErrors, `Ping send failed: ${String(error)}`);
  };
  try {
    client.socket.send(pingWire(requestId), (error) => {
      if (error) sendFailed(error.message);
    });
  } catch (error) {
    sendFailed(error);
  }
  return true;
}

function scheduleAcknowledgment(
  client: ClientState,
  delivery: LiveDeliveryMessage,
  receivedAt: number,
  delayMs: number,
  snapshotSequence: number | null,
  scenario: LoadHarnessScenario,
  metrics: MutableMetrics,
): void {
  client.pendingAcknowledgments += 1;
  setTimeout(() => {
    const timerFiredAt = performance.now();
    if (client.socket.readyState !== WebSocket.OPEN) {
      client.pendingAcknowledgments -= 1;
      return;
    }
    try {
      client.socket.send(serializeLiveAcknowledgment(delivery), (error) => {
        try {
          const callbackAt = performance.now();
          const sendSucceeded = error === undefined || error === null;
          const timing: RecordedAckTiming = {
            clientIndex: client.index,
            deliveryId: delivery.deliveryId,
            configuredDelayMs: delayMs,
            receivedMonotonicMs: receivedAt,
            timerFiredMonotonicMs: timerFiredAt,
            callbackMonotonicMs: callbackAt,
            regionId: client.regionId,
            snapshotSequence,
            succeeded: sendSucceeded,
          };
          const timingErrors = validateAckReceiptTiming(timing);
          if (timingErrors.length > 0) {
            for (const message of timingErrors) recordBounded(metrics.clientErrors, message);
          }
          metrics.ackTimings.push(timing);
          if (!sendSucceeded) {
            metrics.sendErrors += 1;
            recordBounded(metrics.clientErrors, `ACK send failed: ${String(error)}`);
            return;
          }
          client.ackSendCallbacks += 1;
          metrics.ackSendCallbacks += 1;
          if (
            client.ackProofSchedulingEnabled &&
            client.pendingPing === undefined &&
            callbackAt - client.lastPingAt >= scenario.pingProbeIntervalMs
          ) {
            if (snapshotSequence !== null) {
              sendPingProbe(client, 'ack-proof', metrics, {
                deliveryId: delivery.deliveryId,
                regionId: client.regionId,
                snapshotSequence,
                callbackMonotonicMs: callbackAt,
              });
            }
          }
        } finally {
          client.pendingAcknowledgments -= 1;
        }
      });
    } catch (error) {
      client.pendingAcknowledgments -= 1;
      metrics.sendErrors += 1;
      recordBounded(metrics.clientErrors, `ACK send failed: ${String(error)}`);
    }
  }, delayMs);
}

function receiveFrame(
  client: ClientState,
  data: RawData,
  scenario: LoadHarnessScenario,
  metrics: MutableMetrics,
): void {
  const text = rawText(data);
  const bytes = Buffer.byteLength(text);
  metrics.receivedBytes += bytes;
  metrics.maximumEnvelopeBytes = Math.max(metrics.maximumEnvelopeBytes, bytes);
  const parsed = parseLiveServerFrame(text);
  if (!parsed.ok) {
    metrics.invalidFrames += 1;
    recordBounded(metrics.clientErrors, parsed.errors.join(' '));
    return;
  }
  if (parsed.message.type === 'hello') {
    metrics.helloFrames += 1;
    return;
  }
  const delivery = parsed.message;
  const receivedAt = performance.now();
  client.deliveryFrames += 1;
  metrics.deliveryFrames += 1;
  let snapshotSequence: number | null = null;
  for (const message of delivery.messages) {
    if (message.type === 'airspace.snapshot') {
      snapshotSequence = message.snapshot.sequence;
      client.snapshots += 1;
      metrics.snapshotMessages += 1;
      metrics.snapshotReceipts.push({
        regionId: client.regionId,
        sequence: message.snapshot.sequence,
        clientIndex: client.index,
        deliveryId: delivery.deliveryId,
        receivedAtMonotonicMs: receivedAt,
        bytes,
      });
      if (message.snapshot.aircraft.length !== scenario.recordsPerSnapshot) {
        metrics.invalidSnapshotRecordCounts += 1;
      }
      if (
        client.lastSnapshotSequence !== undefined &&
        message.snapshot.sequence < client.lastSnapshotSequence
      ) {
        metrics.sequenceRegressions += 1;
      }
      client.lastSnapshotSequence = message.snapshot.sequence;
      client.snapshotSequences.add(message.snapshot.sequence);
      metrics.maximumAircraftRecords = Math.max(
        metrics.maximumAircraftRecords,
        message.snapshot.aircraft.length,
      );
      const key = `${client.regionId}:${message.snapshot.sequence}`;
      const receipts = metrics.fanoutBySequence.get(key) ?? new Map<number, number>();
      receipts.set(client.index, receivedAt);
      metrics.fanoutBySequence.set(key, receipts);
    } else if (message.type === 'feed.health') {
      metrics.healthMessages += 1;
    } else if (message.type === 'pong') {
      metrics.pongMessages += 1;
      if (client.pendingPing?.requestId === message.requestId) {
        const pending = clearPendingPing(client)!;
        const roundTripMs = receivedAt - pending.sentAt;
        pending.observation.outcome = 'matched';
        pending.observation.completedAtMonotonicMs = receivedAt;
        pending.observation.roundTripMs = roundTripMs;
        metrics.ackProbeRttMs.push(roundTripMs);
        metrics.ackProbeMatches += 1;
        client.ackProbeMatches += 1;
      } else {
        metrics.invalidFrames += 1;
        recordBounded(
          metrics.clientErrors,
          `Unexpected pong request id for client ${client.index}.`,
        );
      }
    } else if (message.type === 'error') {
      metrics.providerErrorMessages += 1;
    }
  }
  metrics.deliveryFrameReceipts.push({
    clientIndex: client.index,
    regionId: client.regionId,
    deliveryId: delivery.deliveryId,
    snapshotSequence,
    receivedAtMonotonicMs: receivedAt,
    bytes,
  });
  if (client.stalled) {
    client.firstStalledReceiptAt ??= receivedAt;
    return;
  }
  if (!client.acceptingAcknowledgments) return;
  const delayMs = scenario.ackDelaysMs[client.index % scenario.ackDelaysMs.length]!;
  scheduleAcknowledgment(
    client,
    delivery,
    receivedAt,
    delayMs,
    snapshotSequence,
    scenario,
    metrics,
  );
}

async function connectClient(
  origin: URL,
  clientOrigin: string,
  regionId: RegionId,
  index: number,
  stalled: boolean,
  replacement: boolean,
  scenario: LoadHarnessScenario,
  metrics: MutableMetrics,
): Promise<{ client?: ClientState; rejection?: Rejection; failed?: string }> {
  metrics.offered += 1;
  const url = new URL(`/api/v1/airspace/${regionId}/stream`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolveConnection) => {
    const socket = new WebSocket(url, { origin: clientOrigin });
    const client: ClientState = {
      index,
      regionId,
      socket,
      stalled,
      closingByHarness: false,
      replacement,
      openedAtMonotonicMs: Number.POSITIVE_INFINITY,
      deliveryFrames: 0,
      ackSendCallbacks: 0,
      pendingAcknowledgments: 0,
      acceptingAcknowledgments: true,
      ackProofSchedulingEnabled: replacement,
      ackProbeMatches: 0,
      snapshots: 0,
      snapshotSequences: new Set(),
      pingCounter: 0,
      lastPingAt: 0,
    };
    let settled = false;
    let opened = false;
    let rejected = false;
    const finish = (result: { client?: ClientState; rejection?: Rejection; failed?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveConnection(result);
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish({ failed: 'Connection attempt timed out.' });
    }, CONNECTION_TIMEOUT_MS);
    socket.on('open', () => {
      opened = true;
      client.openedAtMonotonicMs = performance.now();
      finish({ client });
    });
    socket.on('message', (data) => {
      try {
        receiveFrame(client, data, scenario, metrics);
      } catch (error) {
        metrics.invalidFrames += 1;
        recordBounded(metrics.clientErrors, `Frame handling failed: ${String(error)}`);
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      rejected = true;
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let excessive = false;
      response.on('data', (chunk: Buffer | string) => {
        if (excessive) return;
        const encoded = Buffer.from(chunk);
        bodyBytes += encoded.length;
        if (bodyBytes > MAX_REJECTION_BODY_BYTES) {
          excessive = true;
          response.destroy();
          socket.terminate();
          finish({
            rejection: {
              status: response.statusCode ?? 0,
              code: 'REJECTION_BODY_TOO_LARGE',
              bodyBytes,
            },
          });
          return;
        }
        chunks.push(encoded);
      });
      response.on('end', () => {
        if (excessive) return;
        const body = Buffer.concat(chunks);
        let code = 'UNPARSEABLE_REJECTION';
        try {
          const value = JSON.parse(body.toString('utf8')) as unknown;
          if (isRecord(value) && typeof value.error === 'string') code = value.error;
        } catch {
          // The classification remains explicit and bounded below.
        }
        socket.terminate();
        finish({ rejection: { status: response.statusCode ?? 0, code, bodyBytes: body.length } });
      });
    });
    socket.on('close', (code, reasonBytes) => {
      const reason = reasonBytes.toString('utf8');
      const pending = clearPendingPing(client);
      if (pending !== undefined) {
        pending.observation.outcome = 'unresolved';
        pending.observation.completedAtMonotonicMs = performance.now();
      }
      if (pending !== undefined && !client.closingByHarness) {
        metrics.ackProbeUnresolvedAtEnd += 1;
        recordBounded(
          metrics.clientErrors,
          `${pending.purpose} probe was unresolved when client ${index} closed.`,
        );
      }
      if (
        !client.closingByHarness &&
        client.stalled &&
        client.firstStalledReceiptAt !== undefined &&
        code === EXPECTED_STALL_CLOSE_CODE &&
        reason === EXPECTED_STALL_CLOSE_REASON
      ) {
        const observedAt = performance.now();
        client.expectedClose = {
          code,
          reason,
          observedAtMonotonicMs: observedAt,
          elapsedFromReceiptMs: observedAt - client.firstStalledReceiptAt,
        };
      } else if (opened && !client.closingByHarness) {
        metrics.unexpectedCloses += 1;
        recordBounded(
          metrics.clientErrors,
          `Unexpected close ${code} (${reason || 'no reason'}) for client ${index}.`,
        );
      }
    });
    socket.on('error', (error) => {
      if (!rejected) recordBounded(metrics.clientErrors, `Socket ${index}: ${error.message}`);
      if (!opened && !rejected) finish({ failed: error.message });
    });
  });
}

async function connectInBatches(
  origin: URL,
  clientOrigin: string,
  definition: RunDefinition,
  scenario: LoadHarnessScenario,
  metrics: MutableMetrics,
): Promise<ClientState[]> {
  const clients: ClientState[] = [];
  const work: Array<{ regionId: RegionId; index: number; stalled: boolean }> = [];
  let clientIndex = 0;
  for (const regionId of definition.regionIds) {
    for (let regionalIndex = 0; regionalIndex < definition.viewersPerRegion; regionalIndex += 1) {
      work.push({
        regionId,
        index: clientIndex,
        stalled: definition.stalledPerRegion && regionalIndex === definition.viewersPerRegion - 1,
      });
      clientIndex += 1;
    }
  }
  for (let offset = 0; offset < work.length; offset += 8) {
    const results = await Promise.all(
      work
        .slice(offset, offset + 8)
        .map(({ regionId, index, stalled }) =>
          connectClient(origin, clientOrigin, regionId, index, stalled, false, scenario, metrics),
        ),
    );
    for (const result of results) {
      if (result.client) {
        metrics.admitted += 1;
        clients.push(result.client);
      } else if (result.rejection) {
        classifyRejection(result.rejection, metrics);
      } else {
        metrics.connectionFailures += 1;
        recordBounded(metrics.clientErrors, result.failed ?? 'Unknown connection failure.');
      }
    }
  }
  for (let attempt = 0; attempt < definition.overflowAttempts; attempt += 1) {
    const result = await connectClient(
      origin,
      clientOrigin,
      definition.regionIds[0]!,
      clientIndex + attempt,
      false,
      false,
      scenario,
      metrics,
    );
    if (result.client) {
      metrics.admitted += 1;
      clients.push(result.client);
    } else if (result.rejection) {
      classifyRejection(result.rejection, metrics);
    } else {
      metrics.connectionFailures += 1;
      recordBounded(metrics.clientErrors, result.failed ?? 'Unknown overflow connection failure.');
    }
  }
  return clients;
}

function classifyRejection(
  rejection: Rejection,
  metrics: MutableMetrics,
): 'viewer-capacity' | 'isolate-admission' | 'unexpected' {
  metrics.rejections.push(rejection);
  if (rejection.code === 'VIEWER_CAPACITY' && rejection.status === 503) {
    metrics.rejectedViewerCapacity += 1;
    return 'viewer-capacity';
  } else if (rejection.code === 'STREAM_ADMISSION_LIMIT' && rejection.status === 429) {
    metrics.rejectedAdmission += 1;
    return 'isolate-admission';
  } else {
    metrics.unexpectedRejections += 1;
    return 'unexpected';
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, Math.max(0, durationMs)));
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

export async function freezeAndDrainAcknowledgments(
  clients: readonly { acceptingAcknowledgments: boolean; pendingAcknowledgments: number }[],
  timeoutMs: number,
): Promise<boolean> {
  for (const client of clients) client.acceptingAcknowledgments = false;
  return waitForCondition(
    () => clients.every((client) => client.pendingAcknowledgments === 0),
    timeoutMs,
  );
}

async function exerciseStalledExpiryAndReconnect(
  origin: URL,
  clientOrigin: string,
  definition: RunDefinition,
  scenario: LoadHarnessScenario,
  metrics: MutableMetrics,
  clients: ClientState[],
  startMonotonic: number,
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>,
): Promise<{
  observations: ExpiryWakeObservation[];
  providerCallsBeforeReconnect: number | null;
  providerCallsAfterReconnect: number | null;
  reconnectProviderObservation: ReconnectProviderObservation;
}> {
  const totalProviderCalls = () =>
    [...providerCallOffsetsByRegion.values()].reduce((total, offsets) => total + offsets.length, 0);
  const stalledClients = clients.filter((client) => client.stalled);
  if (stalledClients.length === 0) {
    return {
      observations: [],
      providerCallsBeforeReconnect: null,
      providerCallsAfterReconnect: null,
      reconnectProviderObservation: {
        startedAtOffsetMs: null,
        finishedAtOffsetMs: null,
        nextScheduledPublicationObserved: true,
        regions: [],
      },
    };
  }

  const stalledReceiptsObserved = await waitForCondition(
    () => stalledClients.every((client) => client.firstStalledReceiptAt !== undefined),
    5_000,
  );
  if (!stalledReceiptsObserved) {
    recordBounded(metrics.clientErrors, 'Not every stalled client received an initial delivery.');
  }
  const observations = stalledClients.map((client): ExpiryWakeObservation => ({
    regionId: client.regionId,
    stalledClientIndex: client.index,
    expectedDeadlineOffsetMs:
      client.firstStalledReceiptAt === undefined
        ? null
        : client.firstStalledReceiptAt + LIVE_DELIVERY_ACK_TIMEOUT_MS - startMonotonic,
    wakeSentAtOffsetMs: null,
    wakeToCloseMs: null,
    closeObservedBeforeTeardown: false,
  }));
  const triggerClients = stalledClients.map((stalled) =>
    clients.find(
      (candidate) =>
        candidate.regionId === stalled.regionId &&
        !candidate.stalled &&
        candidate.socket.readyState === WebSocket.OPEN,
    ),
  );
  const wakeAt = Math.max(
    performance.now(),
    ...stalledClients.map((client) =>
      client.firstStalledReceiptAt === undefined
        ? performance.now()
        : client.firstStalledReceiptAt + LIVE_DELIVERY_ACK_TIMEOUT_MS + POST_DEADLINE_WAKE_SLACK_MS,
    ),
    ...triggerClients.flatMap((client) =>
      client === undefined
        ? []
        : [client.lastPingAt + MIN_LIVE_PING_INTERVAL_MS + POST_DEADLINE_WAKE_SLACK_MS],
    ),
  );
  await delay(wakeAt - performance.now());
  await waitForCondition(
    () =>
      triggerClients.every((client) => client === undefined || client.pendingPing === undefined),
    ACK_PROBE_SETTLE_MS,
  );
  const nextAllowedWake = Math.max(
    performance.now(),
    ...triggerClients.flatMap((client) =>
      client === undefined
        ? []
        : [client.lastPingAt + MIN_LIVE_PING_INTERVAL_MS + POST_DEADLINE_WAKE_SLACK_MS],
    ),
  );
  await delay(nextAllowedWake - performance.now());

  for (let index = 0; index < stalledClients.length; index += 1) {
    const stalled = stalledClients[index]!;
    const trigger = triggerClients[index];
    if (
      trigger === undefined ||
      performance.now() - trigger.lastPingAt < MIN_LIVE_PING_INTERVAL_MS ||
      !sendPingProbe(trigger, 'post-deadline-wake', metrics)
    ) {
      recordBounded(
        metrics.clientErrors,
        `Could not send the post-deadline wake probe for ${stalled.regionId}.`,
      );
      continue;
    }
    observations[index]!.wakeSentAtOffsetMs = trigger.lastPingAt - startMonotonic;
  }

  await waitForCondition(
    () => stalledClients.every((client) => client.expectedClose !== undefined),
    POST_DEADLINE_CLOSE_TIMEOUT_MS,
  );
  for (let index = 0; index < stalledClients.length; index += 1) {
    const client = stalledClients[index]!;
    const observation = observations[index]!;
    if (client.expectedClose === undefined || observation.wakeSentAtOffsetMs === null) continue;
    observation.closeObservedBeforeTeardown = true;
    observation.wakeToCloseMs =
      client.expectedClose.observedAtMonotonicMs - startMonotonic - observation.wakeSentAtOffsetMs;
  }

  const observedRegionIds = [...new Set(stalledClients.map((client) => client.regionId))];
  const providerCountsBeforeReconnect = new Map(
    observedRegionIds.map((regionId) => [
      regionId,
      providerCallOffsetsByRegion.get(regionId)?.length ?? 0,
    ]),
  );
  const providerCallsBeforeReconnect = totalProviderCalls();
  const reconnectObservationStartedAt = performance.now();
  let nextClientIndex =
    clients.reduce((maximum, client) => Math.max(maximum, client.index), -1) + 1;
  const replacements: ClientState[] = [];
  for (const stalled of stalledClients) {
    metrics.reconnectAttempts += 1;
    const result = await connectClient(
      origin,
      clientOrigin,
      stalled.regionId,
      nextClientIndex,
      false,
      true,
      scenario,
      metrics,
    );
    nextClientIndex += 1;
    if (result.client) {
      metrics.admitted += 1;
      metrics.reconnectAdmitted += 1;
      clients.push(result.client);
      replacements.push(result.client);
      continue;
    }
    if (result.rejection) {
      const classification = classifyRejection(result.rejection, metrics);
      if (classification === 'viewer-capacity') metrics.reconnectViewerCapacityRejections += 1;
      else if (classification === 'isolate-admission') metrics.reconnectAdmissionRejections += 1;
      else metrics.reconnectUnexpectedRejections += 1;
      continue;
    }
    metrics.connectionFailures += 1;
    metrics.reconnectFailures += 1;
    recordBounded(metrics.clientErrors, result.failed ?? 'Unknown reconnect failure.');
  }
  const providerCountsAtReplacementOpen = new Map(
    observedRegionIds.map((regionId) => [
      regionId,
      providerCallOffsetsByRegion.get(regionId)?.length ?? 0,
    ]),
  );
  const replacementsSettled = await waitForCondition(
    () =>
      replacements.every(
        (client) =>
          client.snapshots > 0 && client.ackSendCallbacks > 0 && client.ackProbeMatches > 0,
      ),
    RECONNECT_SETTLE_TIMEOUT_MS,
  );
  if (!replacementsSettled) {
    recordBounded(
      metrics.clientErrors,
      `Replacement clients did not settle on cached delivery within ${RECONNECT_SETTLE_TIMEOUT_MS} ms.`,
    );
  }
  const nextScheduledPublicationObserved = await waitForCondition(
    () =>
      observedRegionIds.every(
        (regionId) =>
          (providerCallOffsetsByRegion.get(regionId)?.length ?? 0) >
          (providerCountsAtReplacementOpen.get(regionId) ?? 0),
      ),
    RECONNECT_PROVIDER_OBSERVATION_TIMEOUT_MS,
  );
  if (!nextScheduledPublicationObserved) {
    recordBounded(
      metrics.clientErrors,
      `No post-reconnect provider publication was observed within ${RECONNECT_PROVIDER_OBSERVATION_TIMEOUT_MS} ms.`,
    );
  }
  await delay(100);
  const reconnectProviderRegions = observedRegionIds.map(
    (regionId): ReconnectProviderRegionObservation => {
      const allOffsets = [...(providerCallOffsetsByRegion.get(regionId) ?? [])];
      const callsBeforeReconnect = providerCountsBeforeReconnect.get(regionId) ?? 0;
      const callsAtReplacementOpen = providerCountsAtReplacementOpen.get(regionId) ?? 0;
      const observationStartIndex = Math.max(0, callsBeforeReconnect - 1);
      const offsetsFromPreviousCallMs = allOffsets.slice(observationStartIndex);
      return {
        regionId,
        callsBeforeReconnect,
        callsAtReplacementOpen,
        callsDuringReconnect: Math.max(0, callsAtReplacementOpen - callsBeforeReconnect),
        callsAfterReplacementOpen: Math.max(0, allOffsets.length - callsAtReplacementOpen),
        callsDuringObservation: Math.max(0, allOffsets.length - callsBeforeReconnect),
        offsetsFromPreviousCallMs,
        gapsMs: offsetsFromPreviousCallMs
          .slice(1)
          .map((offsetMs, index) => offsetMs - offsetsFromPreviousCallMs[index]!),
      };
    },
  );
  return {
    observations,
    providerCallsBeforeReconnect,
    providerCallsAfterReconnect: totalProviderCalls(),
    reconnectProviderObservation: {
      startedAtOffsetMs: reconnectObservationStartedAt - startMonotonic,
      finishedAtOffsetMs: performance.now() - startMonotonic,
      nextScheduledPublicationObserved,
      regions: reconnectProviderRegions,
    },
  };
}

async function captureMemory(
  metrics: MutableMetrics,
  measurementStartedAtMonotonicMs: number,
  scheduledAtMonotonicMs: number,
  reader: WorkerdMemorySampler,
): Promise<void> {
  const driver = process.memoryUsage();
  const runtime = await reader.sample();
  metrics.memory.push({
    scheduledAtOffsetMs: scheduledAtMonotonicMs - measurementStartedAtMonotonicMs,
    startedAtOffsetMs: runtime.startedAtMonotonicMs - measurementStartedAtMonotonicMs,
    completedAtOffsetMs: runtime.completedAtMonotonicMs - measurementStartedAtMonotonicMs,
    pollDurationMs: runtime.durationMs,
    driverRssBytes: driver.rss,
    driverHeapUsedBytes: driver.heapUsed,
    workerdStatus: runtime.status,
    workerdRssBytes: runtime.status === 'available' ? runtime.rssBytes : null,
    workerdProcessCount: runtime.status === 'available' ? runtime.pids.length : null,
    workerdPids: runtime.status === 'available' ? [...runtime.pids] : null,
    workerdError: runtime.error,
  });
}

export function startMemorySampler(
  metrics: MutableMetrics,
  measurementStartedAtMonotonicMs: number,
  intervalMs: number,
  durationMs: number,
  reader: WorkerdMemorySampler,
): { stop(): Promise<{ missedScheduledSlots: number }> } {
  if (!Number.isFinite(measurementStartedAtMonotonicMs)) {
    throw new RangeError('The memory measurement start must be finite.');
  }
  expectedMemorySchedule(durationMs, intervalMs);
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let releasePendingTimer: (() => void) | undefined;
  let missedScheduledSlots = 0;
  let nextSlot = 0;
  let stopPromise: Promise<{ missedScheduledSlots: number }> | undefined;
  const task = (async () => {
    while (!stopped && nextSlot * intervalMs < durationMs) {
      const scheduledAtMonotonicMs = measurementStartedAtMonotonicMs + nextSlot * intervalMs;
      const waitMs = scheduledAtMonotonicMs - performance.now();
      if (waitMs > 0) {
        await new Promise<void>((resolveTimer) => {
          releasePendingTimer = resolveTimer;
          pendingTimer = setTimeout(resolveTimer, waitMs);
        });
        pendingTimer = undefined;
        releasePendingTimer = undefined;
      }
      if (stopped) break;
      await captureMemory(metrics, measurementStartedAtMonotonicMs, scheduledAtMonotonicMs, reader);
      nextSlot += 1;
      const completedAtMonotonicMs = performance.now();
      while (
        nextSlot * intervalMs < durationMs &&
        measurementStartedAtMonotonicMs + nextSlot * intervalMs <= completedAtMonotonicMs
      ) {
        missedScheduledSlots += 1;
        nextSlot += 1;
      }
    }
  })();
  return {
    async stop() {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      releasePendingTimer?.();
      stopPromise = (async () => {
        await task;
        await captureMemory(
          metrics,
          measurementStartedAtMonotonicMs,
          measurementStartedAtMonotonicMs + durationMs,
          reader,
        );
        return { missedScheduledSlots };
      })();
      return stopPromise;
    },
  };
}

function numericMemory(metrics: MutableMetrics, field: 'driverRssBytes' | 'driverHeapUsedBytes') {
  return summarizeSamples(metrics.memory.map((sample) => sample[field]));
}

function workerdMemorySummary(metrics: MutableMetrics) {
  const values = metrics.memory.flatMap((sample) =>
    sample.workerdStatus === 'available' && sample.workerdRssBytes !== null
      ? [sample.workerdRssBytes]
      : [],
  );
  const statusCounts = Object.fromEntries(
    (['available', 'unavailable', 'error', 'closed'] as const).map((status) => [
      status,
      metrics.memory.filter((sample) => sample.workerdStatus === status).length,
    ]),
  );
  return {
    availability:
      values.length === metrics.memory.length
        ? 'complete'
        : values.length > 0
          ? 'partial'
          : 'unavailable',
    scope:
      'Best-effort OS RSS for local workerd descendant processes. It includes runtime-native and shared process memory, is not per Durable Object, and is not Cloudflare isolate memory.',
    rssBytes: summarizeSamples(values),
    statusCounts,
    errors: metrics.memory.flatMap((sample) =>
      sample.workerdError === null ? [] : [sample.workerdError],
    ),
    processIdentities: [
      ...new Map(
        metrics.memory.flatMap((sample) =>
          sample.workerdPids === null
            ? []
            : [[sample.workerdPids.join(','), sample.workerdPids] as const],
        ),
      ).values(),
    ],
  };
}

export function expectedMemorySchedule(durationMs: number, intervalMs: number): number[] {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new RangeError('Memory sampling duration must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Memory sampling interval must be a positive safe integer.');
  }
  const scheduledOffsetsMs: number[] = [];
  for (let offsetMs = 0; offsetMs < durationMs; offsetMs += intervalMs) {
    scheduledOffsetsMs.push(offsetMs);
  }
  scheduledOffsetsMs.push(durationMs);
  return scheduledOffsetsMs;
}

function samePidSet(left: readonly number[] | null, right: readonly number[]): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every((pid, index) => pid === right[index])
  );
}

function finalSequenceCoverage(
  clients: readonly ClientState[],
  regionIds: readonly RegionId[],
  targetSequenceByRegion: ReadonlyMap<RegionId, number>,
) {
  return regionIds.map((regionId) => {
    const healthy = clients.filter((client) => client.regionId === regionId && !client.stalled);
    const finalSequence = targetSequenceByRegion.get(regionId) ?? 0;
    return {
      regionId,
      finalSequence,
      expectedClients: healthy.length,
      coveredClients: healthy.filter((client) => client.snapshotSequences.has(finalSequence))
        .length,
    };
  });
}

function sequenceWatermark(
  regionIds: readonly RegionId[],
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>,
  maximumOffsetMs = Number.POSITIVE_INFINITY,
): Map<RegionId, number> {
  return new Map(
    regionIds.map((regionId) => [
      regionId,
      (providerCallOffsetsByRegion.get(regionId) ?? []).filter(
        (offsetMs) => offsetMs <= maximumOffsetMs,
      ).length,
    ]),
  );
}

export function captureSequenceWatermarkAtBoundary(
  regionIds: readonly RegionId[],
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>,
  runStartedAtMonotonicMs: number,
  now: () => number = () => performance.now(),
): { capturedAtMonotonicMs: number; target: Map<RegionId, number> } {
  const capturedAtMonotonicMs = now();
  return {
    capturedAtMonotonicMs,
    target: sequenceWatermark(
      regionIds,
      providerCallOffsetsByRegion,
      capturedAtMonotonicMs - runStartedAtMonotonicMs,
    ),
  };
}

function sameWatermark(
  regionIds: readonly RegionId[],
  left: ReadonlyMap<RegionId, number>,
  right: ReadonlyMap<RegionId, number>,
): boolean {
  return regionIds.every((regionId) => left.get(regionId) === right.get(regionId));
}

function watermarkDrained(
  clients: readonly ClientState[],
  regionIds: readonly RegionId[],
  target: ReadonlyMap<RegionId, number>,
): boolean {
  return (
    finalSequenceCoverage(clients, regionIds, target).every(
      (coverage) =>
        coverage.finalSequence > 0 && coverage.coveredClients === coverage.expectedClients,
    ) &&
    clients.every(
      (client) => client.pendingAcknowledgments === 0 && client.pendingPing === undefined,
    )
  );
}

async function drainStableCurrentWatermark(
  clients: readonly ClientState[],
  regionIds: readonly RegionId[],
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>,
  runStartedAtMonotonicMs: number,
): Promise<{
  drained: boolean;
  target: Map<RegionId, number>;
  capturedAtMonotonicMs: number;
}> {
  const deadline = performance.now() + WATERMARK_DRAIN_TIMEOUT_MS;
  let target = sequenceWatermark(regionIds, providerCallOffsetsByRegion);
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    const drained = await waitForCondition(
      () => watermarkDrained(clients, regionIds, target),
      remainingMs,
    );
    if (!drained) {
      return { drained: false, target, capturedAtMonotonicMs: performance.now() };
    }
    const captured = captureSequenceWatermarkAtBoundary(
      regionIds,
      providerCallOffsetsByRegion,
      runStartedAtMonotonicMs,
    );
    if (sameWatermark(regionIds, target, captured.target)) {
      return { drained: true, target, capturedAtMonotonicMs: captured.capturedAtMonotonicMs };
    }
    target = captured.target;
  }
  return { drained: false, target, capturedAtMonotonicMs: performance.now() };
}

export function buildMeasurementEvidence(input: {
  clients: readonly MeasurementClient[];
  metrics: MeasurementMetricInputs;
  regionIds: readonly RegionId[];
  providerCallOffsetsByRegion: ReadonlyMap<RegionId, readonly number[]>;
  runStartedAtMonotonicMs: number;
  measurementStartedAtMonotonicMs: number;
  measurementFinishedAtMonotonicMs: number;
  startSequenceByRegion: ReadonlyMap<RegionId, number>;
  endSequenceByRegion: ReadonlyMap<RegionId, number>;
}): MeasurementEvidence {
  const {
    clients,
    metrics,
    regionIds,
    providerCallOffsetsByRegion,
    runStartedAtMonotonicMs,
    measurementStartedAtMonotonicMs,
    measurementFinishedAtMonotonicMs,
    startSequenceByRegion,
    endSequenceByRegion,
  } = input;
  const measurementStartedOffsetMs = measurementStartedAtMonotonicMs - runStartedAtMonotonicMs;
  const measurementFinishedOffsetMs = measurementFinishedAtMonotonicMs - runStartedAtMonotonicMs;
  const measuredProviderOffsets = new Map<RegionId, readonly number[]>(
    regionIds.map((regionId) => [
      regionId,
      [...(providerCallOffsetsByRegion.get(regionId) ?? [])].filter(
        (offsetMs) =>
          offsetMs > measurementStartedOffsetMs && offsetMs <= measurementFinishedOffsetMs,
      ),
    ]),
  );
  const receiptsBySequenceAndClient = new Map<string, SnapshotReceipt[]>();
  for (const receipt of metrics.snapshotReceipts) {
    const key = `${receipt.regionId}:${receipt.sequence}:${receipt.clientIndex}`;
    const entries = receiptsBySequenceAndClient.get(key) ?? [];
    entries.push(receipt);
    receiptsBySequenceAndClient.set(key, entries);
  }

  const completeReceipts: SnapshotReceipt[] = [];
  const sequenceCoverage: SequenceCoverage[] = [];
  const fanoutSpreadMs: number[] = [];
  for (const regionId of regionIds) {
    const startSequence = startSequenceByRegion.get(regionId) ?? 0;
    const endSequence = endSequenceByRegion.get(regionId) ?? 0;
    let completeSequences = 0;
    let expectedReceipts = 0;
    let coveredReceipts = 0;
    let duplicateReceipts = 0;
    for (let sequence = startSequence + 1; sequence <= endSequence; sequence += 1) {
      const providerOffset = providerCallOffsetsByRegion.get(regionId)?.[sequence - 1];
      const providerStartedAt =
        providerOffset === undefined
          ? Number.NEGATIVE_INFINITY
          : runStartedAtMonotonicMs + providerOffset;
      const expectedClients = clients.filter(
        (client) =>
          client.regionId === regionId &&
          !client.stalled &&
          client.openedAtMonotonicMs <= providerStartedAt,
      );
      expectedReceipts += expectedClients.length;
      const receiptsForSequence: SnapshotReceipt[] = [];
      let complete = expectedClients.length > 0 && providerOffset !== undefined;
      for (const client of expectedClients) {
        const key = `${regionId}:${sequence}:${client.index}`;
        const receipts = receiptsBySequenceAndClient.get(key) ?? [];
        if (receipts.length === 0) {
          complete = false;
          continue;
        }
        coveredReceipts += 1;
        duplicateReceipts += Math.max(0, receipts.length - 1);
        receiptsForSequence.push(receipts[0]!);
      }
      if (!complete) continue;
      completeSequences += 1;
      completeReceipts.push(...receiptsForSequence);
      if (receiptsForSequence.length > 1) {
        const receivedAt = receiptsForSequence.map((receipt) => receipt.receivedAtMonotonicMs);
        fanoutSpreadMs.push(Math.max(...receivedAt) - Math.min(...receivedAt));
      }
    }
    sequenceCoverage.push({
      regionId,
      startSequence,
      endSequence,
      expectedSequences: Math.max(0, endSequence - startSequence),
      completeSequences,
      expectedReceipts,
      coveredReceipts,
      duplicateReceipts,
    });
  }

  const receiptDeliveryKeys = new Set(
    completeReceipts.map((receipt) => `${receipt.clientIndex}:${receipt.deliveryId}`),
  );
  const completeReceiptKeys = new Set(
    completeReceipts.map(
      (receipt) =>
        `${receipt.clientIndex}:${receipt.deliveryId}:${receipt.regionId}:${receipt.sequence}`,
    ),
  );
  const ackTimings = metrics.ackTimings.filter((timing) =>
    receiptDeliveryKeys.has(`${timing.clientIndex}:${timing.deliveryId}`),
  );
  const ackTimingCounts = new Map<string, number>();
  for (const timing of ackTimings) {
    const key = `${timing.clientIndex}:${timing.deliveryId}`;
    ackTimingCounts.set(key, (ackTimingCounts.get(key) ?? 0) + 1);
  }
  const duplicateAckTimings = [...ackTimingCounts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const probes = metrics.probeObservations.filter((probe) => {
    const cause = probe.precedingAcknowledgment;
    return (
      probe.purpose === 'ack-proof' &&
      cause !== null &&
      cause.callbackMonotonicMs <= probe.sentAtMonotonicMs &&
      receiptDeliveryKeys.has(`${probe.clientIndex}:${cause.deliveryId}`) &&
      completeReceiptKeys.has(
        `${probe.clientIndex}:${cause.deliveryId}:${cause.regionId}:${cause.snapshotSequence}`,
      )
    );
  });
  const postBoundaryDeliveryFrames = metrics.deliveryFrameReceipts.filter((receipt) => {
    if (receipt.snapshotSequence === null) return false;
    return receipt.snapshotSequence > (endSequenceByRegion.get(receipt.regionId) ?? 0);
  });
  const postBoundarySnapshotReceipts = metrics.snapshotReceipts.filter(
    (receipt) => receipt.sequence > (endSequenceByRegion.get(receipt.regionId) ?? 0),
  );
  const lateInWindowDeliveryFrames = metrics.deliveryFrameReceipts.filter((receipt) => {
    if (
      receipt.receivedAtMonotonicMs <= measurementFinishedAtMonotonicMs ||
      receipt.snapshotSequence === null
    ) {
      return false;
    }
    const startSequence = startSequenceByRegion.get(receipt.regionId) ?? 0;
    const endSequence = endSequenceByRegion.get(receipt.regionId) ?? 0;
    return receipt.snapshotSequence > startSequence && receipt.snapshotSequence <= endSequence;
  });
  return {
    startedAtMonotonicMs: measurementStartedAtMonotonicMs,
    finishedAtMonotonicMs: measurementFinishedAtMonotonicMs,
    startSequenceByRegion,
    endSequenceByRegion,
    providerCallOffsetsByRegion: measuredProviderOffsets,
    sequenceCoverage,
    snapshotReceipts: completeReceipts,
    ackTimings,
    probes,
    fanoutSpreadMs,
    duplicateAckTimings,
    drain: {
      snapshotReceiptsAfterBoundary: completeReceipts.filter(
        (receipt) => receipt.receivedAtMonotonicMs > measurementFinishedAtMonotonicMs,
      ).length,
      ackCallbacksAfterBoundary: ackTimings.filter(
        (timing) => timing.callbackMonotonicMs > measurementFinishedAtMonotonicMs,
      ).length,
      probeMatchesAfterBoundary: probes.filter(
        (probe) =>
          probe.outcome === 'matched' &&
          (probe.completedAtMonotonicMs ?? Number.NEGATIVE_INFINITY) >
            measurementFinishedAtMonotonicMs,
      ).length,
    },
    postBoundary: {
      providerCalls: regionIds.reduce(
        (total, regionId) =>
          total +
          (providerCallOffsetsByRegion.get(regionId) ?? []).filter(
            (offsetMs) => offsetMs > measurementFinishedOffsetMs,
          ).length,
        0,
      ),
      deliveryFrames: postBoundaryDeliveryFrames.length,
      snapshotReceipts: postBoundarySnapshotReceipts.length,
      receivedBytes: postBoundaryDeliveryFrames.reduce(
        (total, receipt) => total + receipt.bytes,
        0,
      ),
      lateInWindowDeliveryFrames: lateInWindowDeliveryFrames.length,
      controlDeliveryFramesAfterBoundary: metrics.deliveryFrameReceipts.filter(
        (receipt) =>
          receipt.receivedAtMonotonicMs > measurementFinishedAtMonotonicMs &&
          receipt.snapshotSequence === null,
      ).length,
    },
  };
}

function hardGates(input: GateInputs): HardGate[] {
  const {
    definition,
    scenario,
    clients,
    metrics,
    measurement,
    invalidProviderCalls,
    representativeProviderResponseBytes,
    expiryWakeObservations,
    providerCallsBeforeReconnect,
    providerCallsAfterReconnect,
    reconnectProviderObservation,
    egressAttempts,
    hashesUnchanged,
    clockDriftMs,
    measurementDurationMs,
    soakMemory,
    memoryRun,
    ackTimersDrainedBeforeTeardown,
  } = input;
  const expectedAdmitted = definition.regionIds.length * definition.viewersPerRegion;
  const expectedViewerRejections = definition.overflowAttempts;
  const healthyClients = clients.filter((client) => !client.stalled);
  const stalledClients = clients.filter((client) => client.stalled);
  const expectedReconnects = stalledClients.length;
  const successfulAckTimings = measurement.ackTimings.filter((timing) => timing.succeeded);
  const ackCallbackMs = successfulAckTimings.map(
    (timing) => timing.callbackMonotonicMs - timing.receivedMonotonicMs,
  );
  const timingValidationErrors = measurement.ackTimings.flatMap(validateAckReceiptTiming);
  const ackSummary = summarizeSamples(ackCallbackMs);
  const matchedProbes = measurement.probes.filter(
    (probe) => probe.outcome === 'matched' && probe.roundTripMs !== undefined,
  );
  const probeSummary = summarizeSamples(matchedProbes.map((probe) => probe.roundTripMs!));
  const latencyP95LimitMs = scenario.profile === 'smoke' ? 2_000 : 5_000;
  const minimumProviderCalls = Math.max(
    1,
    Math.floor(Math.max(0, measurementDurationMs - 1_000) / POLL_INTERVAL_MS),
  );
  const maximumProviderCalls = Math.ceil((measurementDurationMs + 1_000) / POLL_INTERVAL_MS);
  const providerCadence = definition.regionIds.map((regionId) => {
    const offsets = measurement.providerCallOffsetsByRegion.get(regionId) ?? [];
    const coverage = measurement.sequenceCoverage.find((entry) => entry.regionId === regionId);
    const cadence = assessProviderCadence(
      offsets,
      POLL_INTERVAL_MS,
      PROVIDER_EARLY_TOLERANCE_MS,
      PROVIDER_LATE_TOLERANCE_MS,
    );
    return {
      regionId,
      calls: offsets.length,
      cadence,
      expectedSequences: coverage?.expectedSequences ?? 0,
    };
  });
  const coveredSequences = measurement.sequenceCoverage.every(
    (coverage) =>
      coverage.expectedSequences > 0 &&
      coverage.completeSequences === coverage.expectedSequences &&
      coverage.coveredReceipts === coverage.expectedReceipts &&
      coverage.duplicateReceipts === 0,
  );
  const probesByClient = new Map<number, number>();
  for (const probe of matchedProbes) {
    probesByClient.set(probe.clientIndex, (probesByClient.get(probe.clientIndex) ?? 0) + 1);
  }
  const expectedMemoryOffsets = expectedMemorySchedule(
    memoryRun.configuredDurationMs,
    memoryRun.configuredIntervalMs,
  );
  const observedMemoryOffsets = metrics.memory.map((sample) => sample.scheduledAtOffsetMs);
  const memoryScheduleMatches =
    expectedMemoryOffsets.length === observedMemoryOffsets.length &&
    expectedMemoryOffsets.every(
      (expectedOffset, index) =>
        Math.abs(expectedOffset - observedMemoryOffsets[index]!) <= MEMORY_TIMING_TOLERANCE_MS,
    );
  const memorySamplesValid = metrics.memory.every(
    (sample) =>
      sample.workerdStatus === 'available' &&
      sample.workerdError === null &&
      sample.workerdRssBytes !== null &&
      Number.isSafeInteger(sample.workerdRssBytes) &&
      sample.workerdRssBytes > 0 &&
      sample.workerdPids !== null &&
      samePidSet(sample.workerdPids, memoryRun.discovery.pids) &&
      sample.workerdProcessCount === sample.workerdPids.length &&
      sample.startedAtOffsetMs + MEMORY_TIMING_TOLERANCE_MS >= sample.scheduledAtOffsetMs &&
      sample.completedAtOffsetMs >= sample.startedAtOffsetMs &&
      Math.abs(sample.completedAtOffsetMs - sample.startedAtOffsetMs - sample.pollDurationMs) <=
        MEMORY_TIMING_TOLERANCE_MS &&
      sample.pollDurationMs <= memoryRun.configuredIntervalMs &&
      sample.startedAtOffsetMs - sample.scheduledAtOffsetMs <= memoryRun.configuredIntervalMs,
  );
  const gates: HardGate[] = [
    {
      id: 'attempt-accounting',
      category: 'harness-integrity',
      passed: attemptAccountingIsComplete({
        offered: metrics.offered,
        admitted: metrics.admitted,
        classifiedRejected: metrics.rejectedViewerCapacity + metrics.rejectedAdmission,
        failed: metrics.connectionFailures + metrics.unexpectedRejections,
      }),
      detail: 'Every offered connection is admitted or explicitly classified.',
    },
    {
      id: 'expected-admission',
      category: 'workerd-correctness',
      passed:
        metrics.admitted === expectedAdmitted + expectedReconnects &&
        metrics.rejectedViewerCapacity === expectedViewerRejections &&
        metrics.rejectedAdmission === 0 &&
        metrics.unexpectedRejections === 0 &&
        metrics.reconnectAttempts === expectedReconnects &&
        metrics.reconnectAdmitted === expectedReconnects &&
        metrics.reconnectViewerCapacityRejections === 0 &&
        metrics.reconnectAdmissionRejections === 0 &&
        metrics.reconnectUnexpectedRejections === 0 &&
        metrics.reconnectFailures === 0,
      detail: `${metrics.admitted}/${expectedAdmitted + expectedReconnects} total admissions; ${metrics.reconnectAdmitted}/${expectedReconnects} post-expiry reconnects; ${metrics.rejectedViewerCapacity}/${expectedViewerRejections} initial bounded viewer-capacity rejections.`,
    },
    {
      id: 'hello-accounting',
      category: 'workerd-correctness',
      passed: metrics.helloFrames === metrics.admitted,
      detail: `${metrics.helloFrames}/${metrics.admitted} admitted connections received exactly one hello frame.`,
    },
    {
      id: 'healthy-delivery',
      category: 'workerd-correctness',
      passed:
        healthyClients.every(
          (client) =>
            client.snapshots > 0 &&
            client.ackSendCallbacks > 0 &&
            (probesByClient.get(client.index) ?? 0) > 0,
        ) && coveredSequences,
      detail: `Every healthy client received a complete-sequence snapshot and a causally linked server-confirmed ACK proof; complete sequence windows ${measurement.sequenceCoverage.map((coverage) => `${coverage.regionId}=${coverage.completeSequences}/${coverage.expectedSequences}`).join(', ')}.`,
    },
    {
      id: 'stalled-expiry-capacity-release',
      category: 'workerd-correctness',
      passed:
        expiryWakeObservations.length === stalledClients.length &&
        stalledClients.every(
          (client) =>
            client.expectedClose === undefined ||
            (client.expectedClose.code === EXPECTED_STALL_CLOSE_CODE &&
              client.expectedClose.reason === EXPECTED_STALL_CLOSE_REASON &&
              client.expectedClose.elapsedFromReceiptMs >= LIVE_DELIVERY_ACK_TIMEOUT_MS),
        ) &&
        expiryWakeObservations.every(
          (observation) =>
            observation.expectedDeadlineOffsetMs !== null &&
            observation.wakeSentAtOffsetMs !== null &&
            observation.wakeSentAtOffsetMs >= observation.expectedDeadlineOffsetMs,
        ) &&
        (stalledClients.length === 0 ||
          (definition.viewersPerRegion === MAX_REGIONAL_VIEWERS &&
            definition.overflowAttempts > 0 &&
            metrics.reconnectAdmitted === stalledClients.length)),
      detail:
        stalledClients.length === 0
          ? 'No deliberately stalled clients in this profile.'
          : `A post-deadline control wake was sent for every stalled viewer and ${metrics.reconnectAdmitted}/${stalledClients.length} replacements were admitted only after the initially full region had rejected overflow; ${stalledClients.filter((client) => client.expectedClose).length} client-side close notifications were observed before teardown.`,
    },
    {
      id: 'reconnect-no-amplification',
      category: 'workerd-correctness',
      passed:
        expectedReconnects === 0 ||
        (providerCallsBeforeReconnect !== null &&
          providerCallsAfterReconnect !== null &&
          providerCallsAfterReconnect >= providerCallsBeforeReconnect &&
          reconnectProviderObservation.nextScheduledPublicationObserved &&
          reconnectProviderObservation.regions.length ===
            new Set(stalledClients.map((client) => client.regionId)).size &&
          reconnectProviderObservation.regions.every(
            (region) =>
              region.callsBeforeReconnect > 0 &&
              region.callsAtReplacementOpen >= region.callsBeforeReconnect &&
              region.callsAfterReplacementOpen === 1 &&
              region.gapsMs.length === region.callsDuringObservation &&
              assessProviderCadence(
                region.offsetsFromPreviousCallMs,
                POLL_INTERVAL_MS,
                PROVIDER_EARLY_TOLERANCE_MS,
                PROVIDER_LATE_TOLERANCE_MS,
              ).valid,
          )),
      detail:
        expectedReconnects === 0
          ? 'No reconnect exercise in this profile.'
          : `Observed reconnect and exactly one subsequent provider publication after replacement open; per-region during-connect/after-open calls and gaps: ${reconnectProviderObservation.regions.map((region) => `${region.regionId}=${region.callsDuringReconnect}/${region.callsAfterReplacementOpen},[${region.gapsMs.map((gapMs) => gapMs.toFixed(1)).join(',')}]ms`).join('; ')}; allowed gap ${MIN_RECONNECT_PROVIDER_GAP_MS}-${MAX_RECONNECT_PROVIDER_GAP_MS} ms.`,
    },
    {
      id: 'bounded-exact-payload',
      category: 'harness-integrity',
      passed:
        metrics.maximumEnvelopeBytes > 0 &&
        metrics.maximumEnvelopeBytes <= MAX_LIVE_MESSAGE_BYTES &&
        representativeProviderResponseBytes <= MAX_LIVE_MESSAGE_BYTES &&
        metrics.maximumAircraftRecords === definition.recordsPerSnapshot &&
        metrics.invalidSnapshotRecordCounts === 0 &&
        metrics.sequenceRegressions === 0 &&
        measurement.sequenceCoverage.every((coverage) => coverage.duplicateReceipts === 0),
      detail: `Maximum envelope ${metrics.maximumEnvelopeBytes} bytes; representative provider response ${representativeProviderResponseBytes} bytes; every snapshot retained the exact ${definition.recordsPerSnapshot}-record scenario with no duplicate in-window receipt.`,
    },
    {
      id: 'ack-window',
      category: 'workerd-correctness',
      passed:
        timingValidationErrors.length === 0 &&
        ackSummary.count > 0 &&
        ackSummary.p95 !== null &&
        ackSummary.p95 <= latencyP95LimitMs &&
        ackSummary.max !== null &&
        ackSummary.max < LIVE_DELIVERY_ACK_TIMEOUT_MS &&
        probeSummary.count > 0 &&
        probeSummary.p95 !== null &&
        probeSummary.p95 <= latencyP95LimitMs &&
        probeSummary.max !== null &&
        probeSummary.max < LIVE_DELIVERY_ACK_TIMEOUT_MS,
      detail: `Receipt-to-ACK callback p95 ${ackSummary.p95?.toFixed(3) ?? 'unavailable'} ms; ordered ACK proof p95 ${probeSummary.p95?.toFixed(3) ?? 'unavailable'} ms; limit ${latencyP95LimitMs} ms.`,
    },
    {
      id: 'ack-proof-accounting',
      category: 'workerd-correctness',
      passed:
        measurement.probes.length > 0 &&
        matchedProbes.length === measurement.probes.length &&
        healthyClients.every((client) => (probesByClient.get(client.index) ?? 0) > 0) &&
        measurement.ackTimings.length === measurement.snapshotReceipts.length &&
        successfulAckTimings.length === measurement.snapshotReceipts.length &&
        measurement.duplicateAckTimings === 0,
      detail: `${matchedProbes.length}/${measurement.probes.length} causally scoped ordered ACK probes matched; ${successfulAckTimings.length}/${measurement.snapshotReceipts.length} complete-sequence snapshot deliveries received exactly one successful ACK callback.`,
    },
    {
      id: 'ack-timer-drain',
      category: 'harness-integrity',
      passed:
        ackTimersDrainedBeforeTeardown &&
        clients.every((client) => client.pendingAcknowledgments === 0),
      detail: `New ACK scheduling froze, then all outstanding timers drained before teardown: ${ackTimersDrainedBeforeTeardown}; ${clients.reduce((total, client) => total + client.pendingAcknowledgments, 0)} pending at report time.`,
    },
    {
      id: 'provider-cadence',
      category: 'workerd-correctness',
      passed:
        invalidProviderCalls === 0 &&
        providerCadence.every(
          (entry) =>
            entry.calls === entry.expectedSequences &&
            entry.calls >= minimumProviderCalls &&
            entry.calls <= maximumProviderCalls &&
            entry.cadence.valid,
        ),
      detail: `Per-region in-window calls/sequence delta/min-max gap: ${providerCadence.map((entry) => `${entry.regionId}=${entry.calls}/${entry.expectedSequences},${entry.cadence.minimumGapMs?.toFixed(1) ?? 'n/a'}-${entry.cadence.maximumGapMs?.toFixed(1) ?? 'n/a'}ms`).join('; ')}; accepted call range ${minimumProviderCalls}-${maximumProviderCalls}, gap range ${MIN_RECONNECT_PROVIDER_GAP_MS}-${MAX_RECONNECT_PROVIDER_GAP_MS} ms.`,
    },
    {
      id: 'measurement-window-isolation',
      category: 'harness-integrity',
      passed:
        coveredSequences &&
        measurement.snapshotReceipts.length ===
          measurement.sequenceCoverage.reduce(
            (total, coverage) => total + coverage.expectedReceipts,
            0,
          ),
      detail: `Only complete sequences between the drained start and end watermarks contribute to throughput, fanout, and ACK gates; ${measurement.drain.snapshotReceiptsAfterBoundary} scoped snapshot receipt(s) completed during the bounded drain and ${measurement.postBoundary.providerCalls} later provider call(s) were recorded separately.`,
    },
    {
      id: 'runtime-errors',
      category: 'harness-integrity',
      passed:
        metrics.invalidFrames === 0 &&
        metrics.sendErrors === 0 &&
        metrics.providerErrorMessages === 0 &&
        metrics.unexpectedCloses === 0 &&
        metrics.clientErrors.length === 0 &&
        metrics.runtimeErrors.length === 0 &&
        metrics.runtimeRestarts === 0,
      detail:
        'No protocol, send, provider, close, structured-runtime, or restart error was observed.',
    },
    {
      id: 'external-egress',
      category: 'harness-integrity',
      passed: egressAttempts === 0,
      detail: `${egressAttempts} external outbound attempt(s) reached the blocking service.`,
    },
    {
      id: 'artifact-identity',
      category: 'harness-integrity',
      passed: hashesUnchanged,
      detail:
        'The generated Worker, configuration, harness, report model, and lockfile hashes are unchanged.',
    },
    {
      id: 'memory-sampler-integrity',
      category: 'harness-integrity',
      passed:
        memoryRun.discovery.status === 'available' &&
        memoryRun.discovery.error === null &&
        memoryRun.discovery.pids.length > 0 &&
        memoryRun.close.status === 'closed' &&
        memoryRun.close.error === null &&
        samePidSet(memoryRun.close.pids, memoryRun.discovery.pids) &&
        memoryRun.configuredDurationMs === definition.durationMs &&
        memoryRun.configuredIntervalMs === scenario.memorySampleIntervalMs &&
        memoryRun.missedScheduledSlots === 0 &&
        memoryScheduleMatches &&
        new Set(observedMemoryOffsets).size === observedMemoryOffsets.length &&
        memorySamplesValid,
      detail: `Discovery ${memoryRun.discovery.status} for PIDs [${memoryRun.discovery.pids.join(',')}]; close ${memoryRun.close.status}; ${metrics.memory.length}/${expectedMemoryOffsets.length} scheduled samples; ${memoryRun.missedScheduledSlots} skipped deadline(s); ${metrics.memory.filter((sample) => sample.workerdStatus !== 'available').length} unavailable/error sample(s).`,
    },
    {
      id: 'clock-continuity',
      category: 'harness-integrity',
      passed: clockDriftMs < 1_000,
      detail: `Wall/monotonic elapsed divergence was ${clockDriftMs.toFixed(3)} ms.`,
    },
    {
      id: 'measurement-duration',
      category: 'harness-integrity',
      passed: Math.abs(measurementDurationMs - definition.durationMs) <= 1_000,
      detail: `Measured ${measurementDurationMs.toFixed(3)} ms against the configured ${definition.durationMs} ms fixed window.`,
    },
  ];
  if (scenario.profile === 'soak') {
    gates.push({
      id: 'soak-memory-plateau',
      category: 'harness-integrity',
      passed: soakMemory?.passed === true,
      detail:
        soakMemory === null
          ? 'No workerd RSS plateau assessment was available.'
          : `Completeness ${(soakMemory.completeness * 100).toFixed(2)}%; tail growth ${soakMemory.tailGrowthBytes ?? 'unavailable'} bytes; Theil-Sen slope ${soakMemory.theilSenBytesPerMinute?.toFixed(1) ?? 'unavailable'} bytes/minute.`,
    });
  }
  return gates;
}

async function runDefinition(
  artifact: LoadArtifactRuntimePaths,
  config: GeneratedWorkerConfig,
  scenario: LoadHarnessScenario,
  definition: RunDefinition,
) {
  const startedAt = new Date().toISOString();
  const startWall = Date.now();
  const startMonotonic = performance.now();
  const metrics = freshMetrics();
  let providerCalls = 0;
  const providerCallOffsetsMs: number[] = [];
  const providerCallOffsetsByRegion = new Map<RegionId, number[]>(
    REGION_IDS.map((regionId) => [regionId, []]),
  );
  const providerResponseBytes: number[] = [];
  let invalidProviderCalls = 0;
  let externalEgressAttempts = 0;
  const provider = syntheticProvider(definition.recordsPerSnapshot, (regionId, responseBytes) => {
    providerCalls += 1;
    const offset = performance.now() - startMonotonic;
    providerCallOffsetsMs.push(offset);
    if (regionId === null) invalidProviderCalls += 1;
    else providerCallOffsetsByRegion.get(regionId)!.push(offset);
    if (responseBytes !== null) providerResponseBytes.push(responseBytes);
  });
  const clientOrigin = loadHarnessClientOrigin(config);
  const workerPath = resolve(artifact.workerRoot, config.main);
  const hashesBefore = {
    workerBundleSha256: await sha256File(workerPath),
    workerConfigSha256: await sha256File(artifact.workerConfigPath),
    loadHarnessSha256: await sha256File(fileURLToPath(import.meta.url)),
    reportModelSha256: await sha256File(
      resolve(dirname(fileURLToPath(import.meta.url)), 'loadHarnessReport.ts'),
    ),
    lockfileSha256: await sha256File(resolve(REPOSITORY_ROOT, 'pnpm-lock.yaml')),
    aircraftCorpusSha256: provider.aircraftCorpusSha256,
    scenarioSha256: sha256Text(JSON.stringify({ scenario, definition })),
  };
  const resourceTmpPath = await mkdtemp(resolve(tmpdir(), 'airspace-load-'));
  const worker: V4WorkerOptions = {
    name: config.name,
    scriptPath: workerPath,
    modules: true,
    modulesRoot: artifact.workerRoot,
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags,
    bindings: { ...config.vars },
    serviceBindings: { MOCK_PROVIDER: provider.fetch },
    durableObjects: {
      REGION_FEEDS: { className: config.durableObjectClassName, useSQLite: true },
    },
    r2Buckets: { MAP_ASSETS: config.r2BucketName },
    assets: {
      directory: artifact.clientRoot,
      binding: config.assets.binding,
      run_worker_first: config.assets.runWorkerFirst,
      routerConfig: { has_user_worker: true },
      assetConfig: {
        html_handling: config.assets.htmlHandling,
        not_found_handling: config.assets.notFoundHandling,
      },
    },
    outboundService: async () => {
      externalEgressAttempts += 1;
      return Response.json({ error: 'LOAD_HARNESS_EXTERNAL_EGRESS_BLOCKED' }, { status: 502 });
    },
    unsafeRegisterWorker: false,
  };
  const options: V4MiniflareOptions = {
    host: '127.0.0.1',
    port: 0,
    logRequests: false,
    resourceTmpPath,
    telemetry: { enabled: false },
    handleStructuredLogs(log: V4WorkerdStructuredLog) {
      if (['error', 'fatal'].includes(log.level.toLowerCase())) {
        recordBounded(metrics.runtimeErrors, log.message);
      }
    },
    unsafeHandleRuntimeRestart() {
      metrics.runtimeRestarts += 1;
    },
    workers: [worker],
  };
  const converted = convertV4MiniflareOptions(options);
  converted.workers[0]!.config.limits = config.limits;
  const miniflare = new Miniflare(converted);
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let sampler: ReturnType<typeof startMemorySampler> | undefined;
  let workerdSampler: WorkerdMemorySampler | undefined;
  let memoryClose: WorkerdMemoryCloseResult | undefined;
  let memoryMissedScheduledSlots = 0;
  let ackTimersDrainedBeforeTeardown: boolean;
  const clients: ClientState[] = [];
  let measurementStartedAt: number;
  let measurementFinishedAt: number;
  let teardownStartedAt: number;
  let startSequenceByRegion: Map<RegionId, number>;
  let endSequenceByRegion: Map<RegionId, number>;
  let expiryExercise: Awaited<ReturnType<typeof exerciseStalledExpiryAndReconnect>>;
  try {
    const origin = await miniflare.ready;
    workerdSampler = await createWorkerdMemorySampler();
    clients.push(...(await connectInBatches(origin, clientOrigin, definition, scenario, metrics)));
    for (const client of clients) client.ackProofSchedulingEnabled = false;
    const readinessDrain = await drainStableCurrentWatermark(
      clients,
      definition.regionIds,
      providerCallOffsetsByRegion,
      startMonotonic,
    );
    if (!readinessDrain.drained) {
      recordBounded(
        metrics.clientErrors,
        `The pre-capacity sequence watermark did not drain within ${WATERMARK_DRAIN_TIMEOUT_MS} ms.`,
      );
    }

    expiryExercise = await exerciseStalledExpiryAndReconnect(
      origin,
      clientOrigin,
      definition,
      scenario,
      metrics,
      clients,
      startMonotonic,
      providerCallOffsetsByRegion,
    );
    for (const client of clients) client.ackProofSchedulingEnabled = false;
    const measurementSetupDrain = await drainStableCurrentWatermark(
      clients,
      definition.regionIds,
      providerCallOffsetsByRegion,
      startMonotonic,
    );
    startSequenceByRegion = measurementSetupDrain.target;
    measurementStartedAt = measurementSetupDrain.capturedAtMonotonicMs;
    if (!measurementSetupDrain.drained) {
      recordBounded(
        metrics.clientErrors,
        `The measurement-start sequence watermark did not drain within ${WATERMARK_DRAIN_TIMEOUT_MS} ms.`,
      );
    }
    sampler = startMemorySampler(
      metrics,
      measurementStartedAt,
      scenario.memorySampleIntervalMs,
      definition.durationMs,
      workerdSampler,
    );
    for (const client of clients) client.ackProofSchedulingEnabled = !client.stalled;
    const remainingDurationMs = measurementStartedAt + definition.durationMs - performance.now();
    if (remainingDurationMs > 0) await delay(remainingDurationMs);
    measurementFinishedAt = performance.now();
    const measurementFinishedOffsetMs = measurementFinishedAt - startMonotonic;
    endSequenceByRegion = sequenceWatermark(
      definition.regionIds,
      providerCallOffsetsByRegion,
      measurementFinishedOffsetMs,
    );
    for (const client of clients) client.ackProofSchedulingEnabled = false;
    if (sampler) {
      const stoppedSampler = await sampler.stop();
      memoryMissedScheduledSlots = stoppedSampler.missedScheduledSlots;
    }
    sampler = undefined;

    const drained = await waitForCondition(() => {
      const current = buildMeasurementEvidence({
        clients,
        metrics,
        regionIds: definition.regionIds,
        providerCallOffsetsByRegion,
        runStartedAtMonotonicMs: startMonotonic,
        measurementStartedAtMonotonicMs: measurementStartedAt,
        measurementFinishedAtMonotonicMs: measurementFinishedAt,
        startSequenceByRegion,
        endSequenceByRegion,
      });
      return (
        current.sequenceCoverage.every(
          (coverage) =>
            coverage.expectedSequences > 0 &&
            coverage.completeSequences === coverage.expectedSequences,
        ) &&
        current.probes.every((probe) => probe.outcome !== 'pending') &&
        current.ackTimings.length === current.snapshotReceipts.length &&
        current.ackTimings.every((timing) => timing.succeeded)
      );
    }, WATERMARK_DRAIN_TIMEOUT_MS);
    if (!drained) {
      const incomplete = buildMeasurementEvidence({
        clients,
        metrics,
        regionIds: definition.regionIds,
        providerCallOffsetsByRegion,
        runStartedAtMonotonicMs: startMonotonic,
        measurementStartedAtMonotonicMs: measurementStartedAt,
        measurementFinishedAtMonotonicMs: measurementFinishedAt,
        startSequenceByRegion,
        endSequenceByRegion,
      });
      for (const coverage of incomplete.sequenceCoverage) {
        if (coverage.completeSequences === coverage.expectedSequences) continue;
        recordBounded(
          metrics.clientErrors,
          `Measurement sequence window ${coverage.startSequence + 1}-${coverage.endSequence} completed ${coverage.completeSequences}/${coverage.expectedSequences} sequences in ${coverage.regionId} before the drain deadline.`,
        );
      }
    }
    ackTimersDrainedBeforeTeardown = await freezeAndDrainAcknowledgments(
      clients,
      ACK_PROBE_TIMEOUT_MS,
    );
    if (!ackTimersDrainedBeforeTeardown) {
      recordBounded(
        metrics.clientErrors,
        `ACK timers did not drain within ${ACK_PROBE_TIMEOUT_MS} ms before teardown.`,
      );
    }
    for (const client of clients) {
      const pending = clearPendingPing(client);
      if (pending === undefined) continue;
      pending.observation.outcome = 'unresolved';
      pending.observation.completedAtMonotonicMs = performance.now();
      metrics.ackProbeUnresolvedAtEnd += 1;
      recordBounded(
        metrics.clientErrors,
        `${pending.purpose} probe remained unresolved at measurement end for client ${client.index}.`,
      );
    }
  } finally {
    teardownStartedAt = performance.now();
    for (const client of clients) {
      clearPendingPing(client);
      client.closingByHarness = true;
      if (client.socket.readyState === WebSocket.OPEN)
        client.socket.close(1000, 'Load run complete');
      else if (client.socket.readyState === WebSocket.CONNECTING) client.socket.terminate();
    }
    await delay(200);
    if (sampler) {
      try {
        const stoppedSampler = await sampler.stop();
        memoryMissedScheduledSlots = stoppedSampler.missedScheduledSlots;
      } catch (error) {
        recordBounded(metrics.runtimeErrors, `Memory sampler stop: ${String(error)}`);
      }
    }
    if (workerdSampler) memoryClose = await workerdSampler.close();
    eventLoop.disable();
    await miniflare.dispose().catch((error: unknown) => {
      recordBounded(metrics.runtimeErrors, `Miniflare disposal: ${String(error)}`);
    });
    await rm(resourceTmpPath, { recursive: true, force: true });
  }
  if (workerdSampler === undefined || memoryClose === undefined) {
    throw new Error('The workerd memory sampler lifecycle did not complete.');
  }
  const memoryRun: MemoryRunEvidence = {
    discovery: workerdSampler.discovery,
    close: memoryClose,
    configuredIntervalMs: scenario.memorySampleIntervalMs,
    configuredDurationMs: definition.durationMs,
    missedScheduledSlots: memoryMissedScheduledSlots,
  };
  const measurement = buildMeasurementEvidence({
    clients,
    metrics,
    regionIds: definition.regionIds,
    providerCallOffsetsByRegion,
    runStartedAtMonotonicMs: startMonotonic,
    measurementStartedAtMonotonicMs: measurementStartedAt,
    measurementFinishedAtMonotonicMs: measurementFinishedAt,
    startSequenceByRegion,
    endSequenceByRegion,
  });
  const finishedWall = Date.now();
  const finishedMonotonic = performance.now();
  const wallElapsedMs = finishedWall - startWall;
  const monotonicElapsedMs = finishedMonotonic - startMonotonic;
  const clockDriftMs = Math.abs(wallElapsedMs - monotonicElapsedMs);
  const hashesAfter = {
    workerBundleSha256: await sha256File(workerPath),
    workerConfigSha256: await sha256File(artifact.workerConfigPath),
    loadHarnessSha256: await sha256File(fileURLToPath(import.meta.url)),
    reportModelSha256: await sha256File(
      resolve(dirname(fileURLToPath(import.meta.url)), 'loadHarnessReport.ts'),
    ),
    lockfileSha256: await sha256File(resolve(REPOSITORY_ROOT, 'pnpm-lock.yaml')),
  };
  const hashesUnchanged =
    hashesBefore.workerBundleSha256 === hashesAfter.workerBundleSha256 &&
    hashesBefore.workerConfigSha256 === hashesAfter.workerConfigSha256 &&
    hashesBefore.loadHarnessSha256 === hashesAfter.loadHarnessSha256 &&
    hashesBefore.reportModelSha256 === hashesAfter.reportModelSha256 &&
    hashesBefore.lockfileSha256 === hashesAfter.lockfileSha256;
  const allAckCallbackMs = metrics.ackTimings.map(
    (timing) => timing.callbackMonotonicMs - timing.receivedMonotonicMs,
  );
  const eventLoopP99Ms = eventLoop.percentile(99) / 1_000_000;
  const immediateAckCallbackMs = measurement.ackTimings
    .filter((timing) => timing.configuredDelayMs === 0)
    .map((timing) => timing.callbackMonotonicMs - timing.receivedMonotonicMs);
  const scopedAckTimerOvershootMs = measurement.ackTimings.map(
    (timing) =>
      timing.timerFiredMonotonicMs - timing.receivedMonotonicMs - timing.configuredDelayMs,
  );
  const generatorHealthy =
    (summarizeSamples(scopedAckTimerOvershootMs).p99 ?? Number.POSITIVE_INFINITY) < 1_000 &&
    (summarizeSamples(immediateAckCallbackMs).p99 ?? Number.POSITIVE_INFINITY) < 1_000 &&
    eventLoopP99Ms < 100 &&
    clockDriftMs < 1_000;
  const measurementDurationMs = measurementFinishedAt - measurementStartedAt;
  const workerdSamples = metrics.memory.map((sample) => ({
    atMs: sample.startedAtOffsetMs,
    scheduledAtMs: sample.scheduledAtOffsetMs,
    completedAtMs: sample.completedAtOffsetMs,
    pollDurationMs: sample.pollDurationMs,
    rssBytes: sample.workerdRssBytes,
    pids: sample.workerdPids,
  }));
  const soakMemory =
    scenario.profile === 'soak'
      ? assessSoakMemoryPlateau(
          workerdSamples,
          memoryRun.configuredDurationMs,
          scenario.memorySampleIntervalMs,
        )
      : null;
  const gates = hardGates({
    definition,
    scenario,
    clients,
    metrics,
    measurement,
    invalidProviderCalls,
    representativeProviderResponseBytes: provider.representativeResponseBytes,
    expiryWakeObservations: expiryExercise.observations,
    providerCallsBeforeReconnect: expiryExercise.providerCallsBeforeReconnect,
    providerCallsAfterReconnect: expiryExercise.providerCallsAfterReconnect,
    reconnectProviderObservation: expiryExercise.reconnectProviderObservation,
    egressAttempts: externalEgressAttempts,
    hashesUnchanged,
    clockDriftMs,
    measurementDurationMs,
    soakMemory,
    memoryRun,
    ackTimersDrainedBeforeTeardown,
  });
  const measurementSeconds = measurementDurationMs / 1_000;
  const measuredProviderCalls = [...measurement.providerCallOffsetsByRegion.values()].reduce(
    (total, offsets) => total + offsets.length,
    0,
  );
  const measuredDeliveryFrames = measurement.snapshotReceipts.length;
  const measuredReceivedBytes = measurement.snapshotReceipts.reduce(
    (total, receipt) => total + receipt.bytes,
    0,
  );
  const measuredAckTimings = measurement.ackTimings.filter((timing) => timing.succeeded);
  const measuredAckCallbackMs = measuredAckTimings.map(
    (timing) => timing.callbackMonotonicMs - timing.receivedMonotonicMs,
  );
  const measuredAckTimerOvershootMs = measuredAckTimings.map(
    (timing) =>
      timing.timerFiredMonotonicMs - timing.receivedMonotonicMs - timing.configuredDelayMs,
  );
  const measuredProbeRttMs = measurement.probes.flatMap((probe) =>
    probe.outcome === 'matched' && probe.roundTripMs !== undefined ? [probe.roundTripMs] : [],
  );
  return {
    id: definition.id,
    startedAt,
    finishedAt: new Date(finishedWall).toISOString(),
    definition,
    syntheticFixture: {
      id: `synthetic-${definition.recordsPerSnapshot}-fully-populated-v1`,
      records: definition.recordsPerSnapshot,
      aircraftCorpusSha256: provider.aircraftCorpusSha256,
      representativeResponseBytes: provider.representativeResponseBytes,
      actualResponseBytes: summarizeSamples(providerResponseBytes),
      containsRealAircraftData: false,
    },
    artifact: {
      ...hashesBefore,
      hashesAfter,
      unchanged: hashesUnchanged,
      topology:
        'Generated mock-staging Worker configuration validated; MOCK_PROVIDER is replaced by a deterministic in-process Miniflare service binding and external outbound fetch is blocked.',
    },
    timing: {
      wallElapsedMs,
      monotonicElapsedMs,
      wallMonotonicDriftMs: clockDriftMs,
      eventLoopDelayP99Ms: eventLoopP99Ms,
      measurementStartedAtOffsetMs: measurementStartedAt - startMonotonic,
      measurementFinishedAtOffsetMs: measurementFinishedAt - startMonotonic,
      measurementDurationMs,
      teardownStartedAtOffsetMs: teardownStartedAt - startMonotonic,
    },
    connectionAttempts: {
      offered: metrics.offered,
      admitted: metrics.admitted,
      rejectedViewerCapacity: metrics.rejectedViewerCapacity,
      rejectedIsolateAdmission: metrics.rejectedAdmission,
      unexpectedRejected: metrics.unexpectedRejections,
      failed: metrics.connectionFailures,
      reconnect: {
        offered: metrics.reconnectAttempts,
        admitted: metrics.reconnectAdmitted,
        rejectedViewerCapacity: metrics.reconnectViewerCapacityRejections,
        rejectedIsolateAdmission: metrics.reconnectAdmissionRejections,
        unexpectedRejected: metrics.reconnectUnexpectedRejections,
        failed: metrics.reconnectFailures,
      },
      rejectionBodies: metrics.rejections.map(({ status, code, bodyBytes }) => ({
        status,
        code,
        bodyBytes,
      })),
    },
    delivery: {
      providerCalls,
      providerCallOffsetsMs,
      providerCallOffsetsByRegion: Object.fromEntries(
        definition.regionIds.map((regionId) => [
          regionId,
          providerCallOffsetsByRegion.get(regionId),
        ]),
      ),
      invalidProviderCalls,
      helloFrames: metrics.helloFrames,
      deliveryFrames: metrics.deliveryFrames,
      ackSendCallbacks: metrics.ackSendCallbacks,
      snapshotMessages: metrics.snapshotMessages,
      healthMessages: metrics.healthMessages,
      pongMessages: metrics.pongMessages,
      providerErrorMessages: metrics.providerErrorMessages,
      receivedBytes: metrics.receivedBytes,
      maximumEnvelopeBytes: metrics.maximumEnvelopeBytes,
      maximumAircraftRecords: metrics.maximumAircraftRecords,
      measurementWindow: {
        providerCalls: measuredProviderCalls,
        deliveryFrames: measuredDeliveryFrames,
        snapshotMessages: measuredDeliveryFrames,
        receivedBytes: measuredReceivedBytes,
        deliveriesPerSecond: measuredDeliveryFrames / measurementSeconds,
        bytesPerSecond: measuredReceivedBytes / measurementSeconds,
        fanoutSpreadMs: summarizeSamples(measurement.fanoutSpreadMs),
        startSequences: Object.fromEntries(measurement.startSequenceByRegion),
        endSequences: Object.fromEntries(measurement.endSequenceByRegion),
        sequenceCoverage: measurement.sequenceCoverage,
        providerCallOffsetsByRegion: Object.fromEntries(measurement.providerCallOffsetsByRegion),
        drain: measurement.drain,
        postBoundary: measurement.postBoundary,
        scope:
          'Provider offsets are strictly after the captured, drained start watermark and at or before the fixed end watermark. Late receipts from those sequences remain scoped drain evidence. Only higher provider sequences are classified as post-boundary delivery traffic.',
      },
    },
    acknowledgments: {
      receiptToAckSendCallbackMs: summarizeSamples(measuredAckCallbackMs),
      configuredDelayTimerOvershootMs: summarizeSamples(measuredAckTimerOvershootMs),
      orderedAckThenPingPongRttMs: summarizeSamples(measuredProbeRttMs),
      probes: {
        sent: measurement.probes.length,
        matched: measurement.probes.filter((probe) => probe.outcome === 'matched').length,
        timedOut: measurement.probes.filter((probe) => probe.outcome === 'timed-out').length,
        sendFailed: measurement.probes.filter((probe) => probe.outcome === 'send-failed').length,
        unresolvedAtMeasurementEnd: measurement.probes.filter(
          (probe) => probe.outcome === 'pending' || probe.outcome === 'unresolved',
        ).length,
      },
      snapshotDeliveriesInScope: measurement.snapshotReceipts.length,
      successfulSnapshotAcksInScope: measuredAckTimings.length,
      duplicateAckTimings: measurement.duplicateAckTimings,
      causalProbeObservations: measurement.probes,
      allRunReceiptToAckSendCallbackMs: summarizeSamples(allAckCallbackMs),
      pendingDeliveryAcknowledgmentsAtTeardown: clients.reduce(
        (total, client) => total + client.pendingAcknowledgments,
        0,
      ),
      timersDrainedBeforeTeardown: ackTimersDrainedBeforeTeardown,
      scope:
        'Only complete provider sequences strictly after the drained start watermark and at or before the end watermark contribute to snapshot ACK and latency statistics. Receipt-to-callback is client validation, configured delay, and ws.send callback time; it is not server acknowledgment. A matched probe must identify the exact preceding complete-sequence snapshot ACK; its pong proves the server processed that ACK and is a conservative upper bound, not internal server time.',
    },
    expiryWake: expiryExercise,
    stalledViewers: clients
      .filter((client) => client.stalled)
      .map((client) => ({
        regionId: client.regionId,
        firstReceiptOffsetMs:
          client.firstStalledReceiptAt === undefined
            ? null
            : client.firstStalledReceiptAt - startMonotonic,
        close:
          client.expectedClose === undefined
            ? null
            : {
                code: client.expectedClose.code,
                reason: client.expectedClose.reason,
                observedAtOffsetMs: client.expectedClose.observedAtMonotonicMs - startMonotonic,
                elapsedFromReceiptMs: client.expectedClose.elapsedFromReceiptMs,
              },
      })),
    memory: {
      driver: {
        scope:
          'Node load driver plus in-process Miniflare orchestration host; excludes the separately sampled workerd child and is not Cloudflare memory.',
        rssBytes: numericMemory(metrics, 'driverRssBytes'),
        heapUsedBytes: numericMemory(metrics, 'driverHeapUsedBytes'),
      },
      workerd: workerdMemorySummary(metrics),
      sampler: memoryRun,
      soakPlateau: soakMemory,
      sampleCount: metrics.memory.length,
      samples: metrics.memory,
    },
    errors: {
      invalidFrames: metrics.invalidFrames,
      sendErrors: metrics.sendErrors,
      unexpectedCloses: metrics.unexpectedCloses,
      ackProbeTimeouts: metrics.ackProbeTimeouts,
      ackProbeSendFailures: metrics.ackProbeSendFailures,
      ackProbeUnresolvedAtEnd: metrics.ackProbeUnresolvedAtEnd,
      runtimeRestarts: metrics.runtimeRestarts,
      externalEgressAttempts,
      runtime: metrics.runtimeErrors,
      client: metrics.clientErrors,
    },
    generatorHealthy,
    gates,
    outcome: measuredOutcome(gates, generatorHealthy),
  };
}

async function atomicWrite(
  output: ResolvedLoadHarnessOutput,
  value: string,
  protectedRoots: readonly string[],
): Promise<void> {
  await mkdir(dirname(output.absolutePath), { recursive: true });
  await revalidateLoadHarnessOutputPath(output, REPOSITORY_ROOT, protectedRoots);
  const temporary = `${output.absolutePath}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryExists = false;
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
    temporaryExists = true;
    await revalidateLoadHarnessOutputPath(output, REPOSITORY_ROOT, protectedRoots);
    await rename(temporary, output.absolutePath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

export async function runLoadHarness(argv: readonly string[]) {
  const cli = parseLoadHarnessCli(argv);
  if (cli.help) return { help: LOAD_HARNESS_HELP } as const;
  if (cli.artifactInput === undefined) {
    throw new Error('The load harness requires one explicit artifact input.');
  }
  const sourceBefore = await captureSourceIdentity(REPOSITORY_ROOT);
  const artifact = await resolveLoadArtifactInput(
    cli.artifactInput,
    REPOSITORY_ROOT,
    sourceBefore,
    cli.artifactInput.mode === 'retained-candidate'
      ? { selectionExpectation: loadCandidateSelectionExpectation() }
      : {},
  );
  const output =
    cli.outputPath === undefined
      ? undefined
      : await resolveLoadHarnessOutputPath(
          cli.outputPath,
          REPOSITORY_ROOT,
          artifact.protectedRoots,
        );
  const stagedArtifact = await stageLoadArtifactInput(artifact);
  let stagedArtifactDisposed = false;
  try {
    const runtimeDependencies = {
      miniflare: await packageVersion('miniflare', 'Miniflare'),
      ws: await packageVersion('ws', 'ws'),
    };
    const config = await loadGeneratedWorkerConfig(stagedArtifact);
    const startedAt = new Date().toISOString();
    const results = [];
    for (const definition of caseDefinitions(cli.scenario)) {
      results.push(await runDefinition(stagedArtifact, config, cli.scenario, definition));
    }
    const executionAfter = await completeStagedLoadArtifactInput(stagedArtifact);
    const artifactAfter = await completeLoadArtifactInput(artifact, sourceBefore);
    const sourceAfter = await captureSourceIdentity(REPOSITORY_ROOT);
    const sourceUnchanged = sameSourceIdentity(sourceBefore, sourceAfter);
    const outcome =
      !sourceUnchanged ||
      !artifactAfter.unchanged ||
      !executionAfter.unchanged ||
      results.some((result) => result.outcome === 'failed')
        ? 'failed'
        : results.some((result) => result.outcome === 'inconclusive')
          ? 'inconclusive'
          : 'passed';
    const report = {
      schemaVersion: LOAD_HARNESS_SCHEMA_VERSION,
      kind: 'measured-local-miniflare-workerd-loopback-not-cloudflare',
      profile: cli.scenario.profile,
      startedAt,
      finishedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        architecture: arch(),
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        ci: process.env.CI === 'true',
        runtimeDependencies,
      },
      sourceIdentity: {
        scope:
          'The current checkout supplies the load harness and policy constants. In raw-artifact mode it is not build provenance.',
        before: sourceBefore,
        after: sourceAfter,
        unchanged: sourceUnchanged,
        gate: {
          id: 'source-identity',
          passed: sourceUnchanged,
          detail:
            'Git HEAD, status, tracked patch, independently hashed tracked worktree, and untracked content identity remained unchanged during all measured cases.',
        },
      },
      artifactInput: {
        mode: artifact.mode,
        requestedPath: artifact.requestedPath,
        artifactPath: artifact.artifactPath,
        before: artifact.identityBefore,
        after: artifactAfter.identityAfter,
        unchanged: artifactAfter.unchanged,
        candidate:
          artifact.candidateBefore === null
            ? null
            : {
                before: artifact.candidateBefore,
                after: artifactAfter.candidateAfter,
                unchanged:
                  JSON.stringify(artifact.candidateBefore) ===
                  JSON.stringify(artifactAfter.candidateAfter),
              },
        gate: artifactAfter.gate,
      },
      executionSnapshot: {
        before: stagedArtifact.identityBefore,
        after: executionAfter.identityAfter,
        unchanged: executionAfter.unchanged,
        gate: executionAfter.gate,
      },
      generatedWorker: {
        name: config.name,
        buildTarget: config.vars.LIVE_BUILD_TARGET,
        providerMode: config.vars.LIVE_PROVIDER_MODE,
        releaseSha: config.vars.RELEASE_SHA,
        cpuLimitMs: config.limits.cpuMs,
        subrequestLimit: config.limits.subrequests,
        mockProviderServiceName: config.mockProviderServiceName,
        sqliteMigrationTag: config.sqliteMigrationTag,
        topology:
          'The explicit mock-staging artifact input is copied to a hash-matched harness-owned execution snapshot. Its Worker, assets, Durable Object SQLite migration, R2 binding, service declaration, and limits are validated. The external mock-provider Worker is intentionally replaced by a deterministic in-process Miniflare service function for this harness.',
      },
      truthBoundary: [
        'Measures the generated mock-staging Worker in local Miniflare/workerd over loopback WebSockets with synthetic fixed-region observations.',
        artifact.mode === 'retained-candidate'
          ? 'Candidate mode verifies the clean exact-source retained candidate, checksum allowlist, provenance, and complete retained artifact before and after measurement, while workerd executes only a hash-matched private snapshot.'
          : 'Raw-artifact mode binds the complete selected tree before and after measurement and executes a hash-matched private snapshot, but does not claim retained-candidate provenance.',
        'Does not measure Cloudflare isolate memory, placement, billing, account limits, R2 metering, provider permission, or production capacity.',
        'Node driver plus Miniflare-host memory and best-effort workerd process RSS are separate; neither is per Durable Object heap.',
        'Latency and throughput are descriptive for this machine and source identity. Hard gates cover protocol and accounting invariants only.',
        'Capacity rejection, stalled-viewer expiry, replacement admission, and reconnect polling are exercised before the fixed-duration measurement; the stable replacement cohort is then included for the entire measurement window.',
        'Stalled-viewer expiration is awakened by an explicit post-deadline control frame. This does not claim an upper bound for autonomous Cloudflare alarm delivery.',
      ],
      cases: results,
      outcome,
    };
    const encoded = JSON.stringify(report, null, 2) + '\n';
    await disposeStagedLoadArtifactInput(stagedArtifact);
    stagedArtifactDisposed = true;
    if (output) await atomicWrite(output, encoded, artifact.protectedRoots);
    return { report, encoded, outputPath: output?.reportPath } as const;
  } finally {
    if (!stagedArtifactDisposed) await disposeStagedLoadArtifactInput(stagedArtifact);
  }
}

async function main(): Promise<void> {
  const result = await runLoadHarness(process.argv.slice(2));
  if ('help' in result) {
    process.stdout.write(result.help);
    return;
  }
  if (result.outputPath) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: result.report.schemaVersion,
        profile: result.report.profile,
        outcome: result.report.outcome,
        outputPath: result.outputPath,
        cases: result.report.cases.map((entry) => ({ id: entry.id, outcome: entry.outcome })),
      })}\n`,
    );
  } else {
    process.stdout.write(result.encoded);
  }
  if (result.report.outcome !== 'passed') process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
