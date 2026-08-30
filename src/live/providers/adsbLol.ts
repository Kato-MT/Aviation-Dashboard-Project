import { LiveProviderError, type LiveAircraftProvider } from '../provider';
import {
  cancelLiveResponse,
  LiveResponseError,
  readBoundedLiveText,
  withLiveRequestDeadline,
} from '../http';
import { parseRetryAfter } from '../retryAfter';
import {
  MAX_LIVE_FUTURE_OFFSET_MS,
  isBoundedText,
  isCanonicalTimestamp,
  isFiniteNumber,
  isJsonRecord,
  isSafeInteger,
} from '../validation';
import type {
  AircraftQualityFlag,
  AircraftState,
  ProviderSnapshot,
  RegionConfig,
  SnapshotValidationSummary,
} from '../types';
import { RUNTIME_POLICY_LIMITS } from '../runtimePolicyLimits';

const DEFAULT_BASE_URL = 'https://api.adsb.lol';
const DEFAULT_MAX_RESPONSE_BYTES: number = RUNTIME_POLICY_LIMITS.provider.maximumResponseBytes;
const DEFAULT_MAX_AIRCRAFT: number = RUNTIME_POLICY_LIMITS.provider.maximumAircraft;
const AIRCRAFT_ID_PATTERN = /^~?[0-9a-f]{6}$/i;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AdsbLolProviderOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  maxResponseBytes?: number;
  maxAircraft?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface AdsbLolPayload {
  now: number;
  ac: unknown[];
}

interface NormalizeContext {
  receivedAtMs: number;
  providerGeneratedAtMs: number;
  invalidFields: number;
}

function isoFromMilliseconds(value: unknown): string | undefined {
  if (!isFiniteNumber(value, 0)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const timestamp = date.toISOString();
  return isCanonicalTimestamp(timestamp) ? timestamp : undefined;
}

function readOptionalText(
  value: unknown,
  maxLength: number,
  context: NormalizeContext,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    // The provider pads callsigns with spaces; do not trim away invalid control characters.
    const normalized = value.replace(/^ +| +$/gu, '');
    if (normalized.length === 0) return undefined;
    if (isBoundedText(normalized, maxLength)) return normalized;
  }
  context.invalidFields += 1;
  return undefined;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  context: NormalizeContext,
  minimum = -Infinity,
  maximum = Infinity,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (isFiniteNumber(value, minimum, maximum)) return value;
  context.invalidFields += 1;
  return undefined;
}

function normalizeAircraft(input: unknown, context: NormalizeContext): AircraftState | undefined {
  if (!isJsonRecord(input)) {
    return undefined;
  }

  if (typeof input.hex !== 'string' || !AIRCRAFT_ID_PATTERN.test(input.hex)) {
    return undefined;
  }
  const rawId = input.hex.toLowerCase();

  if (!isFiniteNumber(input.seen, 0)) return undefined;
  const lastContactAt = isoFromMilliseconds(context.providerGeneratedAtMs - input.seen * 1_000);
  if (lastContactAt === undefined) return undefined;
  const contactAgeSeconds = (context.receivedAtMs - Date.parse(lastContactAt)) / 1_000;

  const seenPositionSeconds = readOptionalNumber(input, 'seen_pos', context, 0);
  const lastPositionAt =
    seenPositionSeconds === undefined
      ? undefined
      : isoFromMilliseconds(context.providerGeneratedAtMs - seenPositionSeconds * 1_000);
  if (seenPositionSeconds !== undefined && lastPositionAt === undefined) context.invalidFields += 1;
  const positionAgeSeconds =
    lastPositionAt === undefined
      ? undefined
      : (context.receivedAtMs - Date.parse(lastPositionAt)) / 1_000;
  const latitude = readOptionalNumber(input, 'lat', context, -90, 90);
  const longitude = readOptionalNumber(input, 'lon', context, -180, 180);
  const validPosition =
    latitude !== undefined &&
    longitude !== undefined &&
    lastPositionAt !== undefined &&
    positionAgeSeconds !== undefined;

  const flags: AircraftQualityFlag[] = [];
  if (!validPosition) {
    flags.push('missing-position');
  } else if (positionAgeSeconds > 45) {
    flags.push('stale-position');
  }
  if (contactAgeSeconds > 45) {
    flags.push('stale-contact');
  }
  if (context.providerGeneratedAtMs > context.receivedAtMs) flags.push('time-uncertain');
  const rawBarometricAltitude = input.alt_baro;
  // Numeric altitude and a missing ground flag do not establish airborne state.
  const onGround = rawBarometricAltitude === 'ground' ? true : null;
  const barometricAltitudeFeet = onGround
    ? undefined
    : readOptionalNumber(input, 'alt_baro', context);
  const geometricAltitudeFeet = readOptionalNumber(input, 'alt_geom', context);
  const groundSpeedKnots = readOptionalNumber(input, 'gs', context, 0);
  let trackDegrees = readOptionalNumber(input, 'track', context, 0, 360);
  if (trackDegrees === 360) {
    context.invalidFields += 1;
    trackDegrees = undefined;
  }
  const barometricRate = readOptionalNumber(input, 'baro_rate', context);
  const geometricRate = readOptionalNumber(input, 'geom_rate', context);
  const verticalRateFeetPerMinute = barometricRate ?? geometricRate;
  const metadata: Pick<
    AircraftState,
    'callsign' | 'registration' | 'aircraftType' | 'category' | 'sourceType'
  > = {};
  for (const [source, target, limit] of [
    ['flight', 'callsign', 16],
    ['r', 'registration', 16],
    ['t', 'aircraftType', 16],
    ['category', 'category', 16],
    ['type', 'sourceType', 32],
  ] as const) {
    const text = readOptionalText(input[source], limit, context);
    if (text !== undefined) metadata[target] = text;
  }

  return {
    aircraftId: rawId,
    identifierKind: rawId.startsWith('~') ? 'other' : 'icao24',
    ...metadata,
    ...(validPosition
      ? { position: { latitude, longitude }, lastPositionAt, positionAgeSeconds }
      : {}),
    ...(barometricAltitudeFeet !== undefined ? { barometricAltitudeFeet } : {}),
    ...(geometricAltitudeFeet !== undefined ? { geometricAltitudeFeet } : {}),
    ...(groundSpeedKnots !== undefined ? { groundSpeedKnots } : {}),
    ...(trackDegrees !== undefined ? { trackDegrees } : {}),
    ...(verticalRateFeetPerMinute !== undefined
      ? {
          verticalRateFeetPerMinute,
          verticalRateBasis:
            barometricRate !== undefined ? ('barometric' as const) : ('geometric' as const),
        }
      : {}),
    onGround,
    observedAt: lastContactAt,
    lastContactAt,
    contactAgeSeconds,
    qualityFlags: flags,
  };
}

function parsePayload(value: unknown): AdsbLolPayload {
  if (!isJsonRecord(value) || !Array.isArray(value.ac)) {
    throw new LiveProviderError(
      'INVALID_PAYLOAD',
      'The ADSB.lol response must contain a provider timestamp and an aircraft array.',
    );
  }
  const timestamp = isoFromMilliseconds(value.now);
  if (timestamp === undefined) {
    throw new LiveProviderError(
      'INVALID_PAYLOAD',
      'The provider timestamp must be valid Unix milliseconds.',
    );
  }
  return { now: Date.parse(timestamp), ac: value.ac };
}

export function normalizeAdsbLolPayload(
  value: unknown,
  region: RegionConfig,
  receivedAtMs: number,
  maxAircraft = DEFAULT_MAX_AIRCRAFT,
): ProviderSnapshot {
  if (!isSafeInteger(maxAircraft, 1, DEFAULT_MAX_AIRCRAFT)) {
    throw new RangeError('maxAircraft must be a positive integer within the live record limit.');
  }
  const receivedAt = isoFromMilliseconds(receivedAtMs);
  if (receivedAt === undefined)
    throw new RangeError('receivedAtMs must be valid Unix milliseconds.');
  receivedAtMs = Date.parse(receivedAt);
  const payload = parsePayload(value);
  if (payload.now - receivedAtMs > MAX_LIVE_FUTURE_OFFSET_MS) {
    throw new LiveProviderError(
      'INVALID_PAYLOAD',
      'The provider timestamp exceeds the future-clock tolerance.',
    );
  }
  if (payload.ac.length > maxAircraft) {
    throw new LiveProviderError(
      'PAYLOAD_TOO_LARGE',
      `The provider returned ${payload.ac.length} aircraft; the limit is ${maxAircraft}.`,
    );
  }

  const context: NormalizeContext = {
    receivedAtMs,
    providerGeneratedAtMs: payload.now,
    invalidFields: 0,
  };
  const byId = new Map<string, AircraftState>();
  let rejectedAircraft = 0;
  let duplicateAircraft = 0;

  for (const candidate of payload.ac) {
    const normalized = normalizeAircraft(candidate, context);
    if (!normalized) {
      rejectedAircraft += 1;
      continue;
    }
    const existing = byId.get(normalized.aircraftId);
    if (existing) {
      duplicateAircraft += 1;
      if (normalized.contactAgeSeconds >= existing.contactAgeSeconds) {
        continue;
      }
    }
    byId.set(normalized.aircraftId, normalized);
  }

  const aircraft = [...byId.values()].sort((left, right) =>
    left.aircraftId.localeCompare(right.aircraftId),
  );
  const validation: SnapshotValidationSummary = {
    receivedAircraft: payload.ac.length,
    acceptedAircraft: aircraft.length,
    rejectedAircraft,
    duplicateAircraft,
    invalidFields: context.invalidFields,
  };

  return {
    providerId: 'adsb-lol',
    regionId: region.id,
    receivedAt,
    providerGeneratedAt: new Date(payload.now).toISOString(),
    aircraft,
    validation,
  };
}

export function createAdsbLolProvider(options: AdsbLolProviderOptions = {}): LiveAircraftProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxAircraft = options.maxAircraft ?? DEFAULT_MAX_AIRCRAFT;
  const timeoutMs = options.timeoutMs ?? RUNTIME_POLICY_LIMITS.provider.requestTimeoutMs;
  const now = options.now ?? Date.now;
  if (!isSafeInteger(maxResponseBytes, 1, DEFAULT_MAX_RESPONSE_BYTES)) {
    throw new RangeError(
      'maxResponseBytes must be a positive integer within the live payload limit.',
    );
  }
  if (!isSafeInteger(maxAircraft, 1, DEFAULT_MAX_AIRCRAFT)) {
    throw new RangeError('maxAircraft must be a positive integer within the live record limit.');
  }
  if (!isSafeInteger(timeoutMs, 1, RUNTIME_POLICY_LIMITS.provider.requestTimeoutMs)) {
    throw new RangeError('timeoutMs must be a positive integer within the provider policy limit.');
  }

  return {
    id: 'adsb-lol',
    label: 'ADSB.lol',
    attributionUrl: 'https://www.adsb.lol/',
    async fetchRegion(region, signal) {
      const url = `${baseUrl}/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`;
      try {
        return await withLiveRequestDeadline(
          async (requestSignal) => {
            const response = await fetcher(url, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: requestSignal,
              redirect: 'error',
            });
            const headerReceivedAtMs = now();
            if (requestSignal.aborted) {
              cancelLiveResponse(response);
              requestSignal.throwIfAborted();
            }
            if (!response.ok) {
              cancelLiveResponse(response);
              throw new LiveProviderError(
                response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR',
                `The live aircraft provider returned HTTP ${response.status}.`,
                {
                  status: response.status,
                  ...parseRetryAfter(response.headers.get('retry-after'), headerReceivedAtMs),
                },
              );
            }
            const body = await readBoundedLiveText(response, {
              maxBytes: maxResponseBytes,
              signal: requestSignal,
            });
            let payload: unknown;
            try {
              payload = JSON.parse(body) as unknown;
            } catch (error) {
              throw new LiveProviderError(
                'MALFORMED_JSON',
                'The provider returned malformed JSON.',
                {
                  cause: error,
                },
              );
            }
            return normalizeAdsbLolPayload(payload, region, now(), maxAircraft);
          },
          { timeoutMs, signal },
        );
      } catch (error) {
        if (error instanceof LiveProviderError) throw error;
        if (error instanceof LiveResponseError && error.code === 'TOO_LARGE') {
          throw new LiveProviderError(
            'PAYLOAD_TOO_LARGE',
            `The provider payload exceeds the ${maxResponseBytes}-byte limit.`,
            { cause: error },
          );
        }
        if (error instanceof LiveResponseError && error.code === 'INVALID_ENCODING') {
          throw new LiveProviderError(
            'MALFORMED_JSON',
            'The provider returned invalid UTF-8 JSON.',
            { cause: error },
          );
        }
        throw new LiveProviderError('NETWORK_ERROR', 'The live aircraft provider request failed.', {
          cause: error,
        });
      }
    },
  };
}
