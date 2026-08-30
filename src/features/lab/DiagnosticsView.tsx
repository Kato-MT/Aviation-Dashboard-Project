import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { exportFindingsCsv } from '../../export';
import { DECLARED_FAULT_SCENARIOS, getFaultScenario } from '../../faults';
import { downloadText, formatObserved, slug } from '../../ui/dom';
import {
  diagnosticsFilterOptions,
  diagnosticsFindingPage,
  filterDiagnosticsFindings,
  hasActiveDiagnosticsFilters,
} from './diagnostics';
import { MAX_FAULT_SEED, type LabSession, type LabSessionState } from './session';
import type { LabSubview } from './routes';

const DISPLAY_LIMIT = 100;

export function DiagnosticsView({
  state,
  session,
  onNavigate,
}: {
  state: LabSessionState;
  session: LabSession;
  onNavigate: (subview: LabSubview) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      session.cancelFaultCandidate();
    };
  }, [session]);
  const current = state.current;
  const findings = current?.analysis.findings ?? [];
  const filterOptions = useMemo(() => diagnosticsFilterOptions(findings), [findings]);
  const deferredSearch = useDeferredValue(state.diagnosticsFilters.search);
  const filteredFindings = useMemo(
    () =>
      filterDiagnosticsFindings(findings, {
        ...state.diagnosticsFilters,
        search: deferredSearch,
      }),
    [
      deferredSearch,
      findings,
      state.diagnosticsFilters.ruleId,
      state.diagnosticsFilters.severity,
      state.diagnosticsFilters.sourceId,
    ],
  );
  const queryKey = [
    current?.run.runId ?? 'none',
    current?.run.provenance.datasetSha256 ?? 'none',
    state.diagnosticsFilters.severity,
    state.diagnosticsFilters.ruleId,
    state.diagnosticsFilters.sourceId,
    deferredSearch,
  ].join('\u0000');
  const [requestedPage, setRequestedPage] = useState({ queryKey, pageIndex: 0 });
  const page = diagnosticsFindingPage(
    filteredFindings,
    requestedPage.queryKey === queryKey ? requestedPage.pageIndex : 0,
    DISPLAY_LIMIT,
  );
  const filtersActive = hasActiveDiagnosticsFilters(state.diagnosticsFilters);
  const scenario = getFaultScenario(state.faultScenarioId) ?? DECLARED_FAULT_SCENARIOS[0];
  const sourceCompatible = scenario.target !== 'legacy-csv' || current?.inputFormat === 'csv';
  const canCreateCandidate = Boolean(
    current &&
    !current.run.fatal &&
    !current.analysis.blocked &&
    current.run.samples.length > 0 &&
    sourceCompatible &&
    state.faultStatus !== 'injecting',
  );
  const resultMessage = !current
    ? 'Load telemetry to run diagnostics.'
    : findings.length === 0
      ? 'This analysis has no findings.'
      : filteredFindings.length === 0
        ? 'No findings match the active filters.'
        : `${filteredFindings.length} of ${findings.length} findings match.`;

  return (
    <div className="lab-diagnostics-view">
      <div className="lab-section-heading lab-diagnostics-heading">
        <div>
          <p className="section-label">Evidence-backed fault isolation</p>
          <h2 id="diagnostics-title">Diagnostics</h2>
          <p>
            Filter deterministic findings, inspect containment, then create a reproducible
            candidate.
          </p>
        </div>
        <button
          type="button"
          disabled={!current}
          onClick={() => {
            if (!current) return;
            downloadText(
              `${slug(current.run.runId)}-findings.csv`,
              exportFindingsCsv(current.analysis.findings),
              'text/csv',
            );
          }}
        >
          Export all findings CSV
        </button>
      </div>

      <div className="lab-diagnostics-command-grid">
        <section className="lab-diagnostics-filters" aria-labelledby="diagnostics-filters-title">
          <div className="lab-finding-heading">
            <div>
              <p className="section-label">Rule-engine query</p>
              <h3 id="diagnostics-filters-title">Finding filters</h3>
            </div>
            <button
              type="button"
              className="quiet-button"
              disabled={!filtersActive}
              onClick={() => session.clearDiagnosticsFilters()}
            >
              Clear filters
            </button>
          </div>
          <div className="lab-diagnostics-filter-fields">
            <label>
              Severity
              <select
                value={state.diagnosticsFilters.severity}
                disabled={!current}
                onChange={(event) =>
                  session.setDiagnosticsFilters({
                    severity: event.target
                      .value as LabSessionState['diagnosticsFilters']['severity'],
                  })
                }
              >
                <option value="all">All severities</option>
                <option value="critical">Critical</option>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </label>
            <label>
              Rule
              <select
                value={state.diagnosticsFilters.ruleId}
                disabled={!current}
                onChange={(event) => session.setDiagnosticsFilters({ ruleId: event.target.value })}
              >
                <option value="all">All rules</option>
                {filterOptions.ruleIds.map((ruleId) => (
                  <option key={ruleId} value={ruleId}>
                    {ruleId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Source
              <select
                value={state.diagnosticsFilters.sourceId}
                disabled={!current}
                onChange={(event) =>
                  session.setDiagnosticsFilters({ sourceId: event.target.value })
                }
              >
                <option value="all">All sources</option>
                {filterOptions.sourceIds.map((sourceId) => (
                  <option key={sourceId} value={sourceId}>
                    {sourceId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Search evidence
              <input
                type="search"
                value={state.diagnosticsFilters.search}
                disabled={!current}
                placeholder="Timestamp, value, or evidence"
                onChange={(event) => session.setDiagnosticsFilters({ search: event.target.value })}
              />
            </label>
          </div>
          <p className="lab-diagnostics-result" role="status" aria-live="polite">
            {resultMessage}
          </p>
        </section>

        <section className="lab-fault-builder" aria-labelledby="fault-builder-title">
          <p className="section-label">Deterministic test stimulus</p>
          <h3 id="fault-builder-title">Create and verify a candidate</h3>
          <p>
            The current run becomes the captured baseline. Candidate publication is atomic and the
            original source remains unchanged.
          </p>
          <label>
            Declared scenario
            <select
              value={state.faultScenarioId}
              disabled={!current || state.faultStatus === 'injecting'}
              onChange={(event) => session.setFaultScenario(event.target.value)}
            >
              {DECLARED_FAULT_SCENARIOS.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Deterministic seed
            <input
              type="number"
              min={1}
              max={MAX_FAULT_SEED}
              step={1}
              inputMode="numeric"
              value={state.faultSeed}
              disabled={!current || state.faultStatus === 'injecting'}
              onChange={(event) => session.setFaultSeed(event.target.value)}
            />
          </label>
          <div className="lab-fault-description" id="fault-scenario-description">
            <p>{scenario.description}</p>
            <p>
              Expected evidence:{' '}
              {scenario.expectedRuleIds.map((ruleId, index) => (
                <span key={ruleId}>
                  {index > 0 ? ', ' : ''}
                  <code>{ruleId}</code>
                </span>
              ))}
              .
            </p>
            <p>
              Input boundary:{' '}
              {scenario.target === 'legacy-csv'
                ? 'legacy CSV row transformation'
                : 'canonical telemetry transformation'}
              .
            </p>
          </div>
          {!sourceCompatible && current && (
            <p className="lab-inline-warning">
              This scenario needs a legacy CSV source. Load the included baseline to enable it.
            </p>
          )}
          {state.faultIssue && (
            <p role="alert" className="lab-inline-error">
              {state.faultIssue}
            </p>
          )}
          <button
            type="button"
            className="lab-primary-action"
            disabled={!canCreateCandidate}
            aria-describedby="fault-scenario-description"
            onClick={() => {
              void session.createFaultCandidate().then((created) => {
                if (created && mounted.current) onNavigate('verification');
              });
            }}
          >
            {state.faultStatus === 'injecting'
              ? 'Creating candidate...'
              : 'Create candidate and verify'}
          </button>
        </section>
      </div>

      <div className="lab-diagnostics-evidence-grid">
        <section className="lab-diagnostics-findings" aria-labelledby="diagnostic-findings-title">
          <div className="lab-finding-heading">
            <div>
              <p className="section-label">Filtered rule evidence</p>
              <h3 id="diagnostic-findings-title">
                Findings <span>{filteredFindings.length}</span>
              </h3>
            </div>
            {page.pageCount > 1 && (
              <span className="muted">
                Page {page.pageIndex + 1} of {page.pageCount}
              </span>
            )}
          </div>
          {filteredFindings.length === 0 ? (
            <p className="lab-empty-state">{resultMessage}</p>
          ) : (
            <ol>
              {page.items.map((finding) => (
                <li key={finding.findingId}>
                  <div className="lab-finding-heading">
                    <div>
                      <h4>{finding.ruleLabel}</h4>
                      <code>{finding.ruleId}</code>
                    </div>
                    <span className="lab-severity" data-severity={finding.severity}>
                      {finding.severity}
                    </span>
                  </div>
                  <p>{finding.evidence.message}</p>
                  <dl>
                    <div>
                      <dt>Source and time</dt>
                      <dd>
                        {finding.sourceId} ·{' '}
                        {finding.timestamp ?? `row ${finding.rowNumber ?? 'unknown'}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Observed</dt>
                      <dd>{formatObserved(finding.observedValue)}</dd>
                    </div>
                    <div>
                      <dt>Expected</dt>
                      <dd>{finding.expectedCondition}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="quiet-button"
                    disabled={finding.sampleIndex === undefined}
                    onClick={() => {
                      session.seekFinding(finding);
                      onNavigate('monitor');
                    }}
                  >
                    {finding.sampleIndex === undefined
                      ? 'No accepted sample to inspect'
                      : `Inspect sample ${finding.sampleIndex + 1} in Monitor`}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {page.pageCount > 1 && (
            <nav className="lab-diagnostics-pagination" aria-label="Diagnostic finding pages">
              <p aria-live="polite">
                Showing {page.firstItem} through {page.lastItem} of {filteredFindings.length}{' '}
                matching findings.
              </p>
              <div>
                <button
                  type="button"
                  disabled={page.pageIndex === 0}
                  onClick={() => setRequestedPage({ queryKey, pageIndex: page.pageIndex - 1 })}
                >
                  Previous findings
                </button>
                <button
                  type="button"
                  disabled={page.pageIndex >= page.pageCount - 1}
                  onClick={() => setRequestedPage({ queryKey, pageIndex: page.pageIndex + 1 })}
                >
                  Next findings
                </button>
              </div>
            </nav>
          )}
        </section>

        <section className="lab-quarantine-evidence" aria-labelledby="quarantine-evidence-title">
          <p className="section-label">Validation containment</p>
          <h3 id="quarantine-evidence-title">
            Quarantined rows <span>{current?.run.quarantinedRows.length ?? 0}</span>
          </h3>
          <p>
            Invalid rows never enter accepted-sample analysis. Raw values remain local and are not
            displayed here.
          </p>
          {!current || current.run.quarantinedRows.length === 0 ? (
            <p className="lab-empty-state">No quarantined rows.</p>
          ) : (
            <ol>
              {current.run.quarantinedRows.slice(0, DISPLAY_LIMIT).map((row) => (
                <li key={`${row.rowNumber}-${row.sourceId ?? 'unknown'}`}>
                  <strong>
                    Row {row.rowNumber}
                    {row.sourceId ? ` · ${row.sourceId}` : ''}
                  </strong>
                  <p>{row.issues.map((issue) => issue.message).join(' ')}</p>
                  <p className="identifier">{row.issues.map((issue) => issue.code).join(', ')}</p>
                </li>
              ))}
            </ol>
          )}
          {(current?.run.quarantinedRows.length ?? 0) > DISPLAY_LIMIT && (
            <p className="muted">
              {(current?.run.quarantinedRows.length ?? 0) - DISPLAY_LIMIT} additional rows remain in
              the source-minimized JSON report.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
