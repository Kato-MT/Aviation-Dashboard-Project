import Chart from 'chart.js/auto';
import type { Chart as ChartInstance, ChartConfiguration, ChartDataset, Plugin } from 'chart.js';
import type { LiveHistoryChannel, SessionSeries } from '../../live/historyPresentation';

export interface LiveChartCanvases {
  altitude: HTMLCanvasElement;
  speed: HTMLCanvasElement;
}

export interface LiveChartRenderer {
  setSeries(altitude: SessionSeries, speed: SessionSeries): void;
  setSelection(sequence: number | undefined, observedAt?: string | undefined): void;
  destroy(): void;
}

interface LiveChartPoint {
  x: number;
  y: number;
  sequence: number;
  observedAt: string;
}

interface OwnedChart {
  chart: ChartInstance<'line', LiveChartPoint[], number>;
  channel: LiveHistoryChannel;
}

const COLORS: Record<LiveHistoryChannel, string> = {
  barometricAltitudeFeet: '#075eae',
  groundSpeedKnots: '#526676',
};

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

function pointFromRaw(raw: unknown): LiveChartPoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const point = raw as Partial<LiveChartPoint>;
  return typeof point.sequence === 'number' && typeof point.observedAt === 'string'
    ? (point as LiveChartPoint)
    : undefined;
}

class ChartJsLiveRenderer implements LiveChartRenderer {
  private readonly charts: OwnedChart[] = [];
  private readonly observedAtBySequence = new Map<number, string>();
  private selectedSequence?: number | undefined;
  private selectedObservedAt?: string | undefined;
  private disposed = false;

  constructor(
    canvases: LiveChartCanvases,
    private readonly onSelect: (sequence: number) => void,
  ) {
    try {
      this.charts.push(this.create(canvases.altitude, 'barometricAltitudeFeet', 'ft'));
      this.charts.push(this.create(canvases.speed, 'groundSpeedKnots', 'kt'));
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  setSeries(altitude: SessionSeries, speed: SessionSeries): void {
    if (this.disposed) return;
    if (altitude.channel !== 'barometricAltitudeFeet' || speed.channel !== 'groundSpeedKnots')
      throw new TypeError('Live chart channels do not match their chart canvases.');
    const seriesByChannel: Record<LiveHistoryChannel, SessionSeries> = {
      barometricAltitudeFeet: altitude,
      groundSpeedKnots: speed,
    };
    this.observedAtBySequence.clear();
    const observedTimes: number[] = [];
    for (const series of [altitude, speed])
      for (const segment of series.segments)
        for (const point of segment) {
          const observedMs = Date.parse(point.observedAt);
          if (!Number.isFinite(observedMs)) continue;
          observedTimes.push(observedMs);
          if (!this.observedAtBySequence.has(point.sequence))
            this.observedAtBySequence.set(point.sequence, point.observedAt);
        }
    this.applyTimeDomain(observedTimes);
    for (const owned of this.charts) {
      const series = seriesByChannel[owned.channel];
      owned.chart.data.datasets = series.segments.map((segment, index) =>
        this.dataset(
          series.label,
          segment.map((point) => ({
            x: Date.parse(point.observedAt),
            y: point.value,
            sequence: point.sequence,
            observedAt: point.observedAt,
          })),
          owned.channel,
          index,
        ),
      );
      this.applySelection(owned.chart, owned.channel);
      owned.chart.update('none');
    }
  }

  setSelection(sequence: number | undefined, observedAt?: string | undefined): void {
    if (this.disposed) return;
    this.selectedSequence = sequence;
    this.selectedObservedAt =
      observedAt !== undefined && Number.isFinite(Date.parse(observedAt)) ? observedAt : undefined;
    if (this.observedAtBySequence.size === 0 && this.selectedObservedAt)
      this.applyTimeDomain([Date.parse(this.selectedObservedAt)]);
    for (const { chart, channel } of this.charts) {
      this.applySelection(chart, channel);
      chart.update('none');
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { chart } of this.charts) chart.destroy();
    this.charts.length = 0;
  }

  private applySelection(
    chart: ChartInstance<'line', LiveChartPoint[], number>,
    channel: LiveHistoryChannel,
  ): void {
    for (const dataset of chart.data.datasets) {
      const points = dataset.data as LiveChartPoint[];
      dataset.pointRadius = points.map((point) =>
        point.sequence === this.selectedSequence ? 4 : 2,
      );
      dataset.pointBackgroundColor = points.map((point) =>
        point.sequence === this.selectedSequence ? '#ffffff' : COLORS[channel],
      );
      dataset.pointBorderWidth = points.map((point) =>
        point.sequence === this.selectedSequence ? 3 : 1,
      );
    }
  }

  private applyTimeDomain(observedTimes: readonly number[]): void {
    const minimum = observedTimes.length > 0 ? Math.min(...observedTimes) : undefined;
    const maximum = observedTimes.length > 0 ? Math.max(...observedTimes) : undefined;
    const span = minimum === undefined || maximum === undefined ? 0 : maximum - minimum;
    const padding = span === 0 ? 30_000 : Math.max(1_000, span * 0.05);
    for (const { chart } of this.charts) {
      const x = chart.options.scales?.x;
      if (!x) continue;
      if (minimum === undefined || maximum === undefined) {
        delete x.min;
        delete x.max;
      } else {
        x.min = minimum - padding;
        x.max = maximum + padding;
      }
    }
  }

  private dataset(
    label: string,
    data: LiveChartPoint[],
    channel: LiveHistoryChannel,
    segment: number,
  ): ChartDataset<'line', LiveChartPoint[]> {
    return {
      label: `${label}, segment ${segment + 1}`,
      data,
      borderColor: COLORS[channel],
      backgroundColor: 'transparent',
      borderWidth: 1.8,
      fill: false,
      spanGaps: false,
      tension: 0,
      pointRadius: 2,
      pointHoverRadius: 5,
      pointHitRadius: 10,
      pointBorderColor: COLORS[channel],
      pointBackgroundColor: COLORS[channel],
    };
  }

  private create(canvas: HTMLCanvasElement, channel: LiveHistoryChannel, unit: string): OwnedChart {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing live history canvas.');
    const cursorPlugin: Plugin<'line'> = {
      id: `live-receipt-cursor-${channel}`,
      afterDatasetsDraw: (chart) => {
        if (this.selectedSequence === undefined) return;
        const observedAt =
          this.selectedObservedAt ?? this.observedAtBySequence.get(this.selectedSequence);
        const observedMs = observedAt === undefined ? Number.NaN : Date.parse(observedAt);
        if (!Number.isFinite(observedMs)) return;
        const x = chart.scales.x?.getPixelForValue(observedMs);
        if (x === undefined || !Number.isFinite(x)) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = '#526676';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
      },
    };
    const configuration: ChartConfiguration<'line', LiveChartPoint[], number> = {
      type: 'line',
      data: { datasets: [] },
      plugins: [cursorPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        parsing: false,
        interaction: { intersect: false, mode: 'nearest' },
        onClick: (_event, elements, chart) => {
          const element = elements[0];
          if (!element) return;
          const raw = chart.data.datasets[element.datasetIndex]?.data[element.index];
          const point = pointFromRaw(raw);
          if (point) this.onSelect(point.sequence);
        },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Measurement time (UTC)', color: '#526676' },
            ticks: {
              color: '#667580',
              maxTicksLimit: 5,
              maxRotation: 0,
              callback: (value) => timeFormatter.format(new Date(Number(value))),
            },
            grid: { color: 'rgba(58, 74, 88, 0.14)' },
          },
          y: {
            ticks: { color: '#667580' },
            grid: { color: 'rgba(58, 74, 88, 0.14)' },
            title: { display: true, text: unit, color: '#526676' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#13202a',
            borderColor: '#526676',
            borderWidth: 1,
            displayColors: false,
            callbacks: {
              title: (items) => pointFromRaw(items[0]?.raw)?.observedAt ?? 'Unknown time',
              label: (item) => `${item.formattedValue} ${unit}`,
            },
          },
        },
      },
    };
    const chart = new Chart(canvas, configuration) as ChartInstance<
      'line',
      LiveChartPoint[],
      number
    >;
    return { chart, channel };
  }
}

export function createLiveChartRenderer(
  canvases: LiveChartCanvases,
  onSelect: (sequence: number) => void,
): LiveChartRenderer {
  return new ChartJsLiveRenderer(canvases, onSelect);
}
