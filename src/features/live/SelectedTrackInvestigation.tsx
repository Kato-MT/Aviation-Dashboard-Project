import { aircraftEvidence } from '../../live/freshness';
import type { LiveEvidenceSelection } from '../../live/history';
import {
  buildHistoryReceiptRows,
  buildSessionSeries,
  describeHistoryIssues,
  resolveHistorySample,
} from '../../live/historyPresentation';
import { aircraftIdentifier } from '../../live/presentation';
import type { LiveSessionState } from '../../live/session';
import type { AircraftState } from '../../live/types';
import { HistoryEvidenceTable } from './HistoryEvidenceTable';
import { LiveHistoryCharts } from './LiveHistoryCharts';
import { SessionQualityLedger } from './SessionQualityLedger';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const freshnessLabels = {
  current: 'Current',
  delayed: 'Delayed',
  stale: 'Stale',
  expired: 'Expired',
  missing: 'No position',
  'time-uncertain': 'Time uncertain',
};

function measurement(value: number | undefined, unit = ''): string {
  return value === undefined ? 'Unknown' : `${number.format(value)}${unit ? ` ${unit}` : ''}`;
}

function Timestamp({ value }: { value?: string | undefined }) {
  return value ? (
    <time dateTime={value}>{value.replace('T', ' ').replace('Z', ' UTC')}</time>
  ) : (
    <>Unknown</>
  );
}

interface Props {
  aircraft: AircraftState | undefined;
  state: LiveSessionState;
  onSelect(selection?: LiveEvidenceSelection): void;
}

export function SelectedTrackInvestigation({ aircraft, state, onSelect }: Props) {
  const aircraftId = state.selectedAircraftId;
  const history = aircraftId ? state.histories.get(aircraftId) : undefined;
  if (!aircraftId)
    return (
      <aside className="selection-panel" aria-label="Selected track investigation">
        <p className="section-label">Track investigation</p>
        <h2>Select an aircraft</h2>
        <p>
          Choose an aircraft on the map or in the table to inspect its received trail, independent
          timestamps and bounded session measurements.
        </p>
        <div className="evidence-explainer">
          <h3>Received, not predicted</h3>
          <p>Positions are observations. The interface does not invent movement between updates.</p>
          <h3>Session-only evidence</h3>
          <p>History stays in this browser session for at most 15 minutes and is not persisted.</p>
        </div>
        <SessionQualityLedger events={state.qualityEvents} />
      </aside>
    );

  const sample = resolveHistorySample(history, state.selectedHistorySequence);
  const exactReceiptUnavailable = state.selectedHistorySequence !== undefined && !sample;
  const altitude = buildSessionSeries(history, 'barometricAltitudeFeet');
  const speed = buildSessionSeries(history, 'groundSpeedKnots');
  const rows = buildHistoryReceiptRows(history);
  const issues = describeHistoryIssues(history?.incompleteReasons ?? []);
  const currentEvidence = aircraft ? aircraftEvidence(aircraft, state.time) : undefined;
  const selectSequence = (sequence: number) => {
    if (!state.binding) return;
    onSelect({
      mode: 'exact',
      key: { aircraftId, sequence, ...state.binding },
    });
  };

  return (
    <aside className="selection-panel" aria-labelledby="selected-title">
      <div className="selection-heading">
        <p className="section-label">Selected track investigation</p>
        <button type="button" className="quiet-button" onClick={() => onSelect()}>
          Close selected track
        </button>
      </div>
      <h2 id="selected-title">
        {aircraft ? aircraftIdentifier(aircraft) : aircraftId.toUpperCase()}
      </h2>
      <p className="identifier">
        {aircraftId.toUpperCase()}
        {aircraft ? ` · ${aircraft.identifierKind}` : ' · no longer in the current snapshot'}
      </p>
      {currentEvidence ? (
        <span className="freshness" data-freshness={currentEvidence.position.freshness}>
          Latest regional track: {freshnessLabels[currentEvidence.position.freshness]}
        </span>
      ) : (
        <p className="departure-note">
          This track is not in the current regional picture. Only bounded historical receipts are
          shown below.
        </p>
      )}

      <section className="receipt-inspection" aria-labelledby="receipt-inspection-title">
        <div className="investigation-section-heading">
          <h3 id="receipt-inspection-title">
            {state.selectedHistorySequence === undefined
              ? 'Latest retained receipt'
              : `Exact receipt #${state.selectedHistorySequence}`}
          </h3>
          {state.selectedHistorySequence !== undefined && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => onSelect({ mode: 'latest', aircraftId })}
            >
              Follow latest
            </button>
          )}
        </div>
        {exactReceiptUnavailable ? (
          <p role="status">
            This exact receipt is no longer retained. The selection was not moved to another time.
          </p>
        ) : sample ? (
          <>
            <dl
              className="selected-measurements"
              aria-label={
                state.selectedHistorySequence === undefined
                  ? 'Latest retained receipt measurements'
                  : `Exact receipt ${state.selectedHistorySequence} measurements`
              }
            >
              <div className="measurement-primary">
                <dt>Barometric altitude</dt>
                <dd>{measurement(sample.measurements?.barometricAltitudeFeet, 'ft')}</dd>
              </div>
              <div className="measurement-primary">
                <dt>Ground speed</dt>
                <dd>{measurement(sample.measurements?.groundSpeedKnots, 'kt')}</dd>
              </div>
              <div className="measurement-primary">
                <dt>Vertical rate</dt>
                <dd>{measurement(sample.measurements?.verticalRateFeetPerMinute, 'ft/min')}</dd>
              </div>
              <div>
                <dt>Ground state</dt>
                <dd>
                  {sample.measurements?.onGround === undefined ||
                  sample.measurements.onGround === null
                    ? 'Unknown'
                    : sample.measurements.onGround
                      ? 'On ground'
                      : 'Airborne'}
                </dd>
              </div>
              <div>
                <dt>Latitude</dt>
                <dd>{sample.position?.latitude.toFixed(4) ?? 'Unknown'}</dd>
              </div>
              <div>
                <dt>Longitude</dt>
                <dd>{sample.position?.longitude.toFixed(4) ?? 'Unknown'}</dd>
              </div>
            </dl>
            <dl className="timing-evidence">
              <div>
                <dt>Backend receipt</dt>
                <dd>
                  <Timestamp value={sample.receivedAt} />
                </dd>
              </div>
              <div>
                <dt>Provider snapshot</dt>
                <dd>
                  <Timestamp value={sample.providerGeneratedAt} />
                </dd>
              </div>
              <div>
                <dt>Position observed</dt>
                <dd>
                  <Timestamp value={sample.position?.observedAt} />
                </dd>
              </div>
              <div>
                <dt>Measurements observed</dt>
                <dd>
                  <Timestamp value={sample.measurements?.observedAt} />
                </dd>
              </div>
            </dl>
            <p className="muted">
              Position and measurements share this backend receipt. Their separate source times do
              not claim they were observed simultaneously.
            </p>
          </>
        ) : (
          <p>No retained receipt evidence is available for this selected track.</p>
        )}
      </section>

      <SessionQualityLedger events={state.qualityEvents} />

      <section className="session-history" aria-labelledby="session-history-title">
        <div className="investigation-section-heading">
          <h3 id="session-history-title">Current browser session</h3>
          <span>{rows.length} receipts</span>
        </div>
        <p className="muted">
          Straight segments connect received measurements only. Visible breaks are preserved and no
          value is filled forward.
        </p>
        <LiveHistoryCharts
          altitude={altitude}
          speed={speed}
          selectedSequence={sample?.sequence}
          selectedMeasurementObservedAt={sample?.measurements?.observedAt}
          onSelectSequence={selectSequence}
        />
      </section>

      {issues.length > 0 && (
        <section className="history-limitations" aria-labelledby="history-limitations-title">
          <h3 id="history-limitations-title">History limitations</h3>
          <ul>
            {issues.map((entry) => (
              <li key={entry.code}>{entry.message}</li>
            ))}
          </ul>
        </section>
      )}

      <HistoryEvidenceTable
        rows={rows}
        selectedSequence={sample?.sequence}
        onSelectSequence={selectSequence}
      />
      <p className="muted investigation-boundary">
        Unknown values remain unknown. This view does not infer a route, schedule, destination,
        owner, aircraft health or future position.
      </p>
    </aside>
  );
}
