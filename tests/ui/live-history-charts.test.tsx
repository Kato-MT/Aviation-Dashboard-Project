// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHART_LOAD_TIMEOUT_MS,
  LiveHistoryCharts,
} from '../../src/features/live/LiveHistoryCharts';
import type { LiveChartRenderer } from '../../src/features/live/liveChartRenderer';
import type { SessionSeries } from '../../src/live/historyPresentation';

type RendererModule = Pick<
  typeof import('../../src/features/live/liveChartRenderer'),
  'createLiveChartRenderer'
>;

const altitude: SessionSeries = {
  channel: 'barometricAltitudeFeet',
  label: 'Barometric altitude',
  unit: 'ft',
  pointCount: 2,
  segments: [
    [
      {
        sequence: 1,
        receivedAt: '2026-08-27T12:00:01.000Z',
        observedAt: '2026-08-27T12:00:00.000Z',
        value: 10_000,
      },
      {
        sequence: 3,
        receivedAt: '2026-08-27T12:00:21.000Z',
        observedAt: '2026-08-27T12:00:20.000Z',
        value: 11_000,
      },
    ],
  ],
};

const speed: SessionSeries = {
  channel: 'groundSpeedKnots',
  label: 'Ground speed',
  unit: 'kt',
  pointCount: 1,
  segments: [
    [
      {
        sequence: 2,
        receivedAt: '2026-08-27T12:00:11.000Z',
        observedAt: '2026-08-27T12:00:10.000Z',
        value: 250,
      },
    ],
  ],
};

const emptyAltitude: SessionSeries = { ...altitude, pointCount: 0, segments: [] };
const emptySpeed: SessionSeries = { ...speed, pointCount: 0, segments: [] };

let root: Root;
let container: HTMLDivElement;
let instances: LiveChartRenderer[];
let create: ReturnType<typeof vi.fn<RendererModule['createLiveChartRenderer']>>;
let load: ReturnType<typeof vi.fn<() => Promise<RendererModule>>>;

function fakeRenderer(): LiveChartRenderer {
  return { setSeries: vi.fn(), setSelection: vi.fn(), destroy: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  instances = [];
  create = vi.fn<RendererModule['createLiveChartRenderer']>(() => {
    const owner = fakeRenderer();
    instances.push(owner);
    return owner;
  });
  load = vi.fn<() => Promise<RendererModule>>(async () => ({ createLiveChartRenderer: create }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function view(
  selectedSequence: number | undefined = undefined,
  onSelectSequence = vi.fn(),
  nextAltitude = altitude,
  nextSpeed = speed,
) {
  return (
    <LiveHistoryCharts
      altitude={nextAltitude}
      speed={nextSpeed}
      selectedSequence={selectedSequence}
      onSelectSequence={onSelectSequence}
      loadRenderer={load}
    />
  );
}

async function press(key: string) {
  const target = container.querySelector<HTMLElement>('.live-history-charts');
  expect(target).not.toBeNull();
  await act(async () =>
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  );
}

describe('React live history chart ownership', () => {
  it('owns two explicit canvases and updates selection without rebuilding series', async () => {
    await render(view(1));
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    expect(create).toHaveBeenCalledOnce();
    const [canvases] = create.mock.calls[0]!;
    expect(canvases.altitude).toBeInstanceOf(HTMLCanvasElement);
    expect(canvases.speed).toBeInstanceOf(HTMLCanvasElement);
    const owner = instances[0]!;
    expect(owner.setSeries).toHaveBeenCalledExactlyOnceWith(altitude, speed);
    expect(owner.setSelection).toHaveBeenLastCalledWith(1, undefined);

    vi.mocked(owner.setSeries).mockClear();
    await render(view(2));
    expect(owner.setSeries).not.toHaveBeenCalled();
    expect(owner.setSelection).toHaveBeenLastCalledWith(2, undefined);
    expect(create).toHaveBeenCalledOnce();
  });

  it('provides keyboard navigation across the union of retained measurement receipts', async () => {
    const select = vi.fn();
    await render(view(2, select));
    await press('ArrowLeft');
    await press('ArrowRight');
    await press('Home');
    await press('End');
    expect(select.mock.calls.map(([sequence]) => sequence)).toEqual([1, 3, 1, 3]);
  });

  it('moves to the true neighboring receipt when the exact selection has no plotted value', async () => {
    const select = vi.fn();
    await render(view(2, select, altitude, emptySpeed));
    await press('ArrowLeft');
    await press('ArrowRight');
    expect(select.mock.calls.map(([sequence]) => sequence)).toEqual([1, 3]);
    expect(container.textContent).toContain('No ground-speed value in this receipt.');
  });

  it('labels empty channels and removes them from keyboard navigation', async () => {
    const select = vi.fn();
    await render(view(undefined, select, emptyAltitude, emptySpeed));
    expect(container.textContent).toContain('No retained barometric altitude measurements.');
    expect(container.textContent).toContain('No retained ground-speed measurements.');
    expect(container.querySelector('.live-history-charts')?.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelectorAll('canvas')[0]?.getAttribute('aria-label')).toContain(
      '0 received measurement points',
    );
  });

  it('uses the latest props and callback when a delayed renderer finishes loading', async () => {
    let resolve!: (value: RendererModule) => void;
    load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const firstSelect = vi.fn();
    const latestSelect = vi.fn();
    const latestAltitude: SessionSeries = {
      ...altitude,
      pointCount: 1,
      segments: [[altitude.segments[0]![1]!]],
    };
    await render(view(1, firstSelect));
    await render(view(3, latestSelect, latestAltitude, speed));
    await act(async () => resolve({ createLiveChartRenderer: create }));
    const owner = instances[0]!;
    expect(owner.setSeries).toHaveBeenCalledExactlyOnceWith(latestAltitude, speed);
    expect(owner.setSelection).toHaveBeenLastCalledWith(3, undefined);
    const selectFromRenderer = create.mock.calls[0]![1];
    selectFromRenderer(3);
    expect(firstSelect).not.toHaveBeenCalled();
    expect(latestSelect).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('bounds a stalled renderer import and keeps the text fallback available', async () => {
    vi.useFakeTimers();
    try {
      load.mockReturnValueOnce(new Promise(() => undefined));
      await render(view());
      expect(container.textContent).toContain('Loading session charts.');
      await act(async () => vi.advanceTimersByTimeAsync(CHART_LOAD_TIMEOUT_MS));
      expect(container.textContent).toContain('Session charts unavailable');
      expect(container.textContent).toContain('evidence table remain available');
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['import', 'constructor', 'dataset', 'selection'])(
    'contains a %s failure and supports a clean retry',
    async (failure) => {
      if (failure === 'import') load.mockRejectedValueOnce(new Error('chunk unavailable'));
      if (failure === 'constructor')
        create.mockImplementationOnce(() => {
          throw new Error('canvas unavailable');
        });
      if (failure === 'dataset') {
        create.mockImplementationOnce(() => {
          const owner = fakeRenderer();
          vi.mocked(owner.setSeries).mockImplementationOnce(() => {
            throw new Error('dataset failure');
          });
          instances.push(owner);
          return owner;
        });
      }
      if (failure === 'selection') {
        create.mockImplementationOnce(() => {
          const owner = fakeRenderer();
          vi.mocked(owner.setSelection).mockImplementationOnce(() => {
            throw new Error('selection failure');
          });
          instances.push(owner);
          return owner;
        });
      }

      await render(view(1));
      expect(container.textContent).toContain('Session charts unavailable');
      expect(container.textContent).toContain('exact receipt timeline and evidence table remain');
      expect(container.querySelectorAll('canvas')).toHaveLength(0);
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(container.querySelectorAll('canvas')).toHaveLength(2);
      expect(container.textContent).not.toContain('Session charts unavailable');
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('does not construct after a late import resolves into an unmounted view', async () => {
    let resolve!: (value: RendererModule) => void;
    load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(view());
    await render(<p>Closed</p>);
    await act(async () => resolve({ createLiveChartRenderer: create }));
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves only the current chart owner active under Strict Mode', async () => {
    await render(<StrictMode>{view()}</StrictMode>);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.destroy).not.toHaveBeenCalled();
    await render(<p>Closed</p>);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
  });
});
