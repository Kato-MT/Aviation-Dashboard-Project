import type { ServerTimeInterval } from '../../live/clock';
import type { AircraftHistory, LiveEvidenceSelection } from '../../live/history';
import type { AircraftState, LiveFeedBinding } from '../../live/types';

export interface OfflineAirspaceMapProps {
  aircraft: readonly AircraftState[];
  time: ServerTimeInterval | undefined;
  regionId: string;
  selectedId: string | undefined;
  selectedHistorySequence: number | undefined;
  selectedHistory: AircraftHistory | undefined;
  binding: Readonly<LiveFeedBinding> | undefined;
  onSelect(selection: LiveEvidenceSelection): void;
}

/** Offline replacement for AirspaceMap. It deliberately has no renderer or asset loader. */
export function AirspaceMap({ aircraft, regionId, selectedId }: OfflineAirspaceMapProps) {
  return (
    <section className="map-panel" aria-labelledby="geography-title" data-offline-map>
      <header className="map-heading">
        <div>
          <h2 id="geography-title">Geographic context</h2>
          <p>Interactive regional map omitted from the self-contained package.</p>
        </div>
        <span className="development-label">Offline table mode</span>
      </header>
      <div className="map-stage" data-map-status="offline">
        <div className="map-message" role="status">
          <h3>Map unavailable offline</h3>
          <p>
            {aircraft.length} synthetic{' '}
            {aircraft.length === 1 ? 'observation remains' : 'observations remain'} available in the
            table and selected-track investigation below.
          </p>
          <p>
            Scenario region: <strong>{regionId}</strong>
            {selectedId ? ` · selected ${selectedId.toUpperCase()}` : ' · no track selected'}
          </p>
        </div>
      </div>
      <footer className="map-footer">
        <p>Use the observation table to select a track and inspect its retained replay evidence.</p>
        <p>No map renderer, tile archive, sprite, glyph, or network request is included here.</p>
      </footer>
    </section>
  );
}
