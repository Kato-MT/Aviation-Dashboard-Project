// @vitest-environment jsdom
import type { Chart as ChartInstance, ChartConfiguration } from 'chart.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveChartRenderer,
  type LiveChartCanvases,
  type LiveChartRenderer,
} from '../../src/features/live/liveChartRenderer';
import type { SessionSeries } from '../../src/live/historyPresentation';

interface TestPoint {
  x: number;
  y: number;
  sequence: number;
  observedAt: string;
}

type LiveConfiguration = ChartConfiguration<'line', TestPoint[], number>;

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('chart.js/auto', () => ({
  default: class {
    constructor(canvas: unknown, configuration: unknown) {
      return engine.create(canvas, configuration);
    }
  },
}));

function fakeChart(canvas: HTMLCanvasElement, config: LiveConfiguration) {
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
  };
  return {
    canvas,
    config,
    data: config.data,
    options: config.options!,
    ctx,
    chartArea: { top: 10, bottom: 90 },
    scales: { x: { getPixelForValue: vi.fn(() => 60) } },
    update: vi.fn(),
    draw: vi.fn(),
    destroy: vi.fn(),
    getDatasetMeta: vi.fn((datasetIndex: number) => ({
      data: (config.data.datasets[datasetIndex]?.data ?? []).map((_point, pointIndex) => ({
        x: 50 + datasetIndex * 10 + pointIndex,
      })),
    })),
  };
}

const altitude: SessionSeries = {
  channel: 'barometricAltitudeFeet',
  label: 'Barometric altitude',
  unit: 'ft',
  pointCount: 3,
  segments: [
    [
      {
        sequence: 1,
        receivedAt: '2026-08-27T12:00:01.000Z',
        observedAt: '2026-08-27T12:00:00.000Z',
        value: 0,
      },
      {
        sequence: 2,
        receivedAt: '2026-08-27T12:00:11.000Z',
        observedAt: '2026-08-27T12:00:10.000Z',
        value: 12_000,
      },
    ],
    [
      {
        sequence: 4,
        receivedAt: '2026-08-27T12:00:31.000Z',
        observedAt: '2026-08-27T12:00:30.000Z',
        value: 12_500,
      },
    ],
  ],
};

const speed: SessionSeries = {
  channel: 'groundSpeedKnots',
  label: 'Ground speed',
  unit: 'kt',
  pointCount: 2,
  segments: [
    [
      {
        sequence: 1,
        receivedAt: '2026-08-27T12:00:01.000Z',
        observedAt: '2026-08-27T12:00:00.000Z',
        value: 0,
      },
      {
        sequence: 4,
        receivedAt: '2026-08-27T12:00:31.000Z',
        observedAt: '2026-08-27T12:00:30.000Z',
        value: 310,
      },
    ],
  ],
};

let canvases: LiveChartCanvases;
let instances: Array<ReturnType<typeof fakeChart>>;
let owners: LiveChartRenderer[];

beforeEach(() => {
  vi.resetAllMocks();
  canvases = {
    altitude: document.createElement('canvas'),
    speed: document.createElement('canvas'),
  };
  instances = [];
  owners = [];
  engine.create.mockImplementation((canvas, configuration) => {
    const chart = fakeChart(canvas as HTMLCanvasElement, configuration as LiveConfiguration);
    instances.push(chart);
    return chart;
  });
});

afterEach(() => {
  for (const owner of owners) owner.destroy();
  document.body.replaceChildren();
});

function create(onSelect = vi.fn()) {
  const owner = createLiveChartRenderer(canvases, onSelect);
  owners.push(owner);
  return { owner, onSelect };
}

describe('owned live history charts', () => {
  it('plots explicit measurement-time segments without interpolation or animation', () => {
    const { owner } = create();
    owner.setSeries(altitude, speed);

    expect(instances.map(({ canvas }) => canvas)).toEqual([canvases.altitude, canvases.speed]);
    expect(instances.every(({ config }) => config.options?.animation === false)).toBe(true);
    expect(instances.every(({ config }) => config.options?.parsing === false)).toBe(true);
    expect(instances.every(({ config }) => config.options?.scales?.x?.type === 'linear')).toBe(
      true,
    );
    expect(
      instances.every(
        ({ options }) => options.scales?.x?.min === Date.parse('2026-08-27T11:59:58.500Z'),
      ),
    ).toBe(true);
    expect(
      instances.every(
        ({ options }) => options.scales?.x?.max === Date.parse('2026-08-27T12:00:31.500Z'),
      ),
    ).toBe(true);
    expect(instances[0]!.data.datasets).toHaveLength(2);
    expect(instances[0]!.data.datasets[0]!.data).toEqual([
      {
        x: Date.parse('2026-08-27T12:00:00.000Z'),
        y: 0,
        sequence: 1,
        observedAt: '2026-08-27T12:00:00.000Z',
      },
      expect.objectContaining({ y: 12_000, sequence: 2 }),
    ]);
    for (const instance of instances) {
      for (const dataset of instance.data.datasets) {
        expect(dataset).toMatchObject({ fill: false, spanGaps: false, tension: 0 });
      }
      expect(instance.update).toHaveBeenCalledExactlyOnceWith('none');
    }
  });

  it('links point clicks and the dashed cursor to the exact receipt sequence', () => {
    const { owner, onSelect } = create();
    owner.setSeries(altitude, speed);
    owner.setSelection(4);

    expect(instances[0]!.data.datasets[1]!.pointRadius).toEqual([4]);
    expect(instances[0]!.data.datasets[1]!.pointBorderWidth).toEqual([3]);
    expect(instances.every(({ update }) => update.mock.calls.length === 2)).toBe(true);

    const altitudeChart = instances[0]!;
    const cursor = altitudeChart.config.plugins?.[0]?.afterDatasetsDraw;
    cursor?.(altitudeChart as unknown as ChartInstance<'line', TestPoint[], number>, {}, {}, false);
    expect(altitudeChart.ctx.setLineDash).toHaveBeenCalledWith([3, 3]);
    expect(altitudeChart.ctx.moveTo).toHaveBeenCalledWith(60, 10);
    expect(altitudeChart.ctx.lineTo).toHaveBeenCalledWith(60, 90);

    altitudeChart.config.options?.onClick?.(
      {} as never,
      [{ datasetIndex: 1, index: 0 }] as never,
      altitudeChart as unknown as ChartInstance<'line', TestPoint[], number>,
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('destroys each chart once and ignores later writes', () => {
    const { owner } = create();
    owner.setSeries(altitude, speed);
    const updates = instances.map(({ update }) => update.mock.calls.length);
    owner.destroy();
    owner.destroy();
    owner.setSeries(altitude, speed);
    owner.setSelection(1);
    expect(instances.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
    expect(instances.map(({ update }) => update.mock.calls.length)).toEqual(updates);
  });

  it('draws the selected measurement time in both charts when one channel is missing', () => {
    const { owner } = create();
    owner.setSeries(altitude, speed);
    owner.setSelection(2, '2026-08-27T12:00:10.000Z');
    const speedChart = instances[1]!;
    speedChart.config.plugins?.[0]?.afterDatasetsDraw?.(
      speedChart as unknown as ChartInstance<'line', TestPoint[], number>,
      {},
      {},
      false,
    );
    expect(speedChart.scales.x.getPixelForValue).toHaveBeenCalledWith(
      Date.parse('2026-08-27T12:00:10.000Z'),
    );
    expect(speedChart.ctx.moveTo).toHaveBeenCalledWith(60, 10);
  });

  it('fails closed if series are attached to the wrong chart channel', () => {
    const { owner } = create();
    expect(() => owner.setSeries(speed, altitude)).toThrow('do not match');
  });

  it('releases an earlier chart when the second chart cannot be constructed', () => {
    const initialize = engine.create.getMockImplementation()!;
    engine.create.mockImplementationOnce(initialize).mockImplementationOnce(() => {
      throw new Error('controlled chart failure');
    });
    expect(() => createLiveChartRenderer(canvases, vi.fn())).toThrow('controlled chart failure');
    expect(instances).toHaveLength(1);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
  });
});
