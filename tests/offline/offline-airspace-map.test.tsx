// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AircraftState } from '../../src/live/types';
import { AirspaceMap } from '../../src/features/offline/OfflineAirspaceMap';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal(
    'WebSocket',
    vi.fn(() => {
      throw new Error('Offline map must not construct a socket.');
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('offline AirspaceMap replacement', () => {
  it('keeps Replay evidence usable without a renderer, assets, or network capability', async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <AirspaceMap
          aircraft={[{} as AircraftState]}
          time={undefined}
          regionId="replay-atlanta"
          selectedId="abc123"
          selectedHistorySequence={4}
          selectedHistory={undefined}
          binding={undefined}
          onSelect={onSelect}
        />,
      ),
    );

    expect(container.querySelector('[data-offline-map]')).not.toBeNull();
    expect(container.querySelector('.airspace-map')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '1 synthetic observation remains',
    );
    expect(container.textContent).toContain('selected ABC123');
    expect(container.textContent).toContain('Use the observation table to select a track');
    expect(onSelect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it('contains no map renderer or request implementation in its source boundary', async () => {
    const source = await readFile('src/features/offline/OfflineAirspaceMap.tsx', 'utf8');
    expect(source).not.toContain('mapRenderer');
    expect(source).not.toContain('maplibre');
    expect(source).not.toContain('pmtiles');
    expect(source).not.toContain('/map-assets/');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('WebSocket');
  });
});
