// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapRenderer, type MapRenderer } from '../../src/features/live/mapRenderer';
import type { MapFrame } from '../../src/map/observations';

const engine = vi.hoisted(() => ({
  create: vi.fn(),
  addProtocol: vi.fn(),
  removeProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
}));
vi.mock('maplibre-gl', () => ({
  Map: class {
    constructor(options: unknown) {
      return engine.create(options);
    }
  },
  NavigationControl: class {},
  addProtocol: engine.addProtocol,
  removeProtocol: engine.removeProtocol,
  setWorkerUrl: engine.setWorkerUrl,
}));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({
  default: '/map-worker.js',
}));
vi.mock('pmtiles', () => ({
  Protocol: class {
    tile = vi.fn();
  },
}));

function fakeMap() {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const source = { setData: vi.fn() };
  const listen = (name: string, handler: (event?: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(handler);
  };
  return {
    listeners,
    source,
    getCanvas: vi.fn(() => document.createElement('canvas')),
    addControl: vi.fn(),
    touchZoomRotate: { disableRotation: vi.fn() },
    fitBounds: vi.fn(),
    getSource: vi.fn(() => source),
    setFilter: vi.fn(),
    queryRenderedFeatures: vi.fn<() => unknown[]>(() => []),
    project: vi.fn(([x, y]: [number, number]) => ({ x, y })),
    addImage: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    resize: vi.fn(),
    remove: vi.fn(),
    on: vi.fn(listen),
    once: vi.fn(listen),
    off: vi.fn((name: string, handler: (event?: unknown) => void) =>
      listeners.get(name)?.delete(handler),
    ),
    emit(name: string, event?: unknown) {
      for (const handler of listeners.get(name) ?? []) handler(event);
    },
  };
}

let map: ReturnType<typeof fakeMap>;
let owners: MapRenderer[];
let resizeCallback: () => void;
let animationFrame: FrameRequestCallback | undefined;
const disconnect = vi.fn();
const observe = vi.fn();
const frame: MapFrame = {
  regionId: 'atlanta',
  selectedId: undefined,
  selectedHistorySequence: undefined,
  resolvedHistorySequence: undefined,
  observations: { type: 'FeatureCollection', features: [] },
  selectedTrail: { type: 'FeatureCollection', features: [] },
};
const callbacks = { ready: vi.fn(), unavailable: vi.fn(), select: vi.fn() };
function create() {
  const owner = createMapRenderer(document.createElement('div'), frame, callbacks);
  owners.push(owner);
  return owner;
}

beforeEach(() => {
  vi.clearAllMocks();
  map = fakeMap();
  owners = [];
  animationFrame = undefined;
  engine.create.mockImplementation(() => map);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      animationFrame = callback;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    getImageData: vi.fn(() => ({ width: 32, height: 32, data: new Uint8ClampedArray(4096) })),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  for (const owner of owners) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MapLibre effect ownership and failure boundaries', () => {
  it('uses one protocol for concurrent owners and releases it after the final owner', () => {
    const first = create();
    const second = create();
    expect(engine.addProtocol).toHaveBeenCalledOnce();
    expect(engine.setWorkerUrl).toHaveBeenCalledWith('/map-worker.js');
    first.dispose();
    first.dispose();
    expect(engine.removeProtocol).not.toHaveBeenCalled();
    second.dispose();
    expect(engine.removeProtocol).toHaveBeenCalledExactlyOnceWith('pmtiles');
  });

  it('releases registration if WebGL construction fails', () => {
    engine.create.mockImplementationOnce(() => {
      throw new Error('WebGL unavailable');
    });
    expect(create).toThrow('WebGL unavailable');
    expect(engine.removeProtocol).toHaveBeenCalledOnce();
    create();
    expect(engine.addProtocol).toHaveBeenCalledTimes(2);
  });

  it('does not retain an owner count after protocol registration fails', () => {
    engine.addProtocol.mockImplementationOnce(() => {
      throw new Error('registration failed');
    });
    expect(create).toThrow('registration failed');
    create();
    expect(engine.addProtocol).toHaveBeenCalledTimes(2);
  });

  it('cleans up a partially initialized map when control setup fails', () => {
    map.addControl.mockImplementationOnce(() => {
      throw new Error('control failure');
    });
    expect(create).toThrow('control failure');
    expect(map.remove).toHaveBeenCalledOnce();
    expect(engine.removeProtocol).toHaveBeenCalledOnce();
    expect([...map.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('initializes observed layers once loaded and updates selection without fitting on every clock tick', () => {
    const owner = create();
    const changed = {
      ...frame,
      selectedId: 'a1b2c3',
      selectedHistorySequence: 7,
      resolvedHistorySequence: 7,
    };
    owner.update(changed);
    expect(map.source.setData).not.toHaveBeenCalled();
    map.emit('load');
    expect(map.addLayer).toHaveBeenCalledTimes(8);
    expect(map.source.setData).toHaveBeenCalledWith(frame.observations);
    expect(map.source.setData).toHaveBeenCalledWith(frame.selectedTrail);
    expect(map.setFilter).toHaveBeenCalledWith('selection', [
      '==',
      ['get', 'aircraftId'],
      'a1b2c3',
    ]);
    expect(map.setFilter).toHaveBeenCalledWith('selected-trail-evidence', [
      '==',
      ['get', 'historySequence'],
      7,
    ]);
    expect(callbacks.ready).toHaveBeenCalledOnce();
    const dataPublications = map.source.setData.mock.calls.length;
    const filterPublications = map.setFilter.mock.calls.length;
    owner.update(changed);
    expect(map.source.setData).toHaveBeenCalledTimes(dataPublications);
    expect(map.setFilter).toHaveBeenCalledTimes(filterPublications);
    expect(map.fitBounds).toHaveBeenCalledOnce();
    owner.update({ ...changed, regionId: 'central-georgia' });
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
    owner.resetView();
    expect(map.fitBounds).toHaveBeenCalledTimes(3);
    resizeCallback();
    expect(map.resize).toHaveBeenCalledOnce();
  });

  it('shows dense observation labels only after zooming into the regional view', () => {
    create();
    map.emit('load');
    expect(map.addLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'observation-label', minzoom: 8 }),
    );
  });

  it('reports an unchanged map frame on the next presented animation frame', () => {
    const owner = create();
    map.emit('load');
    const painted = vi.fn();
    owner.update(frame, painted);
    expect(painted).not.toHaveBeenCalled();
    animationFrame?.(0);
    expect(painted).toHaveBeenCalledOnce();
  });

  it('does not republish structurally identical observation features', () => {
    const initial = {
      ...frame,
      observations: {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            id: 'a1b2c3',
            geometry: { type: 'Point' as const, coordinates: [-84.43, 33.64] as [number, number] },
            properties: {
              aircraftId: 'a1b2c3',
              label: 'TEST1',
              freshness: 'current' as const,
              track: 90,
            },
          },
        ],
      },
    };
    const owner = createMapRenderer(document.createElement('div'), initial, callbacks);
    owners.push(owner);
    map.emit('load');
    const publications = map.source.setData.mock.calls.length;
    owner.update({
      ...initial,
      observations: {
        type: 'FeatureCollection',
        features: initial.observations.features.map((feature) => ({
          ...feature,
          geometry: { ...feature.geometry, coordinates: [...feature.geometry.coordinates] },
          properties: { ...feature.properties },
        })),
      },
    });
    expect(map.source.setData).toHaveBeenCalledTimes(publications);

    owner.update({
      ...initial,
      observations: {
        type: 'FeatureCollection',
        features: [
          {
            ...initial.observations.features[0]!,
            geometry: { type: 'Point', coordinates: [-84.42, 33.65] },
          },
        ],
      },
    });
    expect(map.source.setData).toHaveBeenCalledTimes(publications + 1);
  });

  it('applies a selection-only change without republishing map sources', () => {
    const owner = create();
    map.emit('load');
    const publications = map.source.setData.mock.calls.length;
    const filters = map.setFilter.mock.calls.length;
    owner.update({ ...frame, selectedId: 'a1b2c3' });
    expect(map.source.setData).toHaveBeenCalledTimes(publications);
    expect(map.setFilter).toHaveBeenCalledTimes(filters + 1);
  });

  it('reports only the newest successful data update after the map becomes idle', () => {
    const owner = create();
    map.emit('load');
    const stalePaint = vi.fn();
    const currentPaint = vi.fn();
    owner.update(frame, stalePaint);
    owner.update({ ...frame, selectedId: 'a1b2c3' }, currentPaint);
    map.emit('idle');
    expect(stalePaint).not.toHaveBeenCalled();
    expect(currentPaint).not.toHaveBeenCalled();
    animationFrame?.(0);
    expect(currentPaint).toHaveBeenCalledOnce();
    map.emit('idle');
    expect(currentPaint).toHaveBeenCalledOnce();
  });

  it.each(['error', 'webglcontextlost'])(
    'contains %s and releases resources before further updates',
    async (event) => {
      const owner = create();
      map.emit('load');
      map.emit(event);
      expect(callbacks.unavailable).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(map.remove).toHaveBeenCalledOnce();
      map.getSource.mockImplementation(() => {
        throw new Error('style was destroyed');
      });
      expect(() => owner.update(frame)).not.toThrow();
      owner.resetView();
      resizeCallback();
      expect(map.fitBounds).toHaveBeenCalledOnce();
      expect(map.resize).not.toHaveBeenCalled();
    },
  );

  it.each(['load', 'update', 'resize', 'reset', 'click'])(
    'contains a %s exception inside the map boundary',
    async (step) => {
      const owner = create();
      const fail = () => {
        throw new Error('controlled renderer failure');
      };
      if (step === 'load') map.addImage.mockImplementationOnce(fail);
      map.emit('load');
      if (step === 'update') {
        map.source.setData.mockImplementationOnce(fail);
        owner.update({
          ...frame,
          observations: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: 'a1b2c3',
                geometry: { type: 'Point', coordinates: [-84.43, 33.64] },
                properties: {
                  aircraftId: 'a1b2c3',
                  label: 'TEST1',
                  freshness: 'current',
                  track: 90,
                },
              },
            ],
          },
        });
      }
      if (step === 'resize') {
        map.resize.mockImplementationOnce(fail);
        resizeCallback();
      }
      if (step === 'reset') {
        map.fitBounds.mockImplementationOnce(fail);
        owner.resetView();
      }
      if (step === 'click') {
        map.queryRenderedFeatures.mockImplementationOnce(fail);
        map.emit('click', { point: { x: 0, y: 0 } });
      }
      expect(callbacks.unavailable).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(map.remove).toHaveBeenCalledOnce();
    },
  );

  it('selects only a nearby observed point and ignores clicks before loading or after disposal', () => {
    const owner = create();
    const event = { point: { x: 100, y: 100 } };
    map.emit('click', event);
    expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
    map.emit('load');
    map.emit('click', event);
    expect(callbacks.select).not.toHaveBeenCalled();
    map.queryRenderedFeatures.mockReturnValueOnce([
      {
        geometry: { type: 'Point', coordinates: [100, 100] },
        properties: {
          aircraftId: 'a1b2c3',
          historySequence: 7,
          providerId: 'adsb-lol',
          regionId: 'atlanta',
          feedEpoch: 'test-feed-1',
        },
      },
    ]);
    map.emit('click', event);
    expect(callbacks.select).toHaveBeenCalledExactlyOnceWith({
      mode: 'exact',
      key: {
        aircraftId: 'a1b2c3',
        sequence: 7,
        providerId: 'adsb-lol',
        regionId: 'atlanta',
        feedEpoch: 'test-feed-1',
      },
    });
    const lateClick = [...map.listeners.get('click')!][0]!;
    const lateLoad = [...map.listeners.get('load')!][0]!;
    owner.dispose();
    const queryCount = map.queryRenderedFeatures.mock.calls.length;
    lateClick(event);
    lateLoad();
    expect(callbacks.select).toHaveBeenCalledOnce();
    expect(callbacks.ready).toHaveBeenCalledOnce();
    expect(map.queryRenderedFeatures).toHaveBeenCalledTimes(queryCount);
  });
});
