import type { LiveEvidenceSelection } from '../live/history';
import { isLiveIdentifier } from '../live/validation';

interface RenderedObservation {
  geometry: { type: string; coordinates?: unknown };
  properties: {
    aircraftId?: unknown;
    historySequence?: unknown;
    providerId?: unknown;
    regionId?: unknown;
    feedEpoch?: unknown;
  } | null;
}
interface ScreenPoint {
  x: number;
  y: number;
}

/** Symbol collision boxes may overlap, so draw order is not a reliable selection rule. */
export function nearestMapEvidence(
  candidates: readonly RenderedObservation[],
  pointer: ScreenPoint,
  project: (coordinates: [number, number]) => ScreenPoint,
): LiveEvidenceSelection | undefined {
  let nearest:
    | { selection: LiveEvidenceSelection; squaredDistance: number; historyPriority: number }
    | undefined;
  for (const candidate of candidates) {
    const coordinates = candidate.geometry.coordinates;
    const id = candidate.properties?.aircraftId;
    if (
      candidate.geometry.type !== 'Point' ||
      !Array.isArray(coordinates) ||
      coordinates.length !== 2 ||
      !coordinates.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      typeof id !== 'string'
    )
      continue;
    const rawSequence = candidate.properties?.historySequence;
    if (
      rawSequence !== undefined &&
      (!Number.isSafeInteger(rawSequence) || (rawSequence as number) < 0)
    )
      continue;
    const historySequence = rawSequence as number | undefined;
    const providerId = candidate.properties?.providerId;
    const regionId = candidate.properties?.regionId;
    const feedEpoch = candidate.properties?.feedEpoch;
    if (
      historySequence !== undefined &&
      (!isLiveIdentifier(providerId) || !isLiveIdentifier(regionId) || !isLiveIdentifier(feedEpoch))
    )
      continue;
    const position = project(coordinates as [number, number]);
    const squaredDistance = (position.x - pointer.x) ** 2 + (position.y - pointer.y) ** 2;
    if (!Number.isFinite(squaredDistance) || squaredDistance > 22 ** 2) continue;
    const historyPriority = historySequence === undefined ? 1 : 0;
    const selection: LiveEvidenceSelection =
      historySequence === undefined
        ? { mode: 'latest', aircraftId: id }
        : {
            mode: 'exact',
            key: {
              aircraftId: id,
              sequence: historySequence,
              providerId: providerId as string,
              regionId: regionId as string,
              feedEpoch: feedEpoch as string,
            },
          };
    const nearestId =
      nearest?.selection.mode === 'latest'
        ? nearest.selection.aircraftId
        : nearest?.selection.key.aircraftId;
    const nearestSequence =
      nearest?.selection.mode === 'exact' ? nearest.selection.key.sequence : -1;
    if (
      !nearest ||
      squaredDistance < nearest.squaredDistance ||
      (squaredDistance === nearest.squaredDistance &&
        (historyPriority < nearest.historyPriority ||
          (historyPriority === nearest.historyPriority &&
            (id < nearestId! || (id === nearestId! && (historySequence ?? -1) > nearestSequence)))))
    )
      nearest = { selection, squaredDistance, historyPriority };
  }
  return nearest?.selection;
}
