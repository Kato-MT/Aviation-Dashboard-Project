import baselineCsv from '../../data/flight.csv?raw';
import learnedBaselineArtifact from '../../models/robust_covariance_v1.json';
import temporalFaultArtifact from '../../models/temporal_fault_model_v2.json';
import temporalFaultArtifactRaw from '../../models/temporal_fault_model_v2.json?raw';
import { legacyCsvAdapter, versionedJsonAdapter } from '../adapters';
import {
  buildDefaultTemporalCampaignSpec,
  serializeCampaignResult,
  type CampaignProgress,
  type CampaignResult,
} from '../campaign';
import { CampaignCancelledError, TemporalCampaignBrowserClient } from '../campaign/browserClient';
import {
  APPLICATION_VERSION,
  DEFAULT_INPUT_LIMITS,
  analyzeTelemetryRun,
  sha256Hex,
  type AnalysisResult,
  type DetectionProfile,
  type DetectionRule,
  type Finding,
  type FindingClassification,
  type TelemetryRun,
  type TelemetrySample,
  type VerificationRun,
} from '../core';
import { buildDiagnosticReport, exportFindingsCsv, serializeDiagnosticReport } from '../export';
import {
  DECLARED_FAULT_SCENARIOS,
  getFaultScenario,
  injectFaultScenario,
  injectLegacyCsvFault,
  type FaultScenarioId,
} from '../faults';
import { analyzeTemporalScenario, type TemporalScenarioInvestigation } from '../investigation';
import {
  modelPassesQualityGate,
  parseLearnedBaselineArtifact,
  parseTemporalFaultModelArtifact,
  scoreLearnedBaseline,
  temporalModelPassesQualityGate,
} from '../ml';
import {
  evaluateModelCompatibility,
  temporalFaultRegistryEntry,
  type ModelCompatibilityResult,
} from '../model-registry';
import {
  detectionProfiles,
  genericFixedWingProfile,
  getDetectionProfile,
  includedBaselineProfile,
} from '../profiles';
import {
  BrowserDemoAdapter,
  ReconnectingStreamClient,
  StreamHealthMonitor,
  type SourceHealth,
  type StreamMessage,
} from '../streaming';
import {
  DECLARED_TEMPORAL_FAULTS,
  generateTemporalScenario,
  type MissionPhase,
  type TemporalScenario,
} from '../temporal';
import { createVerificationRun } from '../verification';
import { TelemetryCharts } from './charts';
import { byId, downloadText, formatNumber, formatObserved, setText, slug } from './dom';
import { generateSyntheticDocument } from './generate';
import {
  evaluateInvestigationComparison,
  InvestigationChartRenderer,
  type InvestigationComparisonCompatibility,
  type InvestigationComparisonIdentity,
  type InvestigationOverlayVisibility,
  type InvestigationPhaseSegment,
  type InvestigationSeries as ChartInvestigationSeries,
} from './investigationCharts';

type InputFormat = 'csv' | 'json' | 'generated' | 'injected';
type MessageState = 'info' | 'warning' | 'error';

interface CapturedRun {
  run: TelemetryRun;
  analysis: AnalysisResult;
}

interface CapturedInvestigationBaseline {
  capturedAt: string;
  profileId: TemporalScenario['profileId'];
  cadenceMs: number;
  sampleCount: number;
  scenarioId: TemporalScenario['scenarioId'];
  seed: number;
  series: ChartInvestigationSeries;
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && getDetectionProfile(value) !== undefined;
}

function sourceProfileFromJson(text: string): DetectionProfile | undefined {
  try {
    const parsed = JSON.parse(text) as { profile?: { id?: unknown; version?: unknown } };
    if (!isProfileId(parsed.profile?.id)) return undefined;
    return getDetectionProfile(
      parsed.profile.id,
      typeof parsed.profile.version === 'string' ? parsed.profile.version : undefined,
    );
  } catch {
    return undefined;
  }
}

function ruleCondition(rule: DetectionRule): string {
  switch (rule.kind) {
    case 'threshold':
      return `${rule.channel} ${rule.operator} ${rule.threshold}`;
    case 'range':
      return `${rule.minimum} <= ${rule.channel} <= ${rule.maximum}`;
    case 'rate':
      return `|delta ${rule.channel}| <= ${rule.maximumAbsoluteRate}/s`;
    case 'decrease-rate':
      return `decrease ${rule.channel} <= ${rule.maximumDecreaseRate}/s`;
    case 'window-decrease':
      return `decrease ${rule.channel} <= ${rule.maximumDecrease} in ${rule.windowMs / 1_000}s`;
    case 'frozen':
      return `${rule.channel} changes within ${rule.minimumDurationMs / 1_000}s`;
  }
}

function classificationFinding(classification: FindingClassification): Finding | undefined {
  return classification.candidate ?? classification.baseline;
}

function streamHealthTone(
  health: readonly SourceHealth[],
): 'unknown' | 'good' | 'warning' | 'failure' {
  if (health.length === 0) return 'unknown';
  if (health.some((source) => source.status === 'disconnected')) return 'failure';
  if (health.some((source) => ['degraded', 'stale'].includes(source.status))) return 'warning';
  return 'good';
}

function meanFinite(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function phaseLabel(phase: MissionPhase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function investigationPhaseSegments(
  investigation: TemporalScenarioInvestigation,
): InvestigationPhaseSegment[] {
  const segments: InvestigationPhaseSegment[] = [];
  for (const point of investigation.points) {
    const previous = segments.at(-1);
    if (previous?.phase === point.phase) {
      previous.endIndex = point.sampleIndex;
    } else {
      segments.push({
        phase: point.phase,
        label: phaseLabel(point.phase),
        startIndex: point.sampleIndex,
        endIndex: point.sampleIndex,
      });
    }
  }
  return segments;
}

export class WorkbenchController {
  private readonly charts = new TelemetryCharts();
  private readonly investigationCharts = new InvestigationChartRenderer({
    onSeek: (sampleIndex) => this.setInvestigationIndex(sampleIndex),
  });
  private readonly campaignClient = new TemporalCampaignBrowserClient();
  private activeProfile: DetectionProfile = includedBaselineProfile;
  private currentRun: TelemetryRun | undefined;
  private currentAnalysis: AnalysisResult | undefined;
  private currentSourceText: string | undefined;
  private currentInputFormat: InputFormat | undefined;
  private baseline: CapturedRun | undefined;
  private candidate: CapturedRun | undefined;
  private verification: VerificationRun | undefined;
  private replayIndex = 0;
  private replayTimer: ReturnType<typeof setInterval> | undefined;
  private streamClient: ReconnectingStreamClient | undefined;
  private browserDemo: BrowserDemoAdapter | undefined;
  private browserDemoUnsubscribe: (() => void) | undefined;
  private browserHealth: StreamHealthMonitor | undefined;
  private browserQueueDropped = 0;
  private modelArtifact = parseLearnedBaselineArtifact(learnedBaselineArtifact);
  private temporalArtifact = parseTemporalFaultModelArtifact(temporalFaultArtifact);
  private temporalArtifactSha256 = '';
  private learnedModelEnabled = false;
  private temporalModelEnabled = false;
  private temporalScenario: TemporalScenario | undefined;
  private investigation: TemporalScenarioInvestigation | undefined;
  private investigationIndex = 0;
  private investigationBaseline: CapturedInvestigationBaseline | undefined;
  private campaignResult: CampaignResult | undefined;
  private campaignRunning = false;

  async initialize(): Promise<void> {
    try {
      this.temporalArtifactSha256 = await sha256Hex(temporalFaultArtifactRaw);
    } catch {
      this.temporalArtifactSha256 = '';
    }
    this.bindTabs();
    this.bindActions();
    this.renderProfiles();
    this.renderFaultScenarios();
    this.renderTemporalScenarios();
    this.renderModelSummary();
    this.renderTemporalModelConfiguration();
    this.renderEmptyInvestigation();
    this.renderEmptyRun();
    this.updateClock();
    setInterval(() => this.updateClock(), 1_000);
    await this.loadIncludedBaseline(true);
  }

  private bindTabs(): void {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-view]')];
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => this.openView(tab.dataset.view ?? 'monitor'));
      tab.addEventListener('keydown', (event) => {
        let targetIndex: number | undefined;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
          targetIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
          targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = tabs.length - 1;
        if (targetIndex === undefined) return;
        event.preventDefault();
        const target = tabs[targetIndex];
        if (target) {
          this.openView(target.dataset.view ?? 'monitor');
          target.focus();
        }
      });
    }

    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-open-view]')) {
      button.addEventListener('click', () => this.openView(button.dataset.openView ?? 'monitor'));
    }
  }

  private bindActions(): void {
    byId<HTMLButtonElement>('load-baseline').addEventListener(
      'click',
      () => void this.loadIncludedBaseline(false),
    );
    byId<HTMLButtonElement>('load-demo').addEventListener(
      'click',
      () => void this.loadGeneratedDemo(),
    );
    byId<HTMLInputElement>('telemetry-file').addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.loadFile(file);
    });
    byId<HTMLButtonElement>('dismiss-message').addEventListener('click', () => {
      byId('message-banner').hidden = true;
    });

    byId<HTMLButtonElement>('replay-start').addEventListener('click', () => this.startReplay());
    byId<HTMLButtonElement>('replay-pause').addEventListener('click', () => this.stopReplay());
    byId<HTMLButtonElement>('replay-reset').addEventListener('click', () => this.setReplayIndex(0));
    byId<HTMLInputElement>('replay-slider').addEventListener('input', (event) => {
      this.stopReplay();
      this.setReplayIndex(Number((event.currentTarget as HTMLInputElement).value));
    });

    for (const id of ['filter-severity', 'filter-rule', 'filter-source']) {
      byId<HTMLSelectElement>(id).addEventListener('change', () => this.renderFindings());
    }
    byId<HTMLInputElement>('filter-search').addEventListener('input', () => this.renderFindings());
    byId<HTMLButtonElement>('clear-filters').addEventListener('click', () => {
      byId<HTMLSelectElement>('filter-severity').value = 'all';
      byId<HTMLSelectElement>('filter-rule').value = 'all';
      byId<HTMLSelectElement>('filter-source').value = 'all';
      byId<HTMLInputElement>('filter-search').value = '';
      this.renderFindings();
    });

    byId<HTMLSelectElement>('fault-scenario').addEventListener('change', () =>
      this.renderFaultDescription(),
    );
    byId<HTMLButtonElement>('inject-fault').addEventListener(
      'click',
      () => void this.injectSelectedFault(),
    );
    byId<HTMLButtonElement>('capture-baseline').addEventListener('click', () =>
      this.captureBaseline(),
    );
    byId<HTMLButtonElement>('use-candidate').addEventListener('click', () =>
      this.captureCandidate(),
    );

    byId<HTMLSelectElement>('profile-select').addEventListener('change', (event) => {
      const selected = getDetectionProfile((event.currentTarget as HTMLSelectElement).value);
      if (!selected) return;
      this.activeProfile = selected;
      if (this.currentRun) {
        this.currentAnalysis = analyzeTelemetryRun(this.currentRun, selected);
        this.verification = undefined;
        this.candidate = undefined;
        this.renderRun();
      } else {
        this.renderConfiguration();
      }
      this.renderTemporalModelConfiguration();
      this.announce(`Selected ${selected.label}.`);
    });

    byId<HTMLButtonElement>('export-findings').addEventListener('click', () =>
      this.downloadFindings(),
    );
    byId<HTMLButtonElement>('export-run').addEventListener('click', () => this.downloadRunReport());
    byId<HTMLButtonElement>('export-verification').addEventListener('click', () =>
      this.downloadVerification(),
    );

    byId<HTMLButtonElement>('stream-connect').addEventListener('click', () =>
      this.connectLocalStream(),
    );
    byId<HTMLButtonElement>('stream-demo').addEventListener('click', () => this.startBrowserDemo());
    byId<HTMLButtonElement>('stream-disconnect').addEventListener('click', () =>
      this.stopStreams(),
    );

    byId<HTMLInputElement>('learned-model-enabled').addEventListener('change', (event) => {
      this.learnedModelEnabled = (event.currentTarget as HTMLInputElement).checked;
      this.renderModelSummary();
      this.renderCurrentSample();
      if (this.temporalScenario) this.analyzeCurrentTemporalScenario();
      this.announce(
        this.learnedModelEnabled
          ? 'Experimental pointwise comparison enabled.'
          : 'Experimental pointwise comparison disabled.',
      );
    });
    byId<HTMLInputElement>('temporal-model-enabled').addEventListener('change', (event) => {
      const requested = (event.currentTarget as HTMLInputElement).checked;
      const compatibility = this.temporalModelCompatibility(requested);
      this.temporalModelEnabled = requested && compatibility.readiness.active;
      this.renderTemporalModelConfiguration();
      if (this.temporalScenario) this.analyzeCurrentTemporalScenario();
      this.announce(
        requested && !this.temporalModelEnabled
          ? 'Experimental temporal hypotheses remain disabled because the registered compatibility or eligibility gate did not pass.'
          : this.temporalModelEnabled
            ? 'Experimental temporal hypotheses enabled when compatible.'
            : 'Experimental temporal hypotheses disabled.',
      );
    });
    byId<HTMLButtonElement>('run-investigation').addEventListener('click', () =>
      this.runInvestigation(),
    );
    byId<HTMLButtonElement>('investigation-export').addEventListener('click', () =>
      this.downloadInvestigation(),
    );
    byId<HTMLButtonElement>('capture-investigation-baseline').addEventListener('click', () =>
      this.captureInvestigationBaseline(),
    );
    byId<HTMLInputElement>('investigation-replay-slider').addEventListener('input', (event) =>
      this.setInvestigationIndex(Number((event.currentTarget as HTMLInputElement).value)),
    );
    for (const checkbox of document.querySelectorAll<HTMLInputElement>(
      '[data-investigation-overlay]',
    )) {
      checkbox.addEventListener('change', () => this.renderInvestigationCharts());
    }
    byId<HTMLButtonElement>('campaign-run').addEventListener(
      'click',
      () => void this.runTemporalCampaign(),
    );
    byId<HTMLButtonElement>('campaign-cancel').addEventListener('click', () =>
      this.cancelTemporalCampaign(),
    );
    byId<HTMLButtonElement>('campaign-export').addEventListener('click', () =>
      this.downloadCampaign(),
    );
  }

  private openView(view: string): void {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-view]')) {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of document.querySelectorAll<HTMLElement>('[data-view-panel]')) {
      const active = panel.dataset.viewPanel === view;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
  }

  private async loadIncludedBaseline(initial: boolean): Promise<void> {
    this.activeProfile = includedBaselineProfile;
    byId<HTMLSelectElement>('profile-select').value = includedBaselineProfile.id;
    await this.loadText(baselineCsv, 'csv', 'Included 85-record synthetic baseline');
    if (this.currentRun && this.currentAnalysis) {
      this.baseline = { run: this.currentRun, analysis: this.currentAnalysis };
      this.candidate = undefined;
      this.verification = undefined;
      this.renderVerification();
    }
    if (!initial)
      this.showMessage(
        'Baseline loaded',
        'The preserved included dataset is ready for replay and verification.',
        'info',
      );
  }

  private async loadGeneratedDemo(): Promise<void> {
    const profile =
      this.activeProfile.platformCategory === 'included-baseline'
        ? genericFixedWingProfile
        : this.activeProfile;
    this.activeProfile = profile;
    byId<HTMLSelectElement>('profile-select').value = profile.id;
    const generated = generateSyntheticDocument(profile);
    await this.loadText(generated, 'generated', `${profile.label} generated run`);
  }

  private async loadFile(file: File): Promise<void> {
    this.prepareForLoad();
    if (file.size > DEFAULT_INPUT_LIMITS.maxBytes) {
      this.failLoad(
        'Upload rejected',
        `The selected file is ${formatNumber(file.size / (1024 * 1024), 2)} MiB. The maximum is 10 MiB.`,
      );
      return;
    }
    try {
      const text = await file.text();
      const format: InputFormat = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      await this.loadText(text, format, file.name, true);
    } catch (error) {
      this.failLoad(
        'Upload failed',
        error instanceof Error ? error.message : 'The file could not be read.',
      );
    }
  }

  private async loadText(
    text: string,
    format: InputFormat,
    label: string,
    alreadyPrepared = false,
  ): Promise<void> {
    if (!alreadyPrepared) this.prepareForLoad();
    try {
      let run: TelemetryRun;
      if (format === 'csv') {
        this.activeProfile = includedBaselineProfile;
        byId<HTMLSelectElement>('profile-select').value = includedBaselineProfile.id;
        run = await legacyCsvAdapter.parse(text, {
          profileId: this.activeProfile.id,
          profileVersion: this.activeProfile.version,
        });
      } else {
        const declaredProfile = sourceProfileFromJson(text);
        if (declaredProfile) {
          this.activeProfile = declaredProfile;
          byId<HTMLSelectElement>('profile-select').value = declaredProfile.id;
        }
        run = await versionedJsonAdapter.parse(text, {
          profileId: this.activeProfile.id,
          profileVersion: this.activeProfile.version,
        });
      }

      this.currentRun = run;
      this.currentAnalysis = analyzeTelemetryRun(run, this.activeProfile);
      this.currentSourceText = text;
      this.currentInputFormat = format;
      this.replayIndex = 0;
      this.renderRun(label);

      if (run.fatal) {
        this.showMessage(
          'Analysis blocked by fatal validation',
          run.validationIssues
            .filter((issue) => issue.disposition === 'fatal')
            .map((issue) => issue.message)
            .join(' '),
          'error',
        );
      } else if (run.quarantinedRows.length > 0) {
        this.showMessage(
          'Analysis completed with quarantined rows',
          `${run.quarantinedRows.length} invalid row${run.quarantinedRows.length === 1 ? '' : 's'} remain visible in Diagnostics.`,
          'warning',
        );
      }
    } catch (error) {
      this.failLoad(
        'Analysis failed',
        error instanceof Error ? error.message : 'Unexpected parsing failure.',
      );
    }
  }

  private prepareForLoad(): void {
    this.stopReplay();
    this.currentRun = undefined;
    this.currentAnalysis = undefined;
    this.currentSourceText = undefined;
    this.currentInputFormat = undefined;
    this.candidate = undefined;
    this.verification = undefined;
    this.charts.clear();
    this.renderEmptyRun();
    this.setRunStatus('empty', 'Loading telemetry');
    this.announce('Loading and validating telemetry.');
  }

  private failLoad(title: string, detail: string): void {
    this.currentRun = undefined;
    this.currentAnalysis = undefined;
    this.currentSourceText = undefined;
    this.currentInputFormat = undefined;
    this.charts.clear();
    this.renderEmptyRun();
    this.setRunStatus('failure', 'Load failed');
    this.showMessage(title, detail, 'error', true);
  }

  private renderEmptyRun(): void {
    setText('active-run-name', 'No telemetry loaded');
    setText('active-run-detail', 'Load the included baseline or select a synthetic CSV/JSON file.');
    setText('metric-accepted', 0);
    setText('metric-total', 'of 0 received');
    setText('metric-quarantined', 0);
    setText('metric-findings', 0);
    setText('metric-severity', 'no active findings');
    setText('metric-hash', '--------');
    setText('diagnostics-tab-count', 0);
    this.updateReplayControls();
    this.renderCurrentSample();
    this.renderFindings();
    this.renderQuarantine();
    this.renderConfiguration();
    this.renderVerification();
    this.toggleRunActions(false);
  }

  private renderRun(label?: string): void {
    const run = this.currentRun;
    const analysis = this.currentAnalysis;
    if (!run || !analysis) return;

    const title =
      label ?? (typeof run.metadata.title === 'string' ? run.metadata.title : run.runId);
    setText('active-run-name', title);
    setText(
      'active-run-detail',
      `${this.activeProfile.label} | ${run.adapterId}@${run.adapterVersion} | ${run.sources.length} source${run.sources.length === 1 ? '' : 's'}`,
    );
    setText('metric-accepted', run.provenance.acceptedRecords);
    setText('metric-total', `of ${run.provenance.totalRows} received`);
    setText('metric-quarantined', run.provenance.quarantinedRecords);
    setText('metric-findings', analysis.findings.length);
    const highest = [...analysis.findings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    )[0];
    setText(
      'metric-severity',
      highest ? `highest severity: ${highest.severity}` : 'nominal deterministic result',
    );
    setText('metric-hash', run.provenance.datasetSha256.slice(0, 8));
    setText('diagnostics-tab-count', analysis.findings.length);

    if (analysis.blocked) this.setRunStatus('failure', 'Analysis blocked');
    else if (analysis.findings.length > 0)
      this.setRunStatus('warning', `${analysis.findings.length} findings`);
    else this.setRunStatus('nominal', 'Nominal run');

    this.charts.setRun(run.samples, analysis.findings);
    this.replayIndex = Math.min(this.replayIndex, Math.max(0, run.samples.length - 1));
    this.updateReplayControls();
    this.setReplayIndex(this.replayIndex);
    this.renderFindingTimeline();
    this.populateFindingFilters();
    this.renderFindings();
    this.renderQuarantine();
    this.renderConfiguration();
    this.renderVerification();
    this.toggleRunActions(true);
  }

  private toggleRunActions(enabled: boolean): void {
    for (const id of [
      'export-findings',
      'export-run',
      'inject-fault',
      'capture-baseline',
      'use-candidate',
    ]) {
      byId<HTMLButtonElement>(id).disabled = !enabled;
    }
    byId<HTMLButtonElement>('export-verification').disabled = this.verification === undefined;
  }

  private setRunStatus(status: 'empty' | 'nominal' | 'warning' | 'failure', text: string): void {
    byId('run-status').dataset.status = status;
    setText('run-status-text', text);
    const symbol =
      status === 'nominal' ? 'OK' : status === 'warning' ? '!' : status === 'failure' ? 'X' : 'o';
    byId('run-status').querySelector('.status-symbol')!.textContent = symbol;
  }

  private updateReplayControls(): void {
    const length = this.currentRun?.samples.length ?? 0;
    const enabled = length > 0;
    const slider = byId<HTMLInputElement>('replay-slider');
    slider.disabled = !enabled;
    slider.max = String(Math.max(0, length - 1));
    slider.value = String(Math.min(this.replayIndex, Math.max(0, length - 1)));
    byId<HTMLButtonElement>('replay-start').disabled = !enabled;
    byId<HTMLButtonElement>('replay-pause').disabled = !enabled;
    byId<HTMLButtonElement>('replay-reset').disabled = !enabled;
    byId<HTMLSelectElement>('replay-speed').disabled = !enabled;
    setText('replay-position', `${enabled ? this.replayIndex + 1 : 0} / ${length}`);
  }

  private setReplayIndex(index: number): void {
    const samples = this.currentRun?.samples ?? [];
    if (samples.length === 0) {
      this.replayIndex = 0;
      this.renderCurrentSample();
      return;
    }
    this.replayIndex = Math.max(0, Math.min(samples.length - 1, Math.floor(index)));
    byId<HTMLInputElement>('replay-slider').value = String(this.replayIndex);
    setText('replay-position', `${this.replayIndex + 1} / ${samples.length}`);
    this.charts.setCursor(this.replayIndex);
    this.renderCurrentSample(samples[this.replayIndex]);
  }

  private startReplay(): void {
    if (!this.currentRun || this.currentRun.samples.length === 0 || this.replayTimer) return;
    if (this.replayIndex >= this.currentRun.samples.length - 1) this.setReplayIndex(0);
    const interval = Number(byId<HTMLSelectElement>('replay-speed').value);
    this.replayTimer = setInterval(() => {
      const last = (this.currentRun?.samples.length ?? 1) - 1;
      if (this.replayIndex >= last) {
        this.stopReplay();
        this.announce('Replay complete.');
      } else this.setReplayIndex(this.replayIndex + 1);
    }, interval);
    this.announce('Replay started.');
  }

  private stopReplay(): void {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = undefined;
  }

  private renderCurrentSample(sample?: TelemetrySample): void {
    const selected = sample ?? this.currentRun?.samples[this.replayIndex];
    const altitude = selected?.measurements.altitude;
    const speed = selected?.measurements.speed ?? selected?.measurements.airspeed;
    const fuel = selected?.measurements.fuel;
    setText('sample-time', selected?.originalTimestamp ?? selected?.timestamp ?? 'No reading');
    setText('reading-altitude', formatNumber(altitude, 0));
    setText('reading-speed', formatNumber(speed, 1));
    setText('reading-fuel', formatNumber(fuel, 1));
    setText('chart-altitude-value', `${formatNumber(altitude, 0)} ft`);
    setText('chart-speed-value', `${formatNumber(speed, 1)} kt`);
    setText('chart-fuel-value', `${formatNumber(fuel, 1)} %`);
    byId<HTMLMeterElement>('meter-altitude').value = altitude ?? 0;
    byId<HTMLMeterElement>('meter-speed').value = speed ?? 0;
    byId<HTMLMeterElement>('meter-fuel').value = fuel ?? 0;
    const quality = byId('sample-quality');
    if (!selected) {
      quality.dataset.quality = 'unknown';
      quality.textContent = 'Unknown';
      this.renderModelScore();
      return;
    }
    const suspect = selected.qualityFlags.some((flag) =>
      ['suspect', 'stale', 'quarantined'].includes(flag),
    );
    quality.dataset.quality = suspect ? 'warning' : 'good';
    quality.textContent = suspect ? `Review: ${selected.qualityFlags.join(', ')}` : 'Valid sample';
    this.renderModelScore(selected.measurements);
  }

  private renderFindingTimeline(): void {
    const list = byId<HTMLOListElement>('finding-timeline');
    list.replaceChildren();
    const findings = this.currentAnalysis?.findings.slice(0, 6) ?? [];
    if (findings.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No findings to display.';
      list.append(empty);
      return;
    }
    for (const finding of findings) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('strong');
      title.textContent = `${finding.severity.toUpperCase()} | ${finding.ruleId}`;
      const detail = document.createElement('span');
      detail.textContent = `${finding.timestamp ?? `row ${finding.rowNumber ?? 'unknown'}`} | ${finding.evidence.message}`;
      button.append(title, detail);
      button.addEventListener('click', () => {
        if (finding.sampleIndex !== undefined) this.setReplayIndex(finding.sampleIndex);
        this.openView('diagnostics');
      });
      item.append(button);
      list.append(item);
    }
  }

  private populateFindingFilters(): void {
    const findings = this.currentAnalysis?.findings ?? [];
    this.replaceSelectOptions(
      byId<HTMLSelectElement>('filter-rule'),
      'All rules',
      [...new Set(findings.map((finding) => finding.ruleId))].sort(),
    );
    this.replaceSelectOptions(
      byId<HTMLSelectElement>('filter-source'),
      'All sources',
      [...new Set(findings.map((finding) => finding.sourceId))].sort(),
    );
  }

  private replaceSelectOptions(
    select: HTMLSelectElement,
    allLabel: string,
    values: string[],
  ): void {
    const prior = select.value;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = allLabel;
    select.append(all);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = values.includes(prior) ? prior : 'all';
  }

  private renderFindings(): void {
    const body = byId<HTMLTableSectionElement>('findings-body');
    body.replaceChildren();
    const severity = byId<HTMLSelectElement>('filter-severity').value;
    const rule = byId<HTMLSelectElement>('filter-rule').value;
    const source = byId<HTMLSelectElement>('filter-source').value;
    const search = byId<HTMLInputElement>('filter-search').value.trim().toLowerCase();
    const findings = (this.currentAnalysis?.findings ?? []).filter((finding) => {
      if (severity !== 'all' && finding.severity !== severity) return false;
      if (rule !== 'all' && finding.ruleId !== rule) return false;
      if (source !== 'all' && finding.sourceId !== source) return false;
      if (!search) return true;
      return [
        finding.ruleId,
        finding.sourceId,
        finding.timestamp,
        finding.observedValue,
        finding.expectedCondition,
        finding.evidence.message,
      ]
        .map(formatObserved)
        .join(' ')
        .toLowerCase()
        .includes(search);
    });
    setText('filtered-count', findings.length);
    if (findings.length === 0) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.className = 'empty-table';
      cell.textContent = this.currentRun
        ? 'No findings match these filters.'
        : 'Load telemetry to run diagnostics.';
      return;
    }
    for (const finding of findings) {
      const row = body.insertRow();
      const severityCell = row.insertCell();
      const badge = document.createElement('span');
      badge.className = `severity ${finding.severity}`;
      badge.textContent = finding.severity;
      severityCell.append(badge);
      const ruleCell = row.insertCell();
      const code = document.createElement('code');
      code.textContent = finding.ruleId;
      ruleCell.append(code);
      const locationCell = row.insertCell();
      locationCell.textContent = `${finding.sourceId}\n${finding.timestamp ?? `row ${finding.rowNumber ?? 'unknown'}`}`;
      row.insertCell().textContent = formatObserved(finding.observedValue);
      row.insertCell().textContent = finding.expectedCondition;
      row.insertCell().textContent = finding.evidence.message;
      if (finding.sampleIndex !== undefined) {
        row.tabIndex = 0;
        row.title = 'Press Enter to jump to this sample in Monitor.';
        const jump = () => {
          this.setReplayIndex(finding.sampleIndex!);
          this.openView('monitor');
        };
        row.addEventListener('dblclick', jump);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') jump();
        });
      }
    }
  }

  private renderQuarantine(): void {
    const container = byId('quarantine-list');
    container.replaceChildren();
    const rows = this.currentRun?.quarantinedRows ?? [];
    setText('quarantine-count', rows.length);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No quarantined rows.';
      container.append(empty);
      return;
    }
    for (const row of rows.slice(0, 100)) {
      const article = document.createElement('article');
      const title = document.createElement('strong');
      title.textContent = `Row ${row.rowNumber} | ${row.issues.map((issue) => issue.code).join(', ')}`;
      const detail = document.createElement('p');
      detail.textContent = row.issues.map((issue) => issue.message).join(' ');
      article.append(title, detail);
      container.append(article);
    }
    if (rows.length > 100) {
      const note = document.createElement('p');
      note.textContent = `${rows.length - 100} additional rows are retained in the JSON report.`;
      container.append(note);
    }
  }

  private renderProfiles(): void {
    const select = byId<HTMLSelectElement>('profile-select');
    select.replaceChildren();
    for (const profile of detectionProfiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `${profile.label} | v${profile.version}`;
      select.append(option);
    }
    select.value = this.activeProfile.id;
  }

  private renderConfiguration(): void {
    const run = this.currentRun;
    setText('app-version', `v${APPLICATION_VERSION}`);
    setText('config-app-version', APPLICATION_VERSION);
    setText('config-schema', run?.schemaVersion ?? 'telemetry.v1');
    setText('config-adapter', run ? `${run.adapterId}@${run.adapterVersion}` : 'None');
    setText('config-profile', this.activeProfile.label);
    setText('config-profile-version', this.activeProfile.version);
    setText('config-hash', run?.provenance.datasetSha256 ?? 'Not loaded');
    setText('rule-count', this.activeProfile.rules.filter((rule) => rule.enabled).length);
    const body = byId<HTMLTableSectionElement>('rules-body');
    body.replaceChildren();
    for (const rule of this.activeProfile.rules.filter((candidate) => candidate.enabled)) {
      const row = body.insertRow();
      const codeCell = row.insertCell();
      const code = document.createElement('code');
      code.textContent = rule.id;
      codeCell.append(code);
      const severityCell = row.insertCell();
      const badge = document.createElement('span');
      badge.className = `severity ${rule.severity}`;
      badge.textContent = rule.severity;
      severityCell.append(badge);
      row.insertCell().textContent = ruleCondition(rule);
    }
    this.renderTemporalModelConfiguration();
  }

  private renderFaultScenarios(): void {
    const select = byId<HTMLSelectElement>('fault-scenario');
    select.replaceChildren();
    for (const scenario of DECLARED_FAULT_SCENARIOS) {
      const option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = scenario.label;
      select.append(option);
    }
    this.renderFaultDescription();
  }

  private renderFaultDescription(): void {
    const scenario = getFaultScenario(byId<HTMLSelectElement>('fault-scenario').value);
    setText(
      'fault-description',
      scenario
        ? `${scenario.description} Expected rule evidence: ${scenario.expectedRuleIds.join(', ')}.`
        : '',
    );
  }

  private async injectSelectedFault(): Promise<void> {
    if (!this.currentRun || !this.currentAnalysis) return;
    const scenarioId = byId<HTMLSelectElement>('fault-scenario').value as FaultScenarioId;
    const scenario = getFaultScenario(scenarioId);
    if (!scenario) return;
    const seed = Number(byId<HTMLInputElement>('fault-seed').value);
    if (!Number.isSafeInteger(seed) || seed <= 0) {
      this.showMessage(
        'Invalid seed',
        'Use a positive integer seed for reproducible injection.',
        'error',
        true,
      );
      return;
    }

    try {
      const source = { run: this.currentRun, analysis: this.currentAnalysis };
      this.baseline = source;
      let candidateRun: TelemetryRun;
      let candidateSource: string | undefined;
      if (scenario.target === 'legacy-csv') {
        if (!this.currentSourceText || this.currentInputFormat !== 'csv') {
          throw new Error(
            'This row-level scenario requires a legacy CSV source. Load the included baseline first.',
          );
        }
        candidateSource = injectLegacyCsvFault(
          this.currentSourceText,
          scenarioId as 'blank-csv-value' | 'nonnumeric-csv-value',
          seed,
        );
        candidateRun = await legacyCsvAdapter.parse(candidateSource, {
          runId: `${this.currentRun.runId}-fault-${scenarioId}-seed-${seed}`,
          profileId: this.activeProfile.id,
          profileVersion: this.activeProfile.version,
        });
      } else {
        candidateRun = await injectFaultScenario(this.currentRun, scenarioId, seed);
      }
      const candidateAnalysis = analyzeTelemetryRun(candidateRun, this.activeProfile);
      this.currentRun = candidateRun;
      this.currentAnalysis = candidateAnalysis;
      this.currentSourceText = candidateSource;
      this.currentInputFormat = 'injected';
      this.candidate = { run: candidateRun, analysis: candidateAnalysis };
      this.verification = createVerificationRun(
        source.run,
        source.analysis,
        candidateRun,
        candidateAnalysis,
      );
      this.replayIndex = 0;
      this.renderRun(`${scenario.label} | seed ${seed}`);
      this.openView('verification');
      this.showMessage(
        'Candidate created',
        `${scenario.label} was injected deterministically with seed ${seed}. The source baseline remains captured for comparison.`,
        'warning',
      );
      this.announce(`Candidate created. Verification status ${this.verification.status}.`);
    } catch (error) {
      this.showMessage(
        'Fault injection failed',
        error instanceof Error ? error.message : 'Unknown failure.',
        'error',
        true,
      );
    }
  }

  private captureBaseline(): void {
    if (!this.currentRun || !this.currentAnalysis) return;
    this.baseline = { run: this.currentRun, analysis: this.currentAnalysis };
    this.candidate = undefined;
    this.verification = undefined;
    this.renderVerification();
    this.announce('Current run captured as the verification baseline.');
  }

  private captureCandidate(): void {
    if (!this.currentRun || !this.currentAnalysis || !this.baseline) {
      this.showMessage(
        'Baseline required',
        'Capture a baseline before selecting a candidate.',
        'warning',
        true,
      );
      return;
    }
    this.candidate = { run: this.currentRun, analysis: this.currentAnalysis };
    try {
      this.verification = createVerificationRun(
        this.baseline.run,
        this.baseline.analysis,
        this.candidate.run,
        this.candidate.analysis,
      );
      this.renderVerification();
      this.announce(`Verification complete with status ${this.verification.status}.`);
    } catch (error) {
      this.verification = undefined;
      this.showMessage(
        'Comparison blocked',
        error instanceof Error ? error.message : 'Runs cannot be compared.',
        'error',
        true,
      );
    }
  }

  private renderVerification(): void {
    this.renderCapturedRun('baseline', this.baseline);
    this.renderCapturedRun('candidate', this.candidate);
    const verification = this.verification;
    const statusCard = byId('verification-status');
    if (!verification) {
      statusCard.dataset.status = 'empty';
      setText('verification-status-title', 'Comparison pending');
      setText('verification-status-detail', 'Capture a baseline and candidate to compare.');
      statusCard.querySelector('.verification-symbol')!.textContent = 'o';
    } else {
      statusCard.dataset.status = verification.status === 'pass' ? 'pass' : 'fail';
      const title =
        verification.status === 'pass'
          ? 'Verification passed'
          : verification.status === 'blocked'
            ? 'Verification blocked'
            : 'Regression detected';
      setText('verification-status-title', title);
      setText(
        'verification-status-detail',
        `${verification.summary.resolved} resolved, ${verification.summary.persisting} persisting, ${verification.summary.newlyIntroduced} newly introduced.`,
      );
      statusCard.querySelector('.verification-symbol')!.textContent =
        verification.status === 'pass' ? 'OK' : 'X';
    }
    this.renderClassificationList('resolved', verification?.resolved ?? []);
    this.renderClassificationList('persisting', verification?.persisting ?? []);
    this.renderClassificationList('introduced', verification?.newlyIntroduced ?? []);
    this.renderRequirementResults();
    byId<HTMLButtonElement>('export-verification').disabled = !verification;
  }

  private renderCapturedRun(prefix: 'baseline' | 'candidate', captured?: CapturedRun): void {
    setText(
      `${prefix}-name`,
      (captured?.run.metadata.title as string | undefined) ?? 'Not captured',
    );
    setText(`${prefix}-hash`, captured?.run.provenance.datasetSha256.slice(0, 8) ?? '--------');
    setText(`${prefix}-samples`, captured?.run.samples.length ?? 0);
    setText(`${prefix}-findings`, captured?.analysis.findings.length ?? 0);
  }

  private renderClassificationList(
    prefix: 'resolved' | 'persisting' | 'introduced',
    classifications: FindingClassification[],
  ): void {
    setText(`${prefix}-count`, classifications.length);
    const list = byId<HTMLOListElement>(`${prefix}-list`);
    list.replaceChildren();
    if (classifications.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'None';
      list.append(empty);
      return;
    }
    for (const classification of classifications.slice(0, 50)) {
      const finding = classificationFinding(classification);
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = finding?.ruleId ?? classification.fingerprint;
      const detail = document.createElement('span');
      detail.textContent = `${finding?.sourceId ?? 'unknown'} | ${finding?.timestamp ?? 'run-level finding'}`;
      item.append(title, detail);
      list.append(item);
    }
  }

  private renderRequirementResults(): void {
    const body = byId<HTMLTableSectionElement>('requirements-body');
    body.replaceChildren();
    const results = [
      {
        id: 'REQ-VER-001',
        pass: Boolean(this.verification && this.verification.status !== 'blocked'),
        pending: !this.verification,
        evidence: this.verification
          ? `Verification ${this.verification.verificationId} completed.`
          : 'Comparison has not run.',
      },
      {
        id: 'REQ-PROV-001',
        pass: Boolean(
          this.baseline?.run.provenance.datasetSha256 &&
          this.candidate?.run.provenance.datasetSha256,
        ),
        pending: !this.verification,
        evidence: 'Both datasets require SHA-256 provenance.',
      },
      {
        id: 'REQ-VER-002',
        pass: this.verification?.newlyIntroduced.length === 0,
        pending: !this.verification,
        evidence: this.verification
          ? `${this.verification.newlyIntroduced.length} newly introduced findings.`
          : 'Comparison has not run.',
      },
    ];
    for (const result of results) {
      const row = body.insertRow();
      const idCell = row.insertCell();
      const code = document.createElement('code');
      code.textContent = result.id;
      idCell.append(code);
      const resultCell = row.insertCell();
      const badge = document.createElement('span');
      badge.className = `result-badge ${result.pending ? 'pending' : result.pass ? 'pass' : 'fail'}`;
      badge.textContent = result.pending ? 'Pending' : result.pass ? 'Pass' : 'Fail';
      resultCell.append(badge);
      row.insertCell().textContent = result.evidence;
    }
  }

  private downloadFindings(): void {
    if (!this.currentAnalysis || !this.currentRun) return;
    downloadText(
      `${slug(this.currentRun.runId)}-findings.csv`,
      exportFindingsCsv(this.currentAnalysis.findings),
      'text/csv',
    );
    this.announce('Findings CSV export created without uploaded source rows.');
  }

  private downloadRunReport(): void {
    if (!this.currentRun || !this.currentAnalysis) return;
    const includeSourceData = byId<HTMLInputElement>('include-source-export').checked;
    downloadText(
      `${slug(this.currentRun.runId)}-diagnostic-report.json`,
      serializeDiagnosticReport(this.currentRun, this.currentAnalysis, this.verification, {
        includeSourceData,
      }),
      'application/json',
    );
    this.announce(
      includeSourceData
        ? 'Diagnostic report exported with source data by explicit selection.'
        : 'Diagnostic report exported without source data.',
    );
  }

  private downloadVerification(): void {
    if (!this.verification || !this.currentRun || !this.currentAnalysis) return;
    const report = buildDiagnosticReport(this.currentRun, this.currentAnalysis, this.verification, {
      includeSourceData: false,
    });
    downloadText(
      `${slug(this.verification.verificationId)}.json`,
      JSON.stringify(report, null, 2),
      'application/json',
    );
    this.announce('Versioned verification report exported without source data.');
  }

  private renderTemporalScenarios(): void {
    const select = byId<HTMLSelectElement>('temporal-scenario');
    select.replaceChildren();
    const nominal = document.createElement('option');
    nominal.value = 'nominal';
    nominal.textContent = 'Nominal mission | no injected fault';
    select.append(nominal);
    for (const definition of DECLARED_TEMPORAL_FAULTS) {
      const option = document.createElement('option');
      option.value = definition.id;
      option.textContent = definition.label;
      select.append(option);
    }
    select.value = 'gradual-drift';
  }

  private runInvestigation(): void {
    const scenarioId = byId<HTMLSelectElement>('temporal-scenario')
      .value as TemporalScenario['scenarioId'];
    const seed = Number(byId<HTMLInputElement>('temporal-seed').value);
    const sampleCount = Number(byId<HTMLInputElement>('temporal-samples').value);
    const state = byId('investigation-status');
    if (!Number.isInteger(seed) || seed < 1 || seed > 2_147_483_647) {
      state.dataset.quality = 'warning';
      state.textContent = 'Invalid seed';
      this.announce('Investigation seed must be a positive integer.');
      return;
    }
    if (!Number.isInteger(sampleCount) || sampleCount < 60 || sampleCount > 2_000) {
      state.dataset.quality = 'warning';
      state.textContent = 'Invalid sample count';
      this.announce('Investigation sample count must be between 60 and 2,000.');
      return;
    }
    state.dataset.quality = 'unknown';
    state.textContent = 'Analyzing';
    byId<HTMLButtonElement>('capture-investigation-baseline').disabled = true;
    byId<HTMLInputElement>('investigation-comparison-overlay').disabled = true;
    this.setInvestigationComparisonStatus(
      this.investigationBaseline
        ? 'Checking the current scenario against the captured baseline.'
        : 'Analyzing the current scenario before a baseline can be captured.',
      'unknown',
    );
    try {
      this.temporalScenario = generateTemporalScenario({
        seed,
        scenarioId,
        sampleCount,
        cadenceMs: this.temporalArtifact.cadenceMs,
      });
      this.analyzeCurrentTemporalScenario();
      this.openView('investigation');
      this.announce(`Temporal investigation completed for ${scenarioId}, seed ${seed}.`);
    } catch (error) {
      this.temporalScenario = undefined;
      this.investigation = undefined;
      this.renderEmptyInvestigation();
      state.dataset.quality = 'warning';
      state.textContent = 'Analysis failed';
      this.announce(
        error instanceof Error
          ? `Temporal analysis failed: ${error.message}`
          : 'Temporal analysis failed.',
      );
    }
  }

  private analyzeCurrentTemporalScenario(): void {
    if (!this.temporalScenario) return;
    const modelActive = this.temporalModelCompatibility().readiness.active;
    this.investigation = analyzeTemporalScenario(this.temporalScenario, {
      modelEnabled: modelActive,
      covarianceModelEnabled: this.learnedModelEnabled,
    });
    this.investigationIndex = this.temporalScenario.faultTimeline?.onsetIndex ?? 0;
    this.renderInvestigationCharts();
    this.renderInvestigationEvidence();
    this.setInvestigationIndex(this.investigationIndex);
    byId<HTMLButtonElement>('investigation-export').disabled = false;
    const state = byId('investigation-status');
    state.dataset.quality = this.investigation.indications.length > 0 ? 'warning' : 'good';
    state.textContent =
      this.investigation.indications.length > 0
        ? `${this.investigation.indications.length} rule indications`
        : 'Nominal rule result';
    this.renderTemporalModelConfiguration();
  }

  private renderEmptyInvestigation(): void {
    this.investigationCharts.clear();
    setText('investigation-phase', '---');
    setText('investigation-phase-detail', 'No temporal sample selected');
    setText('investigation-agreement', '---');
    setText('investigation-agreement-detail', 'deterministic rules are authoritative');
    setText('investigation-rule-count', 0);
    setText('investigation-rule-detail', 'observed evidence only');
    setText('investigation-model-confidence', 'N/A');
    setText('investigation-model-label', 'model disabled');
    const slider = byId<HTMLInputElement>('investigation-replay-slider');
    slider.disabled = true;
    slider.min = '0';
    slider.max = '0';
    slider.value = '0';
    setText('investigation-replay-position', '0 / 0');
    byId<HTMLButtonElement>('investigation-export').disabled = true;
    this.setEmptyList('investigation-hypotheses', 'The temporal model is disabled.');
    this.setEmptyList('investigation-indications', 'No investigation has run.');
    this.setEmptyList('investigation-phase-log', 'No phase evidence is available.');
    this.setEmptyList('investigation-detector-agreement', 'No detector evidence is available.');
    const timeline = byId('investigation-timeline');
    timeline.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Run a synthetic scenario to inspect onset and recovery.';
    timeline.append(empty);
    this.renderInvestigationComparisonState();
  }

  private buildInvestigationChartSeries(): ChartInvestigationSeries | undefined {
    if (!this.temporalScenario || !this.investigation) return undefined;
    const scenario = this.temporalScenario;
    const investigation = this.investigation;
    const timeline = scenario.faultTimeline;
    return {
      sampleIndices: investigation.points.map(({ sampleIndex }) => sampleIndex),
      timestamps: investigation.points.map(({ timestamp }) => timestamp),
      observedAltitude: investigation.points.map(({ fusion }) => fusion.observed.altitude),
      predictedAltitude: investigation.points.map(({ fusion }) => fusion.predicted.altitude),
      lowerUncertainty: investigation.points.map(({ fusion }) => fusion.altitude95[0]),
      upperUncertainty: investigation.points.map(({ fusion }) => fusion.altitude95[1]),
      observedAirspeed: scenario.samples.map(({ measurements }) =>
        meanFinite([measurements.indicatedAirspeed, measurements.gpsGroundSpeed]),
      ),
      observedFuel: scenario.samples.map(({ measurements }) => measurements.fuelQuantity),
      residualValues: investigation.points.map(
        ({ maximumAbsoluteNormalizedResidual }) => maximumAbsoluteNormalizedResidual,
      ),
      phaseSegments: investigationPhaseSegments(investigation),
      faultMarkers:
        timeline === null
          ? []
          : [
              {
                faultId: timeline.faultId,
                label:
                  DECLARED_TEMPORAL_FAULTS.find(({ id }) => id === timeline.faultId)?.label ??
                  timeline.faultId,
                onsetIndex: timeline.onsetIndex,
                endIndex: timeline.activeEndIndex,
                recoveryIndex: timeline.recoveryEndIndex,
                ...(investigation.detection.deterministicIndex === null
                  ? {}
                  : { detectionIndex: investigation.detection.deterministicIndex }),
              },
            ],
    };
  }

  private investigationComparisonIdentity(
    series: ChartInvestigationSeries,
  ): InvestigationComparisonIdentity | undefined {
    const scenario = this.temporalScenario;
    if (!scenario) return undefined;
    return {
      profileId: scenario.profileId,
      cadenceMs: scenario.cadenceMs,
      sampleCount: scenario.samples.length,
      sampleIndices: series.sampleIndices,
    };
  }

  private capturedInvestigationIdentity(): InvestigationComparisonIdentity | undefined {
    const baseline = this.investigationBaseline;
    if (!baseline) return undefined;
    return {
      profileId: baseline.profileId,
      cadenceMs: baseline.cadenceMs,
      sampleCount: baseline.sampleCount,
      sampleIndices: baseline.series.sampleIndices,
    };
  }

  private investigationComparisonCompatibility(
    series: ChartInvestigationSeries,
  ): InvestigationComparisonCompatibility | undefined {
    const baseline = this.capturedInvestigationIdentity();
    const current = this.investigationComparisonIdentity(series);
    return baseline && current ? evaluateInvestigationComparison(baseline, current) : undefined;
  }

  private setInvestigationComparisonStatus(
    message: string,
    quality: 'unknown' | 'good' | 'warning',
  ): void {
    const status = byId('investigation-comparison-status');
    status.textContent = message;
    status.dataset.quality = quality;
  }

  private renderInvestigationComparisonState(
    series = this.buildInvestigationChartSeries(),
  ): InvestigationComparisonCompatibility | undefined {
    const capture = byId<HTMLButtonElement>('capture-investigation-baseline');
    const overlay = byId<HTMLInputElement>('investigation-comparison-overlay');
    const baseline = this.investigationBaseline;
    capture.disabled = series === undefined;
    capture.textContent = baseline ? 'Replace comparison baseline' : 'Capture comparison baseline';
    if (!baseline) {
      overlay.disabled = true;
      this.setInvestigationComparisonStatus('No comparison baseline captured.', 'unknown');
      return undefined;
    }
    if (!series || !this.temporalScenario) {
      overlay.disabled = true;
      this.setInvestigationComparisonStatus(
        `Baseline retained: ${baseline.scenarioId}, seed ${baseline.seed}. Run a compatible scenario to compare.`,
        'unknown',
      );
      return undefined;
    }
    const compatibility = this.investigationComparisonCompatibility(series);
    if (!compatibility?.compatible) {
      overlay.disabled = true;
      this.setInvestigationComparisonStatus(
        `Baseline not overlaid. ${compatibility?.reasons.join(' ') ?? 'Compatibility is unavailable.'}`,
        'warning',
      );
      return compatibility;
    }
    overlay.disabled = false;
    this.setInvestigationComparisonStatus(
      overlay.checked
        ? `Overlay active: baseline ${baseline.scenarioId}, seed ${baseline.seed}, versus current ${this.temporalScenario.scenarioId}, seed ${this.temporalScenario.seed}.`
        : 'Compatible comparison baseline available. The waveform overlay is hidden.',
      'good',
    );
    return compatibility;
  }

  private captureInvestigationBaseline(): void {
    const scenario = this.temporalScenario;
    const series = this.buildInvestigationChartSeries();
    if (!scenario || !series) {
      this.announce('Run a temporal investigation before capturing a comparison baseline.');
      return;
    }
    this.investigationBaseline = {
      capturedAt: new Date().toISOString(),
      profileId: scenario.profileId,
      cadenceMs: scenario.cadenceMs,
      sampleCount: scenario.samples.length,
      scenarioId: scenario.scenarioId,
      seed: scenario.seed,
      series,
    };
    const overlay = byId<HTMLInputElement>('investigation-comparison-overlay');
    overlay.checked = true;
    this.renderInvestigationComparisonState(series);
    this.renderInvestigationCharts();
    this.announce(
      `Comparison baseline captured for ${scenario.scenarioId}, seed ${scenario.seed}. Deterministic rules remain authoritative.`,
    );
  }

  private renderInvestigationCharts(): void {
    const chartSeries = this.buildInvestigationChartSeries();
    if (!chartSeries) return;
    const checkbox = (name: string): boolean =>
      document.querySelector<HTMLInputElement>(`[data-investigation-overlay="${name}"]`)?.checked ??
      true;
    const overlays: Partial<InvestigationOverlayVisibility> = {
      predictedAltitude: checkbox('prediction'),
      uncertainty: checkbox('uncertainty'),
      phases: checkbox('phases'),
      faultMarkers: checkbox('faults'),
      comparisonBaseline: checkbox('comparison'),
    };
    const compatibility = this.renderInvestigationComparisonState(chartSeries);
    const baseline = compatibility?.compatible ? this.investigationBaseline : undefined;
    this.investigationCharts.render(chartSeries, {
      overlays,
      ...(baseline
        ? {
            comparison: {
              sampleIndices: baseline.series.sampleIndices,
              observedAltitude: baseline.series.observedAltitude,
              predictedAltitude: baseline.series.predictedAltitude,
            },
          }
        : {}),
    });
    this.investigationCharts.setCursor(this.investigationIndex);
  }

  private setInvestigationIndex(index: number): void {
    const investigation = this.investigation;
    if (!investigation || investigation.points.length === 0) return;
    this.investigationIndex = Math.max(
      0,
      Math.min(investigation.points.length - 1, Math.floor(index)),
    );
    const point = investigation.points[this.investigationIndex]!;
    const slider = byId<HTMLInputElement>('investigation-replay-slider');
    slider.disabled = false;
    slider.max = String(investigation.points.length - 1);
    slider.value = String(this.investigationIndex);
    setText(
      'investigation-replay-position',
      `${this.investigationIndex + 1} / ${investigation.points.length}`,
    );
    this.investigationCharts.setCursor(this.investigationIndex);
    setText('investigation-phase', phaseLabel(point.phase));
    setText(
      'investigation-phase-detail',
      point.phaseEvaluation.transitioned
        ? `transition confirmed at sample ${point.sampleIndex}`
        : `sample ${point.sampleIndex} | ${point.timestamp.slice(11, 19)} UTC`,
    );
    const fourWayAgreement = point.detectorEvidence.fourWayAgreement;
    const agreementState = fourWayAgreement.state.replaceAll('-', ' ');
    setText(
      'investigation-agreement',
      fourWayAgreement.complete
        ? agreementState
        : `partial ${agreementState.replace('unanimous ', '')}`,
    );
    setText(
      'investigation-agreement-detail',
      `${fourWayAgreement.indicatingSignals} indicate | ${fourWayAgreement.nominalSignals} nominal | ${fourWayAgreement.unavailableSignals.length} unavailable | deterministic authority`,
    );
    setText('investigation-rule-count', investigation.indications.length);
    setText(
      'investigation-rule-detail',
      `${point.indications.length} at selected sample | deterministic authority`,
    );
    const score = point.model.score;
    if (score === null) {
      setText('investigation-model-confidence', 'Warmup');
      setText('investigation-model-label', `${point.model.warmupRemaining} samples remaining`);
    } else if (!score.activation.active) {
      setText('investigation-model-confidence', 'Disabled');
      setText('investigation-model-label', score.activation.inactiveReason ?? 'inactive');
    } else {
      setText('investigation-model-confidence', `${(score.relativeScore * 100).toFixed(1)}%`);
      setText(
        'investigation-model-label',
        score.abstained ? 'unknown | abstained' : score.predictedLabel.replaceAll('-', ' '),
      );
    }
    this.renderInvestigationHypotheses(point.model.score);
    this.renderInvestigationIndications(point.sampleIndex);
    this.renderInvestigationDetectorAgreement(point);
  }

  private renderInvestigationDetectorAgreement(
    point: TemporalScenarioInvestigation['points'][number],
  ): void {
    const list = byId<HTMLOListElement>('investigation-detector-agreement');
    list.replaceChildren();
    const evidence = point.detectorEvidence;
    const topResiduals = evidence.kalmanInnovation.topResidualSensorChannels
      .map(
        ({ sensorId, absoluteNormalizedInnovation }) =>
          `${sensorId} ${absoluteNormalizedInnovation.toFixed(2)} sigma`,
      )
      .join(', ');
    const rows: readonly [string, string][] = [
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
    for (const [labelText, detailText] of rows) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = labelText;
      const detail = document.createElement('span');
      detail.textContent = detailText;
      item.append(label, detail);
      list.append(item);
    }
  }

  private renderInvestigationEvidence(): void {
    const scenario = this.temporalScenario;
    const investigation = this.investigation;
    if (!scenario || !investigation) return;
    const timeline = byId('investigation-timeline');
    timeline.replaceChildren();
    if (scenario.faultTimeline === null) {
      const nominal = document.createElement('p');
      nominal.className = 'empty-state';
      nominal.textContent = 'Nominal scenario, no fault lifecycle was injected.';
      timeline.append(nominal);
    } else {
      const definition = DECLARED_TEMPORAL_FAULTS.find(
        ({ id }) => id === scenario.faultTimeline?.faultId,
      );
      for (const [label, value] of [
        ['Scenario', definition?.label ?? scenario.faultTimeline.faultId],
        ['Onset', `sample ${scenario.faultTimeline.onsetIndex}`],
        [
          'Active interval',
          `${scenario.faultTimeline.durationSamples} samples through ${scenario.faultTimeline.activeEndIndex}`,
        ],
        [
          'Recovery',
          `${scenario.faultTimeline.recoverySamples} samples through ${scenario.faultTimeline.recoveryEndIndex}`,
        ],
        [
          'Rule detection',
          investigation.detection.deterministicIndex === null
            ? 'not detected'
            : `sample ${investigation.detection.deterministicIndex} | ${investigation.detection.deterministicDelaySamples} sample delay`,
        ],
      ] as const) {
        const row = document.createElement('article');
        const title = document.createElement('strong');
        title.textContent = label;
        const detail = document.createElement('p');
        detail.textContent = value;
        row.append(title, detail);
        timeline.append(row);
      }
    }
    const phaseList = byId<HTMLOListElement>('investigation-phase-log');
    phaseList.replaceChildren();
    if (investigation.phaseTransitions.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No phase transitions were confirmed.';
      phaseList.append(empty);
    } else {
      for (const transition of investigation.phaseTransitions) {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = `${phaseLabel(transition.from)} to ${phaseLabel(transition.to)}`;
        const detail = document.createElement('span');
        detail.textContent = `Sample ${transition.sampleIndex} | ${transition.confirmationSamples} confirmations | ${transition.hysteresisCondition}`;
        item.append(title, detail);
        phaseList.append(item);
      }
    }
  }

  private renderInvestigationHypotheses(
    score: TemporalScenarioInvestigation['points'][number]['model']['score'],
  ): void {
    const list = byId<HTMLOListElement>('investigation-hypotheses');
    list.replaceChildren();
    if (!score || !score.activation.active) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = score
        ? 'Temporal model is inactive. Enable it in Configuration to view advisory hypotheses.'
        : 'Temporal model is warming up the 40-sample causal window.';
      list.append(empty);
      return;
    }
    if (score.abstained) {
      const unknown = document.createElement('li');
      unknown.className = 'empty-state';
      unknown.textContent =
        'Unknown: the model abstained because support or confidence was insufficient.';
      list.append(unknown);
    }
    for (const hypothesis of score.hypotheses) {
      const item = document.createElement('li');
      item.className = 'hypothesis-row';
      const label = document.createElement('strong');
      label.textContent = hypothesis.faultType.replaceAll('-', ' ');
      const value = document.createElement('span');
      value.textContent = `${(hypothesis.relativeScore * 100).toFixed(1)}%`;
      const meter = document.createElement('meter');
      meter.min = 0;
      meter.max = 1;
      meter.value = hypothesis.relativeScore;
      meter.textContent = value.textContent;
      item.append(label, value, meter);
      list.append(item);
    }
  }

  private renderInvestigationIndications(sampleIndex: number): void {
    const list = byId<HTMLOListElement>('investigation-indications');
    list.replaceChildren();
    const indications =
      this.investigation?.indications
        .filter((entry) => entry.sampleIndex <= sampleIndex)
        .slice(-8) ?? [];
    if (indications.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No deterministic indication has occurred by this sample.';
      list.append(empty);
      return;
    }
    for (const indication of indications) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `${indication.severity.toUpperCase()} | ${indication.ruleId}`;
      const detail = document.createElement('span');
      detail.textContent = `Sample ${indication.sampleIndex} | ${formatObserved(indication.observedValue)} | ${indication.expectedCondition}`;
      item.append(title, detail);
      list.append(item);
    }
  }

  private setEmptyList(id: string, message: string): void {
    const list = byId<HTMLOListElement>(id);
    list.replaceChildren();
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = message;
    list.append(empty);
  }

  private downloadInvestigation(): void {
    if (!this.temporalScenario || !this.investigation) return;
    const includeSourceData = byId<HTMLInputElement>('include-investigation-source-export').checked;
    const payload = {
      schemaVersion: 'investigation-export.v1',
      applicationVersion: APPLICATION_VERSION,
      generatedAt: new Date().toISOString(),
      authority: 'deterministic-rules',
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      model: {
        artifactVersion: this.temporalArtifact.artifactVersion,
        modelVersion: this.temporalArtifact.modelVersion,
        userEnabled: this.temporalModelEnabled,
        artifactSha256: this.temporalArtifactSha256,
        configurationSha256: this.temporalArtifact.training.configurationSha256,
      },
      scenario: {
        schemaVersion: this.temporalScenario.schemaVersion,
        profileId: this.temporalScenario.profileId,
        scenarioId: this.temporalScenario.scenarioId,
        seed: this.temporalScenario.seed,
        cadenceMs: this.temporalScenario.cadenceMs,
        startedAt: this.temporalScenario.startedAt,
        synthetic: this.temporalScenario.synthetic,
        dataClassification: this.temporalScenario.dataClassification,
        faultTimeline: this.temporalScenario.faultTimeline,
        sampleCount: this.temporalScenario.samples.length,
      },
      investigation: {
        scenario: this.investigation.scenario,
        phaseTransitions: this.investigation.phaseTransitions,
        indications: this.investigation.indications,
        markers: this.investigation.markers,
        hypothesisScores: this.investigation.hypothesisScores,
        detection: this.investigation.detection,
      },
      exportPolicy: {
        sourceDataIncluded: includeSourceData,
        note: includeSourceData
          ? 'Generated source windows were included by explicit user selection.'
          : 'Generated source windows, point traces, and series were excluded by default.',
      },
      ...(includeSourceData
        ? {
            sourceData: {
              samples: this.temporalScenario.samples,
              points: this.investigation.points,
              series: this.investigation.series,
            },
          }
        : {}),
    };
    downloadText(
      `temporal-investigation-${this.temporalScenario.scenarioId}-seed-${this.temporalScenario.seed}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    );
    this.announce(
      includeSourceData
        ? 'Synthetic temporal investigation exported with generated source windows by explicit selection.'
        : 'Synthetic temporal investigation exported without generated source windows.',
    );
  }

  private campaignSeeds(): number[] {
    const raw = byId<HTMLInputElement>('campaign-seeds').value;
    const tokens = raw
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token !== '');
    if (tokens.length === 0 || tokens.length > 12) {
      throw new Error('Enter between 1 and 12 comma-separated campaign seeds.');
    }
    const seeds = tokens.map(Number);
    if (seeds.some((seed) => !Number.isInteger(seed) || seed < 1 || seed > 2_147_483_647)) {
      throw new Error('Campaign seeds must be positive 32-bit integers.');
    }
    if (new Set(seeds).size !== seeds.length) {
      throw new Error('Campaign seeds must be unique.');
    }
    return seeds;
  }

  private async runTemporalCampaign(): Promise<void> {
    if (this.campaignRunning) return;
    let spec;
    try {
      spec = buildDefaultTemporalCampaignSpec(this.campaignSeeds());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Campaign configuration is invalid.';
      setText('campaign-status', 'Configuration error');
      setText('campaign-progress-label', message);
      this.announce(message);
      return;
    }

    this.campaignRunning = true;
    this.campaignResult = undefined;
    byId<HTMLButtonElement>('campaign-run').disabled = true;
    byId<HTMLButtonElement>('campaign-cancel').disabled = false;
    byId<HTMLButtonElement>('campaign-export').disabled = true;
    const progress = byId<HTMLProgressElement>('campaign-progress');
    progress.max = spec.profiles.length * spec.scenarios.length * spec.seeds.length;
    progress.value = 0;
    setText('campaign-status', 'Running in worker');
    setText('campaign-progress-label', `0 of ${progress.max} cases complete.`);
    this.renderCampaignSummaryMessage(
      'Campaign running',
      'The interface remains available while the inline worker evaluates synthetic cases.',
    );

    try {
      const result = await this.campaignClient.run(spec, {
        onProgress: (update) => this.renderCampaignProgress(update),
      });
      this.campaignResult = result;
      this.renderCampaignResult(result);
      byId<HTMLButtonElement>('campaign-export').disabled = false;
      this.announce(
        `Temporal campaign completed: ${result.summary.completedCases} cases and ${result.summary.failedCases} contained failures.`,
      );
    } catch (error) {
      if (error instanceof CampaignCancelledError) {
        this.campaignResult = error.partialResult;
        this.renderCampaignResult(error.partialResult);
        byId<HTMLButtonElement>('campaign-export').disabled = false;
        this.announce(
          `Temporal campaign cancelled after ${error.partialResult.summary.completedCases} completed cases with ${error.partialResult.summary.remainingCases} remaining. Partial evidence is available to export.`,
        );
      } else if (error instanceof Error && error.name === 'AbortError') {
        setText('campaign-status', 'Cancelled before start');
        setText('campaign-progress-label', error.message);
        this.renderCampaignSummaryMessage(
          'Campaign cancelled before start',
          'No campaign case ran, so there is no partial result to export.',
        );
        this.announce('Temporal campaign cancelled before start.');
      } else {
        const message = error instanceof Error ? error.message : 'Temporal campaign failed.';
        setText('campaign-status', 'Failed');
        setText('campaign-progress-label', message);
        this.renderCampaignSummaryMessage('Campaign failed safely', message);
        this.announce(`Temporal campaign failed: ${message}`);
      }
    } finally {
      this.campaignRunning = false;
      byId<HTMLButtonElement>('campaign-run').disabled = false;
      byId<HTMLButtonElement>('campaign-cancel').disabled = true;
    }
  }

  private cancelTemporalCampaign(): void {
    if (!this.campaignRunning) return;
    if (this.campaignClient.cancel()) {
      setText('campaign-status', 'Cancelling');
      setText('campaign-progress-label', 'Cancellation requested. Finishing the active case.');
    }
  }

  private renderCampaignProgress(update: CampaignProgress): void {
    const progress = byId<HTMLProgressElement>('campaign-progress');
    progress.max = Math.max(1, update.totalCases);
    progress.value = update.completedCases;
    const current = update.currentCaseId ? ` Last case: ${update.currentCaseId}.` : '';
    setText(
      'campaign-progress-label',
      `${update.completedCases} of ${update.totalCases} cases complete.${current}`,
    );
  }

  private renderCampaignResult(result: CampaignResult): void {
    const { metrics, summary } = result;
    const progress = byId<HTMLProgressElement>('campaign-progress');
    progress.max = Math.max(1, summary.plannedCases);
    progress.value = summary.attemptedCases;
    setText(
      'campaign-status',
      result.status === 'completed'
        ? 'Completed'
        : result.status === 'completed-with-errors'
          ? 'Completed with contained errors'
          : 'Cancelled with partial evidence',
    );
    setText('campaign-cases', `${summary.completedCases} / ${summary.plannedCases}`);
    setText('campaign-f1', metrics.episodes.f1 === null ? 'N/A' : metrics.episodes.f1.toFixed(3));
    setText(
      'campaign-far-run',
      metrics.falseAlarmsPerRun === null ? 'N/A' : metrics.falseAlarmsPerRun.toFixed(3),
    );
    setText(
      'campaign-delay',
      metrics.timeToDetection.median === null
        ? 'N/A'
        : `${Math.round(metrics.timeToDetection.median / 1_000)} s`,
    );
    setText(
      'campaign-abstention',
      metrics.calibration.abstentionRate === null
        ? 'N/A'
        : `${(metrics.calibration.abstentionRate * 100).toFixed(1)}%`,
    );
    setText(
      'campaign-progress-label',
      `${summary.completedCases} completed, ${summary.failedCases} failed, ${summary.remainingCases} remaining.`,
    );

    const container = byId('campaign-summary');
    container.replaceChildren();
    const details: readonly [string, string][] = [
      [
        'Outcome',
        result.status === 'cancelled'
          ? `Cancelled with ${summary.completedCases} completed, ${summary.failedCases} failed, and ${summary.remainingCases} remaining cases. The in-flight case was not committed.`
          : `${summary.completedCases} completed, ${summary.failedCases} contained failures, and ${summary.remainingCases} remaining cases.`,
      ],
      [
        'Episode confusion',
        `${metrics.confusion.truePositives} TP, ${metrics.confusion.falsePositives} FP, ${metrics.confusion.trueNegatives} TN, ${metrics.confusion.falseNegatives} FN`,
      ],
      [
        'F1 confidence interval',
        metrics.bootstrap.f1.lower === null || metrics.bootstrap.f1.upper === null
          ? 'Unavailable for the completed sample'
          : `${metrics.bootstrap.f1.lower.toFixed(3)} to ${metrics.bootstrap.f1.upper.toFixed(3)} at ${(metrics.bootstrap.f1.confidenceLevel * 100).toFixed(0)}%`,
      ],
      [
        'Synthetic exposure',
        `${metrics.syntheticHours.toFixed(3)} hours | ${metrics.falseAlarmsPerSyntheticHour?.toFixed(3) ?? 'N/A'} false alarms/hour`,
      ],
      [
        'Replay evidence',
        `${result.replayManifest.cases.length} cases | spec ${result.replayManifest.specSha256.slice(0, 16)}`,
      ],
    ];
    for (const [label, detail] of details) {
      const row = document.createElement('article');
      const title = document.createElement('strong');
      title.textContent = label;
      const text = document.createElement('p');
      text.textContent = detail;
      row.append(title, text);
      container.append(row);
    }
  }

  private renderCampaignSummaryMessage(titleText: string, detailText: string): void {
    const container = byId('campaign-summary');
    container.replaceChildren();
    const row = document.createElement('article');
    const title = document.createElement('strong');
    title.textContent = titleText;
    const detail = document.createElement('p');
    detail.textContent = detailText;
    row.append(title, detail);
    container.append(row);
  }

  private downloadCampaign(): void {
    if (!this.campaignResult) return;
    downloadText(
      `${slug(this.campaignResult.campaignId)}-campaign.json`,
      serializeCampaignResult(this.campaignResult),
      'application/json',
    );
    this.announce('Versioned synthetic campaign report exported without source telemetry rows.');
  }

  private temporalModelCompatibility(
    userEnabled = this.temporalModelEnabled,
  ): ModelCompatibilityResult {
    return evaluateModelCompatibility(temporalFaultRegistryEntry, {
      schemaVersion: this.temporalArtifact.schemaVersion,
      profile: {
        id: this.temporalArtifact.profile.id,
        version: this.temporalArtifact.profile.version,
      },
      channelUnits: this.temporalArtifact.units,
      cadenceMs: this.temporalScenario?.cadenceMs ?? this.temporalArtifact.cadenceMs,
      windowLength: this.temporalArtifact.windowLength,
      artifactSha256: this.temporalArtifactSha256,
      configurationSha256: this.temporalArtifact.training.configurationSha256,
      userSelection: userEnabled ? 'enabled' : 'disabled',
      qualityGatePassed: temporalModelPassesQualityGate(this.temporalArtifact),
    });
  }

  private renderTemporalModelConfiguration(): void {
    let compatibility = this.temporalModelCompatibility();
    const eligible =
      compatibility.supported && compatibility.readiness.eligibility.state === 'eligible';
    if (!eligible && this.temporalModelEnabled) {
      this.temporalModelEnabled = false;
      compatibility = this.temporalModelCompatibility();
    }
    setText(
      'temporal-registry-entry',
      `${temporalFaultRegistryEntry.registryEntryId}@${temporalFaultRegistryEntry.modelVersion}`,
    );
    setText(
      'temporal-compatibility',
      compatibility.supported
        ? compatibility.readiness.active
          ? 'Supported and active'
          : compatibility.readiness.eligibility.state === 'eligible'
            ? 'Supported, user disabled'
            : 'Supported, quality gate ineligible'
        : 'Unsupported for active telemetry',
    );
    setText(
      'temporal-artifact-hash',
      this.temporalArtifactSha256
        ? this.temporalArtifactSha256.slice(0, 16)
        : 'Identity unavailable',
    );
    setText(
      'temporal-config-hash',
      temporalFaultRegistryEntry.identities.configurationSha256?.slice(0, 16) ?? 'Not registered',
    );
    setText(
      'temporal-window',
      `${this.temporalArtifact.windowLength} samples at ${this.temporalArtifact.cadenceMs} ms`,
    );
    setText(
      'temporal-training-evidence',
      `${temporalFaultRegistryEntry.evidence.training.seedSummary} | ${temporalFaultRegistryEntry.evidence.training.path}${temporalFaultRegistryEntry.evidence.training.jsonPointer}`,
    );
    setText(
      'temporal-calibration-evidence',
      `${temporalFaultRegistryEntry.evidence.calibration.seedSummary} | ${temporalFaultRegistryEntry.evidence.calibration.path}${temporalFaultRegistryEntry.evidence.calibration.jsonPointer}`,
    );
    setText(
      'temporal-evaluation-evidence',
      `${temporalFaultRegistryEntry.evidence.evaluation.seedSummary} | ${temporalFaultRegistryEntry.evidence.evaluation.path}${temporalFaultRegistryEntry.evidence.evaluation.jsonPointer}`,
    );
    const control = byId<HTMLInputElement>('temporal-model-enabled');
    control.checked = this.temporalModelEnabled;
    control.disabled = !eligible;
    const state = byId('temporal-model-state');
    state.dataset.quality = compatibility.readiness.active
      ? 'good'
      : eligible
        ? 'warning'
        : 'unknown';
    state.textContent = compatibility.readiness.active
      ? 'Active | advisory'
      : eligible
        ? 'Eligible | disabled'
        : compatibility.supported
          ? 'Gate failed | disabled'
          : 'Incompatible | disabled';
    const reasons = byId('temporal-compatibility-reasons');
    reasons.replaceChildren();
    if (compatibility.reasons.length === 0) {
      const ready = document.createElement('p');
      ready.textContent =
        'Schema, profile, channels, units, cadence, window, artifact, configuration, and quality gates match.';
      reasons.append(ready);
    } else {
      for (const reason of compatibility.reasons) {
        const row = document.createElement('article');
        const title = document.createElement('strong');
        title.textContent = reason.code;
        const detail = document.createElement('p');
        detail.textContent = reason.detail;
        row.append(title, detail);
        reasons.append(row);
      }
    }
  }

  private renderModelSummary(): void {
    const metrics = this.modelArtifact.evaluation.metrics;
    setText('model-version', this.modelArtifact.modelVersion);
    setText('model-f1', metrics.f1.toFixed(3));
    setText('model-fpr', `${(metrics.falsePositiveRate * 100).toFixed(2)}%`);
    const passed = modelPassesQualityGate(this.modelArtifact);
    const state = byId('model-state');
    const enabled = passed && this.learnedModelEnabled;
    byId<HTMLInputElement>('learned-model-enabled').checked = this.learnedModelEnabled;
    byId<HTMLInputElement>('learned-model-enabled').disabled = !passed;
    state.dataset.quality = enabled ? 'good' : passed ? 'unknown' : 'warning';
    state.textContent = enabled
      ? 'Active | advisory'
      : passed
        ? 'Eligible | user disabled'
        : 'Gate failed | disabled';
  }

  private renderModelScore(measurements?: Record<string, number>): void {
    const container = byId('model-contributions');
    container.replaceChildren();
    if (
      !measurements ||
      this.modelArtifact.channels.some((channel) => !Number.isFinite(measurements[channel]))
    ) {
      setText('model-score', 'N/A for this profile');
      return;
    }
    try {
      const score = scoreLearnedBaseline(
        this.modelArtifact,
        measurements,
        this.learnedModelEnabled,
      );
      const status = this.learnedModelEnabled ? 'active' : 'preview';
      setText(
        'model-score',
        `${score.score.toFixed(2)} / ${score.threshold.toFixed(2)} | ${status}`,
      );
      for (const contribution of score.contributions) {
        const row = document.createElement('div');
        row.className = 'contribution-row';
        row.setAttribute('role', 'listitem');
        const label = document.createElement('span');
        label.textContent = contribution.channel;
        const bar = document.createElement('div');
        bar.className = 'contribution-bar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(1, contribution.absoluteShare * 100)}%`;
        bar.append(fill);
        const value = document.createElement('strong');
        value.textContent = `${(contribution.absoluteShare * 100).toFixed(1)}%`;
        row.append(label, bar, value);
        container.append(row);
      }
    } catch {
      setText('model-score', 'Score unavailable');
    }
  }

  private connectLocalStream(): void {
    this.stopStreams(false);
    const url = byId<HTMLInputElement>('stream-url').value.trim();
    if (!/^wss?:\/\//i.test(url)) {
      this.showMessage('Invalid WebSocket endpoint', 'Use a ws:// or wss:// URL.', 'error', true);
      return;
    }
    this.setStreamState('Connecting', 'unknown');
    this.streamClient = new ReconnectingStreamClient({
      url,
      queueCapacity: 512,
      queueOverflowStrategy: 'drop-oldest',
      drainBatchSize: 64,
      backoff: {
        initialDelayMs: 500,
        maximumDelayMs: 8_000,
        maximumAttempts: 8,
        multiplier: 2,
        jitterRatio: 0.2,
      },
      heartbeatStaleAfterMs: 5_000,
      heartbeatDisconnectedAfterMs: 15_000,
      onMessage: (message) => this.observeStreamMessage(message),
      onProtocolError: (errors) =>
        this.showMessage('Stream protocol error', errors.join(' '), 'warning'),
      onHealth: (health) => this.renderStreamHealth(health),
      onQueuePressure: (dropped) => {
        this.browserQueueDropped = dropped;
        setText('health-dropped', dropped);
      },
      onReconnectExhausted: () => this.setStreamState('Reconnect limit reached', 'failure'),
    });
    this.streamClient.start();
    byId<HTMLButtonElement>('stream-disconnect').disabled = false;
    this.announce('Connecting to the local WebSocket simulator.');
  }

  private startBrowserDemo(): void {
    this.stopStreams(false);
    this.browserQueueDropped = 0;
    this.browserHealth = new StreamHealthMonitor({
      staleAfterMs: 2_500,
      disconnectedAfterMs: 7_500,
    });
    this.browserDemo = new BrowserDemoAdapter({
      seed: 20260717,
      samplesPerSource: 160,
      sampleIntervalMs: 150,
      queueCapacity: 64,
      heartbeatEvery: 8,
    });
    this.browserDemoUnsubscribe = this.browserDemo.subscribe((event) => {
      if (event.type === 'message') {
        this.browserHealth?.observe(event.message);
        this.observeStreamMessage(event.message);
        this.renderStreamHealth(this.browserHealth?.snapshot() ?? []);
      } else if (event.type === 'queue-pressure') {
        this.browserQueueDropped = event.totalDropped;
        this.renderStreamHealth(this.browserHealth?.snapshot() ?? []);
      } else if (event.type === 'disconnect') {
        this.setStreamState(`Injected disconnect | retry ${event.reconnectAfterMs} ms`, 'warning');
      } else if (event.type === 'complete') {
        this.setStreamState('Demo complete', 'good');
      }
    });
    this.browserDemo.start();
    byId<HTMLButtonElement>('stream-disconnect').disabled = false;
    this.setStreamState('In-browser demo active', 'good');
    this.announce('In-browser multi-source streaming demonstration started.');
  }

  private observeStreamMessage(message: StreamMessage): void {
    if (message.type === 'telemetry') {
      const measurements = Object.fromEntries(
        Object.entries(message.measurements).filter(
          (entry): entry is [string, number] => entry[1] !== null,
        ),
      );
      this.renderModelScore(measurements);
    }
  }

  private renderStreamHealth(health: readonly SourceHealth[]): void {
    setText('health-sources', health.length);
    setText(
      'health-messages',
      health.reduce((sum, source) => sum + source.receivedMessages, 0),
    );
    setText(
      'health-dropped',
      this.browserQueueDropped +
        health.reduce(
          (sum, source) => sum + source.localDroppedMessages + source.remoteDroppedMessages,
          0,
        ),
    );
    const heartbeatAges = health.flatMap((source) =>
      source.heartbeatAgeMs === undefined ? [] : [source.heartbeatAgeMs],
    );
    setText('health-heartbeat', heartbeatAges.length ? `${Math.max(...heartbeatAges)} ms` : 'N/A');
    setText(
      'health-queue',
      health.reduce((sum, source) => sum + source.remoteQueueDepth, 0),
    );
    setText(
      'health-reconnects',
      health.reduce((sum, source) => sum + source.reconnectAttempts, 0),
    );
    const tone = streamHealthTone(health);
    const label =
      health.length === 0 ? 'Connecting' : health.map((source) => source.status).join(', ');
    this.setStreamState(label, tone);
  }

  private stopStreams(announce = true): void {
    this.streamClient?.stop();
    this.streamClient = undefined;
    this.browserDemoUnsubscribe?.();
    this.browserDemoUnsubscribe = undefined;
    this.browserDemo?.stop();
    this.browserDemo = undefined;
    this.browserHealth = undefined;
    this.browserQueueDropped = 0;
    byId<HTMLButtonElement>('stream-disconnect').disabled = true;
    this.setStreamState('Disconnected', 'unknown');
    if (announce) this.announce('Streaming disconnected.');
  }

  private setStreamState(label: string, quality: 'unknown' | 'good' | 'warning' | 'failure'): void {
    const state = byId('stream-state');
    state.textContent = label;
    state.dataset.quality = quality;
  }

  private showMessage(title: string, detail: string, state: MessageState, focus = false): void {
    const banner = byId('message-banner');
    setText('message-title', title);
    setText('message-detail', detail);
    banner.dataset.state = state;
    banner.hidden = false;
    if (focus) banner.focus();
    this.announce(`${title}. ${detail}`);
  }

  private announce(message: string): void {
    setText('live-region', '');
    window.setTimeout(() => setText('live-region', message), 20);
  }

  private updateClock(): void {
    setText(
      'clock',
      new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
  }
}
