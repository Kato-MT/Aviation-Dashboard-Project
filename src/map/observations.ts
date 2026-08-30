import { aircraftEvidence } from '../live/freshness';
import type { ServerTimeInterval } from '../live/clock';
import { aircraftIdentifier } from '../live/presentation';
import { buildSessionTrailSegments } from '../live/historyPresentation';
import type { AircraftHistory } from '../live/history';
import type { AircraftState, LiveFeedBinding } from '../live/types';

export interface ObservationFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    aircraftId: string;
    label: string;
    freshness: 'current' | 'delayed' | 'stale';
    track: number | null;
  };
}
export interface ObservationFeatures {
  type: 'FeatureCollection';
  features: ObservationFeature[];
}

export interface TrailLineFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { aircraftId: string };
}

export interface TrailPointFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    aircraftId: string;
    historySequence: number;
    providerId: string;
    regionId: string;
    feedEpoch: string;
    observedAt: string;
    sourceType: string | null;
  };
}

export interface SelectedTrailFeatures {
  type: 'FeatureCollection';
  features: (TrailLineFeature | TrailPointFeature)[];
}

export interface MapFrame {
  regionId: string;
  selectedId: string | undefined;
  /** Requested exact receipt. Undefined means follow the latest retained receipt. */
  selectedHistorySequence: number | undefined;
  /** Currently retained receipt used only for the visual point highlight. */
  resolvedHistorySequence: number | undefined;
  observations: ObservationFeatures;
  selectedTrail: SelectedTrailFeatures;
}

export function observationFeatures(
  aircraft: readonly AircraftState[],
  time?: ServerTimeInterval,
): ObservationFeatures {
  const features: ObservationFeature[] = [];
  for (const track of aircraft) {
    const evidence = aircraftEvidence(track, time);
    const freshness = evidence.position.freshness;
    if (
      !track.position ||
      !evidence.activeContact ||
      (freshness !== 'current' && freshness !== 'delayed' && freshness !== 'stale')
    )
      continue;
    features.push({
      type: 'Feature',
      id: track.aircraftId,
      geometry: {
        type: 'Point',
        coordinates: [track.position.longitude, track.position.latitude],
      },
      properties: {
        aircraftId: track.aircraftId,
        label: aircraftIdentifier(track),
        freshness,
        track: track.trackDegrees ?? null,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function selectedTrailFeatures(
  aircraftId: string | undefined,
  history: AircraftHistory | undefined,
  binding: Readonly<LiveFeedBinding> | undefined,
): SelectedTrailFeatures {
  if (!aircraftId || !history || !binding) return { type: 'FeatureCollection', features: [] };
  const segments = buildSessionTrailSegments(history);
  const features: (TrailLineFeature | TrailPointFeature)[] = [];
  for (const segment of segments) {
    if (segment.length > 1) {
      features.push({
        type: 'Feature',
        id: `${aircraftId}:${segment[0]!.sequence}-${segment.at(-1)!.sequence}`,
        geometry: {
          type: 'LineString',
          coordinates: segment.map((point) => [point.longitude, point.latitude]),
        },
        properties: { aircraftId },
      });
    }
    for (const point of segment) {
      features.push({
        type: 'Feature',
        id: `${aircraftId}:${point.sequence}`,
        geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
        properties: {
          aircraftId,
          historySequence: point.sequence,
          providerId: binding.providerId,
          regionId: binding.regionId,
          feedEpoch: binding.feedEpoch,
          observedAt: point.observedAt,
          sourceType: point.sourceType ?? null,
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
