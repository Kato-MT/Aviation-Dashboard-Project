// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestigationCharts } from '../../src/features/lab/InvestigationCharts';
import type { InvestigationSeries } from '../../src/ui/investigationCharts';

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/ui/investigationCharts', () => ({
  InvestigationChartRenderer: class {
    constructor(...args: unknown[]) {
      return engine.create(...args);
    }
  },
}));

interface FakeRenderer {
  render: ReturnType<typeof vi.fn>;
  setCursor: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeRenderer(): FakeRenderer {
  return { render: vi.fn(), setCursor: vi.fn(), destroy: vi.fn() };
}

const series: InvestigationSeries = {
  sampleIndices: [0, 1],
  timestamps: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'],
  observedAltitude: [100, 110],
  predictedAltitude: [99, 109],
  lowerUncertainty: [95, 105],
  upperUncertainty: [103, 113],
  observedAirspeed: [80, 82],
  observedFuel: [90, 89.9],
  residualValues: [0.1, 0.2],
  phaseSegments: [{ phase: 'ground', label: 'Ground', startIndex: 0, endIndex: 1 }],
  faultMarkers: [],
};

let root: Root;
let container: HTMLDivElement;
let instances: FakeRenderer[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  instances = [];
  engine.create.mockImplementation(() => {
    const owner = fakeRenderer();
    instances.push(owner);
    return owner;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

function view(
  sampleIndex = 0,
  onSeek = vi.fn(),
  overlays: { predictedAltitude?: boolean } | undefined = undefined,
) {
  return (
    <InvestigationCharts
      series={series}
      overlays={overlays}
      sampleIndex={sampleIndex}
      onSeek={onSeek}
    />
  );
}

describe('React Investigation chart ownership', () => {
  it('owns stable, uniquely named canvases and separates dataset, cursor, and seek updates', async () => {
    const onSeek = vi.fn();
    await render(
      <>
        {view(0, onSeek)}
        {view(1)}
      </>,
    );

    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases).toHaveLength(4);
    expect(new Set(canvases.map(({ id }) => id)).size).toBe(4);
    expect(canvases.every(({ id }) => id.startsWith('lab-investigation-'))).toBe(true);
    expect(canvases.map((canvas) => canvas.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('observed and predicted state'),
      expect.stringContaining('normalized sensor residual'),
      expect.stringContaining('observed and predicted state'),
      expect.stringContaining('normalized sensor residual'),
    ]);

    expect(engine.create).toHaveBeenCalledTimes(2);
    const firstOptions = engine.create.mock.calls[0]![0] as {
      stateCanvasId: string;
      residualCanvasId: string;
      theme: string;
      onSeek: (sampleIndex: number) => void;
    };
    expect(firstOptions).toMatchObject({
      stateCanvasId: canvases[0]!.id,
      residualCanvasId: canvases[1]!.id,
      theme: 'light',
    });
    firstOptions.onSeek(1);
    expect(onSeek).toHaveBeenCalledWith(1);

    const firstOwner = instances[0]!;
    expect(firstOwner.render).toHaveBeenCalledWith(series, {
      overlays: undefined,
      comparison: undefined,
    });
    expect(firstOwner.setCursor).toHaveBeenCalledWith(0);
    const idsBeforeUpdate = canvases.map(({ id }) => id);
    firstOwner.render.mockClear();
    await render(
      <>
        {view(1, onSeek)}
        {view(1)}
      </>,
    );
    expect(firstOwner.render).not.toHaveBeenCalled();
    expect(firstOwner.setCursor).toHaveBeenLastCalledWith(1);
    expect([...container.querySelectorAll('canvas')].map(({ id }) => id)).toEqual(idsBeforeUpdate);

    const overlays = { predictedAltitude: false };
    await render(
      <>
        {view(1, onSeek, overlays)}
        {view(1)}
      </>,
    );
    expect(firstOwner.render).toHaveBeenLastCalledWith(series, {
      overlays,
      comparison: undefined,
    });
    expect(engine.create).toHaveBeenCalledTimes(2);
  });

  it.each(['constructor', 'dataset', 'cursor'] as const)(
    'contains a %s failure in an accessible alert and supports a clean retry',
    async (failure) => {
      if (failure === 'constructor') {
        engine.create.mockImplementationOnce(() => {
          throw new Error('canvas unavailable');
        });
      } else {
        engine.create.mockImplementationOnce(() => {
          const owner = fakeRenderer();
          instances.push(owner);
          const method = failure === 'dataset' ? owner.render : owner.setCursor;
          method.mockImplementationOnce(() => {
            throw new Error(`${failure} draw failure`);
          });
          return owner;
        });
      }

      await render(view());
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Investigation charts unavailable');
      expect(alert?.textContent).toContain('evidence tables, and exports remain available');
      expect(container.querySelectorAll('canvas')).toHaveLength(0);
      if (failure !== 'constructor') expect(instances[0]!.destroy).toHaveBeenCalledOnce();

      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelectorAll('canvas')).toHaveLength(2);
      expect(engine.create).toHaveBeenCalledTimes(2);
      expect(instances.at(-1)!.render).toHaveBeenCalledOnce();
      expect(instances.at(-1)!.setCursor).toHaveBeenCalledOnce();
    },
  );

  it('releases the first Strict Mode owner and the current owner without leaking resources', async () => {
    await render(<StrictMode>{view()}</StrictMode>);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(instances[1]!.destroy).not.toHaveBeenCalled();

    await render(<p>Investigation closed</p>);
    expect(instances[1]!.destroy).toHaveBeenCalledOnce();
    expect(instances.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
  });
});
