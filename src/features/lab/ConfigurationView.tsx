import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import robustCovarianceArtifactJson from '../../../models/robust_covariance_v1.json';
import { APPLICATION_VERSION } from '../../core/constants';
import type { EvidenceBuildIdentity } from '../../evidence/types';
import {
  serializeConfigurationReport,
  type ConfigurationModelEvidenceInput,
} from '../../export/configurationReport';
import { serializeDiagnosticReport } from '../../export/reports';
import {
  parseLearnedBaselineArtifact,
  scoreLearnedBaseline,
  type LearnedBaselineScore,
} from '../../ml';
import { DETERMINISTIC_AUTHORITY } from '../../model-registry';
import { detectionProfiles } from '../../profiles';
import { downloadText, slug } from '../../ui/dom';
import {
  pendingBundledModelVerification,
  projectActiveRunConfiguration,
  projectModelRegistryDescriptors,
  projectProfileConfiguration,
  projectRobustCovarianceCompatibility,
  projectTemporalV2Compatibility,
  verifyBundledModelEvidence,
  type BundledModelVerificationEvidence,
  type ModelConfigurationCompatibilityEvidence,
} from './configuration';
import {
  createConfigurationSimulatorController,
  type ConfigurationSimulatorSnapshot,
} from './configurationRuntime';
import type {
  LabConfigurationStreamEvidence,
  LabModelSelectionIntent,
  LabSession,
  LabSessionState,
} from './session';

const pointwiseArtifact = parseLearnedBaselineArtifact(robustCovarianceArtifactJson);
const registryDescriptors = projectModelRegistryDescriptors();
const localBuildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'static-preview',
});
const activeSimulatorPhases = new Set(['running', 'degraded', 'stale']);

function streamEvidenceFromSnapshot(
  snapshot: Readonly<ConfigurationSimulatorSnapshot>,
): LabConfigurationStreamEvidence {
  return {
    phase: snapshot.phase,
    sources: snapshot.aggregate.sources,
    receivedMessages: snapshot.aggregate.messages,
    droppedMessages: snapshot.aggregate.dropped,
    queueDepth: snapshot.aggregate.queue,
    reconnectAttempts: snapshot.aggregate.reconnects,
    maximumHeartbeatAgeMs: snapshot.aggregate.heartbeatAgeMs,
    sourceHealth: snapshot.sourceHealth.map((source) => ({ ...source })),
    injectedFaultIds: [...snapshot.injectedFaultIds],
    ...(snapshot.terminalIssue === null ? {} : { issue: snapshot.terminalIssue }),
  };
}

function noRunCompatibility(
  model: Readonly<BundledModelVerificationEvidence>,
  state: LabSessionState,
): ModelConfigurationCompatibilityEvidence {
  const userSelection = state.pointwiseModelSelection.intent;
  return {
    key: model.key,
    contextLabel: 'Current accepted synthetic telemetry run',
    userSelection,
    supported: false,
    eligible: false,
    active: false,
    authority: DETERMINISTIC_AUTHORITY,
    observed: {
      schemaVersion: '',
      profile: { id: state.profile.id, version: state.profile.version },
      channelUnits: {},
      cadenceMs: null,
      windowLength: 1,
      sourceCadenceMs: {},
    },
    reasons: [{ code: 'NO_SOURCES', detail: 'No accepted synthetic telemetry run is active.' }],
  };
}

function compatibilityLabel(value: Readonly<ModelConfigurationCompatibilityEvidence>): string {
  if (value.active) return 'Supported and active';
  if (value.eligible) return 'Supported, user disabled';
  if (value.userSelection === 'enabled') return 'Requested, inactive';
  return 'Ineligible, disabled';
}

function modelTone(value: Readonly<ModelConfigurationCompatibilityEvidence>): string {
  if (value.active) return 'good';
  if (
    value.userSelection === 'enabled' ||
    value.reasons.some((reason) => /MISMATCH|FAILED/u.test(reason.code))
  ) {
    return 'warning';
  }
  return 'unknown';
}

function modelReportEvidence(
  family: ConfigurationModelEvidenceInput['family'],
  activationPurpose: ConfigurationModelEvidenceInput['activationPurpose'],
  model: Readonly<BundledModelVerificationEvidence>,
  compatibility: Readonly<ModelConfigurationCompatibilityEvidence>,
): ConfigurationModelEvidenceInput {
  return {
    key: model.key,
    family,
    activationPurpose,
    context: compatibility.contextLabel,
    expectedIdentities: {
      artifactSha256: model.artifact.expectedSha256,
      configurationSha256: model.configuration.expectedSha256,
    },
    observedIdentities: {
      artifactSha256: model.artifact.actualSha256,
      configurationSha256: model.configuration.actualSha256,
    },
    identityVerification: {
      artifact: model.artifact.state,
      configuration: model.configuration.state,
    },
    qualityGate: {
      state: model.qualityGate.state,
      storedPassed: model.qualityGate.storedPassed,
      recomputedPassed: model.qualityGate.recomputedPassed,
    },
    userSelection: compatibility.userSelection,
    supported: compatibility.supported,
    reasons: compatibility.reasons.map((reason) => reason.code),
    eligibility: compatibility.eligible ? 'eligible' : 'ineligible',
    active: compatibility.active,
    authority: DETERMINISTIC_AUTHORITY,
  };
}

function researchReportEvidence(): ConfigurationModelEvidenceInput[] {
  return registryDescriptors
    .filter((entry) => entry.activationPurpose === 'research-evidence-only')
    .map((entry) => ({
      key: entry.key,
      family: entry.artifact.family,
      activationPurpose: entry.activationPurpose,
      context: 'Display-only historical research evidence',
      expectedIdentities: {
        artifactSha256: entry.identities.artifactSha256,
        configurationSha256: entry.identities.configurationSha256,
      },
      observedIdentities: { artifactSha256: null, configurationSha256: null },
      identityVerification: { artifact: 'unavailable', configuration: 'unavailable' },
      qualityGate: { state: 'unavailable', storedPassed: null, recomputedPassed: null },
      userSelection: 'disabled',
      supported: false,
      reasons: ['RESEARCH_EVIDENCE_ONLY'],
      eligibility: 'ineligible',
      active: false,
      authority: DETERMINISTIC_AUTHORITY,
    }));
}

function pointwiseScore(
  state: LabSessionState,
  compatibility: Readonly<ModelConfigurationCompatibilityEvidence>,
): LearnedBaselineScore | undefined {
  if (!compatibility.supported || !state.current) return undefined;
  const sample = state.current.run.samples[state.replayIndex];
  if (!sample) return undefined;
  try {
    return scoreLearnedBaseline(pointwiseArtifact, sample.measurements, compatibility.active);
  } catch {
    return undefined;
  }
}

function displayValue(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'Not available' : String(value);
}

function streamStatusLabel(phase: LabConfigurationStreamEvidence['phase']): string {
  switch (phase) {
    case 'idle':
      return 'Not started';
    case 'running':
      return 'Demo active';
    case 'degraded':
      return 'Demo degraded';
    case 'stale':
      return 'Source stale';
    case 'complete':
      return 'Demo complete';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
  }
}

export function ConfigurationView({
  state,
  session,
  buildIdentity,
}: {
  state: LabSessionState;
  session: LabSession;
  buildIdentity?: Readonly<EvidenceBuildIdentity> | undefined;
}) {
  const [bundledModels, setBundledModels] = useState(pendingBundledModelVerification);
  const [simulator] = useState(createConfigurationSimulatorController);
  const simulatorState = useSyncExternalStore(
    simulator.subscribe,
    simulator.getState,
    simulator.getState,
  );
  const suppressStreamPersistence = useRef(false);
  const lifecycleGeneration = useRef(0);
  const cleared = state.message === 'Lab session data cleared. No records were persisted.';
  const clearedRef = useRef(cleared);
  clearedRef.current = cleared;

  useEffect(() => {
    let current = true;
    void verifyBundledModelEvidence().then((evidence) => {
      if (current) setBundledModels(evidence);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++lifecycleGeneration.current;
    const persistTerminal = () => {
      const snapshot = simulator.getState();
      if (
        !suppressStreamPersistence.current &&
        ['complete', 'stopped', 'failed'].includes(snapshot.phase)
      ) {
        session.setConfigurationStream(streamEvidenceFromSnapshot(snapshot));
      }
    };
    const unsubscribe = simulator.subscribe(persistTerminal);
    return () => {
      const before = simulator.getState();
      unsubscribe();
      if (activeSimulatorPhases.has(before.phase)) simulator.stop();
      if (before.phase !== 'idle' && !clearedRef.current) {
        session.setConfigurationStream(streamEvidenceFromSnapshot(simulator.getState()));
      }
      // React Strict Mode replays effect setup and cleanup once in development. Defer only the
      // terminal listener disposal so the replayed setup can invalidate this cleanup. Timers and
      // adapter listeners are still released synchronously by stop() above on a real route exit.
      queueMicrotask(() => {
        if (lifecycleGeneration.current === generation) simulator.dispose();
      });
    };
  }, [session, simulator]);

  useEffect(() => {
    const stopForPageHide = () => simulator.stop();
    window.addEventListener('pagehide', stopForPageHide);
    return () => window.removeEventListener('pagehide', stopForPageHide);
  }, [simulator]);

  const contextIdentity = `${state.profile.id}@${state.profile.version}:${state.current?.run.runId ?? 'none'}:${state.current?.run.provenance.datasetSha256 ?? 'none'}`;
  const previousContext = useRef(contextIdentity);
  useEffect(() => {
    if (
      previousContext.current !== contextIdentity &&
      activeSimulatorPhases.has(simulator.getState().phase)
    ) {
      suppressStreamPersistence.current = cleared;
      simulator.stop();
      suppressStreamPersistence.current = false;
    }
    previousContext.current = contextIdentity;
  }, [cleared, contextIdentity, simulator]);

  const profileEvidence = useMemo(
    () => projectProfileConfiguration(state.profile),
    [state.profile],
  );
  const runEvidence = useMemo(
    () => projectActiveRunConfiguration(state.current?.run, state.profile),
    [state.current?.run, state.profile],
  );
  const pointwiseCompatibility = useMemo(
    () =>
      state.current
        ? projectRobustCovarianceCompatibility(
            state.current.run,
            state.profile,
            bundledModels.robustCovariance,
            state.pointwiseModelSelection.intent,
          )
        : noRunCompatibility(bundledModels.robustCovariance, state),
    [
      bundledModels.robustCovariance,
      state.current,
      state.pointwiseModelSelection.intent,
      state.profile,
    ],
  );
  const temporalCompatibility = useMemo(
    () =>
      projectTemporalV2Compatibility(bundledModels.temporalV2, state.temporalModelSelection.intent),
    [bundledModels.temporalV2, state.temporalModelSelection.intent],
  );
  const temporalDescriptor = registryDescriptors.find(
    (entry) => entry.key === bundledModels.temporalV2.key,
  );
  const score = useMemo(
    () => pointwiseScore(state, pointwiseCompatibility),
    [pointwiseCompatibility, state],
  );
  const liveStreamEvidence = streamEvidenceFromSnapshot(simulatorState);
  const streamEvidence =
    cleared && simulatorState.phase === 'stopped'
      ? state.configurationStream
      : simulatorState.phase === 'idle' && state.configurationStream.phase !== 'idle'
        ? state.configurationStream
        : liveStreamEvidence;
  const exactBuildIdentity = buildIdentity ?? localBuildIdentity;
  const configurationModels = useMemo(
    () => [
      modelReportEvidence(
        'robust-covariance',
        bundledModels.robustCovariance.activationPurpose,
        bundledModels.robustCovariance,
        pointwiseCompatibility,
      ),
      modelReportEvidence(
        'temporal',
        bundledModels.temporalV2.activationPurpose,
        bundledModels.temporalV2,
        temporalCompatibility,
      ),
      ...researchReportEvidence(),
    ],
    [bundledModels, pointwiseCompatibility, temporalCompatibility],
  );
  const enabledRules = profileEvidence.rules.filter((rule) => rule.enabled);
  const running = activeSimulatorPhases.has(simulatorState.phase);

  const setModelSelection = (
    family: 'robust-covariance' | 'temporal',
    intent: LabModelSelectionIntent,
  ) => session.setModelSelection(family, intent);

  return (
    <div className="lab-configuration-view">
      <div className="lab-configuration-heading lab-section-heading">
        <div>
          <p className="section-label">Versions, provenance and experiment controls</p>
          <h2>Configuration</h2>
          <p>Every analysis is tied to explicit schemas, adapters, profiles, rules and hashes.</p>
        </div>
        <div className="lab-configuration-actions">
          <button
            id="export-run"
            type="button"
            disabled={!state.current}
            onClick={() => {
              if (!state.current) return;
              downloadText(
                `${slug(state.current.run.runId)}-diagnostic-report.json`,
                serializeDiagnosticReport(
                  state.current.run,
                  state.current.analysis,
                  state.verification,
                  { includeSourceData: state.includeSourceData },
                ),
                'application/json',
              );
            }}
          >
            Export run evidence
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                `configuration-${slug(state.profile.id)}.json`,
                serializeConfigurationReport({
                  buildIdentity: exactBuildIdentity,
                  currentRun: state.current,
                  selectedProfile: state.profile,
                  modelEvidence: configurationModels,
                  streamEvidence,
                }),
                'application/json',
              )
            }
          >
            Export minimized configuration JSON
          </button>
        </div>
      </div>

      <div className="lab-configuration-grid">
        <section className="lab-configuration-card" aria-labelledby="config-active-title">
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Run and build identity</p>
              <h3 id="config-active-title">Active analysis</h3>
            </div>
            <span
              className="lab-configuration-badge"
              data-quality={runEvidence.fatal ? 'warning' : 'unknown'}
            >
              {runEvidence.state === 'available'
                ? runEvidence.fatal
                  ? 'Blocked'
                  : 'Inspectable'
                : 'No run'}
            </span>
          </div>
          <dl className="lab-configuration-definition-grid">
            <div>
              <dt>React shell</dt>
              <dd>{exactBuildIdentity.applicationVersion}</dd>
            </div>
            <div>
              <dt>Build identity</dt>
              <dd>{exactBuildIdentity.releaseSha}</dd>
            </div>
            <div>
              <dt>Deterministic engine</dt>
              <dd id="config-app-version">{APPLICATION_VERSION}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd id="config-schema">{displayValue(runEvidence.schemaVersion)}</dd>
            </div>
            <div>
              <dt>Adapter</dt>
              <dd id="config-adapter">
                {runEvidence.adapter
                  ? `${runEvidence.adapter.id}@${runEvidence.adapter.version}`
                  : 'None'}
              </dd>
            </div>
            <div>
              <dt>Source-declared profile</dt>
              <dd>
                {runEvidence.declaredProfile
                  ? `${runEvidence.declaredProfile.id}@${runEvidence.declaredProfile.version}`
                  : 'Undeclared'}
              </dd>
            </div>
            <div>
              <dt>Selected analysis profile</dt>
              <dd id="config-profile">{state.profile.label}</dd>
            </div>
            <div>
              <dt>Profile version</dt>
              <dd id="config-profile-version">{state.profile.version}</dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Dataset SHA-256</dt>
              <dd id="config-hash">{displayValue(runEvidence.datasetSha256)}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{runEvidence.acceptedRecords}</dd>
            </div>
            <div>
              <dt>Quarantined</dt>
              <dd>{runEvidence.quarantinedRecords}</dd>
            </div>
            <div>
              <dt>Classification</dt>
              <dd>{state.current?.run.metadata.dataClassification ?? 'SYNTHETIC_UNCLASSIFIED'}</dd>
            </div>
          </dl>
          {runEvidence.profileRelationship === 'mismatch' && (
            <p className="lab-inline-warning" role="status">
              The selected analysis profile differs from the run-declared profile. Run bytes and
              parse-time provenance were not rewritten.
            </p>
          )}
          <label className="checkbox-label">
            <input
              id="include-source-export"
              type="checkbox"
              checked={state.includeSourceData}
              onChange={(event) => session.setSourceExport(event.target.checked)}
            />
            Include uploaded source data in JSON export
          </label>
          <p className="lab-configuration-help">
            Source data remains excluded by default. This opt-in affects only the diagnostic run
            export, never the minimized Configuration report.
          </p>
          <details>
            <summary>Inspect field and unit mappings</summary>
            <div
              className="lab-configuration-table-scroll"
              role="region"
              aria-label="Adapter field and unit mapping table"
              tabIndex={0}
            >
              <table>
                <caption>Adapter field and unit mapping evidence</caption>
                <thead>
                  <tr>
                    <th scope="col">Canonical field</th>
                    <th scope="col">Source field</th>
                    <th scope="col">Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {runEvidence.fieldMappings.length ? (
                    runEvidence.fieldMappings.map((mapping) => (
                      <tr key={`${mapping.canonicalField}:${mapping.sourceField}`}>
                        <th scope="row">{mapping.canonicalField}</th>
                        <td>{mapping.sourceField}</td>
                        <td>{mapping.origin}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3}>No active adapter mapping.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {runEvidence.unitMappings.length > 0 && (
              <ul className="lab-configuration-evidence-list">
                {runEvidence.unitMappings.map((mapping) => (
                  <li key={mapping.canonicalChannel}>
                    <strong>{mapping.canonicalChannel}</strong> {mapping.unit} · {mapping.origin}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </section>

        <section className="lab-configuration-card" aria-labelledby="config-profile-title">
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Selected analysis contract</p>
              <h3 id="config-profile-title">Synthetic profile</h3>
            </div>
            <span className="lab-configuration-badge" data-quality="unknown">
              {profileEvidence.key}
            </span>
          </div>
          <label>
            Synthetic profile
            <select
              id="profile-select"
              value={state.profile.id}
              onChange={(event) => session.setProfile(event.target.value)}
            >
              {detectionProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} · v{profile.version}
                </option>
              ))}
            </select>
          </label>
          <p className="lab-configuration-help">{profileEvidence.description}</p>
          <dl className="lab-configuration-definition-grid">
            <div>
              <dt>Expected cadence</dt>
              <dd>{displayValue(profileEvidence.limits.expectedCadenceMs)} ms</dd>
            </div>
            <div>
              <dt>Cadence tolerance</dt>
              <dd>{displayValue(profileEvidence.limits.cadenceToleranceMs)} ms</dd>
            </div>
            <div>
              <dt>Stale threshold</dt>
              <dd>{displayValue(profileEvidence.limits.staleAfterMs)} ms</dd>
            </div>
            <div>
              <dt>Sequence policy</dt>
              <dd>{profileEvidence.limits.sequencePolicy}</dd>
            </div>
          </dl>
          <div
            className="lab-configuration-table-scroll"
            role="region"
            aria-label="Canonical profile channel table"
            tabIndex={0}
          >
            <table>
              <caption>Canonical channels for the selected profile</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Required</th>
                  <th scope="col">Bounds</th>
                </tr>
              </thead>
              <tbody>
                {profileEvidence.channels.map((channel) => (
                  <tr key={channel.channel}>
                    <th scope="row">{channel.channel}</th>
                    <td>{channel.unit}</td>
                    <td>{channel.required ? 'Yes' : 'No'}</td>
                    <td>
                      {channel.minimum === null && channel.maximum === null
                        ? 'Not declared'
                        : `${displayValue(channel.minimum)} to ${displayValue(channel.maximum)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="lab-configuration-card lab-configuration-card-wide"
          aria-labelledby="config-stream-title"
        >
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Version 1 protocol · deterministic · network-free</p>
              <h3 id="config-stream-title">Streaming simulator</h3>
            </div>
            <span
              id="stream-state"
              className="lab-configuration-badge"
              data-quality={
                streamEvidence.phase === 'failed' || streamEvidence.phase === 'stale'
                  ? 'warning'
                  : streamEvidence.phase === 'complete' || streamEvidence.phase === 'running'
                    ? 'good'
                    : 'unknown'
              }
              role="status"
            >
              {streamStatusLabel(streamEvidence.phase)}
            </span>
          </div>
          <p className="lab-configuration-help">
            This bounded in-browser simulator opens no socket and never becomes a diagnostic run.
            Public aircraft observations remain owned by Live Airspace.
          </p>
          <div className="lab-configuration-actions">
            <button
              id="stream-demo"
              type="button"
              disabled={running}
              onClick={() => simulator.start()}
            >
              Run in-browser demo
            </button>
            <button
              id="stream-disconnect"
              type="button"
              className="quiet-button"
              disabled={!running}
              onClick={() => simulator.stop()}
            >
              Stop simulator
            </button>
          </div>
          <dl className="lab-configuration-health-grid">
            <div>
              <dt>Sources</dt>
              <dd id="health-sources">{streamEvidence.sources}</dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd id="health-messages">{streamEvidence.receivedMessages}</dd>
            </div>
            <div>
              <dt>Dropped</dt>
              <dd id="health-dropped">{streamEvidence.droppedMessages}</dd>
            </div>
            <div>
              <dt>Heartbeat age</dt>
              <dd id="health-heartbeat">
                {streamEvidence.maximumHeartbeatAgeMs === null
                  ? 'N/A'
                  : `${streamEvidence.maximumHeartbeatAgeMs} ms`}
              </dd>
            </div>
            <div>
              <dt>Queue depth</dt>
              <dd id="health-queue">{streamEvidence.queueDepth}</dd>
            </div>
            <div>
              <dt>Reconnect events</dt>
              <dd id="health-reconnects">{streamEvidence.reconnectAttempts}</dd>
            </div>
          </dl>
          {streamEvidence.issue && (
            <p className="lab-inline-error" role="alert">
              {streamEvidence.issue}
            </p>
          )}
          {streamEvidence.sourceHealth.length > 0 && (
            <div
              className="lab-configuration-table-scroll"
              role="region"
              aria-label="Simulator source health table"
              tabIndex={0}
            >
              <table>
                <caption>Bounded per-source simulator health</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col">Messages</th>
                    <th scope="col">Missing</th>
                    <th scope="col">Duplicate</th>
                    <th scope="col">Out of order</th>
                    <th scope="col">Queue</th>
                    <th scope="col">Drops</th>
                  </tr>
                </thead>
                <tbody>
                  {streamEvidence.sourceHealth.map((source) => (
                    <tr key={source.sourceId}>
                      <th scope="row">{source.sourceId}</th>
                      <td>{source.status}</td>
                      <td>{source.receivedMessages}</td>
                      <td>{source.missingMessages}</td>
                      <td>{source.duplicateMessages}</td>
                      <td>{source.outOfOrderMessages}</td>
                      <td>{source.remoteQueueDepth}</td>
                      <td>{source.localDroppedMessages + source.remoteDroppedMessages}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="lab-configuration-card" aria-labelledby="config-pointwise-title">
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Experimental comparison only</p>
              <h3 id="config-pointwise-title">Learned baseline</h3>
            </div>
            <span
              id="model-state"
              className="lab-configuration-badge"
              data-quality={modelTone(pointwiseCompatibility)}
            >
              {compatibilityLabel(pointwiseCompatibility)}
            </span>
          </div>
          <p className="lab-configuration-help">
            Deterministic rules remain authoritative. Activation requires an exact current-run
            contract, verified identities, a recomputed quality gate and explicit selection.
          </p>
          <dl className="lab-configuration-definition-grid">
            <div>
              <dt>Model version</dt>
              <dd id="model-version">{pointwiseArtifact.modelVersion}</dd>
            </div>
            <div>
              <dt>Held-out F1</dt>
              <dd id="model-f1">{pointwiseArtifact.evaluation.metrics.f1.toFixed(3)}</dd>
            </div>
            <div>
              <dt>False-positive rate</dt>
              <dd id="model-fpr">
                {(pointwiseArtifact.evaluation.metrics.falsePositiveRate * 100).toFixed(2)}%
              </dd>
            </div>
            <div>
              <dt>Current anomaly score</dt>
              <dd id="model-score">
                {score
                  ? `${score.score.toFixed(2)} / ${score.threshold.toFixed(2)} · ${score.active ? 'active advisory' : 'preview'}`
                  : 'N/A for this run'}
              </dd>
            </div>
            <div>
              <dt>Artifact identity</dt>
              <dd>{bundledModels.robustCovariance.artifact.state}</dd>
            </div>
            <div>
              <dt>Quality gate</dt>
              <dd>{bundledModels.robustCovariance.qualityGate.state}</dd>
            </div>
          </dl>
          <label className="checkbox-label">
            <input
              id="learned-model-enabled"
              type="checkbox"
              checked={state.pointwiseModelSelection.intent === 'enabled'}
              disabled={!pointwiseCompatibility.eligible}
              onChange={(event) =>
                setModelSelection(
                  'robust-covariance',
                  event.target.checked ? 'enabled' : 'disabled',
                )
              }
            />
            Enable experimental pointwise comparison
          </label>
          <div
            id="model-contributions"
            className="lab-configuration-contributions"
            role="list"
            aria-label="Per-channel residual contributions"
          >
            {score?.contributions.map((contribution) => (
              <div key={contribution.channel} role="listitem">
                <span>{contribution.channel}</span>
                <meter min={0} max={1} value={contribution.absoluteShare}>
                  {contribution.absoluteShare}
                </meter>
                <strong>{(contribution.absoluteShare * 100).toFixed(1)}%</strong>
              </div>
            ))}
          </div>
          <div className="lab-configuration-reasons" aria-label="Pointwise compatibility evidence">
            {pointwiseCompatibility.reasons.length === 0 ? (
              <p>Every exact compatibility and eligibility gate passes.</p>
            ) : (
              <ul>
                {pointwiseCompatibility.reasons.map((reason, index) => (
                  <li key={`${reason.code}:${index}`}>
                    <strong>{reason.code}</strong>: {reason.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="lab-configuration-card" aria-labelledby="config-temporal-title">
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Fixed-wing Investigation context</p>
              <h3 id="config-temporal-title">Temporal model</h3>
            </div>
            <span
              id="temporal-model-state"
              className="lab-configuration-badge"
              data-quality={modelTone(temporalCompatibility)}
            >
              {compatibilityLabel(temporalCompatibility)}
            </span>
          </div>
          <p className="lab-configuration-help">
            Eligibility is evaluated against the fixed-wing Investigation generator, not inferred
            from the active diagnostic profile. Deterministic rules remain authoritative.
          </p>
          <label className="checkbox-label">
            <input
              id="temporal-model-enabled"
              type="checkbox"
              checked={state.temporalModelSelection.intent === 'enabled'}
              disabled={!temporalCompatibility.eligible}
              onChange={(event) =>
                setModelSelection('temporal', event.target.checked ? 'enabled' : 'disabled')
              }
            />
            Enable experimental temporal hypotheses
          </label>
          <dl className="lab-configuration-definition-grid">
            <div>
              <dt>Registry entry</dt>
              <dd id="temporal-registry-entry">{bundledModels.temporalV2.key}</dd>
            </div>
            <div>
              <dt>Compatibility</dt>
              <dd id="temporal-compatibility">{compatibilityLabel(temporalCompatibility)}</dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Artifact SHA-256</dt>
              <dd id="temporal-artifact-hash">
                {displayValue(
                  bundledModels.temporalV2.artifact.actualSha256 ??
                    bundledModels.temporalV2.artifact.expectedSha256,
                )}
              </dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Configuration SHA-256</dt>
              <dd id="temporal-config-hash">
                {displayValue(
                  bundledModels.temporalV2.configuration.actualSha256 ??
                    bundledModels.temporalV2.configuration.expectedSha256,
                )}
              </dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd id="temporal-window">
                {temporalCompatibility.observed.windowLength} samples at{' '}
                {displayValue(temporalCompatibility.observed.cadenceMs)} ms
              </dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Deterministic rules</dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Training evidence</dt>
              <dd id="temporal-training-evidence">
                {temporalDescriptor
                  ? `${temporalDescriptor.evidence.training.seedSummary} · ${temporalDescriptor.evidence.training.path}${temporalDescriptor.evidence.training.jsonPointer}`
                  : 'Not available'}
              </dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Calibration evidence</dt>
              <dd id="temporal-calibration-evidence">
                {temporalDescriptor
                  ? `${temporalDescriptor.evidence.calibration.seedSummary} · ${temporalDescriptor.evidence.calibration.path}${temporalDescriptor.evidence.calibration.jsonPointer}`
                  : 'Not available'}
              </dd>
            </div>
            <div className="lab-configuration-wide-value">
              <dt>Held-out evidence</dt>
              <dd id="temporal-evaluation-evidence">
                {temporalDescriptor
                  ? `${temporalDescriptor.evidence.evaluation.seedSummary} · ${temporalDescriptor.evidence.evaluation.path}${temporalDescriptor.evidence.evaluation.jsonPointer}`
                  : 'Not available'}
              </dd>
            </div>
          </dl>
          <div id="temporal-compatibility-reasons" className="lab-configuration-reasons">
            {temporalCompatibility.reasons.length === 0 ? (
              <p>
                Schema, profile, channels, units, cadence, window, artifact, configuration and
                quality gates match.
              </p>
            ) : (
              <ul>
                {temporalCompatibility.reasons.map((reason, index) => (
                  <li key={`${reason.code}:${index}`}>
                    <strong>{reason.code}</strong>: {reason.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section
          className="lab-configuration-card lab-configuration-card-wide"
          aria-labelledby="config-registry-title"
        >
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Immutable exact-version descriptors</p>
              <h3 id="config-registry-title">Model registry evidence</h3>
            </div>
            <strong>{registryDescriptors.length}</strong>
          </div>
          <div className="lab-configuration-registry-list">
            {registryDescriptors.map((entry) => (
              <details key={entry.key}>
                <summary>
                  <strong>{entry.key}</strong> · {entry.activationPurpose}
                </summary>
                <dl className="lab-configuration-definition-grid">
                  <div>
                    <dt>Family</dt>
                    <dd>{entry.artifact.family}</dd>
                  </div>
                  <div>
                    <dt>Availability</dt>
                    <dd>{entry.availability}</dd>
                  </div>
                  <div>
                    <dt>Profile</dt>
                    <dd>
                      {entry.profile.id}@{entry.profile.version}
                    </dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>
                      {entry.compatibility.windowLength} at {entry.compatibility.cadenceMs} ms
                    </dd>
                  </div>
                  <div className="lab-configuration-wide-value">
                    <dt>Artifact SHA-256</dt>
                    <dd>{displayValue(entry.identities.artifactSha256)}</dd>
                  </div>
                  <div className="lab-configuration-wide-value">
                    <dt>Configuration SHA-256</dt>
                    <dd>{displayValue(entry.identities.configurationSha256)}</dd>
                  </div>
                  <div className="lab-configuration-wide-value">
                    <dt>Training</dt>
                    <dd>
                      {entry.evidence.training.seedSummary} · {entry.evidence.training.path}
                      {entry.evidence.training.jsonPointer}
                    </dd>
                  </div>
                  <div className="lab-configuration-wide-value">
                    <dt>Calibration</dt>
                    <dd>
                      {entry.evidence.calibration.seedSummary} · {entry.evidence.calibration.path}
                      {entry.evidence.calibration.jsonPointer}
                    </dd>
                  </div>
                  <div className="lab-configuration-wide-value">
                    <dt>Held-out evaluation</dt>
                    <dd>
                      {entry.evidence.evaluation.seedSummary} · {entry.evidence.evaluation.path}
                      {entry.evidence.evaluation.jsonPointer}
                    </dd>
                  </div>
                  <div>
                    <dt>Default selection</dt>
                    <dd>{entry.defaultUserSelection}</dd>
                  </div>
                  <div>
                    <dt>Authority</dt>
                    <dd>{entry.authority}</dd>
                  </div>
                </dl>
              </details>
            ))}
          </div>
        </section>

        <section
          className="lab-configuration-card lab-configuration-card-wide"
          aria-labelledby="config-rules-title"
        >
          <div className="lab-configuration-card-heading">
            <div>
              <p className="section-label">Profile-driven deterministic logic</p>
              <h3 id="config-rules-title">Enabled rules</h3>
            </div>
            <strong id="rule-count">{enabledRules.length}</strong>
          </div>
          <div
            className="lab-configuration-table-scroll"
            role="region"
            aria-label="Enabled deterministic rules table"
            tabIndex={0}
          >
            <table>
              <caption>Rules enabled by the selected synthetic profile</caption>
              <thead>
                <tr>
                  <th scope="col">Rule ID and evidence</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Condition</th>
                </tr>
              </thead>
              <tbody id="rules-body">
                {enabledRules.map((rule) => (
                  <tr key={rule.id}>
                    <th scope="row">
                      <strong>{rule.id}</strong>
                      <span>
                        {rule.label}. {rule.description}
                      </span>
                    </th>
                    <td>{rule.kind}</td>
                    <td>{rule.severity}</td>
                    <td>{rule.condition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
