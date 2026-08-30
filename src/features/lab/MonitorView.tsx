import { exportFindingsCsv, serializeDiagnosticReport } from '../../export';
import { downloadText, formatNumber, formatObserved, slug } from '../../ui/dom';
import { LabCharts } from './LabCharts';
import type { LabSession, LabSessionState } from './session';

export function MonitorView({ state, session }: { state: LabSessionState; session: LabSession }) {
  const includeSourceData = state.includeSourceData;
  const current = state.current;
  if (!current) return null;
  const { run, analysis } = current;
  const sample = run.samples[state.replayIndex];
  const enabled = run.samples.length > 0;
  const quantity = (value: number | undefined, unit: string) =>
    value === undefined ? 'Unknown' : `${formatNumber(value)} ${unit}`;
  return (
    <>
      <section className="lab-monitor" aria-labelledby="monitor-title">
        <div className="lab-section-heading">
          <h2 id="monitor-title">Telemetry monitor</h2>
          <p>Local samples, not live aircraft health.</p>
        </div>
        <div className="lab-replay-controls" role="group" aria-label="Synthetic sample replay">
          <button
            type="button"
            onClick={() => session.startReplay()}
            disabled={!enabled || state.replayPlaying}
          >
            Start replay
          </button>
          <button
            type="button"
            onClick={() => session.pauseReplay()}
            disabled={!state.replayPlaying}
          >
            Pause replay
          </button>
          <button type="button" onClick={() => session.setReplayIndex(0)} disabled={!enabled}>
            Reset replay
          </button>
          <label>
            Replay pace
            <select
              value={state.replayInterval}
              onChange={(event) => session.setReplayInterval(Number(event.target.value))}
              disabled={!enabled || state.replayPlaying}
            >
              <option value={600}>Slow · 600 ms/sample</option>
              <option value={300}>Normal · 300 ms/sample</option>
              <option value={150}>Fast · 150 ms/sample</option>
            </select>
          </label>
        </div>
        <label className="lab-replay-slider">
          Selected sample{' '}
          <span id="lab-replay-position">
            {enabled ? state.replayIndex + 1 : 0} / {run.samples.length}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, run.samples.length - 1)}
            value={state.replayIndex}
            disabled={!enabled}
            onChange={(event) => session.scrub(Number(event.target.value))}
            aria-valuetext={`Sample ${enabled ? state.replayIndex + 1 : 0} of ${run.samples.length}`}
          />
        </label>
        <p className="muted">
          Replay advances by sample at the chosen pace, not by recorded time gaps. Scrubbing pauses
          playback.
        </p>
        <dl className="lab-sample-evidence">
          <div>
            <dt>Source timestamp</dt>
            <dd>{sample?.originalTimestamp ?? sample?.timestamp ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{sample?.sourceId ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Altitude</dt>
            <dd>{quantity(sample?.measurements.altitude, 'ft')}</dd>
          </div>
          <div>
            <dt>Airspeed</dt>
            <dd>{quantity(sample?.measurements.speed ?? sample?.measurements.airspeed, 'kt')}</dd>
          </div>
          <div>
            <dt>Fuel</dt>
            <dd>{quantity(sample?.measurements.fuel, '%')}</dd>
          </div>
          <div>
            <dt>Quality flags</dt>
            <dd>{sample?.qualityFlags.join(', ') || 'Unknown'}</dd>
          </div>
        </dl>
        <LabCharts samples={run.samples} findings={analysis.findings} cursor={state.replayIndex} />
      </section>
      <section className="lab-findings" aria-labelledby="lab-findings-title">
        <div className="lab-section-heading">
          <h2 id="lab-findings-title">Diagnostic findings</h2>
          <p>
            {analysis.findings.length} findings from deterministic synthetic rules and input
            validation.
          </p>
        </div>
        {analysis.findings.length === 0 ? (
          <p>No findings in this analysis.</p>
        ) : (
          <ol>
            {analysis.findings.slice(0, 100).map((finding) => (
              <li key={finding.findingId}>
                <div className="lab-finding-heading">
                  <h3>{finding.ruleLabel}</h3>
                  <span className="lab-severity" data-severity={finding.severity}>
                    {finding.severity}
                  </span>
                </div>
                <p>{finding.evidence.message}</p>
                <div className="lab-finding-actions">
                  <span className="identifier">{finding.ruleId}</span>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={finding.sampleIndex === undefined}
                    onClick={() => session.seekFinding(finding)}
                  >
                    Inspect sample{' '}
                    {finding.sampleIndex === undefined ? '' : finding.sampleIndex + 1}
                  </button>
                </div>
                <details>
                  <summary>Finding evidence</summary>
                  <dl className="lab-finding-evidence">
                    <div>
                      <dt>Observed</dt>
                      <dd>{formatObserved(finding.observedValue)}</dd>
                    </div>
                    <div>
                      <dt>Expected condition</dt>
                      <dd>{finding.expectedCondition}</dd>
                    </div>
                    <div>
                      <dt>Timestamp</dt>
                      <dd>{finding.timestamp ?? 'Not present'}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{finding.sourceId}</dd>
                    </div>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        )}
        {analysis.findings.length > 100 && (
          <p>
            Showing the first 100 findings. The findings export contains all{' '}
            {analysis.findings.length}.
          </p>
        )}
      </section>
      {(run.validationIssues.length > 0 || run.quarantinedRows.length > 0) && (
        <section className="lab-validation" aria-labelledby="validation-title">
          <h2 id="validation-title">Input validation evidence</h2>
          <p>
            {run.quarantinedRows.length} quarantined rows, excluded from accepted samples. Raw
            values remain local and are omitted from exports by default.
          </p>
          <ul>
            {run.validationIssues.slice(0, 100).map((issue, index) => (
              <li key={index}>
                <strong>{issue.code}</strong>: {issue.message}
              </li>
            ))}
          </ul>
          {run.validationIssues.length > 100 && (
            <p>Showing the first 100 issues. The diagnostic report includes every issue.</p>
          )}
        </section>
      )}
      <section className="lab-exports" aria-labelledby="lab-exports-title">
        <h2 id="lab-exports-title">Export local evidence</h2>
        <p>
          Findings and versioned reports preserve provenance. Source samples and raw quarantined
          rows are excluded unless explicitly selected.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={includeSourceData}
            onChange={(event) => session.setSourceExport(event.target.checked)}
          />
          Include source samples and raw rows in the JSON report
        </label>
        <div className="lab-export-actions">
          <button
            type="button"
            onClick={() =>
              downloadText(
                `${slug(run.runId)}-findings.csv`,
                exportFindingsCsv(analysis.findings),
                'text/csv',
              )
            }
          >
            Export findings CSV
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                `${slug(run.runId)}-diagnostic-report.json`,
                serializeDiagnosticReport(run, analysis, state.verification, { includeSourceData }),
                'application/json',
              )
            }
          >
            Export diagnostic JSON
          </button>
        </div>
      </section>
    </>
  );
}
