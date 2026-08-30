import type { Finding, FindingClassification, VerificationRun } from '../../core';
import { serializeDiagnosticReport } from '../../export';
import { downloadText, formatObserved, slug } from '../../ui/dom';
import type { CapturedLabRun, LabSession, LabSessionState } from './session';

const DISPLAY_LIMIT = 50;

function RunEvidence({ captured, title }: { captured: CapturedLabRun | undefined; title: string }) {
  if (!captured) {
    return (
      <article className="lab-verification-run is-empty">
        <h3>{title}</h3>
        <p>No run captured.</p>
      </article>
    );
  }
  const { run, analysis, label } = captured;
  return (
    <article className="lab-verification-run">
      <div className="lab-finding-heading">
        <h3>{title}</h3>
        <span className="lab-run-state" data-blocked={analysis.blocked || undefined}>
          {analysis.blocked ? 'Analysis blocked' : 'Analysis complete'}
        </span>
      </div>
      <p>{label}</p>
      <dl>
        <div>
          <dt>Accepted</dt>
          <dd>{run.samples.length}</dd>
        </div>
        <div>
          <dt>Quarantined</dt>
          <dd>{run.quarantinedRows.length}</dd>
        </div>
        <div>
          <dt>Validation issues</dt>
          <dd>{run.validationIssues.length}</dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd>{analysis.findings.length}</dd>
        </div>
        <div>
          <dt>Schema</dt>
          <dd>{run.schemaVersion}</dd>
        </div>
        <div>
          <dt>Adapter</dt>
          <dd>
            {run.adapterId}@{run.adapterVersion}
          </dd>
        </div>
        <div>
          <dt>Profile</dt>
          <dd>
            {analysis.profileId}@{analysis.profileVersion}
          </dd>
        </div>
        <div className="lab-verification-hash">
          <dt>Dataset SHA-256</dt>
          <dd>{run.provenance.datasetSha256}</dd>
        </div>
      </dl>
    </article>
  );
}

function classificationFinding(
  classification: FindingClassification,
  kind: 'resolved' | 'persisting' | 'introduced',
): Finding | undefined {
  return kind === 'resolved' ? classification.baseline : classification.candidate;
}

function ClassificationGroup({
  title,
  kind,
  classifications,
}: {
  title: string;
  kind: 'resolved' | 'persisting' | 'introduced';
  classifications: readonly FindingClassification[];
}) {
  const visible = classifications.slice(0, DISPLAY_LIMIT);
  return (
    <section className="lab-classification-group" aria-labelledby={`classification-${kind}`}>
      <div className="lab-finding-heading">
        <h3 id={`classification-${kind}`}>{title}</h3>
        <span>{classifications.length}</span>
      </div>
      {visible.length === 0 ? (
        <p className="muted">No {title.toLowerCase()} findings.</p>
      ) : (
        <ol>
          {visible.map((classification) => {
            const finding = classificationFinding(classification, kind);
            if (!finding) return null;
            return (
              <li key={classification.fingerprint}>
                <div className="lab-finding-heading">
                  <h4>{finding.ruleLabel}</h4>
                  <span className="lab-severity" data-severity={finding.severity}>
                    {finding.severity}
                  </span>
                </div>
                <p>{finding.evidence.message}</p>
                <details>
                  <summary>Finding evidence</summary>
                  <dl>
                    <div>
                      <dt>Rule</dt>
                      <dd>{finding.ruleId}</dd>
                    </div>
                    <div>
                      <dt>Observed</dt>
                      <dd>{formatObserved(finding.observedValue)}</dd>
                    </div>
                    <div>
                      <dt>Expected</dt>
                      <dd>{finding.expectedCondition}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{finding.sourceId}</dd>
                    </div>
                    <div className="lab-verification-hash">
                      <dt>Stable fingerprint</dt>
                      <dd>{classification.fingerprint}</dd>
                    </div>
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      {classifications.length > DISPLAY_LIMIT && (
        <p className="muted">
          Showing the first {DISPLAY_LIMIT} of {classifications.length}. The minimized export
          contains all classifications.
        </p>
      )}
    </section>
  );
}

function outcomeCopy(verification: VerificationRun | undefined, issue: string | undefined) {
  if (issue) {
    return {
      label: 'Comparison unavailable',
      detail: issue,
      status: 'unavailable',
    } as const;
  }
  if (!verification) {
    return {
      label: 'Verification pending',
      detail: 'Capture a baseline and compare the current run to produce evidence.',
      status: 'pending',
    } as const;
  }
  if (verification.status === 'blocked') {
    return {
      label: 'Verification blocked',
      detail:
        'Fatal validation evidence prevents a pass. Classification counts remain inspectable but are not proof of improvement.',
      status: 'blocked',
    } as const;
  }
  if (verification.status === 'fail') {
    return {
      label: 'Regression detected',
      detail: 'The candidate introduced one or more finding fingerprints.',
      status: 'fail',
    } as const;
  }
  return {
    label: 'Verification passed',
    detail:
      'No finding fingerprints were newly introduced. Persisting findings may still require investigation.',
    status: 'pass',
  } as const;
}

export function VerificationView({
  state,
  session,
}: {
  state: LabSessionState;
  session: LabSession;
}) {
  const { baseline, candidate, current, verification } = state;
  const outcome = outcomeCopy(verification, state.comparisonIssue);
  return (
    <div className="lab-verification-view">
      <section aria-labelledby="verification-title">
        <div className="lab-section-heading">
          <h2 id="verification-title">Baseline and candidate verification</h2>
          <p>
            Compare deterministic finding fingerprints and validation evidence from two synthetic
            runs using the same analysis profile.
          </p>
        </div>
        <div className="lab-verification-actions">
          <button type="button" disabled={!current} onClick={() => session.captureBaseline()}>
            Capture current as baseline
          </button>
          <button
            type="button"
            disabled={!current || !baseline}
            onClick={() => session.captureCandidate()}
          >
            Compare current with baseline
          </button>
        </div>
        <div className="lab-verification-runs">
          <RunEvidence title="Baseline" captured={baseline} />
          <RunEvidence title="Candidate" captured={candidate} />
        </div>
      </section>

      <section
        className="lab-verification-outcome"
        data-outcome={outcome.status}
        aria-labelledby="verification-outcome-title"
        role="status"
        aria-live="polite"
      >
        <div>
          <p className="section-label">Comparison outcome</p>
          <h2 id="verification-outcome-title">{outcome.label}</h2>
          <p>{outcome.detail}</p>
        </div>
        <dl aria-label="Finding classification totals">
          <div>
            <dt>Resolved</dt>
            <dd>{verification?.summary.resolved ?? 0}</dd>
          </div>
          <div>
            <dt>Persisting</dt>
            <dd>{verification?.summary.persisting ?? 0}</dd>
          </div>
          <div>
            <dt>Introduced</dt>
            <dd>{verification?.summary.newlyIntroduced ?? 0}</dd>
          </div>
        </dl>
      </section>

      <section className="lab-classifications" aria-labelledby="verification-evidence-title">
        <div className="lab-section-heading">
          <h2 id="verification-evidence-title">Classification evidence</h2>
          <p>Resolved uses baseline evidence. Persisting and introduced use candidate evidence.</p>
        </div>
        <div className="lab-classification-grid">
          <ClassificationGroup
            title="Resolved"
            kind="resolved"
            classifications={verification?.resolved ?? []}
          />
          <ClassificationGroup
            title="Persisting"
            kind="persisting"
            classifications={verification?.persisting ?? []}
          />
          <ClassificationGroup
            title="Newly introduced"
            kind="introduced"
            classifications={verification?.newlyIntroduced ?? []}
          />
        </div>
      </section>

      <section className="lab-requirement-evidence" aria-labelledby="requirement-evidence-title">
        <div className="lab-section-heading">
          <h2 id="requirement-evidence-title">Requirement evidence</h2>
          <p>Canonical requirement IDs and executable test IDs are preserved in the report.</p>
        </div>
        {verification ? (
          <ol>
            {verification.requirementResults.map((result) => (
              <li key={result.requirementId}>
                <div>
                  <strong>{result.requirementId}</strong>
                  <span className="lab-requirement-status" data-status={result.status}>
                    {result.status === 'not-run' ? 'Not applicable to this run' : result.status}
                  </span>
                </div>
                <p>{result.evidence}</p>
                <p className="identifier">{result.testIds.join(', ')}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p>No requirement result exists until a comparison completes.</p>
        )}
      </section>

      <section className="lab-exports" aria-labelledby="verification-export-title">
        <h2 id="verification-export-title">Export minimized verification evidence</h2>
        <p>
          The export uses the captured candidate, not the mutable current run. Source samples,
          source definitions, and raw quarantined values are always excluded.
        </p>
        <button
          type="button"
          disabled={!candidate || !verification}
          onClick={() => {
            if (!candidate || !verification) return;
            downloadText(
              `${slug(verification.verificationId)}-verification-report.json`,
              serializeDiagnosticReport(candidate.run, candidate.analysis, verification, {
                includeSourceData: false,
              }),
              'application/json',
            );
          }}
        >
          Export minimized verification JSON
        </button>
      </section>
    </div>
  );
}
