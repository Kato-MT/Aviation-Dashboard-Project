import baselineCsv from '../../data/flight.csv?raw';
import learnedBaselineArtifact from '../../models/robust_covariance_v1.json';
import { legacyCsvAdapter, versionedJsonAdapter } from '../adapters';
import {
  APPLICATION_VERSION,
  DEFAULT_INPUT_LIMITS,
  analyzeTelemetryRun,
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
import { modelPassesQualityGate, parseLearnedBaselineArtifact, scoreLearnedBaseline } from '../ml';
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
import { createVerificationRun } from '../verification';
import { TelemetryCharts } from './charts';
import { byId, downloadText, formatNumber, formatObserved, setText, slug } from './dom';
import { generateSyntheticDocument } from './generate';

type InputFormat = 'csv' | 'json' | 'generated' | 'injected';
type MessageState = 'info' | 'warning' | 'error';

interface CapturedRun {
  run: TelemetryRun;
  analysis: AnalysisResult;
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

export class WorkbenchController {
  private readonly charts = new TelemetryCharts();
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

  async initialize(): Promise<void> {
    this.bindTabs();
    this.bindActions();
    this.renderProfiles();
    this.renderFaultScenarios();
    this.renderModelSummary();
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

  private renderModelSummary(): void {
    const metrics = this.modelArtifact.evaluation.metrics;
    setText('model-version', this.modelArtifact.modelVersion);
    setText('model-f1', metrics.f1.toFixed(3));
    setText('model-fpr', `${(metrics.falsePositiveRate * 100).toFixed(2)}%`);
    const passed = modelPassesQualityGate(this.modelArtifact);
    const state = byId('model-state');
    state.dataset.quality = passed ? 'good' : 'warning';
    state.textContent = passed ? 'Gate passed | experimental' : 'Gate failed | disabled';
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
      const score = scoreLearnedBaseline(this.modelArtifact, measurements, true);
      setText('model-score', `${score.score.toFixed(2)} / ${score.threshold.toFixed(2)}`);
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
