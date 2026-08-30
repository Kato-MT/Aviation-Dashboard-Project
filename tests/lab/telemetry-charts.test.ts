// @vitest-environment jsdom
import type { Chart as ChartInstance, ChartConfiguration } from 'chart.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineCsv from '../../data/flight.csv?raw';
import { legacyCsvAdapter } from '../../src/adapters';
import { analyzeTelemetryRun, type Finding, type TelemetrySample } from '../../src/core';
import { includedBaselineProfile } from '../../src/profiles';
import { TelemetryCharts, type TelemetryCanvases } from '../../src/ui/charts';

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('chart.js/auto', () => ({
  default: class {
    constructor(canvas: unknown, config: unknown) {
      return engine.create(canvas, config);
    }
  },
}));

function fakeChart(canvas: HTMLCanvasElement, config: ChartConfiguration<'line'>) {
  return { canvas, config, data: config.data, update: vi.fn(), draw: vi.fn(), destroy: vi.fn() };
}
let instances: Array<ReturnType<typeof fakeChart>>;
let owners: TelemetryCharts[];
let samples: TelemetrySample[];
let findings: Finding[];
let canvases: TelemetryCanvases;

beforeEach(async () => {
  vi.resetAllMocks();
  instances = [];
  owners = [];
  const run = await legacyCsvAdapter.parse(baselineCsv);
  samples = run.samples;
  findings = analyzeTelemetryRun(run, includedBaselineProfile).findings;
  canvases = {
    altitude: document.createElement('canvas'),
    speed: document.createElement('canvas'),
    fuel: document.createElement('canvas'),
  };
  engine.create.mockImplementation((canvas, config) => {
    const chart = fakeChart(canvas, config);
    instances.push(chart);
    return chart;
  });
});
afterEach(() => {
  for (const owner of owners) owner.destroy();
  document.body.replaceChildren();
});
function create(theme: 'light' | 'dark' = 'light') {
  const owner = new TelemetryCharts(canvases, theme);
  owners.push(owner);
  return owner;
}

describe('owned telemetry charts', () => {
  it('uses explicit canvases without looking up or taking over legacy charts', () => {
    create();
    expect(instances.map((chart) => chart.canvas)).toEqual([
      canvases.altitude,
      canvases.speed,
      canvases.fuel,
    ]);
    expect(instances[0]?.data.datasets[0]?.borderColor).toBe('#28728c');
    expect(instances.every((chart) => chart.config.options?.animation === false)).toBe(true);
  });

  it('preserves the existing canvas-ID and dark-theme contract', () => {
    for (const [channel, canvas] of Object.entries(canvases)) {
      canvas.id = `chart-${channel}`;
      document.body.append(canvas);
    }
    const owner = new TelemetryCharts();
    owners.push(owner);
    owner.setRun(samples, findings);
    expect(instances[0]?.data.datasets[0]?.borderColor).toBe('#78b69a');
    expect(instances[0]?.data.datasets[0]?.pointBackgroundColor).toContain('#d5747b');
  });

  it('retains exact source labels, airspeed fallback and actual zeroes, with missing channels as gaps', () => {
    const owner = create();
    const first = samples[0]!;
    owner.setRun(
      [
        { ...first, measurements: { altitude: 0, speed: 0, airspeed: 55, fuel: 0 } },
        {
          ...first,
          sampleIndex: 1,
          originalTimestamp: undefined,
          timestampMs: Date.parse('2026-01-01T12:34:56Z'),
          measurements: { airspeed: 65 },
        },
        { ...first, sampleIndex: 2, measurements: {} },
      ],
      [],
    );
    expect(instances[0]?.data.labels).toEqual([
      first.originalTimestamp,
      '12:34:56',
      first.originalTimestamp,
    ]);
    expect(instances[0]?.data.datasets[0]?.data).toEqual([0, null, null]);
    expect(instances[1]?.data.datasets[0]?.data).toEqual([0, 65, null]);
    expect(instances[2]?.data.datasets[0]?.data).toEqual([0, null, null]);
    expect(instances.every((chart) => chart.update.mock.calls[0]?.[0] === 'none')).toBe(true);
  });

  it('bounds plotted points while retaining the final source record and source-index finding markers', () => {
    const owner = create();
    const many = Array.from({ length: 5_001 }, (_, index) => ({
      ...samples[0]!,
      sampleIndex: index,
      originalTimestamp: String(index),
    }));
    owner.setRun(many, [
      { ...findings[0]!, sampleIndex: 5_000 },
      { ...findings[0]!, sampleIndex: undefined },
    ]);
    const chart = instances[0]!;
    expect(chart.data.labels!.length).toBeLessThanOrEqual(2_001);
    expect(chart.data.labels!.at(-1)).toBe('5000');
    expect(chart.data.datasets[0]?.pointRadius).toEqual(expect.arrayContaining([3]));
    expect(chart.data.datasets[0]?.pointBackgroundColor).toEqual(
      expect.arrayContaining(['#b9474d']),
    );
  });

  it('draws a clamped sample cursor and clears all plotted data', () => {
    const owner = create();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    const fake = {
      ctx,
      chartArea: { left: 10, width: 100, top: 20, bottom: 80 },
    } as unknown as ChartInstance<'line'>;
    const drawCursor = () =>
      instances[0]!.config.plugins![0]!.afterDatasetsDraw?.(fake, {}, {}, false);
    drawCursor();
    expect(ctx.moveTo).not.toHaveBeenCalled();
    owner.setRun(samples, findings);
    owner.setCursor(42);
    drawCursor();
    expect(ctx.moveTo).toHaveBeenLastCalledWith(60, 20);
    owner.setCursor(999);
    drawCursor();
    expect(ctx.moveTo).toHaveBeenLastCalledWith(110, 20);
    owner.setCursor(-5);
    drawCursor();
    expect(ctx.moveTo).toHaveBeenLastCalledWith(10, 20);
    owner.clear();
    expect(
      instances.every(
        (chart) => chart.data.labels?.length === 0 && chart.data.datasets[0]?.data.length === 0,
      ),
    ).toBe(true);
    ctx.moveTo.mockClear();
    drawCursor();
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it('destroys every chart once and ignores subsequent writes after disposal', () => {
    const owner = create();
    owner.destroy();
    owner.destroy();
    owner.setRun(samples, findings);
    owner.setCursor(42);
    owner.clear();
    expect(instances.every((chart) => chart.destroy.mock.calls.length === 1)).toBe(true);
    expect(
      instances.every(
        (chart) => chart.update.mock.calls.length === 0 && chart.draw.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it('releases charts already constructed when a later canvas is missing', () => {
    canvases.altitude.id = 'chart-altitude';
    document.body.append(canvases.altitude);
    expect(() => new TelemetryCharts()).toThrow('Missing telemetry chart canvas');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('releases earlier charts when the rendering engine rejects a later canvas', () => {
    const initialize = engine.create.getMockImplementation()!;
    engine.create.mockImplementationOnce(initialize).mockImplementationOnce(() => {
      throw new Error('controlled canvas failure');
    });
    expect(() => create()).toThrow('controlled canvas failure');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.destroy).toHaveBeenCalledOnce();
  });
});
