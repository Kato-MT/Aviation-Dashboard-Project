import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_AIRCRAFT_FILTERS,
  type AircraftSortField,
  type SortDirection,
} from '../../live/presentation';
import type { LiveEvidenceSelection } from '../../live/history';
import {
  BUNDLED_REPLAY_SCENARIOS,
  loadBundledReplayScenario,
  ReplayRuntime,
  type ReplayRuntimeState,
  type ReplayScenarioId,
  type ReplayScenarioMetadata,
  type ReplaySpeed,
  type ValidatedReplayManifest,
} from '../../replay';
import { AirspaceInvestigationView } from '../live/AirspaceView';
import './replay.css';

type ScenarioLoader = (id: ReplayScenarioId, seed?: number) => Promise<ValidatedReplayManifest>;
type RuntimeFactory = (manifest: ValidatedReplayManifest) => ReplayRuntime;

export interface ReplayAppProps {
  scenarios?: readonly ReplayScenarioMetadata[];
  loadScenario?: ScenarioLoader;
  createRuntime?: RuntimeFactory;
  initialScenarioId?: ReplayScenarioId;
}

interface ScenarioRequest {
  id: ReplayScenarioId;
  seed: number;
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.floor(valueMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function replayStatus(state: ReplayRuntimeState): string {
  if (state.ended) return 'Complete';
  return state.playing ? `Playing ${state.speed}x` : 'Paused';
}

function useReplayRuntime(runtime: ReplayRuntime): ReplayRuntimeState {
  const subscribe = useCallback((notify: () => void) => runtime.subscribe(notify), [runtime]);
  return useSyncExternalStore(subscribe, runtime.getState, runtime.getState);
}

function ReplayWorkspace({
  runtime,
  scenarios,
  request,
  onRequest,
}: {
  runtime: ReplayRuntime;
  scenarios: readonly ReplayScenarioMetadata[];
  request: ScenarioRequest;
  onRequest(value: ScenarioRequest): void;
}) {
  const state = useReplayRuntime(runtime);
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_AIRCRAFT_FILTERS }));
  const [sortField, setSortField] = useState<AircraftSortField>('identifier');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const [draftScenario, setDraftScenario] = useState(request.id);
  const [draftSeed, setDraftSeed] = useState(String(request.seed));
  const manifest = state.manifest;
  const virtualAt = new Date(Date.parse(manifest.startAt) + state.positionMs).toISOString();
  const transcript = useMemo(
    () => new Map(state.transcript.map((entry) => [entry.eventIndex, entry])),
    [state.transcript],
  );

  useEffect(() => {
    const stop = () => runtime.stop();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      runtime.stop();
    };
  }, [runtime]);

  const select = (selection?: LiveEvidenceSelection) => {
    if (!selection) runtime.selectAircraft();
    else if (selection.mode === 'latest') runtime.selectAircraft(selection.aircraftId);
    else {
      runtime.selectHistorySample(selection.key.aircraftId, selection.key.sequence, selection.key);
    }
  };

  const scenarioControls = (
    <>
      <section className="replay-configuration" aria-labelledby="replay-configuration-title">
        <div>
          <p className="section-label">Scenario identity</p>
          <h2 id="replay-configuration-title">Reproducible input</h2>
          <p>
            Changing the scenario or seed creates a new validated session and clears prior replay
            evidence.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const seed = Number(draftSeed);
            if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffff_ffff) return;
            onRequest({ id: draftScenario, seed });
          }}
        >
          <label>
            Scenario
            <select
              value={draftScenario}
              onChange={(event) => {
                const id = event.target.value as ReplayScenarioId;
                setDraftScenario(id);
                const metadata = scenarios.find((entry) => entry.id === id);
                if (metadata) setDraftSeed(String(metadata.defaultSeed));
              }}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input
              type="number"
              min="1"
              max="4294967295"
              step="1"
              value={draftSeed}
              onChange={(event) => setDraftSeed(event.target.value)}
            />
          </label>
          <button type="submit">Load scenario</button>
        </form>
        <dl className="replay-identity">
          <div>
            <dt>Fixture contract</dt>
            <dd>{manifest.schemaVersion}</dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd>{manifest.seed}</dd>
          </div>
          <div>
            <dt>Classification</dt>
            <dd>{manifest.provenance.classification.replaceAll('_', ' ')}</dd>
          </div>
          <div>
            <dt>Fixture SHA-256</dt>
            <dd title={manifest.provenance.canonicalSha256}>
              {manifest.provenance.canonicalSha256.slice(0, 16)}…
            </dd>
          </div>
        </dl>
      </section>

      <section className="replay-timeline" aria-labelledby="replay-timeline-title">
        <div className="replay-timeline-heading">
          <div>
            <p className="section-label">Virtual clock</p>
            <h2 id="replay-timeline-title">Scenario timeline and event evidence</h2>
          </div>
          <dl>
            <div>
              <dt>Position</dt>
              <dd>
                {formatDuration(state.positionMs)} / {formatDuration(manifest.durationMs)}
              </dd>
            </div>
            <div>
              <dt>Virtual UTC</dt>
              <dd>
                <time dateTime={virtualAt}>{virtualAt}</time>
              </dd>
            </div>
          </dl>
        </div>
        <div className="replay-scrubber">
          <label htmlFor="replay-position">Seek virtual time</label>
          <input
            id="replay-position"
            type="range"
            min="0"
            max={manifest.durationMs}
            step="1000"
            value={state.positionMs}
            onChange={(event) => runtime.seek(Number(event.target.value))}
          />
          <label>
            Playback speed
            <select
              value={state.speed}
              onChange={(event) => runtime.setSpeed(Number(event.target.value) as ReplaySpeed)}
            >
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
          </label>
        </div>
        <div
          className="replay-event-strip"
          role="region"
          aria-label="Replay event strip"
          tabIndex={0}
        >
          <ol>
            {manifest.events.map((event) => {
              const applied = transcript.get(event.index);
              const current = state.currentEvent?.eventIndex === event.index;
              return (
                <li key={event.index} data-outcome={applied?.outcome ?? 'pending'}>
                  <button
                    type="button"
                    aria-current={current ? 'step' : undefined}
                    onClick={() => runtime.seekEvent(event.index)}
                  >
                    <span>{formatDuration(event.offsetMs)}</span>
                    <strong>{event.label}</strong>
                    <small>{applied ? applied.outcome : 'pending'}</small>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <article className="replay-current-event" aria-labelledby="replay-current-event-title">
          <h3 id="replay-current-event-title">Current applied event</h3>
          {state.currentEvent ? (
            <>
              <strong>{state.currentEvent.label}</strong>
              <p>{state.currentEvent.description}</p>
              <span>
                {state.currentEvent.outcome} · expected {state.currentEvent.expectedDisposition} ·
                session {state.currentEvent.phaseAfter}
              </span>
            </>
          ) : (
            <p>No scenario event has been applied at this virtual time.</p>
          )}
        </article>
        <p className="sr-only" aria-live="polite">
          {state.currentEvent
            ? `${state.currentEvent.label}. ${state.currentEvent.outcome}. Session ${state.currentEvent.phaseAfter}.`
            : 'Replay is before the first scenario event.'}
        </p>
      </section>
    </>
  );

  const notice = (
    <p className="replay-notice">
      Virtual time <time dateTime={virtualAt}>{virtualAt}</time>.{' '}
      {state.currentEvent
        ? `${state.currentEvent.label}: ${state.currentEvent.description}`
        : 'No event has been applied yet.'}
    </p>
  );

  return (
    <>
      <div className="source-banner replay-source-banner" role="note">
        <strong>Synthetic Replay</strong>
        <span>
          Wholly fictional observations using reserved demo identities. No aircraft provider,
          catalog, health endpoint, or Live socket is used.
        </span>
      </div>
      <AirspaceInvestigationView
        state={state.session}
        filters={filters}
        sortField={sortField}
        sortDirection={sortDirection}
        onFilters={setFilters}
        onSort={(field) => {
          if (field === sortField) {
            setSortDirection((direction) =>
              direction === 'ascending' ? 'descending' : 'ascending',
            );
          } else {
            setSortField(field);
            setSortDirection('ascending');
          }
        }}
        onSelect={select}
        presentation={{
          sectionLabel: 'Deterministic airspace workspace',
          title: manifest.title,
          subtitle: `${manifest.description} · ${state.session.regionId} · seed ${manifest.seed}`,
          controls: (
            <>
              <span
                className="transport-status replay-playback-status"
                data-transport={state.playing ? 'open' : 'stopped'}
              >
                {replayStatus(state)}
              </span>
              <button
                type="button"
                onClick={() => (state.playing ? runtime.pause() : runtime.play())}
                disabled={state.ended}
              >
                {state.playing ? 'Pause replay' : 'Play replay'}
              </button>
              <button type="button" className="quiet-button" onClick={() => runtime.seek(0)}>
                Reset replay
              </button>
            </>
          ),
          beforeFilters: scenarioControls,
          notice,
          regionLabel: 'Scenario region',
          emptyWaiting: 'Seek to the first validated synthetic snapshot to show replay evidence.',
          emptySource: 'This synthetic event intentionally contains no aircraft observations.',
          emptyFiltered: 'Adjust the filters or seek to another synthetic event.',
          footerPrimary: 'Current ≤ 15 s · delayed ≤ 45 s · stale < 120 s',
          footerSecondary:
            'Ages use the exact virtual clock. Playback speed changes wall time only.',
        }}
      />
    </>
  );
}

const defaultRuntimeFactory: RuntimeFactory = (manifest) => new ReplayRuntime(manifest);

export function ReplayApp({
  scenarios = BUNDLED_REPLAY_SCENARIOS,
  loadScenario = loadBundledReplayScenario,
  createRuntime = defaultRuntimeFactory,
  initialScenarioId = 'provider-outage-recovery',
}: ReplayAppProps) {
  const initial = scenarios.find((scenario) => scenario.id === initialScenarioId) ?? scenarios[0];
  const [request, setRequest] = useState<ScenarioRequest>(() => ({
    id: initial?.id ?? 'provider-outage-recovery',
    seed: initial?.defaultSeed ?? 20_260_830,
  }));
  const [runtime, setRuntime] = useState<ReplayRuntime>();
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let ownedRuntime: ReplayRuntime | undefined;
    setRuntime(undefined);
    setError(false);
    void loadScenario(request.id, request.seed).then(
      (manifest) => {
        if (!active) return;
        try {
          ownedRuntime = createRuntime(manifest);
          setRuntime(ownedRuntime);
        } catch {
          setError(true);
        }
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
      ownedRuntime?.dispose();
    };
  }, [createRuntime, loadScenario, request]);

  return (
    <main id="replay-main" tabIndex={-1}>
      {runtime ? (
        <ReplayWorkspace
          key={runtime.manifest.provenance.canonicalSha256}
          runtime={runtime}
          scenarios={scenarios}
          request={request}
          onRequest={setRequest}
        />
      ) : (
        <section className="startup-state" role={error ? undefined : 'status'}>
          <p className="section-label">Synthetic Replay</p>
          <h1>{error ? 'Replay could not be validated' : 'Validating the bundled scenario'}</h1>
          <p>
            {error
              ? 'No replay state was created. Retry the same bundled fixture or open another workspace.'
              : 'Checking fixture identity, bounds, timestamps, synthetic provenance, and canonical digest.'}
          </p>
          {error && (
            <button type="button" onClick={() => setRequest((value) => ({ ...value }))}>
              Retry scenario validation
            </button>
          )}
        </section>
      )}
    </main>
  );
}
