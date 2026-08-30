// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AirspaceMap, MAP_LOAD_TIMEOUT_MS } from '../../src/features/live/AirspaceMap';
import type { createMapRenderer } from '../../src/features/live/mapRenderer';
import type { AircraftHistory } from '../../src/live/history';
import { aircraftFixture, LIVE_FIXTURE_EPOCH, LIVE_FIXTURE_TIME } from '../live/fixtures';

type RendererModule = { createMapRenderer: typeof createMapRenderer };
const timestamp = Date.parse(LIVE_FIXTURE_TIME);
const time = { earliestMs: timestamp, latestMs: timestamp, referenceAgeMs: 0 };
const binding = {
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  feedEpoch: LIVE_FIXTURE_EPOCH,
} as const;
const selectedHistory: AircraftHistory = {
  samples: [
    {
      sequence: 1,
      receivedAt: LIVE_FIXTURE_TIME,
      providerGeneratedAt: LIVE_FIXTURE_TIME,
      position: {
        latitude: 33.64,
        longitude: -84.43,
        observedAt: LIVE_FIXTURE_TIME,
        breakBefore: true,
      },
    },
  ],
  incompleteReasons: [],
};
let root: Root;
let container: HTMLDivElement;
const dispose = vi.fn();
const update = vi.fn();
const resetView = vi.fn();
const create = vi.fn<typeof createMapRenderer>();
let load: ReturnType<typeof vi.fn<() => Promise<RendererModule>>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  create.mockImplementation(() => ({ dispose, update, resetView }));
  load = vi.fn(async () => ({ createMapRenderer: create }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function view(overrides: Partial<Parameters<typeof AirspaceMap>[0]> = {}) {
  return (
    <AirspaceMap
      aircraft={[aircraftFixture()]}
      time={time}
      regionId="atlanta"
      selectedId={undefined}
      selectedHistorySequence={undefined}
      selectedHistory={undefined}
      binding={binding}
      onSelect={vi.fn()}
      loadRenderer={load}
      {...overrides}
    />
  );
}
function status() {
  return container.querySelector('.map-stage')?.getAttribute('data-map-status');
}
function callbacks() {
  return create.mock.calls.at(-1)![2];
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe('React map resource ownership', () => {
  it('loads once and sends current frames and selection without remounting', async () => {
    const select = vi.fn();
    await render(view({ onSelect: select }));
    expect(container.querySelector('.airspace-map')?.getAttribute('role')).toBe('region');
    expect(status()).toBe('loading');
    await act(async () => callbacks().ready());
    expect(status()).toBe('ready');
    await render(
      view({
        regionId: 'central-georgia',
        selectedId: 'a1b2c3',
        selectedHistorySequence: 1,
        selectedHistory,
        binding: { ...binding, regionId: 'central-georgia' },
        onSelect: select,
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        regionId: 'central-georgia',
        selectedId: 'a1b2c3',
        selectedHistorySequence: 1,
        resolvedHistorySequence: 1,
        selectedTrail: expect.objectContaining({ features: expect.any(Array) }),
      }),
    );
    await click('Reset map view');
    expect(resetView).toHaveBeenCalledOnce();
    await act(async () => {
      callbacks().select({ mode: 'latest', aircraftId: 'unknown' });
      callbacks().select({ mode: 'latest', aircraftId: 'a1b2c3' });
      callbacks().select({
        mode: 'exact',
        key: { aircraftId: 'a1b2c3', sequence: 1, ...binding },
      });
      callbacks().select({
        mode: 'exact',
        key: {
          aircraftId: 'a1b2c3',
          sequence: 1,
          ...binding,
          regionId: 'central-georgia',
        },
      });
    });
    expect(select).toHaveBeenNthCalledWith(1, { mode: 'latest', aircraftId: 'a1b2c3' });
    expect(select).toHaveBeenNthCalledWith(2, {
      mode: 'exact',
      key: {
        aircraftId: 'a1b2c3',
        sequence: 1,
        ...binding,
        regionId: 'central-georgia',
      },
    });
    await render(view({ aircraft: [], onSelect: select }));
    await act(async () => callbacks().select({ mode: 'latest', aircraftId: 'a1b2c3' }));
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not create a map when a lazy import finishes after unmount', async () => {
    let resolve!: (value: RendererModule) => void;
    load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(view());
    await render(<p>Another workspace</p>);
    await act(async () => resolve({ createMapRenderer: create }));
    expect(create).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Another workspace');
  });

  it('binds a stable-paint callback to the exact rendered snapshot token', async () => {
    const onStablePaint = vi.fn();
    await render(view());
    await act(async () => callbacks().ready());
    await render(
      view({
        aircraft: [aircraftFixture({ groundSpeedKnots: 321 })],
        stablePaintToken: 7,
        onStablePaint,
      }),
    );
    const painted = update.mock.calls.at(-1)?.[1];
    expect(painted).toBeTypeOf('function');
    await act(async () => painted?.());
    expect(onStablePaint).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('rejects late ready, error and click callbacks after disposal', async () => {
    const select = vi.fn();
    await render(view({ onSelect: select }));
    const previous = callbacks();
    await render(<p>Another workspace</p>);
    await act(async () => {
      previous.ready();
      previous.unavailable();
      previous.select({ mode: 'latest', aircraftId: 'a1b2c3' });
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Another workspace');
  });

  it('limits loading time and never constructs a renderer from a timed-out import', async () => {
    let resolve!: (value: RendererModule) => void;
    load.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render(view());
    await act(async () => vi.advanceTimersByTimeAsync(MAP_LOAD_TIMEOUT_MS));
    expect(status()).toBe('unavailable');
    await act(async () => resolve({ createMapRenderer: create }));
    expect(create).not.toHaveBeenCalled();
  });

  it('disposes an initialized renderer if its geographic load never completes', async () => {
    await render(view());
    const previous = callbacks();
    await act(async () => vi.advanceTimersByTimeAsync(MAP_LOAD_TIMEOUT_MS));
    expect(status()).toBe('unavailable');
    expect(dispose).toHaveBeenCalledOnce();
    await act(async () => previous.ready());
    expect(status()).toBe('unavailable');
  });

  it.each(['import', 'constructor', 'early-error', 'runtime-error'])(
    'supports a clean retry after %s failure',
    async (failure) => {
      if (failure === 'import') load.mockRejectedValueOnce(new Error('chunk unavailable'));
      if (failure === 'constructor')
        create.mockImplementationOnce(() => {
          throw new Error('WebGL');
        });
      if (failure === 'early-error')
        create.mockImplementationOnce((_element, _frame, events) => {
          events.unavailable();
          return { dispose, update, resetView };
        });
      await render(view());
      if (failure === 'runtime-error') {
        await act(async () => callbacks().ready());
        await act(async () => callbacks().unavailable());
      }
      expect(status()).toBe('unavailable');
      await click('Retry map');
      await act(async () => callbacks().ready());
      expect(status()).toBe('ready');
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps only one constructed owner across Strict Mode effect replay', async () => {
    await render(<StrictMode>{view()}</StrictMode>);
    expect(create).toHaveBeenCalledOnce();
    await act(async () => callbacks().ready());
    await render(<p>Closed</p>);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
