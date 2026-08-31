import { useEffect, useMemo, useRef, useState } from 'react';
import { observationFeatures, selectedTrailFeatures, type MapFrame } from '../../map/observations';
import type { AircraftHistory, LiveEvidenceSelection } from '../../live/history';
import { resolveHistorySample } from '../../live/historyPresentation';
import type { AircraftState, LiveFeedBinding } from '../../live/types';
import type { ServerTimeInterval } from '../../live/clock';
import type { MapRenderer } from './mapRenderer';
import { LIVE_PILOT_POLICY } from '../../live/pilotPolicy';

export const MAP_LOAD_TIMEOUT_MS = 15_000;
type RendererModule = Pick<typeof import('./mapRenderer'), 'createMapRenderer'>;
const defaultLoadRenderer = () => import('./mapRenderer');

interface Props {
  aircraft: readonly AircraftState[];
  time: ServerTimeInterval | undefined;
  regionId: string;
  selectedId: string | undefined;
  selectedHistorySequence: number | undefined;
  selectedHistory: AircraftHistory | undefined;
  binding: Readonly<LiveFeedBinding> | undefined;
  onSelect(selection: LiveEvidenceSelection): void;
  stablePaintToken?: number | undefined;
  onStablePaint?(token: number): void;
  loadRenderer?: () => Promise<RendererModule>;
}

export function AirspaceMap({
  aircraft,
  time,
  regionId,
  selectedId,
  selectedHistorySequence,
  selectedHistory,
  binding,
  onSelect,
  stablePaintToken,
  onStablePaint,
  loadRenderer = defaultLoadRenderer,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<MapRenderer | undefined>(undefined);
  const latestSelect = useRef(onSelect);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const observations = useMemo(() => observationFeatures(aircraft, time), [aircraft, time]);
  const selectedTrail = useMemo(
    () => selectedTrailFeatures(selectedId, selectedHistory, binding),
    [selectedId, selectedHistory, binding],
  );
  const resolvedHistorySequence = resolveHistorySample(
    selectedHistory,
    selectedHistorySequence,
  )?.sequence;
  const frame = useRef<MapFrame>({
    regionId,
    selectedId,
    selectedHistorySequence,
    resolvedHistorySequence,
    observations,
    selectedTrail,
  });
  useEffect(() => {
    latestSelect.current = onSelect;
    frame.current = {
      regionId,
      selectedId,
      selectedHistorySequence,
      resolvedHistorySequence,
      observations,
      selectedTrail,
    };
    if (stablePaintToken === undefined || !onStablePaint) renderer.current?.update(frame.current);
    else renderer.current?.update(frame.current, () => onStablePaint(stablePaintToken));
  }, [
    regionId,
    selectedId,
    selectedHistorySequence,
    resolvedHistorySequence,
    observations,
    selectedTrail,
    onSelect,
    stablePaintToken,
    onStablePaint,
  ]);
  useEffect(() => {
    let active = true;
    let owned: MapRenderer | undefined;
    const disposeOwned = () => {
      const previous = owned;
      owned = undefined;
      if (renderer.current === previous) renderer.current = undefined;
      previous?.dispose();
    };
    const fail = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(deadline);
      setStatus('unavailable');
      queueMicrotask(disposeOwned);
    };
    const deadline = window.setTimeout(fail, MAP_LOAD_TIMEOUT_MS);
    setStatus('loading');
    void Promise.resolve()
      .then(loadRenderer)
      .then(({ createMapRenderer }) => {
        if (!active || !container.current) return;
        try {
          owned = createMapRenderer(container.current, frame.current, {
            ready() {
              if (active) {
                window.clearTimeout(deadline);
                setStatus('ready');
              }
            },
            unavailable: fail,
            select(selection: LiveEvidenceSelection) {
              if (!active) return;
              const valid =
                selection.mode === 'latest'
                  ? frame.current.observations.features.some(
                      (feature) => feature.id === selection.aircraftId,
                    )
                  : frame.current.selectedTrail.features.some(
                      (feature) =>
                        feature.geometry.type === 'Point' &&
                        'historySequence' in feature.properties &&
                        feature.properties.aircraftId === selection.key.aircraftId &&
                        feature.properties.historySequence === selection.key.sequence &&
                        feature.properties.providerId === selection.key.providerId &&
                        feature.properties.regionId === selection.key.regionId &&
                        feature.properties.feedEpoch === selection.key.feedEpoch,
                    );
              if (valid) latestSelect.current(selection);
            },
          });
          if (active) renderer.current = owned;
          else disposeOwned();
        } catch {
          fail();
        }
      }, fail);
    return () => {
      active = false;
      window.clearTimeout(deadline);
      disposeOwned();
    };
  }, [attempt, loadRenderer]);
  return (
    <section className="map-panel" aria-labelledby="geography-title">
      <header className="map-heading">
        <div>
          <h2 id="geography-title">Geographic context</h2>
          <p>Observed positions only. No predicted movement.</p>
        </div>
        <button
          type="button"
          className="quiet-button"
          onClick={() => renderer.current?.resetView()}
          disabled={status !== 'ready'}
        >
          Reset map view
        </button>
      </header>
      <div className="map-stage" data-map-status={status}>
        <div
          ref={container}
          className="airspace-map"
          role="region"
          aria-label="Regional geographic map"
        />
        {status !== 'ready' && (
          <div className="map-message" role="status">
            <h3>{status === 'loading' ? 'Loading geographic context' : 'Map unavailable'}</h3>
            <p>
              {status === 'loading'
                ? 'Loading the local regional archive and map renderer.'
                : 'The aircraft table, selection and timing evidence remain available below.'}
            </p>
            {status === 'unavailable' && (
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Retry map
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="map-footer">
        <p id="map-instructions">
          Arrow keys pan; + and − zoom. Select observations on the map or in the table.
        </p>
        <p className="map-legend">
          <span>Blue: current</span>
          <span>Amber: delayed</span>
          <span>Hollow: stale position</span>
        </p>
        <p className="map-attribution">
          {binding?.providerId === LIVE_PILOT_POLICY.providerId && (
            <>
              Aircraft observations: <a href={LIVE_PILOT_POLICY.sourceUrl}>ADSB.lol</a> ·{' '}
              <a href={LIVE_PILOT_POLICY.licenseUrl}>{LIVE_PILOT_POLICY.licenseLabel}</a> ·{' '}
            </>
          )}
          <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> ·{' '}
          <a href="https://protomaps.com">Protomaps</a> ·{' '}
          <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover</a>
        </p>
      </footer>
    </section>
  );
}
