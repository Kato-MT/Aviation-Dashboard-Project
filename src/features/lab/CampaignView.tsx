import { useMemo, useState } from 'react';
import type { CampaignGroupMetrics } from '../../campaign/types';
import type { EvidenceBuildIdentity } from '../../evidence/types';
import { serializeCampaignReport } from '../../export/campaignReport';
import { downloadText, slug } from '../../ui/dom';
import {
  CAMPAIGN_FAULT_FAMILY_COUNT,
  CAMPAIGN_SCENARIO_COUNT,
  CAMPAIGN_VARIATIONS_PER_FAULT,
  parseCampaignSeeds,
} from './campaign';
import type { LabCampaignPhase, LabSession, LabSessionState } from './session';

const localBuildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'static-preview',
});

const phaseLabels: Readonly<Record<LabCampaignPhase, string>> = Object.freeze({
  idle: 'Not run',
  running: 'Running',
  cancelling: 'Cancelling',
  completed: 'Completed',
  'completed-with-errors': 'Completed with contained errors',
  cancelled: 'Cancelled with partial evidence',
  stopped: 'Stopped without partial evidence',
  failed: 'Failed',
});

function formatNumber(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'Unavailable'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'Unavailable'
    : `${(value * 100).toFixed(1)}%`;
}

function boundedEvidenceText(value: string | undefined, fallback: string, maximum = 500): string {
  const normalized = value?.trim();
  return (normalized || fallback).slice(0, maximum);
}

function intervalText(interval: {
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly confidenceLevel: number;
}): string {
  if (interval.estimate === null || interval.lower === null || interval.upper === null) {
    return 'Unavailable';
  }
  return `${formatPercent(interval.estimate)} | ${formatPercent(interval.lower)} to ${formatPercent(interval.upper)} at ${formatPercent(interval.confidenceLevel)}`;
}

function announcement(state: LabSessionState): string {
  const campaign = state.campaign;
  if (campaign.phase === 'running') {
    const progress = campaign.progress;
    const milestone = progress?.totalCases
      ? Math.floor((progress.completedCases / progress.totalCases) * 10) * 10
      : 0;
    return `Campaign running. ${milestone}% processed.`;
  }
  if (campaign.phase === 'cancelling') {
    return 'Campaign cancellation requested. Waiting for verified partial evidence.';
  }
  if (campaign.phase === 'completed-with-errors') {
    return 'Campaign completed with contained case failures.';
  }
  if (campaign.phase === 'cancelled') {
    return 'Campaign cancelled with verified partial evidence.';
  }
  if (campaign.phase === 'completed') return 'Campaign completed.';
  if (campaign.phase === 'failed') return 'Campaign failed.';
  if (campaign.phase === 'stopped') {
    return 'Campaign worker stopped without verified partial evidence.';
  }
  return 'Campaign has not run.';
}

function GroupMetricsTable({
  label,
  groups,
}: {
  readonly label: string;
  readonly groups: readonly CampaignGroupMetrics[];
}) {
  return (
    <div className="lab-campaign-table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Completed</th>
            <th scope="col">Matched</th>
            <th scope="col">Unexpected</th>
            <th scope="col">Correctly absent</th>
            <th scope="col">Missing</th>
            <th scope="col">Precision</th>
            <th scope="col">Recall</th>
            <th scope="col">F1</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.groupId}>
              <th scope="row">{group.groupId}</th>
              <td>{group.completedCases}</td>
              <td>{group.confusion.truePositives}</td>
              <td>{group.confusion.falsePositives}</td>
              <td>{group.confusion.trueNegatives}</td>
              <td>{group.confusion.falseNegatives}</td>
              <td>{formatPercent(group.episodes.precision)}</td>
              <td>{formatPercent(group.episodes.recall)}</td>
              <td>{formatPercent(group.episodes.f1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CampaignView({
  state,
  session,
  buildIdentity,
}: {
  readonly state: LabSessionState;
  readonly session: LabSession;
  readonly buildIdentity?: Readonly<EvidenceBuildIdentity> | undefined;
}) {
  const campaign = state.campaign;
  const current = campaign.current;
  const result = current?.result;
  const metrics = result?.metrics;
  const working = campaign.phase === 'running' || campaign.phase === 'cancelling';
  const [exportIssue, setExportIssue] = useState<string | undefined>();
  const preview = useMemo(() => {
    try {
      const seeds = parseCampaignSeeds(campaign.seedsInput);
      return {
        seedCount: seeds.length,
        plannedCases: seeds.length * CAMPAIGN_SCENARIO_COUNT,
        issue: undefined,
      };
    } catch (error) {
      return {
        seedCount: 0,
        plannedCases: 0,
        issue: error instanceof Error ? error.message : 'Campaign seed input is invalid.',
      };
    }
  }, [campaign.seedsInput]);
  const progress = campaign.progress;
  const processed = progress?.completedCases ?? result?.summary.attemptedCases ?? 0;
  const planned = progress?.totalCases ?? result?.summary.plannedCases ?? preview.plannedCases;
  const exactBuildIdentity = buildIdentity ?? localBuildIdentity;

  const exportReport = async () => {
    if (!current) return;
    setExportIssue(undefined);
    try {
      const serialized = await serializeCampaignReport({
        buildIdentity: exactBuildIdentity,
        snapshot: current,
      });
      downloadText(
        `temporal-campaign-${slug(current.result.campaignId)}.json`,
        serialized,
        'application/json',
      );
    } catch (error) {
      setExportIssue(
        error instanceof Error ? error.message : 'Campaign report integrity verification failed.',
      );
    }
  };

  return (
    <div className="lab-campaign-view" aria-busy={working}>
      <header className="lab-campaign-heading lab-section-heading">
        <div>
          <p className="section-label">Bounded release evaluation</p>
          <h2>Campaign</h2>
          <p>
            Run the declared synthetic fixed-wing matrix in one disposable browser Worker. This is
            local rule evaluation, not public aircraft surveillance or a safety assessment.
          </p>
        </div>
        <span id="campaign-status" className="lab-campaign-status" data-phase={campaign.phase}>
          {phaseLabels[campaign.phase]}
        </span>
      </header>

      <div className="source-banner" role="note">
        <strong>Synthetic, unclassified evidence only</strong>
        <span>
          Deterministic rules remain authoritative. Temporal calibration is advisory and failed
          cases are excluded from aggregate metrics.
        </span>
      </div>

      <section className="lab-campaign-controls" aria-labelledby="campaign-controls-title">
        <div className="lab-section-heading">
          <p className="section-label">Exact bounded request</p>
          <h3 id="campaign-controls-title">Campaign controls</h3>
        </div>
        <label>
          Deterministic seeds
          <input
            id="campaign-seeds"
            type="text"
            value={campaign.seedsInput}
            disabled={working}
            aria-describedby="campaign-seeds-help campaign-matrix-preview"
            onChange={(event) => session.setCampaignSeedsInput(event.target.value)}
          />
        </label>
        <p id="campaign-seeds-help" className="muted">
          Enter 1 to 12 unique comma-separated decimal integers from 1 through 2,147,483,647.
        </p>
        <p id="campaign-matrix-preview" className="lab-campaign-preview">
          {preview.issue
            ? `Configuration issue: ${preview.issue}`
            : `${preview.seedCount} seeds × ${CAMPAIGN_SCENARIO_COUNT} scenarios = ${preview.plannedCases} planned cases`}
        </p>
        <dl className="lab-campaign-contract-grid">
          <div>
            <dt>Profile</dt>
            <dd>generic-fixed-wing@1.0.0</dd>
          </div>
          <div>
            <dt>Matrix</dt>
            <dd>
              1 nominal + {CAMPAIGN_FAULT_FAMILY_COUNT} fault families ×{' '}
              {CAMPAIGN_VARIATIONS_PER_FAULT} variations
            </dd>
          </div>
          <div>
            <dt>Case generator</dt>
            <dd>180 samples | 1,000 ms cadence | 179,000 ms</dd>
          </div>
          <div>
            <dt>Bootstrap</dt>
            <dd>300 iterations | 95% confidence | seed 22072</dd>
          </div>
        </dl>
        <div className="lab-campaign-actions">
          <button
            type="button"
            disabled={working || preview.issue !== undefined}
            onClick={() => void session.runCampaign()}
          >
            Run Campaign
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={campaign.phase !== 'running'}
            onClick={() => session.cancelCampaign()}
          >
            Cancel Campaign
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={!current || working}
            onClick={() => void exportReport()}
          >
            Export minimized Campaign JSON
          </button>
        </div>
        <div className="lab-campaign-progress">
          <progress
            id="campaign-progress"
            aria-label="Campaign processed cases"
            max={Math.max(1, planned)}
            value={processed}
          />
          <output id="campaign-progress-label" htmlFor="campaign-progress">
            Processed {processed.toLocaleString('en-US')} of {planned.toLocaleString('en-US')}
          </output>
        </div>
        <p className="lab-sr-only" role="status" aria-atomic="true">
          {announcement(state)}
        </p>
        {(campaign.issue || preview.issue || exportIssue) && (
          <p
            className="lab-inline-warning"
            role={campaign.phase === 'failed' || exportIssue ? 'alert' : 'status'}
          >
            {exportIssue ?? campaign.issue ?? preview.issue}
          </p>
        )}
        {campaign.resultSettingsStale && current && (
          <p className="lab-inline-warning" role="status">
            The visible result is a settled snapshot from different seed controls. Run again to
            replace it.
          </p>
        )}
      </section>

      <section className="lab-investigation-summary" aria-labelledby="campaign-outcome-title">
        <div className="lab-section-heading">
          <p className="section-label">Terminal evidence</p>
          <h3 id="campaign-outcome-title">Outcome summary</h3>
        </div>
        <dl>
          {[
            ['Planned', result?.summary.plannedCases],
            ['Attempted', result?.summary.attemptedCases],
            ['Completed', result?.summary.completedCases],
            ['Failed', result?.summary.failedCases],
            ['Remaining', result?.summary.remainingCases],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value ?? 0}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="lab-campaign-metrics" aria-labelledby="campaign-metrics-title">
        <div className="lab-section-heading">
          <p className="section-label">Aggregate completed-case evidence</p>
          <h3 id="campaign-metrics-title">Metrics</h3>
        </div>
        {metrics ? (
          <>
            <dl className="lab-campaign-metric-grid">
              <div>
                <dt>Matched opportunities</dt>
                <dd>{metrics.confusion.truePositives}</dd>
              </div>
              <div>
                <dt>Missing opportunities</dt>
                <dd>{metrics.confusion.falseNegatives}</dd>
              </div>
              <div>
                <dt>Unexpected indications</dt>
                <dd>{metrics.confusion.falsePositives}</dd>
              </div>
              <div>
                <dt>Correctly absent opportunities</dt>
                <dd>{metrics.confusion.trueNegatives}</dd>
              </div>
              <div>
                <dt>Episode precision</dt>
                <dd>{formatPercent(metrics.episodes.precision)}</dd>
              </div>
              <div>
                <dt>Episode recall</dt>
                <dd>{formatPercent(metrics.episodes.recall)}</dd>
              </div>
              <div>
                <dt>Episode F1</dt>
                <dd>{formatPercent(metrics.episodes.f1)}</dd>
              </div>
              <div>
                <dt>False alarms per completed run</dt>
                <dd>{formatNumber(metrics.falseAlarmsPerRun)}</dd>
              </div>
              <div>
                <dt>False alarms per synthetic hour</dt>
                <dd>{formatNumber(metrics.falseAlarmsPerSyntheticHour)}</dd>
              </div>
              <div>
                <dt>Synthetic hours</dt>
                <dd>{formatNumber(metrics.syntheticHours)}</dd>
              </div>
              <div>
                <dt>Calibration observations</dt>
                <dd>{metrics.calibration.observations}</dd>
              </div>
              <div>
                <dt>Calibration abstention</dt>
                <dd>{formatPercent(metrics.calibration.abstentionRate)}</dd>
              </div>
              <div>
                <dt>Expected calibration error</dt>
                <dd>{formatNumber(metrics.calibration.expectedCalibrationError, 4)}</dd>
              </div>
              <div>
                <dt>Brier score</dt>
                <dd>{formatNumber(metrics.calibration.brierScore, 4)}</dd>
              </div>
            </dl>
            <div className="lab-campaign-evidence-grid">
              <article>
                <h4>Detection delay, milliseconds</h4>
                <dl>
                  <div>
                    <dt>Count</dt>
                    <dd>{metrics.timeToDetection.count}</dd>
                  </div>
                  <div>
                    <dt>Minimum</dt>
                    <dd>{formatNumber(metrics.timeToDetection.minimum)}</dd>
                  </div>
                  <div>
                    <dt>Median</dt>
                    <dd>{formatNumber(metrics.timeToDetection.median)}</dd>
                  </div>
                  <div>
                    <dt>Mean</dt>
                    <dd>{formatNumber(metrics.timeToDetection.mean)}</dd>
                  </div>
                  <div>
                    <dt>P95</dt>
                    <dd>{formatNumber(metrics.timeToDetection.p95)}</dd>
                  </div>
                  <div>
                    <dt>Maximum</dt>
                    <dd>{formatNumber(metrics.timeToDetection.maximum)}</dd>
                  </div>
                </dl>
              </article>
              <article>
                <h4>Bootstrap intervals</h4>
                <dl>
                  <div>
                    <dt>Precision</dt>
                    <dd>{intervalText(metrics.bootstrap.precision)}</dd>
                  </div>
                  <div>
                    <dt>Recall</dt>
                    <dd>{intervalText(metrics.bootstrap.recall)}</dd>
                  </div>
                  <div>
                    <dt>F1</dt>
                    <dd>{intervalText(metrics.bootstrap.f1)}</dd>
                  </div>
                </dl>
              </article>
            </div>
          </>
        ) : (
          <p className="lab-empty-state">Run a Campaign to inspect aggregate metrics.</p>
        )}
      </section>

      {metrics && (
        <>
          <section className="lab-campaign-coverage" aria-labelledby="campaign-coverage-title">
            <div className="lab-section-heading">
              <p className="section-label">Declared scenario matrix</p>
              <h3 id="campaign-coverage-title">Scenario coverage</h3>
            </div>
            <div
              className="lab-campaign-table-scroll"
              role="region"
              aria-label="Campaign scenario coverage table"
              tabIndex={0}
            >
              <table>
                <caption>Completed evidence for every declared scenario</caption>
                <thead>
                  <tr>
                    <th scope="col">Scenario</th>
                    <th scope="col">Planned</th>
                    <th scope="col">Completed</th>
                    <th scope="col">All expected</th>
                    <th scope="col">Expected episodes</th>
                    <th scope="col">Detected expected</th>
                    <th scope="col">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.scenarioCoverage.map((coverage) => (
                    <tr key={coverage.scenarioId}>
                      <th scope="row">{coverage.scenarioId}</th>
                      <td>{coverage.plannedCases}</td>
                      <td>{coverage.completedCases}</td>
                      <td>{coverage.casesWithAllExpected}</td>
                      <td>{coverage.expectedEpisodes}</td>
                      <td>{coverage.detectedExpectedEpisodes}</td>
                      <td>{formatPercent(coverage.coverage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="lab-campaign-groups" aria-labelledby="campaign-groups-title">
            <div className="lab-section-heading">
              <p className="section-label">Bounded confusion evidence</p>
              <h3 id="campaign-groups-title">Phase and fault groups</h3>
            </div>
            <GroupMetricsTable
              label="Campaign confusion by phase"
              groups={metrics.confusionByPhase}
            />
            <GroupMetricsTable
              label="Campaign confusion by scenario"
              groups={metrics.confusionByFault}
            />
          </section>
        </>
      )}

      <section className="lab-campaign-failures" aria-labelledby="campaign-failures-title">
        <div className="lab-section-heading">
          <p className="section-label">Contained execution failures</p>
          <h3 id="campaign-failures-title">Failed cases</h3>
        </div>
        {result?.cases.some((campaignCase) => campaignCase.status === 'failed') ? (
          <ol className="lab-investigation-list">
            {result.cases
              .filter((campaignCase) => campaignCase.status === 'failed')
              .slice(0, 32)
              .map((campaignCase) => (
                <li key={campaignCase.caseId}>
                  <strong>{campaignCase.scenarioId}</strong>
                  <span>
                    seed {campaignCase.seed} | {campaignCase.phase} |{' '}
                    {boundedEvidenceText(campaignCase.error?.name, 'Error', 100)}:{' '}
                    {boundedEvidenceText(
                      campaignCase.error?.message,
                      'No failure detail was retained.',
                    )}
                  </span>
                </li>
              ))}
          </ol>
        ) : (
          <p className="lab-empty-state">
            {result ? 'No contained case failures.' : 'No Campaign result is available.'}
          </p>
        )}
      </section>

      <section className="lab-campaign-identity" aria-labelledby="campaign-identity-title">
        <div className="lab-section-heading">
          <p className="section-label">Reproduction identity</p>
          <h3 id="campaign-identity-title">Bound evidence</h3>
        </div>
        <dl className="lab-campaign-contract-grid">
          <div>
            <dt>Campaign ID</dt>
            <dd>{result?.campaignId ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Run ID</dt>
            <dd>{result?.runId ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Spec SHA-256</dt>
            <dd>{result?.replayManifest.specSha256 ?? 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Settled</dt>
            <dd>{current?.settledAt ?? 'Unavailable'}</dd>
          </div>
        </dl>
        <p className="muted">
          The minimized report excludes source rows, samples, points, series, measurements,
          successful case rows, detections, calibration windows, replay case rows, truth, lifecycle
          rows, browser state, storage, and endpoints.
        </p>
      </section>
    </div>
  );
}
