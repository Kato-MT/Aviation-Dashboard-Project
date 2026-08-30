import { useEffect, useState } from 'react';
import { LiveAirspaceRuntime, type LiveAirspaceRuntimeOptions } from '../../live/runtime';
import { loadLiveServiceInfo, type LiveServiceInfo } from '../../live/service';
import {
  DEFAULT_AIRCRAFT_FILTERS,
  type AircraftSortField,
  type SortDirection,
} from '../../live/presentation';
import { AirspaceView } from './AirspaceView';
import { useLiveAirspace } from './useLiveAirspace';

type RuntimeFactory = (options: LiveAirspaceRuntimeOptions) => LiveAirspaceRuntime;
const defaultRuntimeFactory: RuntimeFactory = (options) => new LiveAirspaceRuntime(options);

function ConnectedAirspace({
  info,
  createRuntime,
}: {
  info: LiveServiceInfo;
  createRuntime: RuntimeFactory;
}) {
  const [runtime] = useState(() =>
    createRuntime({ regionId: 'atlanta', providerId: info.source.providerId }),
  );
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_AIRCRAFT_FILTERS }));
  const [sortField, setSortField] = useState<AircraftSortField>('identifier');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const state = useLiveAirspace(runtime, !paused);
  return (
    <AirspaceView
      state={state}
      filters={filters}
      sortField={sortField}
      sortDirection={sortDirection}
      paused={paused}
      onFilters={setFilters}
      onSort={(field) => {
        if (field === sortField)
          setSortDirection((direction) => (direction === 'ascending' ? 'descending' : 'ascending'));
        else {
          setSortField(field);
          setSortDirection('ascending');
        }
      }}
      onSelect={(selection) => {
        if (!selection) runtime.selectAircraft();
        else if (selection.mode === 'latest') runtime.selectAircraft(selection.aircraftId);
        else {
          runtime.selectHistorySample(
            selection.key.aircraftId,
            selection.key.sequence,
            selection.key,
          );
        }
      }}
      onRegion={(regionId) => {
        setFilters({ ...DEFAULT_AIRCRAFT_FILTERS });
        setSortField('identifier');
        setSortDirection('ascending');
        runtime.switchRegion(regionId);
      }}
      onPause={() => setPaused((value) => !value)}
      onReconnect={() => {
        runtime.stop();
        runtime.start();
      }}
    />
  );
}

interface Props {
  loadServiceInfo?: typeof loadLiveServiceInfo;
  createRuntime?: RuntimeFactory;
}

export function LiveAirspaceApp({
  loadServiceInfo = loadLiveServiceInfo,
  createRuntime = defaultRuntimeFactory,
}: Props) {
  const [info, setInfo] = useState<LiveServiceInfo>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setInfo(undefined);
    setError(undefined);
    void loadServiceInfo(controller.signal).then(
      (value) => {
        if (active) setInfo(value);
      },
      () => {
        if (active) setError('The data source could not be verified. No feed was started.');
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [loadServiceInfo, attempt]);
  return (
    <main id="airspace-main" tabIndex={-1}>
      {info && (
        <div className="source-banner" role="note" data-source-mode={info.source.mode}>
          <strong>{info.source.label}</strong>
          <span>
            {info.source.synthetic
              ? 'Fictional observations through the real backend. No real aircraft provider is contacted.'
              : 'Public surveillance observations, not aircraft-health telemetry. Coverage and freshness vary.'}
          </span>
        </div>
      )}
      {!info && !error && (
        <section className="startup-state" role="status">
          <h1>Connecting to the workbench</h1>
          <p>Verifying the server-owned data source before opening a feed.</p>
        </section>
      )}
      {error && (
        <section className="startup-state">
          <h1>Feed unavailable</h1>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry service connection
          </button>
        </section>
      )}
      {info?.source.mode === 'disabled' && (
        <section className="startup-state">
          <h1>Live data is disabled</h1>
          <p>The server has not enabled a provider. No aircraft request or stream is started.</p>
          <a href="#lab">Open the synthetic Diagnostics Lab</a>
        </section>
      )}
      {info && info.source.mode !== 'disabled' && (
        <ConnectedAirspace
          key={`${info.source.target}:${info.source.providerId}`}
          info={info}
          createRuntime={createRuntime}
        />
      )}
      <section className="source-evidence" aria-labelledby="source-title">
        <h2 id="source-title">Engineering evidence</h2>
        <p>
          Inspect the declared source, validation path, map identity, licenses, privacy boundaries,
          limitations and release gates without starting another aircraft feed.
        </p>
        <a href="#evidence">Open the Evidence workspace</a>
      </section>
    </main>
  );
}
