// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chartEngine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('chart.js/auto', () => ({
  default: class {
    constructor(...args: unknown[]) {
      return chartEngine.create(...args);
    }
  },
}));

import {
  buildInvestigationMarkerLines,
  buildInvestigationPhaseBands,
  downsampleInvestigationSeries,
  evaluateInvestigationComparison,
  InvestigationChartRenderer,
  investigationChartPalette,
  investigationWaveformLabels,
  selectInvestigationSamplePositions,
  validateInvestigationComparisonWaveform,
  validateInvestigationSeries,
  type InvestigationSeries,
} from '../../src/ui/investigationCharts';

interface FakeChartOwner {
  data: { datasets: unknown[] };
  destroy: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function fakeChartOwner(config: { data: { datasets: unknown[] } }): FakeChartOwner {
  return {
    data: config.data,
    destroy: vi.fn(),
    draw: vi.fn(),
    update: vi.fn(),
  };
}

function makeSeries(length = 100): InvestigationSeries {
  const sampleIndices = Array.from({ length }, (_, index) => index);
  return {
    sampleIndices,
    timestamps: sampleIndices.map((index) =>
      new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000).toISOString(),
    ),
    observedAltitude: sampleIndices.map((index) => index * 10 + 1),
    predictedAltitude: sampleIndices.map((index) => index * 10),
    lowerUncertainty: sampleIndices.map((index) => index * 10 - 5),
    upperUncertainty: sampleIndices.map((index) => index * 10 + 5),
    observedAirspeed: sampleIndices.map((index) => 100 + index / 10),
    observedFuel: sampleIndices.map((index) => 100 - index / 10),
    residualValues: sampleIndices.map((index) => (index % 2 === 0 ? 1 : -1)),
    phaseSegments: [
      { phase: 'ground', label: 'Ground', startIndex: 0, endIndex: 19 },
      { phase: 'climb', label: 'Climb', startIndex: 20, endIndex: 49 },
      { phase: 'cruise', label: 'Cruise', startIndex: 50, endIndex: length - 1 },
    ],
    faultMarkers: [
      {
        faultId: 'fault-a',
        label: 'Synthetic drift',
        onsetIndex: 33,
        endIndex: 44,
        recoveryIndex: 48,
        detectionIndex: 36,
      },
    ],
  };
}

describe('investigation chart pure helpers', () => {
  it('creates phase bands with stable phase-specific colors', () => {
    const bands = buildInvestigationPhaseBands(makeSeries().phaseSegments);
    expect(bands.map(({ phase }) => phase)).toEqual(['ground', 'climb', 'cruise']);
    expect(bands.every(({ color }) => color.startsWith('rgba('))).toBe(true);
    expect(new Set(bands.map(({ color }) => color)).size).toBe(3);
  });

  it('expands fault lifecycle points into lightweight marker primitives', () => {
    const lines = buildInvestigationMarkerLines(makeSeries().faultMarkers);
    expect(lines.map(({ kind, sampleIndex }) => `${kind}:${sampleIndex}`)).toEqual([
      'onset:33',
      'end:44',
      'recovery:48',
      'detection:36',
    ]);
    expect(lines.every(({ faultId, label }) => faultId === 'fault-a' && label.length > 0)).toBe(
      true,
    );
    expect(lines.find(({ kind }) => kind === 'detection')?.color).toBe('#ff6b7d');
  });

  it('downsamples aligned values while preserving phase and fault evidence', () => {
    const source = makeSeries();
    const sampled = downsampleInvestigationSeries(source, 20);
    expect(sampled.sampleIndices).toHaveLength(20);
    expect(sampled.sampleIndices).toEqual([...sampled.sampleIndices].sort((a, b) => a - b));
    expect(sampled.sampleIndices).toEqual(
      expect.arrayContaining([0, 19, 20, 33, 36, 44, 48, 49, 50, 99]),
    );
    expect(sampled.predictedAltitude).toEqual(
      sampled.sampleIndices.map((sampleIndex) => sampleIndex * 10),
    );
    expect(sampled.phaseSegments).toEqual(source.phaseSegments);
    expect(sampled.faultMarkers).toEqual(source.faultMarkers);
    expect(sampled.phaseSegments).not.toBe(source.phaseSegments);
    expect(sampled.faultMarkers).not.toBe(source.faultMarkers);
  });

  it('preserves critical evidence even when it exceeds the requested display budget', () => {
    const series = makeSeries();
    const positions = selectInvestigationSamplePositions(series, 2);
    const selected = positions.map((position) => series.sampleIndices[position]);
    expect(selected.length).toBeGreaterThan(2);
    expect(selected).toEqual(expect.arrayContaining([0, 33, 44, 48, 99]));
  });

  it('accepts explicit missing observations but rejects malformed prepared data', () => {
    const source = makeSeries();
    const withMissing: InvestigationSeries = {
      ...source,
      observedAltitude: source.observedAltitude.map((value, index) => (index === 2 ? null : value)),
      observedAirspeed: source.observedAirspeed.map((value, index) => (index === 3 ? null : value)),
      observedFuel: source.observedFuel.map((value, index) => (index === 4 ? null : value)),
      residualValues: source.residualValues.map((value, index) => (index === 5 ? null : value)),
    };
    expect(() => validateInvestigationSeries(withMissing)).not.toThrow();

    expect(() => validateInvestigationSeries({ ...makeSeries(), predictedAltitude: [1] })).toThrow(
      'match sampleIndices',
    );
    expect(() =>
      validateInvestigationSeries({
        ...makeSeries(),
        upperUncertainty: makeSeries().upperUncertainty.map((value, index) =>
          index === 3 ? Number.NaN : value,
        ),
      }),
    ).toThrow('must be finite');
    expect(() =>
      validateInvestigationSeries({
        ...makeSeries(),
        lowerUncertainty: makeSeries().lowerUncertainty.map((value, index) =>
          index === 3 ? 100 : value,
        ),
        upperUncertainty: makeSeries().upperUncertainty.map((value, index) =>
          index === 3 ? 50 : value,
        ),
      }),
    ).toThrow('inverted');
  });

  it('rejects unsafe ranges and invalid downsampling limits', () => {
    const empty: InvestigationSeries = {
      ...makeSeries(0),
      phaseSegments: [],
      faultMarkers: [],
    };
    expect(selectInvestigationSamplePositions(empty, 2)).toEqual([]);
    expect(() => selectInvestigationSamplePositions(makeSeries(), 1)).toThrow('at least 2');
    expect(() =>
      validateInvestigationSeries({
        ...makeSeries(),
        phaseSegments: [{ phase: 'ground', label: 'Outside', startIndex: 0, endIndex: 500 }],
      }),
    ).toThrow('sample range');
    expect(() =>
      validateInvestigationSeries({
        ...makeSeries(),
        timestamps: makeSeries().timestamps.map((value, index) =>
          index === 4 ? 'not-a-time' : value,
        ),
      }),
    ).toThrow('valid timestamp');
  });

  it('accepts only exact profile, cadence, count, and sample-index comparison alignment', () => {
    const baseline = {
      profileId: 'generic-fixed-wing',
      cadenceMs: 1_000,
      sampleCount: 100,
      sampleIndices: makeSeries().sampleIndices,
    };
    expect(evaluateInvestigationComparison(baseline, { ...baseline })).toEqual({
      compatible: true,
      mismatches: [],
      reasons: [],
    });

    const incompatible = evaluateInvestigationComparison(baseline, {
      profileId: 'generic-rotary-wing',
      cadenceMs: 500,
      sampleCount: 99,
      sampleIndices: baseline.sampleIndices.slice(0, 99),
    });
    expect(incompatible.compatible).toBe(false);
    expect(incompatible.mismatches).toEqual(['profile', 'cadence', 'sample-count']);
    expect(incompatible.reasons).toEqual([
      'Profile differs: baseline generic-fixed-wing, current generic-rotary-wing.',
      'Cadence differs: baseline 1000 ms, current 500 ms.',
      'Sample count differs: baseline 100, current 99.',
    ]);
  });

  it('labels current and captured observed and predicted waveforms without ambiguity', () => {
    expect(investigationWaveformLabels(true)).toEqual({
      observed: 'Current observed altitude (ft)',
      predicted: 'Current predicted altitude (ft)',
      baselineObserved: 'Baseline observed altitude (ft)',
      baselinePredicted: 'Baseline predicted altitude (ft)',
    });
    expect(investigationWaveformLabels(false).observed).toBe('Observed altitude (ft)');
  });

  it('rejects silent index realignment and malformed comparison waveforms', () => {
    const candidate = makeSeries();
    const identity = {
      profileId: 'generic-fixed-wing',
      cadenceMs: 1_000,
      sampleCount: candidate.sampleIndices.length,
      sampleIndices: candidate.sampleIndices,
    };
    const shiftedIndices = candidate.sampleIndices.map((sampleIndex) => sampleIndex + 1);
    expect(
      evaluateInvestigationComparison(identity, { ...identity, sampleIndices: shiftedIndices }),
    ).toMatchObject({
      compatible: false,
      mismatches: ['sample-indices'],
      reasons: ['Sample indices do not align exactly.'],
    });

    const waveform = {
      sampleIndices: candidate.sampleIndices,
      observedAltitude: candidate.observedAltitude,
      predictedAltitude: candidate.predictedAltitude,
    };
    expect(() => validateInvestigationComparisonWaveform(waveform, candidate)).not.toThrow();
    expect(() =>
      validateInvestigationComparisonWaveform(
        { ...waveform, sampleIndices: shiftedIndices },
        candidate,
      ),
    ).toThrow('exactly match');
    expect(() =>
      validateInvestigationComparisonWaveform({ ...waveform, observedAltitude: [1] }, candidate),
    ).toThrow('values must match');
  });
});

describe('investigation chart renderer ownership and themes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    chartEngine.create.mockReset();
    document.body.replaceChildren();
    for (const id of ['state-chart', 'residual-chart']) {
      const canvas = document.createElement('canvas');
      canvas.id = id;
      document.body.append(canvas);
    }
    chartEngine.create.mockImplementation((_canvas, config) => fakeChartOwner(config));
  });

  it('keeps the legacy dark palette as the default and applies the explicit light palette', () => {
    expect(investigationChartPalette()).toMatchObject({
      label: '#a0abb5',
      tick: '#73808b',
      cursor: 'rgba(231, 235, 238, 0.78)',
      datasets: { predictedAltitude: '#76add5', residual: '#d5747b' },
    });
    expect(investigationChartPalette('light')).toMatchObject({
      label: '#334155',
      tick: '#526274',
      cursor: 'rgba(15, 23, 42, 0.72)',
      datasets: { predictedAltitude: '#2563eb', residual: '#be123c' },
    });

    const dark = new InvestigationChartRenderer({
      stateCanvasId: 'state-chart',
      residualCanvasId: 'residual-chart',
    });
    const darkStateConfig = chartEngine.create.mock.calls[0]![1] as {
      data: { datasets: Array<{ borderColor: string }> };
      options: { plugins: { legend: { labels: { color: string } } } };
    };
    expect(darkStateConfig.data.datasets[3]!.borderColor).toBe('#76add5');
    expect(darkStateConfig.options.plugins.legend.labels.color).toBe('#a0abb5');
    dark.destroy();

    chartEngine.create.mockClear();
    const light = new InvestigationChartRenderer({
      stateCanvasId: 'state-chart',
      residualCanvasId: 'residual-chart',
      theme: 'light',
    });
    const lightStateConfig = chartEngine.create.mock.calls[0]![1] as {
      data: { datasets: Array<{ borderColor: string }> };
      options: { plugins: { legend: { labels: { color: string } } } };
    };
    expect(lightStateConfig.data.datasets[3]!.borderColor).toBe('#2563eb');
    expect(lightStateConfig.options.plugins.legend.labels.color).toBe('#334155');
    light.destroy();
  });

  it('destroys the first chart when construction of the second chart fails', () => {
    const first = fakeChartOwner({ data: { datasets: [] } });
    const addListener = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener');
    chartEngine.create.mockReturnValueOnce(first).mockImplementationOnce(() => {
      throw new Error('residual chart failed');
    });

    expect(
      () =>
        new InvestigationChartRenderer({
          stateCanvasId: 'state-chart',
          residualCanvasId: 'residual-chart',
        }),
    ).toThrow('residual chart failed');
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
  });

  it('removes both keyboard listeners and destroys both charts exactly once', () => {
    const owners: FakeChartOwner[] = [];
    chartEngine.create.mockImplementation((_canvas, config) => {
      const owner = fakeChartOwner(config);
      owners.push(owner);
      return owner;
    });
    const addListener = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener');
    const removeListener = vi.spyOn(HTMLCanvasElement.prototype, 'removeEventListener');
    const renderer = new InvestigationChartRenderer({
      stateCanvasId: 'state-chart',
      residualCanvasId: 'residual-chart',
    });
    const keydownAdds = addListener.mock.calls.filter(([type]) => type === 'keydown');
    expect(keydownAdds).toHaveLength(2);

    renderer.destroy();
    renderer.destroy();

    const keydownRemovals = removeListener.mock.calls.filter(([type]) => type === 'keydown');
    expect(keydownRemovals).toHaveLength(2);
    expect(keydownRemovals.map(([, listener]) => listener)).toEqual(
      keydownAdds.map(([, listener]) => listener),
    );
    expect(owners).toHaveLength(2);
    expect(owners.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
  });
});
