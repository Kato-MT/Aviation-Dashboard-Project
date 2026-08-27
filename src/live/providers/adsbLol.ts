import { LiveProviderError, type LiveAircraftProvider } from '../provider';
import type {
  AircraftQualityFlag,
  AircraftState,
  ProviderSnapshot,
  RegionConfig,
  SnapshotValidationSummary,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.adsb.lol';
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AIRCRAFT = 2_000;
const AIRCRAFT_ID_PATTERN = /^~?[0-9a-f]{6}$/i;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AdsbLolProviderOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  maxResponseBytes?: number;
  maxAircraft?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function isoFromAge(referenceMs: number, ageSeconds: number): string {
  return new Date(referenceMs - ageSeconds * 1_000).toISOString();
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  context: NormalizeContext,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = finiteNumber(value);
  if (parsed === undefined) {
    context.invalidFields += 1;
  }
  return parsed;
}

function normalizeAircraft(input: unknown, context: NormalizeContext): AircraftState | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const rawId = optionalString(input.hex, 7)?.toLowerCase();
  if (!rawId || !AIRCRAFT_ID_PATTERN.test(rawId)) {
    return undefined;
  }

  const contactAgeSeconds = nonNegativeNumber(input.seen);
  if (contactAgeSeconds === undefined) {
    return undefined;
  }

  const positionAgeSeconds = nonNegativeNumber(input.seen_pos);
  const latitude = readOptionalNumber(input, 'lat', context);
  const longitude = readOptionalNumber(input, 'lon', context);
  const validPosition =
    latitude !== undefined &&
    longitude !== undefined &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  if ((latitude !== undefined || longitude !== undefined) && !validPosition) {
    context.invalidFields += 1;
  }

  const flags: AircraftQualityFlag[] = [];
  if (!validPosition || positionAgeSeconds === undefined) {
    flags.push('missing-position');
  } else if (positionAgeSeconds > 45) {
    flags.push('stale-position');
  }
  if (contactAgeSeconds > 45) {
    flags.push('stale-contact');
  }
  const rawBarometricAltitude = input.alt_baro;
  const onGround = rawBarometricAltitude === 'ground';
  const barometricAltitudeFeet = onGround
    ? undefined
    : readOptionalNumber(input, 'alt_baro', context);
  const geometricAltitudeFeet = readOptionalNumber(input, 'alt_geom', context);
  const groundSpeedKnots = readOptionalNumber(input, 'gs', context);
  const rawTrack = readOptionalNumber(input, 'track', context);
  const trackDegrees = rawTrack === undefined ? undefined : ((rawTrack % 360) + 360) % 360;
  const verticalRateFeetPerMinute =
    readOptionalNumber(input, 'baro_rate', context) ??
    readOptionalNumber(input, 'geom_rate', context);

  return {
    aircraftId: rawId,
    identifierKind: rawId.startsWith('~') ? 'other' : 'icao24',
    callsign: optionalString(input.flight, 16),
    registration: optionalString(input.r, 16),
    aircraftType: optionalString(input.t, 16),
    category: optionalString(input.category, 16),
    ...(validPosition ? { position: { latitude, longitude } } : {}),
    ...(barometricAltitudeFeet !== undefined ? { barometricAltitudeFeet } : {}),
    ...(geometricAltitudeFeet !== undefined ? { geometricAltitudeFeet } : {}),
    ...(groundSpeedKnots !== undefined ? { groundSpeedKnots } : {}),
    ...(trackDegrees !== undefined ? { trackDegrees } : {}),
    ...(verticalRateFeetPerMinute !== undefined ? { verticalRateFeetPerMinute } : {}),
    onGround,
    sourceType: optionalString(input.type, 32),
    observedAt: isoFromAge(context.providerGeneratedAtMs, contactAgeSeconds),
    lastContactAt: isoFromAge(context.providerGeneratedAtMs, contactAgeSeconds),
    ...(validPosition && positionAgeSeconds !== undefined
      ? { lastPositionAt: isoFromAge(context.providerGeneratedAtMs, positionAgeSeconds) }
      : {}),
    contactAgeSeconds,
    ...(positionAgeSeconds !== undefined ? { positionAgeSeconds } : {}),
    qualityFlags: flags,
  };
}

function parsePayload(value: unknown): AdsbLolPayload {
  if (!isRecord(value) || !Array.isArray(value.ac) || finiteNumber(value.now) === undefined) {
    throw new LiveProviderError(
      'INVALID_PAYLOAD',
      'The ADSB.lol response must contain a numeric now value and an aircraft array.',
    );
  }
  return { now: value.now as number, ac: value.ac };
}

export function normalizeAdsbLolPayload(
  value: unknown,
  region: RegionConfig,
  receivedAtMs: number,
  maxAircraft = DEFAULT_MAX_AIRCRAFT,
): ProviderSnapshot {
  const payload = parsePayload(value);
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
    receivedAt: new Date(receivedAtMs).toISOString(),
    providerGeneratedAt: new Date(payload.now).toISOString(),
    aircraft,
    validation,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function createAdsbLolProvider(options: AdsbLolProviderOptions = {}): LiveAircraftProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxAircraft = options.maxAircraft ?? DEFAULT_MAX_AIRCRAFT;
  const now = options.now ?? Date.now;

  return {
    id: 'adsb-lol',
    label: 'ADSB.lol',
    attributionUrl: 'https://www.adsb.lol/',
    async fetchRegion(region, signal) {
      const url = `${baseUrl}/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new LiveProviderError('NETWORK_ERROR', 'The live aircraft provider request failed.', {
          cause: error,
        });
      }

      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
        throw new LiveProviderError(
          response.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR',
          `The live aircraft provider returned HTTP ${response.status}.`,
          {
            status: response.status,
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          },
        );
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        throw new LiveProviderError(
          'PAYLOAD_TOO_LARGE',
          `The provider payload exceeds the ${maxResponseBytes}-byte limit.`,
        );
      }

      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > maxResponseBytes) {
        throw new LiveProviderError(
          'PAYLOAD_TOO_LARGE',
          `The provider payload exceeds the ${maxResponseBytes}-byte limit.`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        throw new LiveProviderError('MALFORMED_JSON', 'The provider returned malformed JSON.', {
          cause: error,
        });
      }
      return normalizeAdsbLolPayload(payload, region, now(), maxAircraft);
    },
  };
}
