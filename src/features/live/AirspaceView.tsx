import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  aircraftEvidence,
  observationEvidence,
  type ObservationEvidence,
} from '../../live/freshness';
import type { LiveEvidenceSelection } from '../../live/history';
import {
  aircraftIdentifier,
  filterAircraft,
  sortAircraft,
  summarizeAirspace,
  type AircraftFilters,
  type AircraftSortField,
  type AltitudeFilter,
  type GroundStateFilter,
  type QualityFilter,
  type SortDirection,
} from '../../live/presentation';
import { getRegionConfig, REGION_CONFIGS } from '../../live/regions';
import type { LiveSessionState } from '../../live/session';
import type { ServerTimeInterval } from '../../live/clock';
import type { AircraftState, RegionConfig } from '../../live/types';
import { AirspaceMap } from './AirspaceMap';
import { SelectedTrackInvestigation } from './SelectedTrackInvestigation';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const freshnessLabels = {
  current: 'Current',
  delayed: 'Delayed',
  stale: 'Stale',
  expired: 'Expired',
  missing: 'No position',
  'time-uncertain': 'Time uncertain',
};
const phaseLabels: Record<LiveSessionState['phase'], string> = {
  loading: 'Waiting',
  connecting: 'Connecting',
  live: 'Live',
  degraded: 'Degraded',
  stale: 'Stale',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  error: 'Protocol error',
};

function measurement(value: number | undefined, unit = ''): string {
  return value === undefined ? 'Unknown' : `${number.format(value)}${unit ? ` ${unit}` : ''}`;
}

function ageText(evidence: ObservationEvidence): string {
  return evidence.age && evidence.freshness !== 'time-uncertain'
    ? `At most ${Math.ceil(evidence.age.maximumMs / 1_000)} s`
    : 'Uncertain';
}

function receiptAgeText(state: LiveSessionState): string {
  if (!state.snapshot) return 'No receipt yet';
  const evidence = observationEvidence(state.snapshot.generatedAt, state.time);
  return evidence.age && evidence.freshness !== 'time-uncertain'
    ? `At most ${Math.max(0, Math.ceil(evidence.age.maximumMs / 1_000))} s`
    : 'Time uncertain';
}

function shortenedEpoch(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 9)}…${value.slice(-5)}`;
}

function Timestamp({ value }: { value?: string | undefined }) {
  return value ? (
    <time dateTime={value}>{value.replace('T', ' ').replace('Z', ' UTC')}</time>
  ) : (
    <>Unknown</>
  );
}

interface SharedProps {
  state: LiveSessionState;
  regions?: readonly RegionConfig[];
  filters: AircraftFilters;
  sortField: AircraftSortField;
  sortDirection: SortDirection;
  onFilters(value: AircraftFilters): void;
  onSort(field: AircraftSortField): void;
  onRegion?(value: string): void;
  onSelect(selection?: LiveEvidenceSelection): void;
  onStableMapPaint?(sequence: number): void;
  presentation: {
    sectionLabel: string;
    title: string;
    subtitle: string;
    controls: ReactNode;
    beforeFilters?: ReactNode;
    notice?: ReactNode;
    regionLabel: string;
    emptyWaiting: string;
    emptySource: string;
    emptyFiltered: string;
    footerPrimary: string;
    footerSecondary: string;
  };
}

interface Props extends Omit<SharedProps, 'presentation'> {
  paused: boolean;
  onRegion(value: string): void;
  onPause(): void;
  onReconnect(): void;
}

interface ObservationRowsProps {
  rows: readonly AircraftState[];
  time: ServerTimeInterval | undefined;
  selectedAircraftId: string | undefined;
  onSelect(selection: LiveEvidenceSelection, origin?: HTMLElement): void;
}

const ObservationRows = memo(function ObservationRows({
  rows,
  time,
  selectedAircraftId,
  onSelect,
}: ObservationRowsProps) {
  return rows.map((track) => {
    const evidence = aircraftEvidence(track, time);
    return (
      <tr key={track.aircraftId} data-selected={track.aircraftId === selectedAircraftId}>
        <th scope="row">
          <button
            type="button"
            className="aircraft-link"
            aria-pressed={track.aircraftId === selectedAircraftId}
            onClick={(event) =>
              onSelect({ mode: 'latest', aircraftId: track.aircraftId }, event.currentTarget)
            }
          >
            {aircraftIdentifier(track)}
          </button>
          <small className="identifier">{track.aircraftId.toUpperCase()}</small>
        </th>
        <td>{measurement(track.barometricAltitudeFeet)}</td>
        <td>{measurement(track.groundSpeedKnots)}</td>
        <td>{track.position ? ageText(evidence.position) : 'No position'}</td>
        <td>
          <span className="freshness" data-freshness={evidence.position.freshness}>
            {freshnessLabels[evidence.position.freshness]}
          </span>
        </td>
      </tr>
    );
  });
});

export function AirspaceInvestigationView(props: SharedProps) {
  const { state, filters, sortField, sortDirection, presentation } = props;
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const restoreSelectionOrigin = useRef(false);
  const onSelectRef = useRef(props.onSelect);
  const deferredQuery = useDeferredValue(filters.query);
  const aircraft = state.snapshot?.aircraft ?? [];
  const effectiveFilters = useMemo<AircraftFilters>(
    () => ({
      query: deferredQuery,
      altitude: filters.altitude,
      groundState: filters.groundState,
      quality: filters.quality,
      positionedOnly: filters.positionedOnly,
    }),
    [deferredQuery, filters.altitude, filters.groundState, filters.positionedOnly, filters.quality],
  );
  const rows = useMemo(
    () =>
      sortAircraft(
        filterAircraft(aircraft, effectiveFilters, state.time),
        sortField,
        sortDirection,
        state.time,
      ),
    [aircraft, effectiveFilters, sortDirection, sortField, state.time],
  );
  const summary = useMemo(() => summarizeAirspace(aircraft, state.time), [aircraft, state.time]);
  const region = getRegionConfig(state.regionId)!;
  const availableRegions = props.regions ?? REGION_CONFIGS;
  const selected = useMemo(
    () => aircraft.find((track) => track.aircraftId === state.selectedAircraftId),
    [aircraft, state.selectedAircraftId],
  );
  const selectedHistory = state.selectedAircraftId
    ? state.histories.get(state.selectedAircraftId)
    : undefined;
  const sortState = (field: AircraftSortField): 'ascending' | 'descending' | 'none' =>
    sortField === field ? sortDirection : 'none';
  const select = useCallback(
    (selection: LiveEvidenceSelection, origin?: HTMLElement) => {
      const nextAircraftId =
        selection.mode === 'latest' ? selection.aircraftId : selection.key.aircraftId;
      if (!state.selectedAircraftId || nextAircraftId !== state.selectedAircraftId) {
        const candidate =
          origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        selectionOrigin.current =
          candidate && candidate !== document.body && document.activeElement === candidate
            ? candidate
            : null;
      }
      onSelectRef.current(selection);
    },
    [state.selectedAircraftId],
  );
  const clearSelection = useCallback(() => {
    restoreSelectionOrigin.current = true;
    onSelectRef.current();
  }, []);
  const selectInvestigationEvidence = useCallback(
    (selection?: LiveEvidenceSelection) => (selection ? select(selection) : clearSelection()),
    [clearSelection, select],
  );
  useLayoutEffect(() => {
    onSelectRef.current = props.onSelect;
  }, [props.onSelect]);
  useEffect(() => {
    if (state.selectedAircraftId || !restoreSelectionOrigin.current) return;
    restoreSelectionOrigin.current = false;
    if (selectionOrigin.current?.isConnected) selectionOrigin.current.focus();
  }, [state.selectedAircraftId]);
  const setFilter = <Key extends keyof AircraftFilters>(key: Key, value: AircraftFilters[Key]) =>
    props.onFilters({ ...filters, [key]: value });

  return (
    <>
      <section className="workspace-heading" aria-labelledby="workspace-title">
        <div>
          <p className="section-label">{presentation.sectionLabel}</p>
          <h1 id="workspace-title">{presentation.title}</h1>
          <p>{presentation.subtitle}</p>
        </div>
        <div className="connection-controls">{presentation.controls}</div>
      </section>

      {presentation.beforeFilters}

      <form
        className="airspace-filters"
        aria-label="Observation filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          {presentation.regionLabel}
          {props.onRegion && availableRegions.length > 1 ? (
            <select
              value={state.regionId}
              onChange={(event) => props.onRegion?.(event.target.value)}
            >
              {availableRegions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="static-control">{region.label}</span>
          )}
        </label>
        <label className="search-filter">
          Search observations
          <input
            type="search"
            maxLength={64}
            value={filters.query}
            onChange={(event) => setFilter('query', event.target.value)}
            placeholder="Callsign or aircraft identifier"
          />
        </label>
        <label>
          Altitude band
          <select
            value={filters.altitude}
            onChange={(event) => setFilter('altitude', event.target.value as AltitudeFilter)}
          >
            <option value="all">All altitudes</option>
            <option value="ground">On ground</option>
            <option value="below-10000">Below 10,000 ft</option>
            <option value="10000-25000">10,000 to 25,000 ft</option>
            <option value="above-25000">Above 25,000 ft</option>
          </select>
        </label>
        <label>
          Ground state
          <select
            value={filters.groundState}
            onChange={(event) => setFilter('groundState', event.target.value as GroundStateFilter)}
          >
            <option value="all">All states</option>
            <option value="airborne">Airborne</option>
            <option value="ground">On ground</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Position freshness
          <select
            value={filters.quality}
            onChange={(event) => setFilter('quality', event.target.value as QualityFilter)}
          >
            <option value="all">All observations</option>
            <option value="current">Current</option>
            <option value="delayed">Delayed</option>
            <option value="stale">Stale</option>
            <option value="expired">Expired position</option>
            <option value="missing-position">No position</option>
            <option value="time-uncertain">Time uncertain</option>
          </select>
        </label>
        <label className="checkbox-filter">
          <input
            type="checkbox"
            checked={filters.positionedOnly}
            onChange={(event) => setFilter('positionedOnly', event.target.checked)}
          />
          Positioned only
        </label>
      </form>

      {presentation.notice}

      <p className="sr-only" aria-live="polite">
        {state.selectedAircraftId
          ? `Selected track ${state.selectedAircraftId.toUpperCase()}${state.selectedHistorySequence === undefined ? ', following latest retained receipt.' : `, exact receipt ${state.selectedHistorySequence}.`}`
          : 'No track selected.'}
      </p>

      <div className="airspace-workspace">
        <AirspaceMap
          aircraft={rows}
          time={state.time}
          regionId={state.regionId}
          selectedId={state.selectedAircraftId}
          selectedHistorySequence={state.selectedHistorySequence}
          selectedHistory={selectedHistory}
          binding={state.binding}
          onSelect={select}
          stablePaintToken={state.snapshot?.sequence}
          {...(props.onStableMapPaint ? { onStablePaint: props.onStableMapPaint } : {})}
        />

        <SelectedTrackInvestigation
          aircraft={selected}
          state={state}
          onSelect={selectInvestigationEvidence}
        />

        <section
          className="observation-panel"
          aria-labelledby="observations-title"
          aria-busy={deferredQuery !== filters.query}
        >
          <header className="observation-heading">
            <div>
              <h2 id="observations-title">Aircraft observations</h2>
              <p className="observation-summary">
                {summary.observed} observed · {summary.positioned} with position · {summary.stale}{' '}
                stale positions
              </p>
            </div>
            <span className="muted">{rows.length} shown</span>
          </header>
          <div
            className="table-scroll"
            role="region"
            aria-label="Aircraft observation table"
            tabIndex={0}
          >
            <table>
              <caption className="sr-only">
                Received aircraft observations. Select an identifier to inspect its evidence.
              </caption>
              <thead>
                <tr>
                  <th scope="col" aria-sort={sortState('identifier')}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => props.onSort('identifier')}
                    >
                      Aircraft
                    </button>
                  </th>
                  <th scope="col" aria-sort={sortState('altitude')}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => props.onSort('altitude')}
                    >
                      Altitude <span>ft, barometric</span>
                    </button>
                  </th>
                  <th scope="col" aria-sort={sortState('speed')}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => props.onSort('speed')}
                    >
                      Ground speed <span>knots</span>
                    </button>
                  </th>
                  <th scope="col">Position age</th>
                  <th scope="col" aria-sort={sortState('freshness')}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => props.onSort('freshness')}
                    >
                      Freshness
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <ObservationRows
                  rows={rows}
                  time={state.time}
                  selectedAircraftId={state.selectedAircraftId}
                  onSelect={select}
                />
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div className="table-empty">
              <h3>
                {!state.snapshot
                  ? 'No observations yet'
                  : state.snapshot.aircraft.length === 0
                    ? 'No aircraft reported'
                    : 'No matching observations'}
              </h3>
              <p>
                {!state.snapshot
                  ? presentation.emptyWaiting
                  : state.snapshot.aircraft.length === 0
                    ? presentation.emptySource
                    : presentation.emptyFiltered}
              </p>
            </div>
          )}
          <footer className="observation-footer">
            <p>{presentation.footerPrimary}</p>
            <p>{presentation.footerSecondary}</p>
          </footer>
        </section>
      </div>
    </>
  );
}

export function AirspaceView(props: Props) {
  const { state, paused, onPause, onReconnect, ...shared } = props;
  const region = getRegionConfig(state.regionId)!;
  const summary = summarizeAirspace(state.snapshot?.aircraft ?? [], state.time);
  const transportLabel = paused
    ? 'Paused'
    : state.transport === 'open'
      ? 'Connected'
      : state.transport === 'reconnecting'
        ? 'Reconnecting'
        : state.transport === 'offline'
          ? 'Disconnected'
          : 'Connecting';
  const status = paused
    ? 'The feed is paused. Live session evidence has been cleared.'
    : state.health?.status === 'degraded' || state.lastError
      ? 'The source is temporarily unavailable. Retained observations continue aging.'
      : state.snapshot && !state.time
        ? 'Time synchronization is unavailable. Current positions are withheld until a measured reference is restored.'
        : state.snapshot?.aircraft.length === 0
          ? 'The source responded successfully with no aircraft observations in this region.'
          : summary.stale > 0
            ? 'Some position observations are stale. A connected feed does not make them current.'
            : !state.snapshot
              ? 'Waiting for the first validated observation snapshot.'
              : undefined;
  const notice = status ? (
    <p className="feed-notice" role="status">
      {status}
      {!paused && state.health && state.health.status !== 'live' && (
        <>
          <br />
          {state.health.message}
          {state.health.retryAt && (
            <>
              {' '}
              Next shared attempt no earlier than <Timestamp value={state.health.retryAt} />.
            </>
          )}
        </>
      )}
    </p>
  ) : undefined;
  const feedStatus = paused ? 'Paused' : phaseLabels[state.health?.status ?? state.phase];
  const evidenceStrip = (
    <section className="live-evidence-strip" aria-label="Live session evidence">
      <p className="section-label">Live evidence</p>
      <dl>
        <div>
          <dt>Source</dt>
          <dd>{state.binding?.providerId ?? 'Awaiting verified feed'}</dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{transportLabel}</dd>
        </div>
        <div>
          <dt>Feed state</dt>
          <dd>{feedStatus}</dd>
        </div>
        <div>
          <dt>Backend receipt age</dt>
          <dd>{receiptAgeText(state)}</dd>
        </div>
        <div>
          <dt>Observations</dt>
          <dd>
            {summary.observed} received, {summary.positioned} positioned
          </dd>
        </div>
        <div>
          <dt>Feed epoch</dt>
          <dd>
            {state.binding ? (
              <span className="feed-epoch" title={state.binding.feedEpoch}>
                <span className="sr-only">{state.binding.feedEpoch}</span>
                <span aria-hidden="true">{shortenedEpoch(state.binding.feedEpoch)}</span>
              </span>
            ) : (
              'Not established'
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
  return (
    <AirspaceInvestigationView
      {...shared}
      state={state}
      presentation={{
        sectionLabel: 'Regional observation workspace',
        title: `${region.label} airspace`,
        subtitle: `${region.radiusNauticalMiles} nautical-mile region · received observations only`,
        controls: (
          <>
            <span
              className="transport-status"
              data-transport={paused ? 'stopped' : state.transport}
            >
              {transportLabel}
            </span>
            <button type="button" onClick={onPause}>
              {paused ? 'Resume feed' : 'Pause feed'}
            </button>
            <button type="button" className="quiet-button" onClick={onReconnect} disabled={paused}>
              Reconnect
            </button>
          </>
        ),
        beforeFilters: evidenceStrip,
        ...(notice ? { notice } : {}),
        regionLabel: 'Region',
        emptyWaiting:
          'A validated response and measured time reference are needed before showing current evidence.',
        emptySource: 'An empty response is valid. The feed will continue checking this region.',
        emptyFiltered:
          'Adjust the filters or wait for more observations. Contacts older than two minutes are removed.',
        footerPrimary: 'Current ≤ 15 s · delayed ≤ 45 s · stale < 120 s',
        footerSecondary: 'Ages use a conservative server-time estimate, not your device clock.',
      }}
    />
  );
}
