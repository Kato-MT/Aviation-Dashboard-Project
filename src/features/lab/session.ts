import baselineCsv from '../../../data/flight.csv?raw';
import { legacyCsvAdapter, versionedJsonAdapter } from '../../adapters';
import {
  analyzeTelemetryRun,
  DEFAULT_INPUT_LIMITS,
  type AnalysisResult,
  type DetectionProfile,
  type Finding,
  type TelemetryRun,
  type VerificationRun,
} from '../../core';
import { utf8ByteLength } from '../../core/limits';
import {
  genericFixedWingProfile,
  getDetectionProfile,
  includedBaselineProfile,
} from '../../profiles';
import { generateSyntheticDocument } from '../../ui/generate';
import { createVerificationRun } from '../../verification';
import {
  DECLARED_FAULT_SCENARIOS,
  getFaultScenario,
  injectFaultScenario,
  injectLegacyCsvFault,
  type FaultScenarioId,
} from '../../faults';
import {
  DEFAULT_DIAGNOSTICS_FILTERS,
  normalizeDiagnosticsFilters,
  type DiagnosticsFilters,
} from './diagnostics';
import { robustCovarianceRegistryEntry, temporalFaultRegistryEntry } from '../../model-registry';
import { getTemporalFaultDefinition } from '../../temporal/generator';
import type { TemporalFaultId } from '../../temporal/types';
import type {
  InvestigationComparisonIdentity,
  InvestigationComparisonWaveform,
  InvestigationOverlayVisibility,
} from '../../ui/investigationCharts';
import {
  defaultInvestigationRunner,
  INVESTIGATION_DEFAULT_CONTROLS,
  validateInvestigationControls,
  type InvestigationModelIntents,
  type InvestigationRunner,
  type InvestigationSettledSnapshot,
} from './investigation';
import {
  CampaignCancelledError,
  TemporalCampaignBrowserClient,
  type BrowserCampaignRunOptions,
} from '../../campaign/browserClient';
import type { CampaignProgress, CampaignResult, CampaignSpec } from '../../campaign/types';
import {
  CAMPAIGN_DEFAULT_SEEDS_INPUT,
  parseCampaignSeeds,
  prepareCampaignRun,
  settleCampaignResult,
  type CampaignSettledSnapshot,
} from './campaign';

export type LabInputFormat = 'csv' | 'json' | 'generated' | 'injected';
export type ReplayInterval = 600 | 300 | 150;
export type FaultCandidateStatus = 'idle' | 'injecting';
export type LabModelFamily = 'robust-covariance' | 'temporal';
export type LabModelSelectionIntent = 'disabled' | 'enabled';
export type LabConfigurationStreamPhase =
  'idle' | 'running' | 'degraded' | 'stale' | 'complete' | 'stopped' | 'failed';
export type LabInvestigationWork =
  | Readonly<{ phase: 'idle'; issue?: string | undefined }>
  | Readonly<{ phase: 'analyzing'; issue?: undefined }>
  | Readonly<{ phase: 'failed'; issue: string }>;
export type LabCampaignPhase =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'completed-with-errors'
  | 'cancelled'
  | 'stopped'
  | 'failed';
export const MAX_FAULT_SEED = 2_147_483_647;
export const INVESTIGATION_DEFAULT_OVERLAYS: Readonly<InvestigationOverlayVisibility> =
  Object.freeze({
    observedAltitude: true,
    predictedAltitude: true,
    uncertainty: true,
    airspeed: true,
    fuel: true,
    residuals: true,
    phases: true,
    faultMarkers: true,
    comparisonBaseline: true,
  });
export interface LabModelSelection {
  registryEntryId: string;
  modelVersion: string;
  intent: LabModelSelectionIntent;
}
export interface LabConfigurationSourceHealth {
  sourceId: string;
  status: string;
  receivedMessages: number;
  duplicateMessages: number;
  outOfOrderMessages: number;
  missingMessages: number;
  remoteQueueDepth: number;
  remoteDroppedMessages: number;
  localDroppedMessages: number;
  reconnectAttempts: number;
  heartbeatAgeMs?: number | undefined;
}
export interface LabConfigurationStreamEvidence {
  phase: LabConfigurationStreamPhase;
  sources: number;
  receivedMessages: number;
  droppedMessages: number;
  queueDepth: number;
  reconnectAttempts: number;
  maximumHeartbeatAgeMs: number | null;
  sourceHealth: readonly LabConfigurationSourceHealth[];
  injectedFaultIds: readonly string[];
  issue?: string | undefined;
}
export interface CapturedLabRun {
  run: TelemetryRun;
  analysis: AnalysisResult;
  label: string;
}
export interface LoadedLabRun extends CapturedLabRun {
  label: string;
  sourceText?: string | undefined;
  inputFormat: LabInputFormat;
}
export interface CapturedInvestigationBaseline {
  readonly capturedAt: string;
  readonly scenarioId: TemporalFaultId | 'nominal';
  readonly seed: number;
  readonly identity: Readonly<InvestigationComparisonIdentity>;
  readonly waveform: Readonly<InvestigationComparisonWaveform>;
}
export interface LabInvestigationState {
  readonly scenarioId: TemporalFaultId | 'nominal';
  readonly seedInput: string;
  readonly sampleCountInput: string;
  readonly overlays: Readonly<InvestigationOverlayVisibility>;
  readonly work: LabInvestigationWork;
  readonly current: Readonly<InvestigationSettledSnapshot> | undefined;
  readonly baseline: Readonly<CapturedInvestigationBaseline> | undefined;
  readonly cursorPosition: number;
  readonly resultSettingsStale: boolean;
}
export interface LabCampaignState {
  readonly seedsInput: string;
  readonly phase: LabCampaignPhase;
  readonly progress: Readonly<CampaignProgress> | undefined;
  readonly current: Readonly<CampaignSettledSnapshot> | undefined;
  readonly resultSettingsStale: boolean;
  readonly issue: string | undefined;
}
export interface LabCampaignClient {
  run(spec: CampaignSpec, options?: BrowserCampaignRunOptions): Promise<CampaignResult>;
  cancel(): boolean;
  terminate(): void;
}
export interface LabSessionDependencies {
  readonly investigationRunner?: InvestigationRunner | undefined;
  readonly campaignClientFactory?: (() => LabCampaignClient) | undefined;
  readonly now?: (() => string) | undefined;
}
export interface LabSessionState {
  status: 'idle' | 'loading' | 'ready' | 'blocked' | 'error';
  profile: DetectionProfile;
  current: LoadedLabRun | undefined;
  baseline: CapturedLabRun | undefined;
  candidate: CapturedLabRun | undefined;
  verification: VerificationRun | undefined;
  comparisonIssue: string | undefined;
  replayIndex: number;
  replayPlaying: boolean;
  replayInterval: ReplayInterval;
  includeSourceData: boolean;
  pointwiseModelSelection: LabModelSelection;
  temporalModelSelection: LabModelSelection;
  configurationStream: LabConfigurationStreamEvidence;
  diagnosticsFilters: DiagnosticsFilters;
  faultScenarioId: FaultScenarioId;
  faultSeed: string;
  faultStatus: FaultCandidateStatus;
  faultIssue: string | undefined;
  investigation: LabInvestigationState;
  campaign: LabCampaignState;
  message: string;
}

function initialState(): LabSessionState {
  return {
    status: 'idle',
    profile: includedBaselineProfile,
    current: undefined,
    baseline: undefined,
    candidate: undefined,
    verification: undefined,
    comparisonIssue: undefined,
    replayIndex: 0,
    replayPlaying: false,
    replayInterval: 300,
    includeSourceData: false,
    pointwiseModelSelection: {
      registryEntryId: robustCovarianceRegistryEntry.registryEntryId,
      modelVersion: robustCovarianceRegistryEntry.modelVersion,
      intent: 'disabled',
    },
    temporalModelSelection: {
      registryEntryId: temporalFaultRegistryEntry.registryEntryId,
      modelVersion: temporalFaultRegistryEntry.modelVersion,
      intent: 'disabled',
    },
    configurationStream: {
      phase: 'idle',
      sources: 0,
      receivedMessages: 0,
      droppedMessages: 0,
      queueDepth: 0,
      reconnectAttempts: 0,
      maximumHeartbeatAgeMs: null,
      sourceHealth: [],
      injectedFaultIds: [],
    },
    diagnosticsFilters: { ...DEFAULT_DIAGNOSTICS_FILTERS },
    faultScenarioId: DECLARED_FAULT_SCENARIOS[0].id,
    faultSeed: '1337',
    faultStatus: 'idle',
    faultIssue: undefined,
    investigation: {
      scenarioId: INVESTIGATION_DEFAULT_CONTROLS.scenarioId,
      seedInput: INVESTIGATION_DEFAULT_CONTROLS.seed,
      sampleCountInput: INVESTIGATION_DEFAULT_CONTROLS.sampleCount,
      overlays: { ...INVESTIGATION_DEFAULT_OVERLAYS },
      work: { phase: 'idle' },
      current: undefined,
      baseline: undefined,
      cursorPosition: 0,
      resultSettingsStale: false,
    },
    campaign: {
      seedsInput: CAMPAIGN_DEFAULT_SEEDS_INPUT,
      phase: 'idle',
      progress: undefined,
      current: undefined,
      resultSettingsStale: false,
      issue: undefined,
    },
    message: '',
  };
}

function declaredProfile(text: string): DetectionProfile | undefined {
  try {
    const parsed = JSON.parse(text) as { profile?: { id?: unknown; version?: unknown } } | null;
    if (typeof parsed?.profile?.id !== 'string') return undefined;
    return getDetectionProfile(
      parsed.profile.id,
      typeof parsed.profile.version === 'string' ? parsed.profile.version : undefined,
    );
  } catch {
    return undefined;
  }
}

/** In-memory Lab data survives navigation; activity is scoped to each route activation. */
export class LabSession {
  private state = initialState();
  private active = false;
  private initialized = false;
  private generation = 0;
  private investigationGeneration = 0;
  private campaignGeneration = 0;
  private campaignClient: LabCampaignClient | undefined;
  private replayTimer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly investigationRunner: InvestigationRunner;
  private readonly campaignClientFactory: () => LabCampaignClient;
  private readonly now: () => string;

  constructor(dependencies: LabSessionDependencies = {}) {
    this.investigationRunner = dependencies.investigationRunner ?? defaultInvestigationRunner;
    this.campaignClientFactory =
      dependencies.campaignClientFactory ?? (() => new TemporalCampaignBrowserClient());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  readonly getState = (): LabSessionState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    if (!this.initialized) await this.loadIncludedBaseline();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.investigationGeneration += 1;
    this.campaignGeneration += 1;
    this.terminateCampaignClient();
    this.clearReplayTimer();
    const faultWasPending = this.state.faultStatus === 'injecting';
    const investigationWasPending = this.state.investigation.work.phase === 'analyzing';
    const campaignWasPending = this.campaignWorkActive();
    const investigation = investigationWasPending
      ? {
          ...this.state.investigation,
          work: {
            phase: 'idle' as const,
            issue: 'Investigation analysis was cancelled when the Lab closed.',
          },
        }
      : this.state.investigation;
    const campaign = campaignWasPending
      ? {
          ...this.state.campaign,
          phase: 'stopped' as const,
          issue: 'Campaign stopped when the Lab closed. No verified partial evidence was returned.',
        }
      : this.state.campaign;
    if (this.state.status === 'loading') {
      this.patch({
        status: 'idle',
        replayPlaying: false,
        faultStatus: 'idle',
        faultIssue: faultWasPending
          ? 'Fault candidate creation was cancelled when the Lab closed.'
          : this.state.faultIssue,
        investigation,
        campaign,
        message: 'The pending import was cancelled when the Lab closed.',
      });
    } else if (
      this.state.replayPlaying ||
      faultWasPending ||
      investigationWasPending ||
      campaignWasPending
    ) {
      this.patch({
        replayPlaying: false,
        faultStatus: 'idle',
        faultIssue: faultWasPending
          ? 'Fault candidate creation was cancelled when the Lab closed.'
          : this.state.faultIssue,
        investigation,
        campaign,
        ...(faultWasPending
          ? { message: 'The pending fault candidate was cancelled when the Lab closed.' }
          : {}),
      });
    }
  }

  clear(): void {
    this.generation += 1;
    this.investigationGeneration += 1;
    this.campaignGeneration += 1;
    this.terminateCampaignClient();
    this.clearReplayTimer();
    this.initialized = true;
    this.state = {
      ...initialState(),
      message: 'Lab session data cleared. No records were persisted.',
    };
    this.emit();
  }

  setSourceExport(includeSourceData: boolean): void {
    if (this.active) this.patch({ includeSourceData });
  }

  setModelSelection(family: LabModelFamily, intent: LabModelSelectionIntent): void {
    if (!this.active) return;
    const key =
      family === 'robust-covariance' ? 'pointwiseModelSelection' : 'temporalModelSelection';
    const current = this.state[key];
    if (current.intent === intent) return;
    this.investigationGeneration += 1;
    const pointwiseIntent =
      family === 'robust-covariance' ? intent : this.state.pointwiseModelSelection.intent;
    const temporalIntent =
      family === 'temporal' ? intent : this.state.temporalModelSelection.intent;
    const settled = this.state.investigation.current;
    this.patch({
      [key]: { ...current, intent },
      investigation: {
        ...this.state.investigation,
        work:
          this.state.investigation.work.phase === 'analyzing'
            ? {
                phase: 'idle',
                issue: 'Investigation analysis was cancelled because model intent changed.',
              }
            : this.state.investigation.work,
        resultSettingsStale:
          settled !== undefined &&
          (settled.modelIntents.robustCovariance !== pointwiseIntent ||
            settled.modelIntents.temporalModel !== temporalIntent),
      },
    });
  }

  setInvestigationScenario(id: string): void {
    if (!this.active || (id !== 'nominal' && getTemporalFaultDefinition(id) === undefined)) return;
    const scenarioId = id as TemporalFaultId | 'nominal';
    if (this.state.investigation.scenarioId === scenarioId) return;
    this.updateInvestigationRequest({ scenarioId });
  }

  setInvestigationSeedInput(seedInput: string): void {
    if (!this.active || this.state.investigation.seedInput === seedInput) return;
    this.updateInvestigationRequest({ seedInput });
  }

  setInvestigationSampleCountInput(sampleCountInput: string): void {
    if (!this.active || this.state.investigation.sampleCountInput === sampleCountInput) return;
    this.updateInvestigationRequest({ sampleCountInput });
  }

  setInvestigationOverlay(overlay: keyof InvestigationOverlayVisibility, visible: boolean): void {
    if (!this.active || this.state.investigation.overlays[overlay] === visible) return;
    this.patch({
      investigation: {
        ...this.state.investigation,
        overlays: { ...this.state.investigation.overlays, [overlay]: visible },
      },
    });
  }

  setInvestigationPosition(position: number): void {
    if (!this.active || !Number.isFinite(position)) return;
    const pointCount = this.state.investigation.current?.analysis.points.length ?? 0;
    const maximum = Math.max(0, pointCount - 1);
    const cursorPosition = Math.max(0, Math.min(maximum, Math.floor(position)));
    if (cursorPosition === this.state.investigation.cursorPosition) return;
    this.patch({
      investigation: { ...this.state.investigation, cursorPosition },
    });
  }

  seekInvestigationSample(sampleIndex: number): void {
    if (!this.active || !Number.isFinite(sampleIndex)) return;
    const position = this.state.investigation.current?.analysis.points.findIndex(
      (point) => point.sampleIndex === sampleIndex,
    );
    if (position !== undefined && position >= 0) this.setInvestigationPosition(position);
  }

  async runInvestigation(): Promise<boolean> {
    if (!this.active) return false;
    let configuration;
    try {
      configuration = validateInvestigationControls({
        scenarioId: this.state.investigation.scenarioId,
        seed: this.state.investigation.seedInput,
        sampleCount: this.state.investigation.sampleCountInput,
      });
    } catch (error) {
      this.patch({
        investigation: {
          ...this.state.investigation,
          work: {
            phase: 'failed',
            issue: this.investigationIssue(error, 'Investigation configuration is invalid.'),
          },
        },
      });
      return false;
    }

    const generation = ++this.investigationGeneration;
    const modelIntents = this.investigationModelIntents();
    this.patch({
      investigation: {
        ...this.state.investigation,
        work: { phase: 'analyzing' },
      },
    });
    if (!this.currentInvestigationGeneration(generation)) return false;

    try {
      const current = await this.investigationRunner(configuration, modelIntents);
      if (!this.currentInvestigationGeneration(generation)) return false;
      const defaultPosition = Math.max(
        0,
        current.analysis.points.findIndex(
          (point) => point.sampleIndex === current.defaultSelectedIndex,
        ),
      );
      this.patch({
        investigation: {
          ...this.state.investigation,
          work: { phase: 'idle' },
          current,
          cursorPosition: defaultPosition,
          resultSettingsStale: false,
        },
      });
      return true;
    } catch (error) {
      if (this.currentInvestigationGeneration(generation)) {
        this.patch({
          investigation: {
            ...this.state.investigation,
            work: {
              phase: 'failed',
              issue: this.investigationIssue(error, 'Investigation analysis failed.'),
            },
          },
        });
      }
      return false;
    }
  }

  captureInvestigationBaseline(): boolean {
    if (!this.active) return false;
    const current = this.state.investigation.current;
    if (!current) {
      this.patch({
        investigation: {
          ...this.state.investigation,
          work: { phase: 'failed', issue: 'Run an investigation before capturing a baseline.' },
        },
      });
      return false;
    }
    const baseline: CapturedInvestigationBaseline = Object.freeze({
      capturedAt: this.now(),
      scenarioId: current.configuration.scenarioId,
      seed: current.configuration.seed,
      identity: current.comparisonIdentity,
      waveform: Object.freeze({
        sampleIndices: current.chartSeries.sampleIndices,
        observedAltitude: current.chartSeries.observedAltitude,
        predictedAltitude: current.chartSeries.predictedAltitude,
      }),
    });
    this.patch({
      investigation: {
        ...this.state.investigation,
        baseline,
        overlays: { ...this.state.investigation.overlays, comparisonBaseline: true },
        work: { phase: 'idle' },
      },
    });
    return true;
  }

  leaveInvestigation(reason = 'Investigation closed'): void {
    if (this.state.investigation.work.phase !== 'analyzing') return;
    this.investigationGeneration += 1;
    this.patch({
      investigation: {
        ...this.state.investigation,
        work: { phase: 'idle', issue: `${reason}. Pending analysis was cancelled.` },
      },
    });
  }

  setCampaignSeedsInput(seedsInput: string): void {
    if (
      !this.active ||
      this.campaignWorkActive() ||
      this.state.campaign.seedsInput === seedsInput
    ) {
      return;
    }
    this.campaignGeneration += 1;
    const current = this.state.campaign.current;
    let resultSettingsStale = false;
    if (current) {
      try {
        const seeds = parseCampaignSeeds(seedsInput);
        resultSettingsStale =
          seeds.length !== current.configuration.seeds.length ||
          seeds.some((seed, index) => seed !== current.configuration.seeds[index]);
      } catch {
        resultSettingsStale = true;
      }
    }
    this.patch({
      campaign: {
        ...this.state.campaign,
        seedsInput,
        resultSettingsStale,
        issue: undefined,
      },
    });
  }

  async runCampaign(): Promise<boolean> {
    if (!this.active || this.campaignWorkActive()) return false;
    let prepared;
    try {
      prepared = prepareCampaignRun({ seedsInput: this.state.campaign.seedsInput }, this.now());
    } catch (error) {
      this.patch({
        campaign: {
          ...this.state.campaign,
          phase: 'failed',
          progress: undefined,
          issue: this.campaignIssue(error, 'Campaign configuration is invalid.'),
        },
      });
      return false;
    }

    const generation = ++this.campaignGeneration;
    let client: LabCampaignClient;
    try {
      client = this.campaignClientFactory();
    } catch (error) {
      if (this.currentCampaignGeneration(generation)) {
        this.patch({
          campaign: {
            ...this.state.campaign,
            phase: 'failed',
            progress: undefined,
            issue: this.campaignIssue(error, 'Campaign worker could not be created.'),
          },
        });
      }
      return false;
    }
    this.campaignClient = client;
    const initialProgress: CampaignProgress = {
      campaignId: prepared.spec.campaignId,
      completedCases: 0,
      totalCases: prepared.configuration.matrix.plannedCases,
      currentCaseId: null,
      currentCaseStatus: null,
    };
    this.patch({
      campaign: {
        ...this.state.campaign,
        phase: 'running',
        progress: initialProgress,
        issue: undefined,
      },
    });

    try {
      const result = await client.run(prepared.spec, {
        onProgress: (progress) => {
          if (!this.currentCampaignGeneration(generation, client)) return;
          this.patch({
            campaign: {
              ...this.state.campaign,
              progress: Object.freeze({ ...progress }),
            },
          });
        },
      });
      const current = await settleCampaignResult(prepared, result, this.now());
      if (!this.currentCampaignGeneration(generation, client)) return false;
      this.patch({
        campaign: {
          ...this.state.campaign,
          phase: current.result.status,
          progress: this.campaignTerminalProgress(current),
          current,
          resultSettingsStale: false,
          issue:
            current.result.status === 'completed-with-errors'
              ? `${current.result.summary.failedCases.toLocaleString('en-US')} contained case failures were excluded from aggregate metrics.`
              : undefined,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof CampaignCancelledError) {
        try {
          const current = await settleCampaignResult(prepared, error.partialResult, this.now());
          if (!this.currentCampaignGeneration(generation, client)) return false;
          this.patch({
            campaign: {
              ...this.state.campaign,
              phase: 'cancelled',
              progress: this.campaignTerminalProgress(current),
              current,
              resultSettingsStale: false,
              issue: `Cancellation returned verified partial evidence for ${current.result.summary.attemptedCases.toLocaleString('en-US')} processed cases.`,
            },
          });
          return true;
        } catch (settlementError) {
          if (this.currentCampaignGeneration(generation, client)) {
            this.patch({
              campaign: {
                ...this.state.campaign,
                phase: 'failed',
                issue: this.campaignIssue(
                  settlementError,
                  'Campaign cancellation evidence failed integrity verification.',
                ),
              },
            });
          }
          return false;
        }
      }
      if (this.currentCampaignGeneration(generation, client)) {
        this.patch({
          campaign: {
            ...this.state.campaign,
            phase: 'failed',
            issue: this.campaignIssue(error, 'Campaign execution failed.'),
          },
        });
      }
      return false;
    } finally {
      if (this.campaignClient === client) this.terminateCampaignClient();
    }
  }

  cancelCampaign(): boolean {
    if (!this.active || this.state.campaign.phase !== 'running' || !this.campaignClient) {
      return false;
    }
    if (!this.campaignClient.cancel()) return false;
    this.patch({
      campaign: {
        ...this.state.campaign,
        phase: 'cancelling',
        issue: 'Cancellation requested. Waiting for verified partial evidence.',
      },
    });
    return true;
  }

  leaveCampaign(reason = 'Campaign closed'): void {
    if (!this.campaignWorkActive()) return;
    this.campaignGeneration += 1;
    this.terminateCampaignClient();
    this.patch({
      campaign: {
        ...this.state.campaign,
        phase: 'stopped',
        issue: `${reason}. The active worker was terminated before verified partial evidence was returned.`,
      },
    });
  }

  setConfigurationStream(evidence: LabConfigurationStreamEvidence): void {
    const terminal = ['complete', 'stopped', 'failed'].includes(evidence.phase);
    if (!this.active && !terminal) return;
    this.patch({
      configurationStream: {
        ...evidence,
        sourceHealth: evidence.sourceHealth.slice(0, 16).map((source) => ({ ...source })),
        injectedFaultIds: [...new Set(evidence.injectedFaultIds)].slice(0, 32),
        ...(evidence.issue === undefined ? {} : { issue: evidence.issue.slice(0, 500) }),
      },
    });
  }

  setDiagnosticsFilters(value: Partial<DiagnosticsFilters>): void {
    if (!this.active) return;
    this.patch({ diagnosticsFilters: { ...this.state.diagnosticsFilters, ...value } });
  }

  clearDiagnosticsFilters(): void {
    if (this.active) this.patch({ diagnosticsFilters: { ...DEFAULT_DIAGNOSTICS_FILTERS } });
  }

  setFaultScenario(id: string): void {
    if (!this.active || !getFaultScenario(id)) return;
    this.patch({ faultScenarioId: id as FaultScenarioId, faultIssue: undefined });
  }

  setFaultSeed(value: string): void {
    if (this.active) this.patch({ faultSeed: value, faultIssue: undefined });
  }

  cancelFaultCandidate(): void {
    if (!this.active || this.state.faultStatus !== 'injecting') return;
    this.generation += 1;
    this.patch({
      faultStatus: 'idle',
      faultIssue: 'Fault candidate creation was cancelled when Diagnostics closed.',
      message: 'The pending fault candidate was cancelled when Diagnostics closed.',
    });
  }

  async loadIncludedBaseline(): Promise<void> {
    if (!this.active) return;
    const generation = this.prepare();
    await this.parse(baselineCsv, 'csv', 'Included 85-record synthetic baseline', generation);
    if (!this.currentGeneration(generation) || !this.state.current) return;
    const { run, analysis, label } = this.state.current;
    this.patch({
      baseline: { run, analysis, label },
      candidate: undefined,
      verification: undefined,
    });
  }

  async loadGeneratedDemo(): Promise<void> {
    if (!this.active) return;
    const generation = this.prepare();
    const profile =
      this.state.profile.platformCategory === 'included-baseline'
        ? genericFixedWingProfile
        : this.state.profile;
    this.patch({ profile });
    try {
      const text = generateSyntheticDocument(profile);
      await this.parse(text, 'generated', `${profile.label} generated run`, generation);
    } catch {
      this.fail(generation, 'The synthetic demo could not be generated.');
    }
  }

  async loadFile(file: Pick<File, 'name' | 'size' | 'text'>): Promise<void> {
    if (!this.active) return;
    const generation = this.prepare();
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > DEFAULT_INPUT_LIMITS.maxBytes) {
      this.fail(generation, 'Upload rejected. The maximum synthetic CSV/JSON file size is 10 MiB.');
      return;
    }
    try {
      const text = await file.text();
      if (!this.currentGeneration(generation)) return;
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      await this.parse(text, format, file.name, generation);
    } catch {
      this.fail(generation, 'The selected file could not be read. No previous run remains active.');
    }
  }

  async loadText(text: string, format: LabInputFormat, label: string): Promise<void> {
    if (!this.active) return;
    await this.parse(text, format, label, this.prepare());
  }

  setProfile(id: string): void {
    if (!this.active) return;
    const profile = getDetectionProfile(id);
    if (!profile || profile === this.state.profile) return;
    this.initialized = true;
    // A pending import must not publish an analysis under a superseded profile selection.
    this.generation += 1;
    const investigation = this.investigationAfterDiagnosticContextChange(
      'The selected diagnostic profile changed',
    );
    const previous = this.state.current;
    const current = previous
      ? { ...previous, analysis: analyzeTelemetryRun(previous.run, profile) }
      : undefined;
    this.patch({
      profile,
      current,
      candidate: undefined,
      verification: undefined,
      comparisonIssue: undefined,
      diagnosticsFilters: current
        ? normalizeDiagnosticsFilters(this.state.diagnosticsFilters, current.analysis.findings)
        : this.state.diagnosticsFilters,
      faultStatus: 'idle',
      faultIssue: undefined,
      pointwiseModelSelection: {
        ...this.state.pointwiseModelSelection,
        intent: 'disabled',
      },
      investigation,
      status: current ? (current.analysis.blocked ? 'blocked' : 'ready') : 'idle',
      message: current ? 'The active run was reanalyzed with the selected synthetic profile.' : '',
    });
  }

  setReplayIndex(index: number): void {
    if (!this.active || !Number.isFinite(index)) return;
    const maximum = Math.max(0, (this.state.current?.run.samples.length ?? 0) - 1);
    this.patch({ replayIndex: Math.max(0, Math.min(maximum, Math.floor(index))) });
  }

  scrub(index: number): void {
    this.pauseReplay();
    this.setReplayIndex(index);
  }

  seekFinding(finding: Finding): void {
    if (finding.sampleIndex === undefined) return;
    const index = this.state.current?.run.samples.findIndex(
      (sample) => sample.sampleIndex === finding.sampleIndex,
    );
    if (index !== undefined && index >= 0) this.setReplayIndex(index);
  }

  setReplayInterval(interval: number): void {
    if (!this.active || (interval !== 600 && interval !== 300 && interval !== 150)) return;
    this.patch({ replayInterval: interval });
  }

  startReplay(): void {
    const length = this.state.current?.run.samples.length ?? 0;
    if (!this.active || !length || this.replayTimer !== undefined) return;
    if (this.state.replayIndex >= length - 1) this.setReplayIndex(0);
    if (!this.active) return;
    this.replayTimer = setInterval(() => {
      if (this.state.replayIndex >= (this.state.current?.run.samples.length ?? 1) - 1) {
        this.pauseReplay();
      } else this.setReplayIndex(this.state.replayIndex + 1);
    }, this.state.replayInterval);
    this.patch({ replayPlaying: true });
  }

  pauseReplay(): void {
    this.clearReplayTimer();
    if (this.state.replayPlaying) this.patch({ replayPlaying: false });
  }

  captureBaseline(): void {
    if (!this.active) return;
    const current = this.state.current;
    if (!current) {
      this.patch({ comparisonIssue: 'Load and validate a synthetic run before capturing it.' });
      return;
    }
    this.patch({
      baseline: { run: current.run, analysis: current.analysis, label: current.label },
      candidate: undefined,
      verification: undefined,
      comparisonIssue: undefined,
      message: current.analysis.blocked
        ? 'The current run was captured as a baseline, but its fatal validation evidence will block verification.'
        : 'The current run was captured as the verification baseline.',
    });
  }

  captureCandidate(): void {
    if (!this.active) return;
    const current = this.state.current;
    const baseline = this.state.baseline;
    if (!current) {
      this.patch({ comparisonIssue: 'Load and validate a synthetic candidate before comparing.' });
      return;
    }
    if (!baseline) {
      this.patch({ comparisonIssue: 'Capture a baseline before selecting a candidate.' });
      return;
    }
    const candidate = { run: current.run, analysis: current.analysis, label: current.label };
    try {
      const verification = createVerificationRun(
        baseline.run,
        baseline.analysis,
        candidate.run,
        candidate.analysis,
      );
      const outcome =
        verification.status === 'pass'
          ? 'passed with no newly introduced findings'
          : verification.status === 'blocked'
            ? 'was blocked by fatal validation evidence'
            : 'detected newly introduced findings';
      this.patch({
        candidate,
        verification,
        comparisonIssue: undefined,
        message: `Verification ${outcome}.`,
      });
    } catch (error) {
      const comparisonIssue =
        error instanceof Error ? error.message : 'The selected runs cannot be compared.';
      this.patch({
        candidate,
        verification: undefined,
        comparisonIssue,
        message: `Comparison unavailable. ${comparisonIssue}`,
      });
    }
  }

  /** Builds a candidate atomically so failed or superseded injection cannot corrupt prior evidence. */
  async createFaultCandidate(): Promise<boolean> {
    if (!this.active || this.state.faultStatus === 'injecting') return false;
    const source = this.state.current;
    const scenario = getFaultScenario(this.state.faultScenarioId);
    const seed = Number(this.state.faultSeed);
    if (!source)
      return this.rejectFault('Load and validate a synthetic run before injecting a fault.');
    if (source.run.fatal || source.analysis.blocked || source.run.samples.length === 0) {
      return this.rejectFault(
        'Fault injection requires a nonfatal run with accepted synthetic samples.',
      );
    }
    if (!scenario) return this.rejectFault('Choose a declared synthetic fault scenario.');
    if (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_FAULT_SEED) {
      return this.rejectFault(
        `Use a whole-number seed from 1 through ${MAX_FAULT_SEED.toLocaleString('en-US')}.`,
      );
    }

    const generation = ++this.generation;
    const investigation = this.investigationAfterDiagnosticContextChange(
      'A new diagnostic candidate was requested',
    );
    this.clearReplayTimer();
    this.patch({
      faultStatus: 'injecting',
      faultIssue: undefined,
      replayPlaying: false,
      investigation,
      message: `Creating ${scenario.label.toLocaleLowerCase('en-US')} with deterministic seed ${seed}.`,
    });
    try {
      let candidateRun: TelemetryRun;
      let candidateSourceText: string | undefined;
      if (scenario.target === 'legacy-csv') {
        if (source.inputFormat !== 'csv' || source.sourceText === undefined) {
          throw new Error(
            'This row-level scenario requires a legacy CSV source. Load the included baseline first.',
          );
        }
        candidateSourceText = injectLegacyCsvFault(
          source.sourceText,
          scenario.id as 'blank-csv-value' | 'nonnumeric-csv-value',
          seed,
        );
        candidateRun = await legacyCsvAdapter.parse(candidateSourceText, {
          runId: `${source.run.runId}-fault-${scenario.id}-seed-${seed}`,
          profileId: this.state.profile.id,
          profileVersion: this.state.profile.version,
        });
        candidateRun.metadata = {
          ...candidateRun.metadata,
          injectedFault: {
            scenarioId: scenario.id,
            seed,
            target: scenario.target,
            expectedRuleIds: [...scenario.expectedRuleIds],
            synthetic: true,
          },
        };
      } else {
        candidateRun = await injectFaultScenario(source.run, scenario.id as FaultScenarioId, seed);
      }
      if (!this.currentGeneration(generation)) return false;

      const candidateAnalysis = analyzeTelemetryRun(candidateRun, this.state.profile);
      const candidateLabel = `${scenario.label} · seed ${seed}`;
      const candidate: CapturedLabRun = {
        run: candidateRun,
        analysis: candidateAnalysis,
        label: candidateLabel,
      };
      let verification: VerificationRun | undefined;
      let comparisonIssue: string | undefined;
      try {
        verification = createVerificationRun(
          source.run,
          source.analysis,
          candidateRun,
          candidateAnalysis,
        );
      } catch (error) {
        comparisonIssue =
          error instanceof Error ? error.message : 'The injected candidate cannot be compared.';
      }
      const result = verification
        ? verification.status === 'pass'
          ? 'Verification passed with no newly introduced findings.'
          : verification.status === 'blocked'
            ? 'Verification is blocked by fatal validation evidence.'
            : 'Verification detected newly introduced findings.'
        : `Comparison is unavailable. ${comparisonIssue}`;
      this.patch({
        status: candidateAnalysis.blocked ? 'blocked' : 'ready',
        current: {
          ...candidate,
          sourceText: candidateSourceText,
          inputFormat: 'injected',
        },
        baseline: { run: source.run, analysis: source.analysis, label: source.label },
        candidate,
        verification,
        comparisonIssue,
        diagnosticsFilters: normalizeDiagnosticsFilters(
          this.state.diagnosticsFilters,
          candidateAnalysis.findings,
        ),
        replayIndex: 0,
        replayPlaying: false,
        pointwiseModelSelection: {
          ...this.state.pointwiseModelSelection,
          intent: 'disabled',
        },
        faultStatus: 'idle',
        faultIssue: undefined,
        message: `Candidate created. ${result}`,
      });
      return true;
    } catch (error) {
      if (this.currentGeneration(generation)) {
        this.rejectFault(
          error instanceof Error ? error.message : 'The fault candidate could not be created.',
        );
      }
      return false;
    }
  }

  private prepare(): number {
    this.generation += 1;
    const generation = this.generation;
    const investigation = this.investigationAfterDiagnosticContextChange(
      'A new diagnostic run was requested',
    );
    this.clearReplayTimer();
    this.patch({
      status: 'loading',
      current: undefined,
      candidate: undefined,
      verification: undefined,
      comparisonIssue: undefined,
      faultStatus: 'idle',
      faultIssue: undefined,
      replayIndex: 0,
      replayPlaying: false,
      pointwiseModelSelection: {
        ...this.state.pointwiseModelSelection,
        intent: 'disabled',
      },
      investigation,
      message: 'Loading and validating synthetic telemetry.',
    });
    return generation;
  }

  private async parse(
    text: string,
    format: LabInputFormat,
    label: string,
    generation: number,
  ): Promise<void> {
    if (!this.currentGeneration(generation)) return;
    if (utf8ByteLength(text) > DEFAULT_INPUT_LIMITS.maxBytes) {
      this.fail(generation, 'Input rejected. The maximum synthetic CSV/JSON input size is 10 MiB.');
      return;
    }
    const profile =
      format === 'csv' ? includedBaselineProfile : (declaredProfile(text) ?? this.state.profile);
    this.patch({ profile });
    try {
      const options = { profileId: profile.id, profileVersion: profile.version };
      const run =
        format === 'csv'
          ? await legacyCsvAdapter.parse(text, options)
          : await versionedJsonAdapter.parse(text, options);
      if (!this.currentGeneration(generation)) return;
      const analysis = analyzeTelemetryRun(run, profile);
      this.initialized = true;
      this.patch({
        status: analysis.blocked ? 'blocked' : 'ready',
        current: { run, analysis, label, sourceText: text, inputFormat: format },
        diagnosticsFilters: normalizeDiagnosticsFilters(
          this.state.diagnosticsFilters,
          analysis.findings,
        ),
        message: run.fatal
          ? 'Analysis is blocked by fatal validation. Inspect the validation evidence below.'
          : run.quarantinedRows.length
            ? 'Analysis completed with quarantined rows. Invalid rows are excluded from the charts.'
            : 'Synthetic telemetry validated and analyzed locally.',
      });
    } catch {
      this.fail(generation, 'Analysis failed. No previous run remains active.');
    }
  }

  private currentGeneration(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private fail(generation: number, message: string): void {
    if (this.currentGeneration(generation)) {
      this.initialized = true;
      this.patch({ status: 'error', current: undefined, message });
    }
  }

  private rejectFault(message: string): false {
    this.patch({
      faultStatus: 'idle',
      faultIssue: message,
      message: `Fault injection failed. ${message}`,
    });
    return false;
  }

  private updateInvestigationRequest(
    value: Partial<Pick<LabInvestigationState, 'scenarioId' | 'seedInput' | 'sampleCountInput'>>,
  ): void {
    this.investigationGeneration += 1;
    const investigation = { ...this.state.investigation, ...value };
    const current = investigation.current;
    this.patch({
      investigation: {
        ...investigation,
        work:
          this.state.investigation.work.phase === 'analyzing'
            ? {
                phase: 'idle',
                issue: 'Investigation analysis was cancelled because its request changed.',
              }
            : { phase: 'idle' },
        resultSettingsStale:
          current !== undefined &&
          (current.configuration.scenarioId !== investigation.scenarioId ||
            current.configuration.seed !== Number(investigation.seedInput) ||
            current.configuration.sampleCount !== Number(investigation.sampleCountInput) ||
            current.modelIntents.robustCovariance !== this.state.pointwiseModelSelection.intent ||
            current.modelIntents.temporalModel !== this.state.temporalModelSelection.intent),
      },
    });
  }

  private investigationModelIntents(): InvestigationModelIntents {
    return {
      robustCovariance: this.state.pointwiseModelSelection.intent,
      temporalModel: this.state.temporalModelSelection.intent,
    };
  }

  private currentInvestigationGeneration(generation: number): boolean {
    return this.active && this.investigationGeneration === generation;
  }

  private campaignWorkActive(): boolean {
    return this.state.campaign.phase === 'running' || this.state.campaign.phase === 'cancelling';
  }

  private currentCampaignGeneration(
    generation: number,
    client?: LabCampaignClient | undefined,
  ): boolean {
    return (
      this.active &&
      this.campaignGeneration === generation &&
      (client === undefined || this.campaignClient === client)
    );
  }

  private campaignTerminalProgress(snapshot: Readonly<CampaignSettledSnapshot>): CampaignProgress {
    return Object.freeze({
      campaignId: snapshot.result.campaignId,
      completedCases: snapshot.result.summary.attemptedCases,
      totalCases: snapshot.result.summary.plannedCases,
      currentCaseId: null,
      currentCaseStatus: snapshot.result.status === 'cancelled' ? 'cancelled' : null,
    });
  }

  private campaignIssue(error: unknown, fallback: string): string {
    const detail = error instanceof Error ? error.message.trim() : '';
    return (detail || fallback).slice(0, 500);
  }

  private terminateCampaignClient(): void {
    const client = this.campaignClient;
    this.campaignClient = undefined;
    client?.terminate();
  }

  private investigationIssue(error: unknown, fallback: string): string {
    const detail = error instanceof Error ? error.message.trim() : '';
    return (detail || fallback).slice(0, 500);
  }

  private investigationAfterDiagnosticContextChange(reason: string): LabInvestigationState {
    this.investigationGeneration += 1;
    const current = this.state.investigation.current;
    return {
      ...this.state.investigation,
      work:
        this.state.investigation.work.phase === 'analyzing'
          ? { phase: 'idle', issue: `${reason}. Pending Investigation analysis was cancelled.` }
          : this.state.investigation.work,
      resultSettingsStale:
        current !== undefined &&
        (current.modelIntents.robustCovariance !== 'disabled' ||
          current.modelIntents.temporalModel !== this.state.temporalModelSelection.intent),
    };
  }

  private clearReplayTimer(): void {
    if (this.replayTimer !== undefined) clearInterval(this.replayTimer);
    this.replayTimer = undefined;
  }

  private patch(value: Partial<LabSessionState>): void {
    this.state = { ...this.state, ...value };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
