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

function pickMeasurement(sample: TelemetrySample, channel: 'altitude' | 'speed' | 'fuel'): number {
  if (channel === 'speed') return sample.measurements.speed ?? sample.measurements.airspeed ?? 0;
  return sample.measurements[channel] ?? 0;
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

  constructor() {
    const cursorPlugin: Plugin<'line'> = {
      id: 'replay-cursor',
      afterDatasetsDraw: (chart) => {
        if (this.totalSamples < 2) return;
        const { ctx, chartArea } = chart;
        const fraction = Math.max(0, Math.min(1, this.cursorSampleIndex / (this.totalSamples - 1)));
        const x = chartArea.left + chartArea.width * fraction;
        ctx.save();
        ctx.strokeStyle = 'rgba(231, 235, 238, 0.72)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };

    this.create('chart-altitude', 'altitude', 'Altitude', 'ft', cursorPlugin);
    this.create('chart-speed', 'speed', 'Airspeed', 'kt', cursorPlugin);
    this.create('chart-fuel', 'fuel', 'Fuel', '%', cursorPlugin);
  }

  setRun(samples: readonly TelemetrySample[], findings: readonly Finding[]): void {
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
        findingIndices.has(sample.sampleIndex) ? '#d5747b' : COLORS[channel as keyof typeof COLORS],
      );
      dataset.pointRadius = visibleSamples.map((sample) =>
        findingIndices.has(sample.sampleIndex) ? 3 : 0,
      );
      state.chart.update('none');
    }
  }

  setCursor(sampleIndex: number): void {
    this.cursorSampleIndex = sampleIndex;
    for (const state of this.charts.values()) state.chart.draw();
  }

  clear(): void {
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

  private create(
    canvasId: string,
    channel: keyof typeof COLORS,
    label: string,
    unit: string,
    cursorPlugin: Plugin<'line'>,
  ): void {
    const canvas = document.getElementById(canvasId);
    if (!(canvas instanceof HTMLCanvasElement))
      throw new Error(`Missing chart canvas #${canvasId}.`);
    const dataset: ChartDataset<'line'> = {
      label: `${label} (${unit})`,
      data: [],
      borderColor: COLORS[channel],
      backgroundColor: `${COLORS[channel]}18`,
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
            title: { display: true, text: unit, color: '#a0abb5' },
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
