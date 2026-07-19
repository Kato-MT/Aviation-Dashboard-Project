import Chart from 'chart.js/auto';
import type {
  Chart as ChartInstance,
  ChartDataset,
  ChartEvent,
  LegendItem,
  Plugin,
  Point,
} from 'chart.js';

export type InvestigationPhase = 'ground' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landing';

export interface InvestigationPhaseSegment {
  phase: InvestigationPhase;
  label: string;
  startIndex: number;
  endIndex: number;
}

export interface InvestigationFaultMarker {
  faultId: string;
  label: string;
  onsetIndex: number;
  endIndex: number;
  recoveryIndex?: number | undefined;
  detectionIndex?: number | undefined;
}

/** Prepared, display-only data. Source telemetry is never read or mutated by this renderer. */
export interface InvestigationSeries {
  sampleIndices: readonly number[];
  timestamps: readonly string[];
  observedAltitude: readonly (number | null)[];
  predictedAltitude: readonly number[];
  lowerUncertainty: readonly number[];
  upperUncertainty: readonly number[];
  observedAirspeed: readonly (number | null)[];
  observedFuel: readonly (number | null)[];
  residualValues: readonly (number | null)[];
  phaseSegments: readonly InvestigationPhaseSegment[];
  faultMarkers: readonly InvestigationFaultMarker[];
}

export interface InvestigationOverlayVisibility {
  observedAltitude: boolean;
  predictedAltitude: boolean;
  uncertainty: boolean;
  airspeed: boolean;
  fuel: boolean;
  residuals: boolean;
  phases: boolean;
  faultMarkers: boolean;
  comparisonBaseline: boolean;
}

export interface InvestigationRenderOptions {
  overlays?: Partial<InvestigationOverlayVisibility> | undefined;
  maximumPoints?: number | undefined;
  comparison?: InvestigationComparisonWaveform | undefined;
}

export interface InvestigationComparisonIdentity {
  profileId: string;
  cadenceMs: number;
  sampleCount: number;
  sampleIndices: readonly number[];
}

export type InvestigationComparisonMismatch =
  'profile' | 'cadence' | 'sample-count' | 'sample-indices';

export interface InvestigationComparisonCompatibility {
  compatible: boolean;
  mismatches: InvestigationComparisonMismatch[];
  reasons: string[];
}

export interface InvestigationComparisonWaveform {
  sampleIndices: readonly number[];
  observedAltitude: readonly (number | null)[];
  predictedAltitude: readonly number[];
}

export interface InvestigationChartRendererOptions {
  stateCanvasId?: string | undefined;
  residualCanvasId?: string | undefined;
  maximumPoints?: number | undefined;
  onSeek?: ((sampleIndex: number) => void) | undefined;
}

export interface InvestigationPhaseBand extends InvestigationPhaseSegment {
  color: string;
}

export type InvestigationMarkerKind = 'onset' | 'end' | 'recovery' | 'detection';

export interface InvestigationMarkerLine {
  faultId: string;
  label: string;
  kind: InvestigationMarkerKind;
  sampleIndex: number;
  color: string;
  dash: readonly number[];
}

type InvestigationLineDataset = ChartDataset<'line', Array<Point | null>>;

const PHASE_COLORS: Record<InvestigationPhase, string> = {
  ground: 'rgba(115, 128, 139, 0.07)',
  takeoff: 'rgba(215, 172, 93, 0.08)',
  climb: 'rgba(118, 173, 213, 0.08)',
  cruise: 'rgba(120, 182, 154, 0.065)',
  descent: 'rgba(145, 130, 166, 0.075)',
  landing: 'rgba(201, 141, 98, 0.08)',
};

const MARKER_STYLES: Record<
  InvestigationMarkerKind,
  Pick<InvestigationMarkerLine, 'color' | 'dash'>
> = {
  onset: { color: '#d7ac5d', dash: [] },
  end: { color: '#c98d62', dash: [5, 3] },
  recovery: { color: '#78b69a', dash: [3, 3] },
  detection: { color: '#ff6b7d', dash: [1, 2] },
};

const DEFAULT_OVERLAYS: InvestigationOverlayVisibility = {
  observedAltitude: true,
  predictedAltitude: true,
  uncertainty: true,
  airspeed: true,
  fuel: true,
  residuals: true,
  phases: true,
  faultMarkers: true,
  comparisonBaseline: true,
};

const STATE_DATASET = {
  lowerUncertainty: 0,
  upperUncertainty: 1,
  observedAltitude: 2,
  predictedAltitude: 3,
  airspeed: 4,
  fuel: 5,
  comparisonObservedAltitude: 6,
  comparisonPredictedAltitude: 7,
} as const;

export function investigationWaveformLabels(hasComparison: boolean): {
  observed: string;
  predicted: string;
  baselineObserved: string;
  baselinePredicted: string;
} {
  return {
    observed: hasComparison ? 'Current observed altitude (ft)' : 'Observed altitude (ft)',
    predicted: hasComparison ? 'Current predicted altitude (ft)' : 'Predicted altitude (ft)',
    baselineObserved: 'Baseline observed altitude (ft)',
    baselinePredicted: 'Baseline predicted altitude (ft)',
  };
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function requireFiniteSeries(
  values: readonly (number | null)[],
  label: string,
  allowNull: boolean,
): void {
  values.forEach((value, index) => {
    if (value === null) {
      if (!allowNull) throw new Error(`${label}[${index}] cannot be null.`);
      return;
    }
    requireFinite(value, `${label}[${index}]`);
  });
}

export function validateInvestigationSeries(series: InvestigationSeries): void {
  const length = series.sampleIndices.length;
  const arrays: Array<readonly unknown[]> = [
    series.timestamps,
    series.observedAltitude,
    series.predictedAltitude,
    series.lowerUncertainty,
    series.upperUncertainty,
    series.observedAirspeed,
    series.observedFuel,
    series.residualValues,
  ];
  if (arrays.some((values) => values.length !== length)) {
    throw new Error('Every investigation value array must match sampleIndices length.');
  }
  series.sampleIndices.forEach((sampleIndex, position) => {
    requireFinite(sampleIndex, `sampleIndices[${position}]`);
    if (!Number.isInteger(sampleIndex))
      throw new Error('Investigation sample indices must be integers.');
    if (position > 0 && sampleIndex <= series.sampleIndices[position - 1]!) {
      throw new Error('Investigation sample indices must increase strictly.');
    }
  });
  series.timestamps.forEach((timestamp, position) => {
    if (timestamp.trim() === '' || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error(`timestamps[${position}] must be a valid timestamp.`);
    }
  });
  requireFiniteSeries(series.observedAltitude, 'observedAltitude', true);
  requireFiniteSeries(series.predictedAltitude, 'predictedAltitude', false);
  requireFiniteSeries(series.lowerUncertainty, 'lowerUncertainty', false);
  requireFiniteSeries(series.upperUncertainty, 'upperUncertainty', false);
  requireFiniteSeries(series.observedAirspeed, 'observedAirspeed', true);
  requireFiniteSeries(series.observedFuel, 'observedFuel', true);
  requireFiniteSeries(series.residualValues, 'residualValues', true);
  for (let index = 0; index < length; index += 1) {
    if (series.lowerUncertainty[index]! > series.upperUncertainty[index]!) {
      throw new Error(`Uncertainty bounds are inverted at position ${index}.`);
    }
  }

  if (length === 0) {
    if (series.phaseSegments.length > 0 || series.faultMarkers.length > 0) {
      throw new Error('Empty investigation series cannot contain phases or fault markers.');
    }
    return;
  }
  const minimumIndex = series.sampleIndices[0]!;
  const maximumIndex = series.sampleIndices.at(-1)!;
  const requireRange = (start: number, end: number, label: string): void => {
    requireFinite(start, `${label} start`);
    requireFinite(end, `${label} end`);
    if (start > end || start < minimumIndex || end > maximumIndex) {
      throw new Error(`${label} must be ordered within the investigation sample range.`);
    }
  };
  series.phaseSegments.forEach((segment) =>
    requireRange(segment.startIndex, segment.endIndex, `Phase ${segment.label}`),
  );
  series.faultMarkers.forEach((marker) => {
    requireRange(marker.onsetIndex, marker.endIndex, `Fault ${marker.label}`);
    for (const [label, index] of [
      ['recovery', marker.recoveryIndex],
      ['detection', marker.detectionIndex],
    ] as const) {
      if (index !== undefined && (index < minimumIndex || index > maximumIndex)) {
        throw new Error(`Fault ${marker.label} ${label} index must be within the sample range.`);
      }
    }
  });
}

function validateComparisonIdentity(
  identity: InvestigationComparisonIdentity,
  label: string,
): void {
  if (identity.profileId.trim() === '') throw new Error(`${label} profileId cannot be blank.`);
  if (!Number.isInteger(identity.cadenceMs) || identity.cadenceMs <= 0) {
    throw new Error(`${label} cadenceMs must be a positive integer.`);
  }
  if (!Number.isInteger(identity.sampleCount) || identity.sampleCount < 0) {
    throw new Error(`${label} sampleCount must be a nonnegative integer.`);
  }
  if (identity.sampleIndices.length !== identity.sampleCount) {
    throw new Error(`${label} sampleIndices must match sampleCount.`);
  }
  identity.sampleIndices.forEach((sampleIndex, position) => {
    if (!Number.isInteger(sampleIndex)) {
      throw new Error(`${label} sampleIndices[${position}] must be an integer.`);
    }
  });
}

/**
 * Compatibility is intentionally strict. The chart never resamples, truncates, or time-warps a
 * captured waveform because that could make unlike evidence appear aligned.
 */
export function evaluateInvestigationComparison(
  baseline: InvestigationComparisonIdentity,
  candidate: InvestigationComparisonIdentity,
): InvestigationComparisonCompatibility {
  validateComparisonIdentity(baseline, 'Baseline');
  validateComparisonIdentity(candidate, 'Candidate');
  const mismatches: InvestigationComparisonMismatch[] = [];
  const reasons: string[] = [];
  if (baseline.profileId !== candidate.profileId) {
    mismatches.push('profile');
    reasons.push(
      `Profile differs: baseline ${baseline.profileId}, current ${candidate.profileId}.`,
    );
  }
  if (baseline.cadenceMs !== candidate.cadenceMs) {
    mismatches.push('cadence');
    reasons.push(
      `Cadence differs: baseline ${baseline.cadenceMs} ms, current ${candidate.cadenceMs} ms.`,
    );
  }
  if (baseline.sampleCount !== candidate.sampleCount) {
    mismatches.push('sample-count');
    reasons.push(
      `Sample count differs: baseline ${baseline.sampleCount}, current ${candidate.sampleCount}.`,
    );
  }
  if (
    baseline.sampleIndices.length === candidate.sampleIndices.length &&
    baseline.sampleIndices.some(
      (sampleIndex, position) => sampleIndex !== candidate.sampleIndices[position],
    )
  ) {
    mismatches.push('sample-indices');
    reasons.push('Sample indices do not align exactly.');
  }
  return { compatible: mismatches.length === 0, mismatches, reasons };
}

export function validateInvestigationComparisonWaveform(
  comparison: InvestigationComparisonWaveform,
  candidate: InvestigationSeries,
): void {
  const identity: InvestigationComparisonIdentity = {
    profileId: 'prepared-waveform',
    cadenceMs: 1,
    sampleCount: comparison.sampleIndices.length,
    sampleIndices: comparison.sampleIndices,
  };
  validateComparisonIdentity(identity, 'Comparison waveform');
  if (
    comparison.observedAltitude.length !== comparison.sampleIndices.length ||
    comparison.predictedAltitude.length !== comparison.sampleIndices.length
  ) {
    throw new Error('Comparison waveform values must match sampleIndices length.');
  }
  requireFiniteSeries(comparison.observedAltitude, 'comparison observedAltitude', true);
  requireFiniteSeries(comparison.predictedAltitude, 'comparison predictedAltitude', false);
  if (
    comparison.sampleIndices.length !== candidate.sampleIndices.length ||
    comparison.sampleIndices.some(
      (sampleIndex, position) => sampleIndex !== candidate.sampleIndices[position],
    )
  ) {
    throw new Error('Comparison waveform must exactly match the candidate sample indices.');
  }
}

export function buildInvestigationPhaseBands(
  segments: readonly InvestigationPhaseSegment[],
): InvestigationPhaseBand[] {
  return segments.map((segment) => ({ ...segment, color: PHASE_COLORS[segment.phase] }));
}

export function buildInvestigationMarkerLines(
  markers: readonly InvestigationFaultMarker[],
): InvestigationMarkerLine[] {
  return markers.flatMap((marker) => {
    const lines: InvestigationMarkerLine[] = [
      {
        faultId: marker.faultId,
        label: marker.label,
        kind: 'onset',
        sampleIndex: marker.onsetIndex,
        ...MARKER_STYLES.onset,
      },
      {
        faultId: marker.faultId,
        label: marker.label,
        kind: 'end',
        sampleIndex: marker.endIndex,
        ...MARKER_STYLES.end,
      },
    ];
    if (marker.recoveryIndex !== undefined) {
      lines.push({
        faultId: marker.faultId,
        label: marker.label,
        kind: 'recovery',
        sampleIndex: marker.recoveryIndex,
        ...MARKER_STYLES.recovery,
      });
    }
    if (marker.detectionIndex !== undefined) {
      lines.push({
        faultId: marker.faultId,
        label: marker.label,
        kind: 'detection',
        sampleIndex: marker.detectionIndex,
        ...MARKER_STYLES.detection,
      });
    }
    return lines;
  });
}

function criticalSampleIndices(series: InvestigationSeries): Set<number> {
  const critical = new Set<number>();
  if (series.sampleIndices.length > 0) {
    critical.add(series.sampleIndices[0]!);
    critical.add(series.sampleIndices.at(-1)!);
  }
  for (const segment of series.phaseSegments) {
    critical.add(segment.startIndex);
    critical.add(segment.endIndex);
  }
  for (const marker of buildInvestigationMarkerLines(series.faultMarkers)) {
    critical.add(marker.sampleIndex);
  }
  return critical;
}

/**
 * Returns source-array positions and never removes declared phase or fault evidence.
 * If critical evidence alone exceeds maximumPoints, evidence preservation wins.
 */
export function selectInvestigationSamplePositions(
  series: InvestigationSeries,
  maximumPoints = 2_000,
): number[] {
  validateInvestigationSeries(series);
  if (!Number.isInteger(maximumPoints) || maximumPoints < 2) {
    throw new Error('maximumPoints must be an integer of at least 2.');
  }
  const length = series.sampleIndices.length;
  if (length <= maximumPoints) return Array.from({ length }, (_, index) => index);
  const positionsBySampleIndex = new Map(
    series.sampleIndices.map((sampleIndex, position) => [sampleIndex, position]),
  );
  const selected = new Set<number>();
  for (const sampleIndex of criticalSampleIndices(series)) {
    const position = positionsBySampleIndex.get(sampleIndex);
    if (position !== undefined) selected.add(position);
  }
  if (selected.size >= maximumPoints) return [...selected].sort((left, right) => left - right);

  const stride = (length - 1) / (maximumPoints - 1);
  for (let slot = 0; slot < maximumPoints && selected.size < maximumPoints; slot += 1) {
    selected.add(Math.min(length - 1, Math.round(slot * stride)));
  }
  for (let position = 0; position < length && selected.size < maximumPoints; position += 1) {
    selected.add(position);
  }
  return [...selected].sort((left, right) => left - right);
}

function selectValues<T>(values: readonly T[], positions: readonly number[]): T[] {
  return positions.map((position) => values[position]!);
}

export function downsampleInvestigationSeries(
  series: InvestigationSeries,
  maximumPoints = 2_000,
): InvestigationSeries {
  const positions = selectInvestigationSamplePositions(series, maximumPoints);
  return {
    sampleIndices: selectValues(series.sampleIndices, positions),
    timestamps: selectValues(series.timestamps, positions),
    observedAltitude: selectValues(series.observedAltitude, positions),
    predictedAltitude: selectValues(series.predictedAltitude, positions),
    lowerUncertainty: selectValues(series.lowerUncertainty, positions),
    upperUncertainty: selectValues(series.upperUncertainty, positions),
    observedAirspeed: selectValues(series.observedAirspeed, positions),
    observedFuel: selectValues(series.observedFuel, positions),
    residualValues: selectValues(series.residualValues, positions),
    phaseSegments: series.phaseSegments.map((segment) => ({ ...segment })),
    faultMarkers: series.faultMarkers.map((marker) => ({ ...marker })),
  };
}

function points(
  sampleIndices: readonly number[],
  values: readonly (number | null)[],
): Array<Point | null> {
  return sampleIndices.map((sampleIndex, position) => {
    const value = values[position];
    return value === null || value === undefined ? null : { x: sampleIndex, y: value };
  });
}

function nearestSampleIndex(sampleIndices: readonly number[], requested: number): number {
  if (sampleIndices.length === 0) return 0;
  let low = 0;
  let high = sampleIndices.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sampleIndices[middle]! < requested) low = middle + 1;
    else high = middle;
  }
  const upper = sampleIndices[low]!;
  const lower = sampleIndices[Math.max(0, low - 1)]!;
  return Math.abs(requested - lower) <= Math.abs(upper - requested) ? lower : upper;
}

export class InvestigationChartRenderer {
  private readonly stateChart: ChartInstance<'line'>;
  private readonly residualChart: ChartInstance<'line'>;
  private readonly onSeek: (sampleIndex: number) => void;
  private readonly defaultMaximumPoints: number;
  private readonly keyboardHandlers = new Map<HTMLCanvasElement, (event: KeyboardEvent) => void>();
  private series: InvestigationSeries | null = null;
  private overlays: InvestigationOverlayVisibility = { ...DEFAULT_OVERLAYS };
  private comparisonRendered = false;
  private cursorIndex = 0;
  private destroyed = false;

  constructor(options: InvestigationChartRendererOptions = {}) {
    const stateCanvas = this.requireCanvas(options.stateCanvasId ?? 'investigation-state-chart');
    const residualCanvas = this.requireCanvas(
      options.residualCanvasId ?? 'investigation-residual-chart',
    );
    this.defaultMaximumPoints = options.maximumPoints ?? 2_000;
    if (!Number.isInteger(this.defaultMaximumPoints) || this.defaultMaximumPoints < 2) {
      throw new Error('maximumPoints must be an integer of at least 2.');
    }
    this.onSeek = options.onSeek ?? (() => undefined);
    this.stateChart = this.createStateChart(stateCanvas);
    this.residualChart = this.createResidualChart(residualCanvas);
    this.bindKeyboard(stateCanvas);
    this.bindKeyboard(residualCanvas);
  }

  render(series: InvestigationSeries, options: InvestigationRenderOptions = {}): void {
    this.requireActive();
    validateInvestigationSeries(series);
    if (options.comparison) validateInvestigationComparisonWaveform(options.comparison, series);
    const maximumPoints = options.maximumPoints ?? this.defaultMaximumPoints;
    const sampled = downsampleInvestigationSeries(series, maximumPoints);
    this.series = series;
    this.overlays = { ...DEFAULT_OVERLAYS, ...options.overlays };
    this.cursorIndex = nearestSampleIndex(
      series.sampleIndices,
      series.sampleIndices.includes(this.cursorIndex)
        ? this.cursorIndex
        : (series.sampleIndices[0] ?? 0),
    );

    const stateDatasets = this.stateChart.data.datasets;
    const hasComparison = options.comparison !== undefined;
    this.comparisonRendered = hasComparison;
    const waveformLabels = investigationWaveformLabels(hasComparison);
    const observedDataset = stateDatasets[STATE_DATASET.observedAltitude];
    const predictedDataset = stateDatasets[STATE_DATASET.predictedAltitude];
    if (observedDataset) observedDataset.label = waveformLabels.observed;
    if (predictedDataset) predictedDataset.label = waveformLabels.predicted;
    this.setDataset(
      stateDatasets,
      STATE_DATASET.lowerUncertainty,
      sampled,
      sampled.lowerUncertainty,
      !this.overlays.uncertainty,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.upperUncertainty,
      sampled,
      sampled.upperUncertainty,
      !this.overlays.uncertainty,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.observedAltitude,
      sampled,
      sampled.observedAltitude,
      !this.overlays.observedAltitude,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.predictedAltitude,
      sampled,
      sampled.predictedAltitude,
      !this.overlays.predictedAltitude,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.airspeed,
      sampled,
      sampled.observedAirspeed,
      !this.overlays.airspeed,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.fuel,
      sampled,
      sampled.observedFuel,
      !this.overlays.fuel,
    );
    const comparisonPositions = new Map(
      options.comparison?.sampleIndices.map((sampleIndex, position) => [sampleIndex, position]) ??
        [],
    );
    const comparisonValues = (
      values: readonly (number | null)[] | undefined,
    ): Array<number | null> =>
      sampled.sampleIndices.map((sampleIndex) => {
        const position = comparisonPositions.get(sampleIndex);
        return position === undefined ? null : (values?.[position] ?? null);
      });
    this.setDataset(
      stateDatasets,
      STATE_DATASET.comparisonObservedAltitude,
      sampled,
      comparisonValues(options.comparison?.observedAltitude),
      !hasComparison || !this.overlays.comparisonBaseline,
    );
    this.setDataset(
      stateDatasets,
      STATE_DATASET.comparisonPredictedAltitude,
      sampled,
      comparisonValues(options.comparison?.predictedAltitude),
      !hasComparison || !this.overlays.comparisonBaseline,
    );
    if (!hasComparison) {
      for (const datasetIndex of [
        STATE_DATASET.comparisonObservedAltitude,
        STATE_DATASET.comparisonPredictedAltitude,
      ]) {
        const dataset = stateDatasets[datasetIndex];
        if (dataset) dataset.data = [];
      }
    }
    this.setDataset(
      this.residualChart.data.datasets,
      0,
      sampled,
      sampled.residualValues,
      !this.overlays.residuals,
    );
    this.stateChart.update('none');
    this.residualChart.update('none');
  }

  setCursor(sampleIndex: number): void {
    this.requireActive();
    requireFinite(sampleIndex, 'Cursor sample index');
    this.cursorIndex =
      this.series === null
        ? Math.round(sampleIndex)
        : nearestSampleIndex(this.series.sampleIndices, sampleIndex);
    this.stateChart.draw();
    this.residualChart.draw();
  }

  clear(): void {
    this.requireActive();
    this.series = null;
    this.comparisonRendered = false;
    this.cursorIndex = 0;
    for (const chart of [this.stateChart, this.residualChart]) {
      for (const dataset of chart.data.datasets) dataset.data = [];
      chart.update('none');
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const [canvas, handler] of this.keyboardHandlers) {
      canvas.removeEventListener('keydown', handler);
    }
    this.keyboardHandlers.clear();
    this.stateChart.destroy();
    this.residualChart.destroy();
    this.series = null;
    this.destroyed = true;
  }

  private requireCanvas(id: string): HTMLCanvasElement {
    const canvas = document.getElementById(id);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`Missing chart canvas #${id}.`);
    return canvas;
  }

  private requireActive(): void {
    if (this.destroyed) throw new Error('Investigation charts have been destroyed.');
  }

  private createStateChart(canvas: HTMLCanvasElement): ChartInstance<'line'> {
    const waveformLabels = investigationWaveformLabels(false);
    const datasets: InvestigationLineDataset[] = [
      this.dataset('Lower uncertainty', '#76add500', 'yAltitude', { borderWidth: 0 }),
      this.dataset('95% uncertainty', '#76add522', 'yAltitude', {
        borderWidth: 0,
        backgroundColor: '#76add522',
        fill: '-1',
      }),
      this.dataset(waveformLabels.observed, '#78b69a', 'yAltitude'),
      this.dataset(waveformLabels.predicted, '#76add5', 'yAltitude', { borderDash: [6, 4] }),
      this.dataset('Observed airspeed (kt)', '#d7ac5d', 'yAuxiliary'),
      this.dataset('Observed fuel (%)', '#c98d62', 'yFuel'),
      this.dataset(waveformLabels.baselineObserved, '#a99bc3', 'yAltitude', {
        borderDash: [2, 3],
        borderWidth: 2,
      }),
      this.dataset(waveformLabels.baselinePredicted, '#c8bdd9', 'yAltitude', {
        borderDash: [8, 4],
        borderWidth: 1.8,
      }),
    ];
    return new Chart(canvas, {
      type: 'line',
      data: { datasets },
      plugins: [this.overlayPlugin(true)],
      options: this.chartOptions('state'),
    });
  }

  private createResidualChart(canvas: HTMLCanvasElement): ChartInstance<'line'> {
    return new Chart(canvas, {
      type: 'line',
      data: { datasets: [this.dataset('Residual', '#d5747b', 'y')] },
      plugins: [this.overlayPlugin(false)],
      options: this.chartOptions('residual'),
    });
  }

  private dataset(
    label: string,
    borderColor: string,
    yAxisID: string,
    overrides: Partial<InvestigationLineDataset> = {},
  ): InvestigationLineDataset {
    return {
      label,
      data: [],
      borderColor,
      backgroundColor: borderColor,
      yAxisID,
      borderWidth: 1.6,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.15,
      spanGaps: false,
      ...overrides,
    };
  }

  private chartOptions(kind: 'state' | 'residual') {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      parsing: false as const,
      normalized: true,
      interaction: { intersect: false, mode: 'index' as const },
      onClick: (event: ChartEvent, _elements: unknown[], chart: ChartInstance<'line'>) => {
        if (typeof event.x === 'number') this.seekFromPixel(chart, event.x);
      },
      scales:
        kind === 'state'
          ? {
              x: this.xScale(),
              yAltitude: this.yScale('Altitude (ft)', 'left'),
              yAuxiliary: this.yScale('Airspeed (kt)', 'right', false),
              yFuel: this.yScale('Fuel (%)', 'right', false),
            }
          : {
              x: this.xScale(),
              y: this.yScale('Residual', 'left'),
            },
      plugins: {
        legend: {
          display: kind === 'state',
          labels: {
            color: '#a0abb5',
            boxWidth: 12,
            usePointStyle: true,
            filter: (item: LegendItem) => {
              if (item.datasetIndex === undefined) return true;
              if (item.datasetIndex < STATE_DATASET.comparisonObservedAltitude) return true;
              return this.comparisonRendered;
            },
          },
        },
        tooltip: {
          backgroundColor: '#0d1319',
          borderColor: '#3a4a58',
          borderWidth: 1,
          displayColors: true,
        },
        decimation: { enabled: false },
      },
    };
  }

  private xScale() {
    return {
      type: 'linear' as const,
      ticks: { color: '#73808b', maxTicksLimit: 9, maxRotation: 0 },
      grid: { color: 'rgba(58, 74, 88, 0.22)' },
      title: { display: true, text: 'Sample index', color: '#a0abb5' },
    };
  }

  private yScale(title: string, position: 'left' | 'right', drawOnChartArea = true) {
    return {
      type: 'linear' as const,
      position,
      ticks: { color: '#73808b' },
      grid: { color: 'rgba(58, 74, 88, 0.22)', drawOnChartArea },
      title: { display: true, text: title, color: '#a0abb5' },
    };
  }

  private overlayPlugin(drawLabels: boolean): Plugin<'line'> {
    return {
      id: drawLabels ? 'investigation-overlays-state' : 'investigation-overlays-residual',
      beforeDatasetsDraw: (chart) => {
        if (!this.series || !this.overlays.phases) return;
        const xScale = chart.scales.x;
        if (!xScale) return;
        const { ctx, chartArea } = chart;
        for (const band of buildInvestigationPhaseBands(this.series.phaseSegments)) {
          const start = xScale.getPixelForValue(band.startIndex);
          const end = xScale.getPixelForValue(band.endIndex);
          const left = Math.max(chartArea.left, Math.min(start, end));
          const right = Math.min(chartArea.right, Math.max(start, end));
          if (right < chartArea.left || left > chartArea.right) continue;
          ctx.save();
          ctx.fillStyle = band.color;
          ctx.fillRect(left, chartArea.top, Math.max(1, right - left), chartArea.height);
          if (drawLabels && right - left > 42) {
            ctx.fillStyle = '#a0abb5';
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText(band.label, left + 4, chartArea.top + 12, right - left - 8);
          }
          ctx.restore();
        }
      },
      afterDatasetsDraw: (chart) => {
        const xScale = chart.scales.x;
        if (!xScale) return;
        const { ctx, chartArea } = chart;
        if (this.series && this.overlays.faultMarkers) {
          for (const marker of buildInvestigationMarkerLines(this.series.faultMarkers)) {
            const x = xScale.getPixelForValue(marker.sampleIndex);
            if (x < chartArea.left || x > chartArea.right) continue;
            ctx.save();
            ctx.strokeStyle = marker.color;
            ctx.lineWidth = marker.kind === 'detection' ? 2 : 1;
            ctx.setLineDash([...marker.dash]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            if (drawLabels && marker.kind === 'onset') {
              ctx.fillStyle = marker.color;
              ctx.font = '10px Inter, sans-serif';
              ctx.fillText(marker.label, x + 4, chartArea.bottom - 6, 150);
            }
            ctx.restore();
          }
        }
        if (this.series) {
          const x = xScale.getPixelForValue(this.cursorIndex);
          ctx.save();
          ctx.strokeStyle = 'rgba(231, 235, 238, 0.78)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.restore();
        }
      },
    };
  }

  private setDataset(
    datasets: ChartDataset<'line'>[],
    datasetIndex: number,
    sampled: InvestigationSeries,
    values: readonly (number | null)[],
    hidden: boolean,
  ): void {
    const dataset = datasets[datasetIndex];
    if (!dataset) throw new Error(`Missing investigation dataset ${datasetIndex}.`);
    dataset.data = points(sampled.sampleIndices, values);
    dataset.hidden = hidden;
  }

  private seekFromPixel(chart: ChartInstance<'line'>, pixel: number): void {
    if (!this.series) return;
    const xScale = chart.scales.x;
    if (!xScale) return;
    const requested = xScale.getValueForPixel(pixel);
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return;
    const selected = nearestSampleIndex(this.series.sampleIndices, requested);
    this.setCursor(selected);
    this.onSeek(selected);
  }

  private bindKeyboard(canvas: HTMLCanvasElement): void {
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    const handler = (event: KeyboardEvent): void => {
      if (!this.series || this.series.sampleIndices.length === 0) return;
      const samples = this.series.sampleIndices;
      const currentPosition = Math.max(0, samples.indexOf(this.cursorIndex));
      let targetPosition: number | null = null;
      if (event.key === 'ArrowLeft') targetPosition = currentPosition - 1;
      else if (event.key === 'ArrowRight') targetPosition = currentPosition + 1;
      else if (event.key === 'PageUp') targetPosition = currentPosition - 10;
      else if (event.key === 'PageDown') targetPosition = currentPosition + 10;
      else if (event.key === 'Home') targetPosition = 0;
      else if (event.key === 'End') targetPosition = samples.length - 1;
      if (targetPosition === null) return;
      event.preventDefault();
      const bounded = Math.max(0, Math.min(samples.length - 1, targetPosition));
      const selected = samples[bounded]!;
      this.setCursor(selected);
      this.onSeek(selected);
    };
    canvas.addEventListener('keydown', handler);
    this.keyboardHandlers.set(canvas, handler);
  }
}
