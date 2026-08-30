import { stableStringify } from '../adapters/shared';
import { sha256Hex } from '../core/hash';
import type { ClockReading, ServerTimeInterval } from '../live/clock';
import { LiveAirspaceSession } from '../live/session';
import { AIRSPACE_SCHEMA_VERSION } from '../live/types';
import type { AircraftState, AirspaceSnapshot, LiveFeedHealth } from '../live/types';
import {
  MAX_LIVE_FUTURE_OFFSET_MS,
  exceedsUtf8ByteLimit,
  isBoundedText,
  isCanonicalTimestamp,
  isFiniteNumber,
  isJsonRecord,
  isLiveIdentifier,
  isSafeInteger,
} from '../live/validation';
import {
  AIRSPACE_REPLAY_GENERATOR_ID,
  AIRSPACE_REPLAY_GENERATOR_VERSION,
  AIRSPACE_REPLAY_SCHEMA_VERSION,
  REPLAY_MAX_AIRCRAFT,
  REPLAY_MAX_BYTES,
  REPLAY_MAX_DURATION_MS,
  REPLAY_MAX_EVENTS,
  REPLAY_PROVIDER_ID,
} from './types';
import type {
  ReadonlyReplayEvent,
  ReadonlyReplaySnapshot,
  ReplayAircraftState,
  ReplayEvent,
  ReplayManifest,
  ReplayParseResult,
  ReplayScenarioId,
  ReplaySnapshot,
  ValidatedReplayManifest,
} from './types';

const MAX_ERRORS = 64;
const MAX_SEED = 0xffff_ffff;
const validatedManifests = new WeakSet<object>();
const scenarioIds = new Set<ReplayScenarioId>([
  'nominal-regional',
  'data-quality-gaps',
  'provider-outage-recovery',
]);
const feedStatuses = new Set([
  'connecting',
  'live',
  'degraded',
  'stale',
  'reconnecting',
  'offline',
]);
const qualityFlags = new Set([
  'missing-position',
  'stale-position',
  'stale-contact',
  'provider-time-regression',
  'time-uncertain',
]);
const manifestFields = new Set([
  'schemaVersion',
  'scenarioId',
  'title',
  'description',
  'seed',
  'synthetic',
  'startAt',
  'durationMs',
  'provenance',
  'events',
]);
const provenanceFields = new Set([
  'synthetic',
  'classification',
  'generatorId',
  'generatorVersion',
  'canonicalSha256',
  'units',
]);
const unitFields = new Set(['altitude', 'groundSpeed', 'verticalRate', 'track', 'time']);
const eventBaseFields = new Set([
  'index',
  'offsetMs',
  'kind',
  'label',
  'description',
  'expectedDisposition',
]);
const snapshotFields = new Set([
  'schemaVersion',
  'providerId',
  'feedEpoch',
  'regionId',
  'sequence',
  'generatedAt',
  'providerGeneratedAt',
  'aircraft',
  'validation',
]);
const healthFields = new Set([
  'schemaVersion',
  'providerId',
  'feedEpoch',
  'regionId',
  'status',
  'checkedAt',
  'lastSuccessAt',
  'lastSnapshotAt',
  'upstreamLatencyMs',
  'consecutiveFailures',
  'retryAt',
  'message',
]);
const aircraftFields = new Set([
  'aircraftId',
  'identifierKind',
  'synthetic',
  'callsign',
  'registration',
  'aircraftType',
  'category',
  'position',
  'barometricAltitudeFeet',
  'geometricAltitudeFeet',
  'groundSpeedKnots',
  'trackDegrees',
  'verticalRateFeetPerMinute',
  'verticalRateBasis',
  'onGround',
  'sourceType',
  'observedAt',
  'lastContactAt',
  'lastPositionAt',
  'contactAgeSeconds',
  'positionAgeSeconds',
  'qualityFlags',
]);
const summaryFields = new Set([
  'receivedAircraft',
  'acceptedAircraft',
  'rejectedAircraft',
  'duplicateAircraft',
  'invalidFields',
]);

function addError(errors: string[], message: string): void {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) addError(errors, `${path} contains unsupported property ${unsupported}.`);
}

function eventInstant(startAt: string, offsetMs: number): string {
  return new Date(Date.parse(startAt) + offsetMs).toISOString();
}

function expectedFeedEpoch(scenarioId: ReplayScenarioId, seed: number): string {
  return `replay-${scenarioId}-${seed}`;
}

function validateProvenance(value: unknown, errors: string[]): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'provenance must be an object.');
    return;
  }
  validateKeys(value, provenanceFields, 'provenance', errors);
  if (
    value.synthetic !== true ||
    value.classification !== 'SYNTHETIC_UNCLASSIFIED' ||
    value.generatorId !== AIRSPACE_REPLAY_GENERATOR_ID ||
    value.generatorVersion !== AIRSPACE_REPLAY_GENERATOR_VERSION
  ) {
    addError(
      errors,
      'provenance must declare the supported synthetic generator and classification.',
    );
  }
  if (typeof value.canonicalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.canonicalSha256)) {
    addError(errors, 'provenance.canonicalSha256 must be a lowercase SHA-256 digest.');
  }
  if (!isJsonRecord(value.units)) {
    addError(errors, 'provenance.units must be an object.');
    return;
  }
  validateKeys(value.units, unitFields, 'provenance.units', errors);
  if (
    value.units.altitude !== 'feet' ||
    value.units.groundSpeed !== 'knots' ||
    value.units.verticalRate !== 'feet-per-minute' ||
    value.units.track !== 'degrees' ||
    value.units.time !== 'UTC ISO-8601' ||
    Object.keys(value.units).length !== unitFields.size
  ) {
    addError(errors, 'provenance.units must declare the replay field units exactly.');
  }
}

function validateQualityFlags(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > qualityFlags.size) return false;
  const seen = new Set<string>();
  return value.every((flag, index) => {
    if (!Object.hasOwn(value, index) || typeof flag !== 'string' || !qualityFlags.has(flag)) {
      return false;
    }
    if (seen.has(flag)) return false;
    seen.add(flag);
    return true;
  });
}

function validateAircraft(
  value: unknown,
  path: string,
  scenarioId: ReplayScenarioId,
  receivedAtMs: number,
  providerAtMs: number,
  errors: string[],
): void {
  if (!isJsonRecord(value)) {
    addError(errors, `${path} must be an object.`);
    return;
  }
  validateKeys(value, aircraftFields, path, errors);
  const escapedScenario = scenarioId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const identity = new RegExp(`^demo:${escapedScenario}:[1-9]\\d{0,3}$`, 'u');
  if (
    typeof value.aircraftId !== 'string' ||
    !identity.test(value.aircraftId) ||
    value.identifierKind !== 'synthetic' ||
    value.synthetic !== true
  ) {
    addError(errors, `${path} must use an explicit reserved synthetic aircraft identity.`);
  }
  for (const field of ['callsign', 'registration', 'aircraftType', 'category', 'sourceType']) {
    if (
      value[field] !== undefined &&
      !isBoundedText(value[field], field === 'sourceType' ? 32 : 16)
    ) {
      addError(errors, `${path}.${field} must be bounded, non-empty, trimmed text.`);
    }
  }
  if (!isCanonicalTimestamp(value.observedAt) || !isCanonicalTimestamp(value.lastContactAt)) {
    addError(errors, `${path} must contain canonical contact timestamps.`);
  }
  if (value.observedAt !== value.lastContactAt) {
    addError(errors, `${path}.observedAt must retain its contact-time basis.`);
  }
  const uncertain =
    Array.isArray(value.qualityFlags) && value.qualityFlags.includes('time-uncertain');
  const minimumAge = uncertain ? -MAX_LIVE_FUTURE_OFFSET_MS / 1_000 : 0;
  if (!isFiniteNumber(value.contactAgeSeconds, minimumAge)) {
    addError(errors, `${path}.contactAgeSeconds must be finite and within the time tolerance.`);
  }
  if (isCanonicalTimestamp(value.lastContactAt)) {
    const contactMs = Date.parse(value.lastContactAt);
    if (contactMs > providerAtMs)
      addError(errors, `${path}.lastContactAt cannot follow provider time.`);
    if (value.contactAgeSeconds !== (receivedAtMs - contactMs) / 1_000) {
      addError(errors, `${path}.contactAgeSeconds must match immutable replay receipt time.`);
    }
  }
  if (typeof value.onGround !== 'boolean' && value.onGround !== null) {
    addError(errors, `${path}.onGround must be a boolean or explicit null.`);
  }
  if (!validateQualityFlags(value.qualityFlags)) {
    addError(errors, `${path}.qualityFlags must contain unique recognized quality flags.`);
  }
  if (
    (value.verticalRateFeetPerMinute !== undefined) !== (value.verticalRateBasis !== undefined) ||
    (value.verticalRateBasis !== undefined &&
      value.verticalRateBasis !== 'barometric' &&
      value.verticalRateBasis !== 'geometric')
  ) {
    addError(errors, `${path} must provide vertical rate and basis together.`);
  }
  for (const field of [
    'barometricAltitudeFeet',
    'geometricAltitudeFeet',
    'verticalRateFeetPerMinute',
  ]) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) {
      addError(errors, `${path}.${field} must be finite when provided.`);
    }
  }
  if (value.groundSpeedKnots !== undefined && !isFiniteNumber(value.groundSpeedKnots, 0)) {
    addError(errors, `${path}.groundSpeedKnots must be finite and non-negative.`);
  }
  if (
    value.trackDegrees !== undefined &&
    (!isFiniteNumber(value.trackDegrees, 0, 360) || value.trackDegrees === 360)
  ) {
    addError(errors, `${path}.trackDegrees must be finite and in [0, 360).`);
  }
  const hasPosition = value.position !== undefined;
  if (
    hasPosition !== (value.lastPositionAt !== undefined) ||
    hasPosition !== (value.positionAgeSeconds !== undefined)
  ) {
    addError(
      errors,
      `${path} must provide position, position timestamp and position age together.`,
    );
  }
  if (value.position !== undefined) {
    if (
      !isJsonRecord(value.position) ||
      Object.keys(value.position).length !== 2 ||
      !Object.hasOwn(value.position, 'latitude') ||
      !Object.hasOwn(value.position, 'longitude') ||
      !isFiniteNumber(value.position.latitude, -90, 90) ||
      !isFiniteNumber(value.position.longitude, -180, 180)
    ) {
      addError(errors, `${path}.position must contain only valid latitude and longitude.`);
    }
  }
  if (value.lastPositionAt !== undefined && !isCanonicalTimestamp(value.lastPositionAt)) {
    addError(errors, `${path}.lastPositionAt must be a canonical timestamp.`);
  }
  if (
    value.positionAgeSeconds !== undefined &&
    !isFiniteNumber(value.positionAgeSeconds, minimumAge)
  ) {
    addError(errors, `${path}.positionAgeSeconds must be finite and within the time tolerance.`);
  }
  if (isCanonicalTimestamp(value.lastPositionAt)) {
    const positionMs = Date.parse(value.lastPositionAt);
    if (positionMs > providerAtMs)
      addError(errors, `${path}.lastPositionAt cannot follow provider time.`);
    if (value.positionAgeSeconds !== (receivedAtMs - positionMs) / 1_000) {
      addError(errors, `${path}.positionAgeSeconds must match immutable replay receipt time.`);
    }
  }
  if (providerAtMs > receivedAtMs && !uncertain) {
    addError(errors, `${path} must declare uncertainty for a future provider clock.`);
  }
}

function validateSummary(value: unknown, count: number | undefined, errors: string[]): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'snapshot.validation must be an object.');
    return;
  }
  validateKeys(value, summaryFields, 'snapshot.validation', errors);
  let valid = Object.keys(value).length === summaryFields.size;
  for (const field of summaryFields) {
    if (
      !isSafeInteger(
        value[field],
        0,
        field === 'invalidFields' ? Number.MAX_SAFE_INTEGER : REPLAY_MAX_AIRCRAFT,
      )
    ) {
      addError(errors, `snapshot.validation.${field} must be a bounded non-negative integer.`);
      valid = false;
    }
  }
  if (!valid) return;
  if (count !== undefined && value.acceptedAircraft !== count) {
    addError(errors, 'snapshot.validation.acceptedAircraft must equal the aircraft count.');
  }
  if (
    value.receivedAircraft !==
    (value.acceptedAircraft as number) +
      (value.rejectedAircraft as number) +
      (value.duplicateAircraft as number)
  ) {
    addError(errors, 'snapshot.validation totals must partition received aircraft.');
  }
}

function validateBinding(
  value: Record<string, unknown>,
  scenarioId: ReplayScenarioId,
  seed: number,
  path: string,
  errors: string[],
): void {
  if (
    value.providerId !== REPLAY_PROVIDER_ID ||
    !isLiveIdentifier(value.regionId) ||
    value.feedEpoch !== expectedFeedEpoch(scenarioId, seed)
  ) {
    addError(errors, `${path} must use the manifest replay provider, region and feed epoch.`);
  }
}

function validateSnapshot(
  value: unknown,
  scenarioId: ReplayScenarioId,
  seed: number,
  instant: string,
  errors: string[],
): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'snapshot must be an object.');
    return;
  }
  validateKeys(value, snapshotFields, 'snapshot', errors);
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    addError(errors, `snapshot.schemaVersion must be ${AIRSPACE_SCHEMA_VERSION}.`);
  }
  validateBinding(value, scenarioId, seed, 'snapshot', errors);
  if (!isSafeInteger(value.sequence)) {
    addError(errors, 'snapshot.sequence must be a non-negative safe integer.');
  }
  const receivedAtMs = isCanonicalTimestamp(value.generatedAt)
    ? Date.parse(value.generatedAt)
    : undefined;
  const providerAtMs = isCanonicalTimestamp(value.providerGeneratedAt)
    ? Date.parse(value.providerGeneratedAt)
    : undefined;
  if (value.generatedAt !== instant || receivedAtMs === undefined || providerAtMs === undefined) {
    addError(
      errors,
      'snapshot timestamps must be canonical and generatedAt must equal the event time.',
    );
  } else if (providerAtMs - receivedAtMs > MAX_LIVE_FUTURE_OFFSET_MS) {
    addError(errors, 'snapshot provider time exceeds the future-clock tolerance.');
  }
  if (!Array.isArray(value.aircraft)) {
    addError(errors, 'snapshot.aircraft must be an array.');
  } else if (value.aircraft.length > REPLAY_MAX_AIRCRAFT) {
    addError(errors, 'snapshot.aircraft exceeds the replay record limit.');
  } else if (receivedAtMs !== undefined && providerAtMs !== undefined) {
    const identities = new Set<string>();
    for (let index = 0; index < value.aircraft.length && errors.length < MAX_ERRORS; index += 1) {
      const aircraft = value.aircraft[index];
      validateAircraft(
        aircraft,
        `snapshot.aircraft[${index}]`,
        scenarioId,
        receivedAtMs,
        providerAtMs,
        errors,
      );
      if (isJsonRecord(aircraft) && typeof aircraft.aircraftId === 'string') {
        if (identities.has(aircraft.aircraftId)) {
          addError(errors, 'snapshot.aircraft must contain unique synthetic identities.');
        }
        identities.add(aircraft.aircraftId);
      }
    }
  }
  validateSummary(
    value.validation,
    Array.isArray(value.aircraft) ? value.aircraft.length : undefined,
    errors,
  );
}

function validateHealth(
  value: unknown,
  scenarioId: ReplayScenarioId,
  seed: number,
  instant: string,
  errors: string[],
): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'health must be an object.');
    return;
  }
  validateKeys(value, healthFields, 'health', errors);
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    addError(errors, `health.schemaVersion must be ${AIRSPACE_SCHEMA_VERSION}.`);
  }
  validateBinding(value, scenarioId, seed, 'health', errors);
  if (value.checkedAt !== instant || !isCanonicalTimestamp(value.checkedAt)) {
    addError(errors, 'health.checkedAt must be canonical and equal the event time.');
  }
  if (!feedStatuses.has(String(value.status)) || !isBoundedText(value.message, 512)) {
    addError(errors, 'health must contain a recognized status and bounded message.');
  }
  if (!isSafeInteger(value.consecutiveFailures)) {
    addError(errors, 'health.consecutiveFailures must be a non-negative safe integer.');
  }
  for (const field of ['lastSuccessAt', 'lastSnapshotAt', 'retryAt']) {
    if (value[field] !== undefined && !isCanonicalTimestamp(value[field])) {
      addError(errors, `health.${field} must be a canonical timestamp.`);
    }
    if (
      field !== 'retryAt' &&
      isCanonicalTimestamp(value[field]) &&
      isCanonicalTimestamp(value.checkedAt) &&
      Date.parse(value[field]) > Date.parse(value.checkedAt)
    ) {
      addError(errors, `health.${field} cannot follow checkedAt.`);
    }
  }
  if (value.upstreamLatencyMs !== undefined && !isFiniteNumber(value.upstreamLatencyMs, 0)) {
    addError(errors, 'health.upstreamLatencyMs must be finite and non-negative.');
  }
}

function validateEvents(
  value: unknown,
  scenarioId: ReplayScenarioId,
  seed: number,
  startAt: string,
  durationMs: number,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > REPLAY_MAX_EVENTS) {
    addError(errors, `events must contain 1 through ${REPLAY_MAX_EVENTS} entries.`);
    return;
  }
  let previousOffset = -1;
  let snapshotCount = 0;
  let regionId: string | undefined;
  for (let index = 0; index < value.length && errors.length < MAX_ERRORS; index += 1) {
    const event = value[index];
    const path = `events[${index}]`;
    if (!isJsonRecord(event)) {
      addError(errors, `${path} must be an object.`);
      continue;
    }
    const allowed = new Set(eventBaseFields);
    if (event.kind === 'snapshot') allowed.add('snapshot');
    if (event.kind === 'health') allowed.add('health');
    validateKeys(event, allowed, path, errors);
    if (event.index !== index) addError(errors, `${path}.index must equal its stable array index.`);
    if (!isSafeInteger(event.offsetMs, 0, durationMs)) {
      addError(errors, `${path}.offsetMs must be within the manifest duration.`);
      continue;
    }
    if (event.offsetMs < previousOffset)
      addError(errors, 'events must be ordered by offset and index.');
    previousOffset = event.offsetMs;
    if (!isBoundedText(event.label, 80) || !isBoundedText(event.description, 240)) {
      addError(errors, `${path} label and description must be bounded text.`);
    }
    if (event.expectedDisposition !== 'accepted' && event.expectedDisposition !== 'rejected') {
      addError(errors, `${path}.expectedDisposition must be accepted or rejected.`);
    }
    const instant = eventInstant(startAt, event.offsetMs);
    if (event.kind === 'snapshot') {
      snapshotCount += 1;
      if (!Object.hasOwn(event, 'snapshot') || Object.hasOwn(event, 'health')) {
        addError(errors, `${path} must contain only a snapshot payload.`);
      }
      validateSnapshot(event.snapshot, scenarioId, seed, instant, errors);
      if (isJsonRecord(event.snapshot) && typeof event.snapshot.regionId === 'string') {
        regionId ??= event.snapshot.regionId;
        if (event.snapshot.regionId !== regionId) {
          addError(errors, `${path} cannot change the replay region.`);
        }
      }
    } else if (event.kind === 'health') {
      if (!Object.hasOwn(event, 'health') || Object.hasOwn(event, 'snapshot')) {
        addError(errors, `${path} must contain only a health payload.`);
      }
      validateHealth(event.health, scenarioId, seed, instant, errors);
      if (isJsonRecord(event.health) && typeof event.health.regionId === 'string') {
        regionId ??= event.health.regionId;
        if (event.health.regionId !== regionId) {
          addError(errors, `${path} cannot change the replay region.`);
        }
      }
    } else {
      addError(errors, `${path}.kind must be snapshot or health.`);
    }
  }
  if (snapshotCount === 0) addError(errors, 'events must include at least one snapshot.');
}

function validateScenarioCoverage(manifest: ReplayManifest, errors: string[]): void {
  const snapshotEvents = manifest.events.filter((event) => event.kind === 'snapshot');
  const aircraft = snapshotEvents.flatMap((event) => event.snapshot.aircraft);
  if (manifest.scenarioId === 'nominal-regional') {
    if (snapshotEvents.filter((event) => event.expectedDisposition === 'accepted').length < 4) {
      addError(errors, 'nominal-regional must contain at least four accepted movement receipts.');
    }
  } else if (manifest.scenarioId === 'data-quality-gaps') {
    const missing = aircraft.some((item) => item.qualityFlags.includes('missing-position'));
    const stale = aircraft.some((item) =>
      item.qualityFlags.some((flag) => flag === 'stale-position' || flag === 'stale-contact'),
    );
    const sparse = aircraft.some(
      (item) => item.barometricAltitudeFeet === undefined || item.groundSpeedKnots === undefined,
    );
    const rejected = snapshotEvents.some((event) => event.expectedDisposition === 'rejected');
    if (!missing || !stale || !sparse || !rejected) {
      addError(
        errors,
        'data-quality-gaps lacks required missing, sparse, stale or rejected evidence.',
      );
    }
  } else if (manifest.scenarioId === 'provider-outage-recovery') {
    const statuses = manifest.events.flatMap((event) =>
      event.kind === 'health' ? [event.health.status] : [],
    );
    const offlineIndex = statuses.indexOf('offline');
    const recoveryIndex = statuses.findIndex(
      (status, index) => index > offlineIndex && status === 'live',
    );
    const identities = new Map<string, number>();
    for (const event of snapshotEvents.filter((item) => item.expectedDisposition === 'accepted')) {
      for (const item of event.snapshot.aircraft) {
        identities.set(item.aircraftId, (identities.get(item.aircraftId) ?? 0) + 1);
      }
    }
    if (
      !statuses.includes('degraded') ||
      offlineIndex < 0 ||
      recoveryIndex < 0 ||
      ![...identities.values()].some((count) => count >= 2) ||
      ![...identities.values()].some((count) => count === 1)
    ) {
      addError(
        errors,
        'provider-outage-recovery lacks degradation, outage, recovery or identity continuity evidence.',
      );
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function digestInput(manifest: ReplayManifest | ValidatedReplayManifest): unknown {
  const { canonicalSha256, ...provenance } = manifest.provenance;
  void canonicalSha256;
  return { ...manifest, provenance };
}

export function canonicalizeReplayManifest(
  manifest: ReplayManifest | ValidatedReplayManifest,
): string {
  return stableStringify(digestInput(manifest));
}

export async function computeReplayManifestDigest(
  manifest: ReplayManifest | ValidatedReplayManifest,
): Promise<string> {
  return sha256Hex(canonicalizeReplayManifest(manifest));
}

export function normalizeReplaySnapshot(snapshot: ReadonlyReplaySnapshot): AirspaceSnapshot {
  return {
    ...snapshot,
    aircraft: snapshot.aircraft.map(({ synthetic: _synthetic, ...aircraft }) => ({
      ...aircraft,
      ...(aircraft.position ? { position: { ...aircraft.position } } : {}),
      qualityFlags: [...aircraft.qualityFlags],
    })),
    validation: { ...snapshot.validation },
  };
}

export function normalizeReplayHealth(health: Readonly<LiveFeedHealth>): LiveFeedHealth {
  return { ...health };
}

function exactTime(startAt: string, positionMs: number): ServerTimeInterval {
  const now = Date.parse(startAt) + positionMs;
  return { earliestMs: now, latestMs: now, referenceAgeMs: 0 };
}

function validateTransitionExpectations(manifest: ReplayManifest, errors: string[]): void {
  let reading: ClockReading = { monotonicMs: 0, wallMs: Date.parse(manifest.startAt) };
  const regionId = manifest.events.find((event) => event.kind === 'snapshot')?.snapshot.regionId;
  if (!regionId) return;
  const session = new LiveAirspaceSession(regionId, {}, REPLAY_PROVIDER_ID, () => reading);
  for (const event of manifest.events) {
    reading = {
      monotonicMs: event.offsetMs,
      wallMs: Date.parse(manifest.startAt) + event.offsetMs,
    };
    session.updateTime(exactTime(manifest.startAt, event.offsetMs));
    const before = session.state;
    if (event.kind === 'snapshot') session.applySnapshot(normalizeReplaySnapshot(event.snapshot));
    else session.applyHealth(normalizeReplayHealth(event.health));
    const accepted =
      event.kind === 'snapshot'
        ? session.state.snapshot !== before.snapshot
        : session.state.health !== before.health;
    if ((accepted ? 'accepted' : 'rejected') !== event.expectedDisposition) {
      addError(
        errors,
        `events[${event.index}] expected disposition does not match session ordering.`,
      );
    }
  }
}

export function isValidatedReplayManifest(value: unknown): value is ValidatedReplayManifest {
  return typeof value === 'object' && value !== null && validatedManifests.has(value);
}

export async function parseReplayManifest(input: unknown): Promise<ReplayParseResult> {
  const errors: string[] = [];
  let value: unknown = input;
  let sourceText: string | undefined;
  if (typeof input === 'string') {
    sourceText = input;
    if (exceedsUtf8ByteLimit(input, REPLAY_MAX_BYTES)) {
      return { ok: false, errors: [`Replay manifest exceeds ${REPLAY_MAX_BYTES} UTF-8 bytes.`] };
    }
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['Replay manifest is not valid JSON.'] };
    }
  }
  if (!isJsonRecord(value))
    return { ok: false, errors: ['Replay manifest must be a JSON object.'] };
  if (sourceText === undefined) {
    try {
      sourceText = stableStringify(value);
    } catch {
      return { ok: false, errors: ['Replay manifest cannot be canonically serialized.'] };
    }
    if (exceedsUtf8ByteLimit(sourceText, REPLAY_MAX_BYTES)) {
      return { ok: false, errors: [`Replay manifest exceeds ${REPLAY_MAX_BYTES} UTF-8 bytes.`] };
    }
  }
  validateKeys(value, manifestFields, 'manifest', errors);
  if (Object.keys(value).length !== manifestFields.size) {
    addError(errors, 'manifest must contain every required top-level field exactly once.');
  }
  if (value.schemaVersion !== AIRSPACE_REPLAY_SCHEMA_VERSION) {
    addError(errors, `schemaVersion must be ${AIRSPACE_REPLAY_SCHEMA_VERSION}.`);
  }
  if (
    typeof value.scenarioId !== 'string' ||
    !scenarioIds.has(value.scenarioId as ReplayScenarioId)
  ) {
    addError(errors, 'scenarioId must name a supported bundled replay scenario.');
  }
  if (!isBoundedText(value.title, 100) || !isBoundedText(value.description, 500)) {
    addError(errors, 'title and description must be bounded, non-empty text.');
  }
  if (!isSafeInteger(value.seed, 1, MAX_SEED)) {
    addError(errors, `seed must be an integer from 1 through ${MAX_SEED}.`);
  }
  if (value.synthetic !== true) addError(errors, 'synthetic must be true.');
  if (!isCanonicalTimestamp(value.startAt))
    addError(errors, 'startAt must be a canonical UTC timestamp.');
  if (!isSafeInteger(value.durationMs, 1, REPLAY_MAX_DURATION_MS)) {
    addError(errors, `durationMs must be from 1 through ${REPLAY_MAX_DURATION_MS}.`);
  }
  validateProvenance(value.provenance, errors);
  if (
    typeof value.scenarioId === 'string' &&
    scenarioIds.has(value.scenarioId as ReplayScenarioId) &&
    isSafeInteger(value.seed, 1, MAX_SEED) &&
    isCanonicalTimestamp(value.startAt) &&
    isSafeInteger(value.durationMs, 1, REPLAY_MAX_DURATION_MS)
  ) {
    validateEvents(
      value.events,
      value.scenarioId as ReplayScenarioId,
      value.seed,
      value.startAt,
      value.durationMs,
      errors,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  let clone: ReplayManifest;
  try {
    clone = JSON.parse(JSON.stringify(value)) as ReplayManifest;
  } catch {
    return { ok: false, errors: ['Replay manifest could not be isolated from its input.'] };
  }
  validateScenarioCoverage(clone, errors);
  try {
    validateTransitionExpectations(clone, errors);
  } catch {
    addError(errors, 'Replay event transitions could not be applied to one normalized session.');
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    const digest = await computeReplayManifestDigest(clone);
    if (digest !== clone.provenance.canonicalSha256) {
      return {
        ok: false,
        errors: ['Replay manifest digest does not match its canonical content.'],
      };
    }
  } catch {
    return { ok: false, errors: ['Replay manifest digest could not be verified.'] };
  }
  const manifest = deepFreeze(clone) as ValidatedReplayManifest;
  validatedManifests.add(manifest);
  return { ok: true, manifest, errors: [] };
}

export function replayEventBinding(event: ReadonlyReplayEvent): {
  providerId: string;
  regionId: string;
  feedEpoch: string;
} {
  const payload = event.kind === 'snapshot' ? event.snapshot : event.health;
  return {
    providerId: payload.providerId,
    regionId: payload.regionId,
    feedEpoch: payload.feedEpoch,
  };
}

export function isReplayAircraft(value: AircraftState): value is ReplayAircraftState {
  return (
    value.identifierKind === 'synthetic' && /^demo:[a-z0-9-]+:[1-9]\d{0,3}$/u.test(value.aircraftId)
  );
}

export function replayEventPayload(event: ReplayEvent): ReplaySnapshot | LiveFeedHealth {
  return event.kind === 'snapshot' ? event.snapshot : event.health;
}
