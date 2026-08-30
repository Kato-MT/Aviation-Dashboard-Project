import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { detectionProfiles } from '../../profiles';
import { LabSession } from './session';
import type { LabSessionOwner } from './owner';
import { MonitorView } from './MonitorView';
import { labSubviewMetadata, type LabSubview } from './routes';
import { VerificationView } from './VerificationView';
import { DiagnosticsView } from './DiagnosticsView';
import { ConfigurationView } from './ConfigurationView';
import { InvestigationView } from './InvestigationView';
import { CampaignView } from './CampaignView';
import type { EvidenceBuildIdentity } from '../../evidence/types';
import './lab.css';

const defaultSessionFactory = () => new LabSession();
const subviews = Object.keys(labSubviewMetadata) as LabSubview[];

function navigateToLabSubview(subview: LabSubview) {
  const oldURL = location.href;
  history.pushState({}, '', labSubviewMetadata[subview].hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

function LabSubviewTabs({ subview }: { subview: LabSubview }) {
  const tabs = useRef<Array<HTMLAnchorElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (index + 1) % subviews.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + subviews.length) % subviews.length;
    }
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = subviews.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    navigateToLabSubview(subviews[next]!);
  };
  return (
    <div className="lab-subview-tabs" role="tablist" aria-label="Diagnostics Lab workflows">
      {subviews.map((key, index) => {
        const metadata = labSubviewMetadata[key];
        const selected = subview === key;
        return (
          <a
            key={key}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            id={metadata.tabId}
            href={metadata.hash}
            role="tab"
            aria-controls={metadata.panelId}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {metadata.label}
          </a>
        );
      })}
    </div>
  );
}

export function LabApp({
  createSession = defaultSessionFactory,
  owner,
  subview = 'monitor',
  buildIdentity,
  legacyOracleHref = './v2.html',
}: {
  createSession?: () => LabSession;
  owner?: LabSessionOwner;
  subview?: LabSubview;
  buildIdentity?: Readonly<EvidenceBuildIdentity> | undefined;
  legacyOracleHref?: string | null;
}) {
  const [session] = useState(() => (owner ? owner.acquire(createSession) : createSession()));
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useEffect(() => {
    void session.start();
    const hide = () => session.stop();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) void session.start();
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      session.stop();
    };
  }, [session]);
  useEffect(() => {
    if (subview !== 'monitor') session.pauseReplay();
    if (subview !== 'investigation') session.leaveInvestigation('Investigation closed');
    if (subview !== 'campaign') session.leaveCampaign('Campaign closed');
  }, [session, subview]);
  const current = state.current;
  return (
    <main id="lab-main" tabIndex={-1}>
      <div className="source-banner" role="note">
        <strong>Synthetic Diagnostics Lab</strong>
        <span>
          Local test telemetry and deterministic rules. Separate from public aircraft surveillance.
        </span>
      </div>
      <section className="workspace-heading" aria-labelledby="lab-title">
        <div>
          <p className="section-label">Local analysis workspace</p>
          <h1 id="lab-title">Diagnostics Lab</h1>
          <p>Import, validate, inspect and replay synthetic telemetry.</p>
        </div>
        <span className="development-label">
          React Monitor + Diagnostics + Verification + Investigation + Campaign + Configuration
          preview
        </span>
      </section>
      <form
        className="lab-inputs"
        aria-label="Synthetic telemetry input"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="lab-load-actions">
          <button type="button" onClick={() => void session.loadIncludedBaseline()}>
            Load included baseline
          </button>
          <button type="button" onClick={() => void session.loadGeneratedDemo()}>
            Generate synthetic demo
          </button>
          <button type="button" className="quiet-button" onClick={() => session.clear()}>
            Clear Lab session
          </button>
        </div>
        <label>
          Import synthetic CSV or JSON
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void session.loadFile(file);
            }}
          />
          <span className="muted">10 MiB maximum. Files are parsed locally, not uploaded.</span>
        </label>
        <label>
          Detection profile
          <select
            value={state.profile.id}
            onChange={(event) => session.setProfile(event.target.value)}
          >
            {detectionProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      </form>
      <p
        className="lab-message"
        data-status={state.status}
        role={state.status === 'error' || state.status === 'blocked' ? 'alert' : 'status'}
      >
        {state.message || 'Choose a synthetic dataset to begin.'}
      </p>
      <section className="lab-run-summary" aria-labelledby="lab-run-title">
        <h2 id="lab-run-title">{current?.label ?? 'No telemetry loaded'}</h2>
        <p>
          {state.profile.label}
          {current ? ` · ${current.run.adapterId}@${current.run.adapterVersion}` : ''}
        </p>
        <dl className="lab-run-statistics">
          <div>
            <dt>Accepted samples</dt>
            <dd id="metric-accepted">{current?.run.samples.length ?? 0}</dd>
          </div>
          <div>
            <dt>Quarantined rows</dt>
            <dd id="metric-quarantined">{current?.run.quarantinedRows.length ?? 0}</dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd id="metric-findings">{current?.analysis.findings.length ?? 0}</dd>
          </div>
          <div>
            <dt>Dataset SHA-256</dt>
            <dd id="metric-hash">
              {current?.run.provenance.datasetSha256.slice(0, 8) ?? 'Not available'}
            </dd>
          </div>
        </dl>
        {current && (
          <details>
            <summary>Run provenance</summary>
            <dl className="lab-provenance">
              <div>
                <dt>Full dataset SHA-256</dt>
                <dd>{current.run.provenance.datasetSha256}</dd>
              </div>
              <div>
                <dt>Schema</dt>
                <dd>{current.run.schemaVersion}</dd>
              </div>
              <div>
                <dt>Baseline captured</dt>
                <dd>
                  {state.baseline?.run.provenance.datasetSha256 ===
                  current.run.provenance.datasetSha256
                    ? 'This dataset is the captured baseline'
                    : state.baseline
                      ? 'A previous baseline remains captured'
                      : 'No baseline captured'}
                </dd>
              </div>
            </dl>
          </details>
        )}
      </section>
      <LabSubviewTabs subview={subview} />
      {subviews.map((key) => {
        const metadata = labSubviewMetadata[key];
        const selected = key === subview;
        return (
          <section
            key={key}
            id={metadata.panelId}
            role="tabpanel"
            aria-labelledby={metadata.tabId}
            hidden={!selected}
            tabIndex={0}
          >
            {selected && key === 'monitor' && current && (
              <MonitorView
                key={current.run.runId + current.run.provenance.datasetSha256}
                state={state}
                session={session}
              />
            )}
            {selected && key === 'diagnostics' && (
              <DiagnosticsView state={state} session={session} onNavigate={navigateToLabSubview} />
            )}
            {selected && key === 'verification' && (
              <VerificationView state={state} session={session} />
            )}
            {selected && key === 'investigation' && (
              <InvestigationView state={state} session={session} buildIdentity={buildIdentity} />
            )}
            {selected && key === 'campaign' && (
              <CampaignView state={state} session={session} buildIdentity={buildIdentity} />
            )}
            {selected && key === 'configuration' && (
              <ConfigurationView state={state} session={session} buildIdentity={buildIdentity} />
            )}
          </section>
        );
      })}
      <section className="lab-migration-note">
        <h2>{legacyOracleHref ? 'Preserved full Lab' : 'Self-contained React Lab'}</h2>
        {legacyOracleHref ? (
          <>
            <p>
              Monitor, Diagnostics, Verification, Investigation, Campaign and Configuration are
              React-owned migration checkpoints. The existing offline Lab remains the regression
              oracle while the unified React artifact is completed.
            </p>
            <a href={legacyOracleHref}>Open the existing offline Lab</a>
          </>
        ) : (
          <p>
            Monitor, Diagnostics, Verification, Investigation, Campaign and Configuration are
            included in this self-contained React package. The separate v2 regression oracle is not
            bundled or linked from this file.
          </p>
        )}
      </section>
    </main>
  );
}
