import Chart from 'chart.js/auto';
import type { Chart as ChartInstance, ChartDataset, Plugin } from 'chart.js';
import type { Finding, TelemetrySample } from '../core';

interface ChannelChart {
  chart: ChartInstance<'line'>;
  samples: TelemetrySample[];
}

const COLORS = {
  altitude: '#78b69a',
  speed: '#76add5',
  fuel: '#d7ac5d',
};
const LIGHT_COLORS = { altitude: '#28728c', speed: '#075eae', fuel: '#946000' };
export interface TelemetryCanvases {
  altitude: HTMLCanvasElement;
  speed: HTMLCanvasElement;
  fuel: HTMLCanvasElement;
}

function pickMeasurement(
  sample: TelemetrySample,
  channel: 'altitude' | 'speed' | 'fuel',
): number | null {
  if (channel === 'speed') return sample.measurements.speed ?? sample.measurements.airspeed ?? null;
  return sample.measurements[channel] ?? null;
}

function displayTimestamp(sample: TelemetrySample): string {
  return sample.originalTimestamp ?? new Date(sample.timestampMs).toISOString().slice(11, 19);
}

function downsample(samples: readonly TelemetrySample[], maximumPoints = 2_000): TelemetrySample[] {
  if (samples.length <= maximumPoints) return [...samples];
  const stride = Math.ceil(samples.length / maximumPoints);
  const selected = samples.filter((_, index) => index % stride === 0);
  const last = samples.at(-1);
  if (last && selected.at(-1) !== last) selected.push(last);
  return selected;
}

export class TelemetryCharts {
  private readonly charts = new Map<string, ChannelChart>();
  private cursorSampleIndex = 0;
  private totalSamples = 0;
  private disposed = false;
  private readonly colors: typeof COLORS;

  constructor(
    canvases?: TelemetryCanvases,
    private readonly theme: 'light' | 'dark' = 'dark',
  ) {
    this.colors = theme === 'light' ? LIGHT_COLORS : COLORS;
    const cursorPlugin: Plugin<'line'> = {
      id: 'replay-cursor',
      afterDatasetsDraw: (chart) => {
        if (this.totalSamples < 2) return;
        const { ctx, chartArea } = chart;
        const fraction = Math.max(0, Math.min(1, this.cursorSampleIndex / (this.totalSamples - 1)));
        const x = chartArea.left + chartArea.width * fraction;
        ctx.save();
        ctx.strokeStyle = theme === 'light' ? '#526676' : 'rgba(231, 235, 238, 0.72)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };

    try {
      this.create(
        canvases?.altitude ?? 'chart-altitude',
        'altitude',
        'Altitude',
        'ft',
        cursorPlugin,
      );
      this.create(canvases?.speed ?? 'chart-speed', 'speed', 'Airspeed', 'kt', cursorPlugin);
      this.create(canvases?.fuel ?? 'chart-fuel', 'fuel', 'Fuel', '%', cursorPlugin);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  setRun(samples: readonly TelemetrySample[], findings: readonly Finding[]): void {
    if (this.disposed) return;
    this.totalSamples = samples.length;
    this.cursorSampleIndex = 0;
    const findingIndices = new Set(
      findings.flatMap((finding) =>
        finding.sampleIndex === undefined ? [] : [finding.sampleIndex],
      ),
    );

    for (const [channel, state] of this.charts) {
      const visibleSamples = downsample(samples);
      state.samples = visibleSamples;
      state.chart.data.labels = visibleSamples.map(displayTimestamp);
      const dataset = state.chart.data.datasets[0];
      if (!dataset) continue;
      dataset.data = visibleSamples.map((sample) =>
        pickMeasurement(sample, channel as 'altitude' | 'speed' | 'fuel'),
      );
      dataset.pointBackgroundColor = visibleSamples.map((sample) =>
        findingIndices.has(sample.sampleIndex)
          ? this.theme === 'light'
            ? '#b9474d'
            : '#d5747b'
          : this.colors[channel as keyof typeof COLORS],
      );
      dataset.pointRadius = visibleSamples.map((sample) =>
        findingIndices.has(sample.sampleIndex) ? 3 : 0,
      );
      state.chart.update('none');
    }
  }

  setCursor(sampleIndex: number): void {
    if (this.disposed) return;
    this.cursorSampleIndex = sampleIndex;
    for (const state of this.charts.values()) state.chart.draw();
  }

  clear(): void {
    if (this.disposed) return;
    this.totalSamples = 0;
    this.cursorSampleIndex = 0;
    for (const state of this.charts.values()) {
      state.samples = [];
      state.chart.data.labels = [];
      const dataset = state.chart.data.datasets[0];
      if (dataset) dataset.data = [];
      state.chart.update('none');
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.charts.values()) state.chart.destroy();
    this.charts.clear();
    this.totalSamples = 0;
  }

  private create(
    canvasOrId: HTMLCanvasElement | string,
    channel: keyof typeof COLORS,
    label: string,
    unit: string,
    cursorPlugin: Plugin<'line'>,
  ): void {
    const canvas =
      typeof canvasOrId === 'string' ? document.getElementById(canvasOrId) : canvasOrId;
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing telemetry chart canvas.');
    const dataset: ChartDataset<'line'> = {
      label: `${label} (${unit})`,
      data: [],
      borderColor: this.colors[channel],
      backgroundColor: `${this.colors[channel]}18`,
      borderWidth: 1.6,
      fill: true,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.22,
    };
    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels: [], datasets: [dataset] },
      plugins: [cursorPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: {
            ticks: { color: '#73808b', maxTicksLimit: 9, maxRotation: 0 },
            grid: { color: 'rgba(58, 74, 88, 0.22)' },
          },
          y: {
            ticks: { color: '#73808b' },
            grid: { color: 'rgba(58, 74, 88, 0.22)' },
            title: {
              display: true,
              text: unit,
              color: this.theme === 'light' ? '#526676' : '#a0abb5',
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0d1319',
            borderColor: '#3a4a58',
            borderWidth: 1,
            displayColors: false,
          },
          decimation: { enabled: true, algorithm: 'lttb', samples: 1_000 },
        },
      },
    });
    this.charts.set(channel, { chart, samples: [] });
  }
}
