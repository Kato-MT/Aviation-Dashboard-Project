import type {
  AircraftHistory,
  AircraftHistorySample,
  HistoryIssue,
  MeasurementPoint,
} from './history';

export type LiveHistoryChannel = 'barometricAltitudeFeet' | 'groundSpeedKnots';

export interface HistoryReceiptRow {
  sequence: number;
  receivedAt: string;
  providerGeneratedAt: string;
  positionObservedAt?: string | undefined;
  measurementObservedAt?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  barometricAltitudeFeet?: number | undefined;
  groundSpeedKnots?: number | undefined;
  verticalRateFeetPerMinute?: number | undefined;
  positionBreakBefore: boolean;
  measurementBreakBefore: boolean;
}

export interface SessionSeriesPoint {
  sequence: number;
  receivedAt: string;
  observedAt: string;
  value: number;
}

export interface SessionSeries {
  channel: LiveHistoryChannel;
  label: string;
  unit: string;
  segments: readonly (readonly SessionSeriesPoint[])[];
  pointCount: number;
}

export interface SessionTrailPoint {
  sequence: number;
  receivedAt: string;
  observedAt: string;
  latitude: number;
  longitude: number;
  sourceType?: string | undefined;
}

export interface HistoryIssueDescription {
  code: HistoryIssue;
  message: string;
}

const SERIES_METADATA: Record<LiveHistoryChannel, Pick<SessionSeries, 'label' | 'unit'>> = {
  barometricAltitudeFeet: { label: 'Barometric altitude', unit: 'ft' },
  groundSpeedKnots: { label: 'Ground speed', unit: 'kt' },
};

const HISTORY_ISSUE_MESSAGES: Record<HistoryIssue, string> = {
  'sample-limit': 'Earlier receipts were removed after the 120-sample session limit.',
  'retention-limit': 'Evidence outside the 15-minute session window was removed.',
  'missing-position': 'At least one received aircraft state had no usable position.',
  'time-uncertain': 'At least one source timestamp could not be trusted.',
  'regressed-time': 'At least one source timestamp moved backward.',
  'conflicting-observation': 'Conflicting values shared the same source timestamp.',
  'feed-gap': 'The session contains a feed or observation gap.',
};

export function resolveHistorySample(
  history: AircraftHistory | undefined,
  sequence: number | undefined,
): AircraftHistorySample | undefined {
  if (!history) return undefined;
  if (sequence === undefined) return history.samples.at(-1);
  return history.samples.find((sample) => sample.sequence === sequence);
}

export function buildHistoryReceiptRows(
  history: AircraftHistory | undefined,
): readonly HistoryReceiptRow[] {
  if (!history) return [];
  return history.samples.map((sample) => ({
    sequence: sample.sequence,
    receivedAt: sample.receivedAt,
    providerGeneratedAt: sample.providerGeneratedAt,
    positionObservedAt: sample.position?.observedAt,
    measurementObservedAt: sample.measurements?.observedAt,
    latitude: sample.position?.latitude,
    longitude: sample.position?.longitude,
    barometricAltitudeFeet: sample.measurements?.barometricAltitudeFeet,
    groundSpeedKnots: sample.measurements?.groundSpeedKnots,
    verticalRateFeetPerMinute: sample.measurements?.verticalRateFeetPerMinute,
    positionBreakBefore: sample.position?.breakBefore ?? false,
    measurementBreakBefore: sample.measurements?.breakBefore ?? false,
  }));
}

function channelValue(point: MeasurementPoint, channel: LiveHistoryChannel): number | undefined {
  return point[channel];
}

export function buildSessionSeries(
  history: AircraftHistory | undefined,
  channel: LiveHistoryChannel,
): SessionSeries {
  const segments: SessionSeriesPoint[][] = [];
  let current: SessionSeriesPoint[] = [];
  const closeSegment = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const sample of history?.samples ?? []) {
    const point = sample.measurements;
    if (!point) continue;
    const value = channelValue(point, channel);
    if (point.breakBefore || value === undefined) closeSegment();
    if (value === undefined) continue;
    current.push({
      sequence: sample.sequence,
      receivedAt: sample.receivedAt,
      observedAt: point.observedAt,
      value,
    });
  }
  closeSegment();
  const metadata = SERIES_METADATA[channel];
  return {
    channel,
    ...metadata,
    segments,
    pointCount: segments.reduce((count, segment) => count + segment.length, 0),
  };
}

export function buildSessionTrailSegments(
  history: AircraftHistory | undefined,
): readonly (readonly SessionTrailPoint[])[] {
  const segments: SessionTrailPoint[][] = [];
  let current: SessionTrailPoint[] = [];
  const closeSegment = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const sample of history?.samples ?? []) {
    const point = sample.position;
    if (!point) continue;
    if (point.breakBefore) closeSegment();
    current.push({
      sequence: sample.sequence,
      receivedAt: sample.receivedAt,
      observedAt: point.observedAt,
      latitude: point.latitude,
      longitude: point.longitude,
      sourceType: point.sourceType,
    });
  }
  closeSegment();
  return segments;
}

export function describeHistoryIssues(
  issues: readonly HistoryIssue[],
): readonly HistoryIssueDescription[] {
  return issues.map((code) => ({ code, message: HISTORY_ISSUE_MESSAGES[code] }));
}
