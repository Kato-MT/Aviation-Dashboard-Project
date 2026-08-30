import { useMemo } from 'react';
import type { EvidenceBuildIdentity } from '../../evidence/types';
import { serializeInvestigationReport } from '../../export/investigationReport';
import type { InvestigationPoint } from '../../investigation';
import { DECLARED_TEMPORAL_FAULTS } from '../../temporal/generator';
import type { MissionPhase } from '../../temporal/types';
import {
  evaluateInvestigationComparison,
  type InvestigationComparisonCompatibility,
  type InvestigationOverlayVisibility,
} from '../../ui/investigationCharts';
import { downloadText, formatObserved, slug } from '../../ui/dom';
import { InvestigationCharts } from './InvestigationCharts';
import type { InvestigationModelActivationEvidence } from './investigation';
import type { LabSession, LabSessionState } from './session';

const localBuildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'static-preview',
});

const phaseLabels: Readonly<Record<MissionPhase, string>> = Object.freeze({
  ground: 'Ground',
  takeoff: 'Takeoff',
  climb: 'Climb',
  cruise: 'Cruise',
  descent: 'Descent',
  landing: 'Landing',
});

const overlayControls: readonly {
  key: keyof InvestigationOverlayVisibility;
  label: string;
}[] = [
  { key: 'observedAltitude', label: 'Observed altitude' },
  { key: 'predictedAltitude', label: 'Prediction' },
  { key: 'uncertainty', label: '95% uncertainty' },
  { key: 'airspeed', label: 'Airspeed' },
  { key: 'fuel', label: 'Fuel' },
  { key: 'residuals', label: 'Normalized residual' },
  { key: 'phases', label: 'Mission phases' },
  { key: 'faultMarkers', label: 'Fault lifecycle' },
  { key: 'comparisonBaseline', label: 'Comparison baseline waveforms' },
];

function formatNumber(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'Not available'
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function investigationStatus(state: LabSessionState): string {
  const investigation = state.investigation;
  if (investigation.work.phase === 'analyzing') return 'Analyzing';
  if (!investigation.current)
    return investigation.work.phase === 'failed' ? 'Analysis failed' : 'Not run';
  const count = investigation.current.analysis.indications.length;
  return count === 0 ? 'Nominal rule result' : `${count.toLocaleString('en-US')} rule indications`;
}

type ActivationPresentationState = 'active' | 'disabled' | 'ineligible' | 'unavailable';

interface ActivationPresentation {
  readonly state: ActivationPresentationState;
  readonly label: 'Active' | 'Disabled' | 'Ineligible' | 'Unavailable';
  readonly detail: string;
}

function modelReasonSummary(evidence: InvestigationModelActivationEvidence): string {
  return evidence.reasons.length > 0
    ? evidence.reasons.map(({ detail }) => detail).join(' ')
    : 'No activation blockers were recorded.';
}

function activationPresentation(
  evidence: InvestigationModelActivationEvidence,
): ActivationPresentation {
  if (evidence.userSelection === 'disabled') {
    return {
      state: 'disabled',
      label: 'Disabled',
      detail: 'User intent was disabled when this run started.',
    };
  }
  if (evidence.active) {
    return {
      state: 'active',
      label: 'Active',
      detail: 'Enabled, eligible, and activated when this run started.',
    };
  }
  const verificationUnavailable =
    evidence.identityVerification.artifact === 'pending' ||
    evidence.identityVerification.artifact === 'unavailable' ||
    evidence.identityVerification.configuration === 'pending' ||
    evidence.identityVerification.configuration === 'unavailable' ||
    evidence.qualityGate.state === 'pending' ||
    evidence.qualityGate.state === 'unavailable';
  if (verificationUnavailable) {
    return {
      state: 'unavailable',
      label: 'Unavailable',
      detail: modelReasonSummary(evidence),
    };
  }
  return {
    state: 'ineligible',
    label: 'Ineligible',
    detail: modelReasonSummary(evidence),
  };
}

function modelSummary(
  evidence: InvestigationModelActivationEvidence | undefined,
  point: InvestigationPoint | undefined,
): { value: string; detail: string } {
  if (!evidence || !point)
    return { value: 'Not run', detail: 'Run an investigation to inspect advisory evidence.' };
  const activation = activationPresentation(evidence);
  if (activation.state !== 'active') {
    return { value: activation.label, detail: activation.detail };
  }
  const score = point.model.score;
  if (!score) {
    return {
      value: 'Warmup',
      detail: `${point.model.warmupRemaining.toLocaleString('en-US')} causal samples remaining`,
    };
  }
  if (!score.activation.active) {
    return {
      value: 'Unavailable',
      detail: score.activation.inactiveReason ?? 'No selected-sample model score is available.',
    };
  }
  if (score.abstained) {
    return {
      value: 'Abstained',
      detail: `${(score.relativeScore * 100).toFixed(1)}% relative similarity | unknown`,
    };
  }
  return {
    value: `${(score.relativeScore * 100).toFixed(1)}%`,
    detail: score.predictedLabel.replaceAll('-', ' '),
  };
}

function hypothesisUnavailableMessage(
  evidence: InvestigationModelActivationEvidence | undefined,
  point: InvestigationPoint | undefined,
): string | undefined {
  if (!evidence || !point) return 'Run an investigation to inspect hypotheses.';
  const activation = activationPresentation(evidence);
  if (activation.state === 'disabled') {
    return 'Temporal model was disabled by user intent for this settled run.';
  }
  if (activation.state === 'unavailable') {
    return `Temporal model evidence was unavailable at activation time. ${activation.detail}`;
  }
  if (activation.state === 'ineligible') {
    return `Temporal model was ineligible at activation time. ${activation.detail}`;
  }
  if (!point.model.score) return 'Temporal model is warming up the 40-sample causal window.';
  if (!point.model.score.activation.active) {
    return `The selected-sample temporal result is unavailable. ${point.model.score.activation.inactiveReason ?? 'No model score was produced.'}`;
  }
  return undefined;
}

function verificationLabel(value: string): string {
  return value.replaceAll('-', ' ').replace(/^./u, (first) => first.toUpperCase());
}

function passLabel(value: boolean | null): string {
  return value === null ? 'not available' : value ? 'passed' : 'failed';
}

function ModelActivationCard({
  id,
  label,
  evidence,
}: {
  readonly id: string;
  readonly label: string;
  readonly evidence: InvestigationModelActivationEvidence;
}) {
  const presentation = activationPresentation(evidence);
  return (
    <article aria-labelledby={`${id}-title`}>
      <strong id={`${id}-title`}>{label}</strong>
      <p>
        <span id={`${id}-state`}>{presentation.label}</span> | {presentation.detail}
      </p>
      <dl>
        <div>
          <dt>User intent</dt>
          <dd>{verificationLabel(evidence.userSelection)}</dd>
        </div>
        <div>
          <dt>Activation purpose</dt>
          <dd>{verificationLabel(evidence.activationPurpose)}</dd>
        </div>
        <div>
          <dt>Artifact identity</dt>
          <dd>{verificationLabel(evidence.identityVerification.artifact)}</dd>
        </div>
        <div>
          <dt>Configuration identity</dt>
          <dd>{verificationLabel(evidence.identityVerification.configuration)}</dd>
        </div>
        <div>
          <dt>Quality gate</dt>
          <dd>
            {verificationLabel(evidence.qualityGate.state)} | stored{' '}
            {passLabel(evidence.qualityGate.storedPassed)} | recomputed{' '}
            {passLabel(evidence.qualityGate.recomputedPassed)}
          </dd>
        </div>
        <div>
          <dt>Compatibility context</dt>
          <dd>{evidence.contextLabel}</dd>
        </div>
        <div>
          <dt>Activation reasons</dt>
          <dd>
            {evidence.reasons.length === 0 ? (
              'No activation blockers.'
            ) : (
              <ul>
                {evidence.reasons.map((reason) => (
                  <li key={`${reason.code}-${reason.channels.join('-')}`}>
                    <code>{reason.code}</code> | {reason.detail}
                    {reason.channels.length > 0 ? ` | channels ${reason.channels.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <p>Advisory only. Deterministic rules remain authoritative.</p>
    </article>
  );
}

function comparisonStatus(
  state: LabSessionState,
  compatibility: InvestigationComparisonCompatibility | undefined,
): { message: string; quality: 'unknown' | 'good' | 'warning' } {
  const { baseline, current, overlays } = state.investigation;
  if (!baseline) return { message: 'No comparison baseline captured.', quality: 'unknown' };
  if (!current) {
    return {
      message: `Baseline retained: ${baseline.scenarioId}, seed ${baseline.seed}. Run a compatible scenario to compare.`,
      quality: 'unknown',
    };
  }
  if (!compatibility?.compatible) {
    return {
      message: `Baseline not overlaid. ${compatibility?.reasons.join(' ') ?? 'Compatibility is unavailable.'}`,
      quality: 'warning',
    };
  }
  return {
    message: overlays.comparisonBaseline
      ? `Overlay active: baseline ${baseline.scenarioId}, seed ${baseline.seed}, versus current ${current.configuration.scenarioId}, seed ${current.configuration.seed}.`
      : 'Compatible comparison baseline available. The waveform overlay is hidden.',
    quality: 'good',
  };
}

function detectorRows(point: InvestigationPoint | undefined): readonly [string, string][] {
  if (!point) return [];
  const evidence = point.detectorEvidence;
  const topResiduals = evidence.kalmanInnovation.topResidualSensorChannels
    .map(
      ({ sensorId, absoluteNormalizedInnovation }) =>
        `${sensorId} ${absoluteNormalizedInnovation.toFixed(2)} sigma`,
    )
    .join(', ');
  return [
    [
      'Deterministic rules | authoritative',
      `${evidence.deterministicRules.state} | ${evidence.deterministicRules.indicationCount} selected-sample indications`,
    ],
    [
      'Robust covariance | advisory',
      evidence.covarianceAdvisory.state === 'unsupported'
        ? `unsupported | ${evidence.covarianceAdvisory.unsupportedReason ?? 'compatibility unavailable'}`
        : `${evidence.covarianceAdvisory.state} | score ${evidence.covarianceAdvisory.score?.score.toFixed(2) ?? 'N/A'} / ${evidence.covarianceAdvisory.threshold.toFixed(2)}`,
    ],
    [
      'Kalman innovation | supporting evidence',
      `${evidence.kalmanInnovation.state} | ${topResiduals || evidence.kalmanInnovation.unsupportedReason || 'no finite residuals'}`,
    ],
    [
      'Temporal model | advisory',
      `${evidence.temporalAdvisory.state} | ${evidence.temporalAdvisory.score?.predictedLabel ?? 'not available'}`,
    ],
  ];
}

export function InvestigationView({
  state,
  session,
  buildIdentity,
}: {
  state: LabSessionState;
  session: LabSession;
  buildIdentity?: Readonly<EvidenceBuildIdentity> | undefined;
}) {
  const investigation = state.investigation;
  const current = investigation.current;
  const points = current?.analysis.points ?? [];
  const selectedPoint = points[investigation.cursorPosition];
  const selectedSample = selectedPoint
    ? current?.scenario.samples.find((sample) => sample.sampleIndex === selectedPoint.sampleIndex)
    : undefined;
  const temporalActivationEvidence = current?.modelEvidence.temporalModel;
  const model = modelSummary(temporalActivationEvidence, selectedPoint);
  const hypothesesUnavailable = hypothesisUnavailableMessage(
    temporalActivationEvidence,
    selectedPoint,
  );
  const comparison = useMemo(
    () =>
      investigation.baseline && current
        ? evaluateInvestigationComparison(
            investigation.baseline.identity,
            current.comparisonIdentity,
          )
        : undefined,
    [current, investigation.baseline],
  );
  const comparisonEvidence = comparisonStatus(state, comparison);
  const comparisonWaveform =
    comparison?.compatible && investigation.overlays.comparisonBaseline
      ? investigation.baseline?.waveform
      : undefined;
  const cumulativeIndications = current?.analysis.indications
    .filter((indication) => indication.sampleIndex <= (selectedPoint?.sampleIndex ?? -1))
    .slice(-8);
  const agreement = selectedPoint?.detectorEvidence.fourWayAgreement;
  const exactBuildIdentity = buildIdentity ?? localBuildIdentity;
  const working = investigation.work.phase === 'analyzing';

  return (
    <div className="lab-investigation-view" aria-busy={working}>
      <div className="lab-investigation-heading lab-section-heading">
        <div>
          <p className="section-label">Temporal fault intelligence</p>
          <h2>Investigation</h2>
          <p>
            Generate a labeled synthetic mission, link every detector to the same sample, and keep
            deterministic rules authoritative over advisory models.
          </p>
        </div>
        <div className="lab-investigation-actions">
          <span
            id="investigation-status"
            className="lab-configuration-badge"
            data-quality={
              investigation.work.phase === 'failed' ? 'warning' : current ? 'good' : undefined
            }
            role="status"
            aria-live="polite"
          >
            {investigationStatus(state)}
          </span>
          <button
            id="investigation-export"
            type="button"
            disabled={!current || working}
            onClick={() => {
              if (!current) return;
              downloadText(
                `temporal-investigation-${slug(current.configuration.scenarioId)}-seed-${current.configuration.seed}.json`,
                serializeInvestigationReport({
                  buildIdentity: exactBuildIdentity,
                  snapshot: current,
                }),
                'application/json',
              );
            }}
          >
            Export minimized investigation JSON
          </button>
        </div>
      </div>

      <section
        className="lab-investigation-controls"
        aria-labelledby="investigation-controls-title"
      >
        <div>
          <p className="section-label">Deterministic request</p>
          <h3 id="investigation-controls-title">Scenario controls</h3>
        </div>
        <div className="lab-investigation-control-grid">
          <label>
            Synthetic scenario
            <select
              id="investigation-scenario"
              value={investigation.scenarioId}
              disabled={working}
              onChange={(event) => session.setInvestigationScenario(event.target.value)}
            >
              <option value="nominal">Nominal mission</option>
              {DECLARED_TEMPORAL_FAULTS.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input
              id="investigation-seed"
              type="number"
              min="1"
              max="2147483647"
              step="1"
              inputMode="numeric"
              value={investigation.seedInput}
              disabled={working}
              onChange={(event) => session.setInvestigationSeedInput(event.target.value)}
            />
          </label>
          <label>
            Samples
            <input
              id="investigation-samples"
              type="number"
              min="60"
              max="2000"
              step="1"
              inputMode="numeric"
              value={investigation.sampleCountInput}
              disabled={working}
              onChange={(event) => session.setInvestigationSampleCountInput(event.target.value)}
            />
          </label>
          <button
            id="investigation-run"
            className="lab-primary-action"
            type="button"
            disabled={working}
            onClick={() => void session.runInvestigation()}
          >
            {working ? 'Analyzing' : 'Run investigation'}
          </button>
        </div>
        <p className="lab-configuration-help">
          One-second cadence, fixed generic-wing projection, 60 to 2,000 samples. Generated source
          windows and browser state are excluded from the versioned report.
        </p>
        {investigation.work.issue && (
          <p className="lab-inline-error" role="alert">
            {investigation.work.issue}
          </p>
        )}
        {investigation.resultSettingsStale && current && (
          <p className="lab-inline-warning" role="status">
            The visible result is a settled snapshot from different controls or advisory intent. Run
            again to apply the current settings. <a href="#lab-configuration">Review models</a>
          </p>
        )}
      </section>

      <section className="lab-investigation-summary" aria-labelledby="investigation-summary-title">
        <div className="lab-section-heading">
          <p className="section-label">Linked sample evidence</p>
          <h3 id="investigation-summary-title">Selected state</h3>
        </div>
        <dl className="lab-investigation-summary-grid">
          <div>
            <dt>Detected phase</dt>
            <dd id="investigation-phase">
              {selectedPoint ? phaseLabels[selectedPoint.phase] : 'Not run'}
            </dd>
            <dd className="lab-investigation-summary-detail">
              {selectedPoint
                ? selectedPoint.phaseEvaluation.transitioned
                  ? `Transition confirmed at sample ${selectedPoint.sampleIndex}`
                  : `Sample ${selectedPoint.sampleIndex} | ${selectedPoint.timestamp.slice(11, 19)} UTC`
                : 'No sample selected'}
            </dd>
          </div>
          <div>
            <dt>Four-way agreement</dt>
            <dd id="investigation-agreement">
              {agreement
                ? `${agreement.complete ? '' : 'Partial '}${agreement.state.replaceAll('-', ' ')}`
                : 'Not run'}
            </dd>
            <dd className="lab-investigation-summary-detail">
              {agreement
                ? `${agreement.indicatingSignals} indicate | ${agreement.nominalSignals} nominal | ${agreement.unavailableSignals.length} unavailable`
                : 'Deterministic authority'}
            </dd>
          </div>
          <div>
            <dt>Rule indications</dt>
            <dd id="investigation-rule-count">{current?.analysis.indications.length ?? 0}</dd>
            <dd className="lab-investigation-summary-detail">
              {selectedPoint?.indications.length ?? 0} at selected sample | authoritative
            </dd>
          </div>
          <div>
            <dt>Relative model similarity</dt>
            <dd id="investigation-model-confidence">{model.value}</dd>
            <dd className="lab-investigation-summary-detail">{model.detail}</dd>
          </div>
        </dl>
      </section>

      <section
        className="lab-investigation-activation"
        aria-labelledby="investigation-model-activation-title"
      >
        <div className="lab-section-heading">
          <p className="section-label">Settled run evidence</p>
          <h3 id="investigation-model-activation-title">Advisory activation</h3>
        </div>
        <p className="lab-configuration-help">
          Captured when this run started. Activation eligibility is separate from the
          selected-sample detector decision shown below.
        </p>
        <div id="investigation-model-activation" className="lab-investigation-card-list">
          {current ? (
            <>
              <ModelActivationCard
                id="investigation-temporal-activation"
                label="Temporal model"
                evidence={current.modelEvidence.temporalModel}
              />
              <ModelActivationCard
                id="investigation-robust-activation"
                label="Robust covariance"
                evidence={current.modelEvidence.robustCovariance}
              />
            </>
          ) : (
            <p className="lab-empty-state">No activation evidence is available before a run.</p>
          )}
        </div>
      </section>

      <section className="lab-investigation-replay" aria-labelledby="investigation-replay-title">
        <div className="lab-investigation-replay-heading">
          <div>
            <p className="section-label">Synchronized replay</p>
            <h3 id="investigation-replay-title">Linked sample</h3>
          </div>
          <output id="investigation-replay-position" htmlFor="investigation-replay-slider">
            {points.length ? investigation.cursorPosition + 1 : 0} / {points.length}
          </output>
        </div>
        <label className="lab-investigation-slider">
          Investigation sample range
          <input
            id="investigation-replay-slider"
            type="range"
            min="0"
            max={Math.max(0, points.length - 1)}
            step="1"
            value={Math.min(investigation.cursorPosition, Math.max(0, points.length - 1))}
            disabled={points.length === 0 || working}
            onChange={(event) => session.setInvestigationPosition(Number(event.target.value))}
          />
        </label>
        <p className="lab-configuration-help">
          Use the slider or focus either chart and press Left, Right, Page Up, Page Down, Home, or
          End. Both charts and every evidence panel follow the same sample.
        </p>
      </section>

      {current && selectedPoint && selectedSample ? (
        <section className="lab-investigation-state" aria-labelledby="investigation-state-title">
          <div className="lab-section-heading">
            <p className="section-label">State projection</p>
            <h3 id="investigation-state-title">Expected, observed, predicted and estimated</h3>
          </div>
          <dl className="lab-investigation-state-grid">
            <div>
              <dt>Expected altitude</dt>
              <dd>{formatNumber(selectedSample.truth.altitude)} ft</dd>
            </div>
            <div>
              <dt>Observed altitude</dt>
              <dd>{formatNumber(selectedPoint.fusion.observed.altitude)} ft</dd>
            </div>
            <div>
              <dt>Predicted altitude</dt>
              <dd>{formatNumber(selectedPoint.fusion.predicted.altitude)} ft</dd>
            </div>
            <div>
              <dt>Estimated altitude</dt>
              <dd>{formatNumber(selectedPoint.fusion.estimated.altitude)} ft</dd>
            </div>
            <div>
              <dt>Expected vertical rate</dt>
              <dd>{formatNumber(selectedSample.truth.verticalRate)} ft/min</dd>
            </div>
            <div>
              <dt>Observed vertical rate</dt>
              <dd>{formatNumber(selectedPoint.fusion.observed.verticalRate)} ft/min</dd>
            </div>
            <div>
              <dt>Predicted vertical rate</dt>
              <dd>{formatNumber(selectedPoint.fusion.predicted.verticalRate)} ft/min</dd>
            </div>
            <div>
              <dt>Estimated vertical rate</dt>
              <dd>{formatNumber(selectedPoint.fusion.estimated.verticalRate)} ft/min</dd>
            </div>
          </dl>
        </section>
      ) : (
        <p className="lab-empty-state">
          Run an investigation to inspect synchronized state evidence.
        </p>
      )}

      <section
        className="lab-investigation-comparison"
        aria-labelledby="investigation-comparison-title"
      >
        <div className="lab-investigation-comparison-heading">
          <div>
            <p className="section-label">Visual evidence only</p>
            <h3 id="investigation-comparison-title">Replay overlays and baseline</h3>
          </div>
          <button
            id="capture-investigation-baseline"
            type="button"
            disabled={!current || working}
            onClick={() => session.captureInvestigationBaseline()}
          >
            {investigation.baseline ? 'Replace comparison baseline' : 'Capture comparison baseline'}
          </button>
        </div>
        <p
          id="investigation-comparison-status"
          className="lab-configuration-badge lab-investigation-comparison-status"
          data-quality={comparisonEvidence.quality}
          role="status"
        >
          {comparisonEvidence.message}
        </p>
        <fieldset className="lab-investigation-overlays">
          <legend>Visible evidence overlays</legend>
          <div>
            {overlayControls.map(({ key, label }) => {
              const comparisonControl = key === 'comparisonBaseline';
              return (
                <label key={key} className="checkbox-label">
                  <input
                    id={comparisonControl ? 'investigation-comparison-overlay' : undefined}
                    type="checkbox"
                    checked={investigation.overlays[key]}
                    disabled={
                      working ||
                      !current ||
                      (comparisonControl && (!investigation.baseline || !comparison?.compatible))
                    }
                    onChange={(event) => session.setInvestigationOverlay(key, event.target.checked)}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="lab-configuration-help">
          Baselines overlay only when profile, cadence, sample count and every sample index match.
          No resampling, truncation or time-warping is allowed. Deterministic rules remain
          authoritative.
        </p>
      </section>

      {current ? (
        <InvestigationCharts
          series={current.chartSeries}
          overlays={investigation.overlays}
          comparison={comparisonWaveform}
          sampleIndex={selectedPoint?.sampleIndex ?? current.defaultSelectedIndex}
          onSeek={(sampleIndex) => session.seekInvestigationSample(sampleIndex)}
        />
      ) : (
        <p className="lab-empty-state">Investigation charts will appear after a valid run.</p>
      )}

      <div className="lab-investigation-evidence-grid">
        <section aria-labelledby="investigation-timeline-title">
          <p className="section-label">Verification metadata</p>
          <h3 id="investigation-timeline-title">Fault timeline</h3>
          <div id="investigation-timeline" className="lab-investigation-card-list">
            {!current ? (
              <p className="lab-empty-state">No fault timeline is available.</p>
            ) : current.scenario.faultTimeline === null ? (
              <p className="lab-empty-state">Nominal scenario, no fault lifecycle was injected.</p>
            ) : (
              <>
                <article>
                  <strong>Scenario</strong>
                  <p>{current.scenario.faultTimeline.faultId}</p>
                </article>
                <article>
                  <strong>Onset</strong>
                  <p>Sample {current.scenario.faultTimeline.onsetIndex}</p>
                </article>
                <article>
                  <strong>Active interval</strong>
                  <p>
                    {current.scenario.faultTimeline.durationSamples} samples through{' '}
                    {current.scenario.faultTimeline.activeEndIndex}
                  </p>
                </article>
                <article>
                  <strong>Recovery</strong>
                  <p>
                    {current.scenario.faultTimeline.recoverySamples} samples through{' '}
                    {current.scenario.faultTimeline.recoveryEndIndex}
                  </p>
                </article>
                <article>
                  <strong>Rule detection</strong>
                  <p>
                    {current.analysis.detection.deterministicIndex === null
                      ? 'Not detected'
                      : `Sample ${current.analysis.detection.deterministicIndex} | ${current.analysis.detection.deterministicDelaySamples} sample delay`}
                  </p>
                </article>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="investigation-hypotheses-title">
          <p className="section-label">Advisory only</p>
          <h3 id="investigation-hypotheses-title">Ranked hypotheses</h3>
          <ol id="investigation-hypotheses" className="lab-investigation-list">
            {hypothesesUnavailable ? (
              <li className="lab-empty-state">{hypothesesUnavailable}</li>
            ) : (
              <>
                {selectedPoint?.model.score?.abstained && (
                  <li className="lab-empty-state">
                    Unknown: the model abstained because support or confidence was insufficient.
                  </li>
                )}
                {selectedPoint?.model.score?.hypotheses.map((hypothesis) => (
                  <li key={hypothesis.faultType}>
                    <strong>{hypothesis.faultType.replaceAll('-', ' ')}</strong>
                    <span>{(hypothesis.relativeScore * 100).toFixed(1)}%</span>
                    <meter
                      aria-label={`${hypothesis.faultType.replaceAll('-', ' ')} relative model similarity`}
                      min="0"
                      max="1"
                      value={hypothesis.relativeScore}
                    >
                      {(hypothesis.relativeScore * 100).toFixed(1)}%
                    </meter>
                  </li>
                ))}
              </>
            )}
          </ol>
        </section>

        <section aria-labelledby="investigation-indications-title">
          <p className="section-label">Observed rule evidence</p>
          <h3 id="investigation-indications-title">Rule indications</h3>
          <ol id="investigation-indications" className="lab-investigation-list">
            {!cumulativeIndications?.length ? (
              <li className="lab-empty-state">
                No deterministic indication has occurred by this sample.
              </li>
            ) : (
              cumulativeIndications.map((indication) => (
                <li key={indication.indicationId}>
                  <strong>
                    {indication.severity.toUpperCase()} | {indication.ruleId}
                  </strong>
                  <span>
                    Sample {indication.sampleIndex} | {formatObserved(indication.observedValue)} |{' '}
                    {indication.expectedCondition}
                  </span>
                </li>
              ))
            )}
          </ol>
        </section>

        <section aria-labelledby="investigation-phase-log-title">
          <p className="section-label">Confirmed transitions</p>
          <h3 id="investigation-phase-log-title">Phase transitions</h3>
          <ol id="investigation-phase-log" className="lab-investigation-list">
            {!current?.analysis.phaseTransitions.length ? (
              <li className="lab-empty-state">No phase transitions were confirmed.</li>
            ) : (
              current.analysis.phaseTransitions.map((transition) => (
                <li key={`${transition.from}-${transition.to}-${transition.sampleIndex}`}>
                  <strong>
                    {phaseLabels[transition.from]} to {phaseLabels[transition.to]}
                  </strong>
                  <span>
                    Sample {transition.sampleIndex} | {transition.confirmationSamples} confirmations
                    | {transition.hysteresisCondition}
                  </span>
                </li>
              ))
            )}
          </ol>
        </section>

        <section
          className="lab-investigation-detectors"
          aria-labelledby="investigation-detectors-title"
        >
          <p className="section-label">Same-sample decisions</p>
          <h3 id="investigation-detectors-title">Detector agreement</h3>
          <ol id="investigation-detector-agreement" className="lab-investigation-list">
            {detectorRows(selectedPoint).length === 0 ? (
              <li className="lab-empty-state">
                Run an investigation to compare detector evidence.
              </li>
            ) : (
              detectorRows(selectedPoint).map(([label, detail]) => (
                <li key={label}>
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </li>
              ))
            )}
          </ol>
        </section>
      </div>
    </div>
  );
}
