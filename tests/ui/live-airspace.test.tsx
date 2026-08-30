// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveAirspaceApp } from '../../src/features/live/LiveAirspaceApp';
import { LiveServerClock } from '../../src/live/clock';
import type { LiveAirspaceClientOptions } from '../../src/live/client';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import { LiveAirspaceRuntime, type LiveAirspaceRuntimeOptions } from '../../src/live/runtime';
import type { LiveServiceInfo } from '../../src/live/service';
import { describeLiveSource } from '../../src/live/source';
import type { AirspaceSnapshot } from '../../src/live/types';
import {
  aircraftFixture,
  healthFixture,
  LIVE_FIXTURE_EPOCH,
  LIVE_FIXTURE_TIME,
  snapshotFixture,
} from '../live/fixtures';

// Map and canvas ownership have focused suites; these tests isolate feed and React composition.
vi.mock('../../src/features/live/AirspaceMap', () => ({
  AirspaceMap: () => null,
}));
vi.mock('../../src/features/live/LiveHistoryCharts', () => ({
  LiveHistoryCharts: () => null,
}));

const BASE = Date.parse(LIVE_FIXTURE_TIME);
const info: LiveServiceInfo = {
  source: describeLiveSource('local-mock', 'mock'),
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
};
let container: HTMLDivElement;
let root: Root;

function harness() {
  let elapsed = 0;
  const clients: Array<{ options: LiveAirspaceClientOptions; stop: ReturnType<typeof vi.fn> }> = [];
  const createRuntime = vi.fn(
    (options: LiveAirspaceRuntimeOptions) =>
      new LiveAirspaceRuntime({
        ...options,
        clock: new LiveServerClock({
          monotonicNow: () => elapsed,
          wallNow: () => BASE + elapsed + 86_400_000,
        }),
        clientFactory: (clientOptions) => {
          const stop = vi.fn();
          clients.push({ options: clientOptions, stop });
          return {
            stop,
            start: () => {
              clientOptions.onFeedBinding?.({
                providerId: clientOptions.providerId!,
                regionId: clientOptions.regionId,
                feedEpoch: LIVE_FIXTURE_EPOCH,
              });
              clientOptions.onStatus('open');
            },
          };
        },
      }),
  );
  const active = () => clients.at(-1)!.options;
  const sendSnapshot = (overrides: Partial<AirspaceSnapshot> = {}) =>
    active().onMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture({
        providerId: 'synthetic-test',
        regionId: active().regionId,
        ...overrides,
      }),
    });
  return {
    createRuntime,
    clients,
    active,
    load: vi.fn(async () => info),
    observe: (empty = false) => sendSnapshot(empty ? { aircraft: [] } : {}),
    sendSnapshot,
    synchronize: () =>
      active().onTimeSample?.({
        sent: { monotonicMs: elapsed, wallMs: BASE + elapsed + 86_400_000 },
        received: { monotonicMs: elapsed, wallMs: BASE + elapsed + 86_400_000 },
        serverAt: new Date(BASE + elapsed).toISOString(),
      }),
    async advance(value: number) {
      const change = value - elapsed;
      elapsed = value;
      await vi.advanceTimersByTimeAsync(change);
    },
  };
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function button(label: string) {
  const match = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

function selectControl(label: string) {
  const control = [...container.querySelectorAll('label')]
    .find((entry) => entry.textContent?.startsWith(label))
    ?.querySelector<HTMLSelectElement>('select');
  expect(control, `select ${label}`).not.toBeNull();
  return control!;
}

async function choose(label: string, value: string) {
  const control = selectControl(label);
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

describe('React-owned live airspace lifecycle and evidence', () => {
  it('shows source verification before creating a feed and cancels an unmounted bootstrap', async () => {
    let resolve!: (value: LiveServiceInfo) => void;
    let signal: AbortSignal | undefined;
    const load = (value?: AbortSignal) => {
      signal = value;
      return new Promise<LiveServiceInfo>((done) => {
        resolve = done;
      });
    };
    const createRuntime = vi.fn();
    await render(<LiveAirspaceApp loadServiceInfo={load} createRuntime={createRuntime} />);
    expect(container.textContent).toContain('Verifying the server-owned data source');
    expect(createRuntime).not.toHaveBeenCalled();
    await render(<p>Another route</p>);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(info));
    expect(container.textContent).toBe('Another route');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('does not start aircraft requests when the service disables its provider', async () => {
    const load = vi.fn(async () => ({
      ...info,
      source: describeLiveSource('production', 'disabled'),
    }));
    const createRuntime = vi.fn();
    await render(<LiveAirspaceApp loadServiceInfo={load} createRuntime={createRuntime} />);
    expect(container.textContent).toContain('Live data is disabled');
    expect(container.querySelector('.startup-state a')?.getAttribute('href')).toBe('#lab');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('reports a bootstrap failure and supports an explicit retry', async () => {
    const load = vi
      .fn<() => Promise<LiveServiceInfo>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(info);
    const state = harness();
    await render(<LiveAirspaceApp loadServiceInfo={load} createRuntime={state.createRuntime} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('No feed was started');
    expect(state.createRuntime).not.toHaveBeenCalled();
    await click('Retry service connection');
    expect(container.textContent).toContain('Synthetic integration feed');
    expect(state.clients).toHaveLength(1);
  });

  it('owns one active client after Strict Mode remount and rejects disposed callbacks', async () => {
    const state = harness();
    await render(
      <StrictMode>
        <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />
      </StrictMode>,
    );
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(state.clients[1]!.stop).not.toHaveBeenCalled();
    await act(async () => {
      state.clients[0]!.options.onError?.('OBSOLETE CALLBACK');
      state.observe();
    });
    expect(container.textContent).not.toContain('OBSOLETE CALLBACK');
    expect(container.querySelector('[data-freshness="current"]')).toBeNull();
    expect(container.textContent).toContain('Time uncertain');
    await act(async () => state.synchronize());
    expect(container.querySelectorAll('tbody [data-freshness="current"]')).toHaveLength(1);
    await render(<p>Route closed</p>);
    expect(state.clients[1]!.stop).toHaveBeenCalledOnce();
  });

  it('presents compact live evidence and keeps regional data quality separate from aircraft state', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.sendSnapshot({
        aircraft: [
          aircraftFixture({
            position: undefined,
            lastPositionAt: undefined,
            positionAgeSeconds: undefined,
            qualityFlags: ['missing-position'],
          }),
        ],
      });
      state.synchronize();
    });

    const evidence = container.querySelector('section[aria-label="Live session evidence"]')!;
    expect(evidence.textContent).toContain('Source');
    expect(evidence.textContent).toContain('synthetic-test');
    expect(evidence.textContent).toContain('Transport');
    expect(evidence.textContent).toContain('Connected');
    expect(evidence.textContent).toContain('Feed state');
    expect(evidence.textContent).toContain('Live');
    expect(evidence.textContent).toContain('Backend receipt age');
    expect(evidence.textContent).toContain('At most 1 s');
    expect(evidence.textContent).toContain('1 received, 0 positioned');
    const epoch = evidence.querySelector('.feed-epoch');
    expect(epoch?.getAttribute('title')).toBe('test-feed-1');
    expect(epoch?.querySelector('.sr-only')?.textContent).toBe('test-feed-1');
    expect(epoch?.querySelector('[aria-hidden="true"]')?.textContent).toBe('test-feed-1');

    const ledger = container.querySelector('.session-quality-ledger')!;
    expect(ledger.textContent).toContain('Regional session quality');
    expect(ledger.textContent).toContain('Missing position');
    expect(ledger.textContent).toContain('LIVE-DQ-003');
    expect(ledger.textContent).toContain('Region atlanta');
    expect(ledger.textContent).toContain('Aircraft A1B2C3');
    expect(ledger.textContent).toContain(
      'They do not describe aircraft condition, maintenance, or safety.',
    );

    await click('TEST123');
    expect(container.querySelectorAll('.session-quality-ledger')).toHaveLength(1);
    expect(container.querySelector('.session-quality-ledger')?.textContent).toContain(
      'Regional session quality',
    );
  });

  it.each([
    [14_000, 'current'],
    [16_000, 'delayed'],
    [46_000, 'stale'],
    [121_000, 'expired'],
  ] as const)(
    'renders measured aging at %i milliseconds without a new snapshot',
    async (elapsed, freshness) => {
      const state = harness();
      await render(
        <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
      );
      await act(async () => {
        state.observe();
        state.synchronize();
      });
      await act(async () => {
        await state.advance(elapsed);
        state.synchronize();
      });
      if (freshness === 'expired') {
        expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
        expect(container.textContent).toContain('No matching observations');
      } else
        expect(container.querySelectorAll(`tbody [data-freshness="${freshness}"]`)).toHaveLength(1);
      expect(container.querySelector('.transport-status')?.textContent).toBe('Connected');
    },
  );

  it('supports selection, filtering, region changes, pause and a fresh resume', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.observe();
      state.synchronize();
    });
    await click('TEST123');
    expect(container.querySelector('#selected-title')?.textContent).toBe('TEST123');
    expect(container.querySelector('.timing-evidence')?.textContent).toContain('Backend receipt');
    await click('Close selected track');
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'nothing',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    const region = container.querySelector('select')!;
    await act(async () => {
      region.value = 'central-georgia';
      region.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(state.active().regionId).toBe('central-georgia');
    expect(search.value).toBe('');
    expect(container.textContent).toContain('Central Georgia airspace');
    await act(async () => {
      state.observe();
      state.synchronize();
    });
    await click('Pause feed');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(button('Reconnect').disabled).toBe(true);
    await click('Resume feed');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    await click('Reconnect');
    expect(state.clients).toHaveLength(4);
  });

  it('links exact receipt evidence and retains bounded history after a track departs', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.observe();
      state.synchronize();
      await state.advance(10_000);
      const observedAt = new Date(BASE + 10_000).toISOString();
      state.sendSnapshot({
        sequence: 2,
        generatedAt: observedAt,
        providerGeneratedAt: observedAt,
        aircraft: [
          aircraftFixture({
            position: { latitude: 33.7, longitude: -84.3 },
            barometricAltitudeFeet: 13_000,
            groundSpeedKnots: 340,
            observedAt,
            lastContactAt: observedAt,
            lastPositionAt: observedAt,
          }),
        ],
      });
      state.synchronize();
    });

    const track = button('TEST123');
    track.focus();
    await act(async () => track.click());
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(2);
    await click('#1');
    expect(container.querySelector('#receipt-inspection-title')?.textContent).toBe(
      'Exact receipt #1',
    );
    const receipt = container.querySelector('.receipt-inspection')!;
    expect(receipt.textContent).toContain('Backend receipt');
    expect(receipt.textContent).toContain('Provider snapshot');
    expect(receipt.textContent).toContain('Position observed');
    expect(receipt.textContent).toContain('Measurements observed');
    expect(receipt.textContent).toContain('12,000 ft');
    expect(container.querySelector('.freshness')?.textContent).toContain('Latest regional track');
    const measurements = receipt.querySelector<HTMLDListElement>('.selected-measurements')!;
    expect(measurements.getAttribute('aria-label')).toBe('Exact receipt 1 measurements');
    expect([...measurements.querySelectorAll('dt')].map((entry) => entry.textContent)).toEqual([
      'Barometric altitude',
      'Ground speed',
      'Vertical rate',
      'Ground state',
      'Latitude',
      'Longitude',
    ]);
    const timing = receipt.querySelector('.timing-evidence')!;
    expect(measurements.compareDocumentPosition(timing) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      container.querySelector('.history-table tr[data-selected="true"]')?.textContent,
    ).toContain('#1');

    await act(async () => {
      await state.advance(20_000);
      const receivedAt = new Date(BASE + 20_000).toISOString();
      state.sendSnapshot({
        sequence: 3,
        generatedAt: receivedAt,
        providerGeneratedAt: receivedAt,
        aircraft: [],
      });
      state.synchronize();
    });
    expect(container.querySelectorAll('.observation-panel tbody tr')).toHaveLength(0);
    expect(container.textContent).toContain('not in the current regional picture');
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(2);
    expect(container.querySelector('#receipt-inspection-title')?.textContent).toBe(
      'Exact receipt #1',
    );

    await act(async () => {
      await state.advance(910_001);
      state.synchronize();
    });
    expect(container.querySelector('#receipt-inspection-title')?.textContent).toBe(
      'Exact receipt #1',
    );
    expect(container.querySelector('.receipt-inspection [role="status"]')?.textContent).toContain(
      'This exact receipt is no longer retained',
    );
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(0);
    expect(container.querySelector('.receipt-inspection .timing-evidence')).toBeNull();
  });

  it('wires all observation filters and stable sortable headers', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.sendSnapshot({
        aircraft: [
          aircraftFixture(),
          aircraftFixture({
            aircraftId: 'b1b2c3',
            callsign: 'GROUND1',
            barometricAltitudeFeet: 0,
            groundSpeedKnots: 20,
            onGround: true,
          }),
          aircraftFixture({
            aircraftId: 'c1c2c3',
            callsign: 'HIGH300',
            position: undefined,
            lastPositionAt: undefined,
            positionAgeSeconds: undefined,
            barometricAltitudeFeet: 30_000,
            groundSpeedKnots: 500,
            onGround: false,
            qualityFlags: ['missing-position'],
          }),
        ],
      });
      state.synchronize();
    });

    await choose('Altitude band', 'above-25000');
    expect(
      [...container.querySelectorAll('.aircraft-link')].map((entry) => entry.textContent),
    ).toEqual(['HIGH300']);
    await choose('Altitude band', 'all');
    await choose('Ground state', 'ground');
    expect(
      [...container.querySelectorAll('.aircraft-link')].map((entry) => entry.textContent),
    ).toEqual(['GROUND1']);
    await choose('Ground state', 'all');

    const positioned = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => positioned.click());
    expect(container.querySelectorAll('.aircraft-link')).toHaveLength(2);
    await act(async () => positioned.click());

    await click('Ground speed knots');
    expect(
      [...container.querySelectorAll('.aircraft-link')].map((entry) => entry.textContent),
    ).toEqual(['GROUND1', 'TEST123', 'HIGH300']);
    await click('Ground speed knots');
    expect(
      [...container.querySelectorAll('.aircraft-link')].map((entry) => entry.textContent),
    ).toEqual(['HIGH300', 'TEST123', 'GROUND1']);
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain(
      'Ground speed',
    );
  });

  it('distinguishes a valid empty source response from source failure', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.observe(true);
      state.synchronize();
    });
    expect(container.textContent).toContain(
      'The source responded successfully with no aircraft observations',
    );
    expect(container.textContent).toContain('No aircraft reported');
    await act(async () => state.active().onError?.('Synthetic outage'));
    expect(container.querySelector('.feed-notice')?.textContent).toContain(
      'temporarily unavailable',
    );
  });

  it('retains bounded evidence through reconnecting, offline and rejected-message states', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.observe();
      state.synchronize();
    });
    await click('TEST123');

    await act(async () => state.active().onStatus('reconnecting'));
    expect(container.querySelector('.transport-status')?.textContent).toBe('Reconnecting');
    expect(container.querySelectorAll('.observation-panel tbody tr')).toHaveLength(1);
    expect(container.querySelector('#selected-title')?.textContent).toBe('TEST123');

    await act(async () =>
      state.active().onProtocolError?.(['snapshot provider binding did not match'], {}),
    );
    expect(container.querySelector('.feed-notice')?.textContent).toContain(
      'temporarily unavailable',
    );
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(1);

    await act(async () => state.active().onStatus('offline'));
    expect(container.querySelector('.transport-status')?.textContent).toBe('Disconnected');
    expect(container.querySelectorAll('.observation-panel tbody tr')).toHaveLength(1);
    expect(container.querySelector('#selected-title')?.textContent).toBe('TEST123');
    expect(container.querySelector('.investigation-boundary')?.textContent).toContain(
      'does not infer a route, schedule, destination, owner, aircraft health or future position',
    );

    await act(async () => state.active().onStatus('open'));
    expect(container.querySelector('.transport-status')?.textContent).toBe('Connected');
    expect(container.querySelector('.feed-notice')).toBeNull();
    expect(container.querySelector('#selected-title')?.textContent).toBe('TEST123');
  });

  it.each(['waiting', 'backoff', 'blocked'] as const)(
    'displays the server %s state without promising an automatic recovery',
    async (mode) => {
      const state = harness();
      await render(
        <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
      );
      const retryAt = '2026-08-27T12:05:00.000Z';
      const message =
        mode === 'blocked'
          ? 'Automatic polling is paused because no safe retry deadline is available.'
          : mode === 'waiting'
            ? 'No observation is cached in this runtime; waiting for the shared polling deadline.'
            : 'Live provider backoff is active; retry is scheduled.';
      await act(async () => {
        state.active().onMessage({
          type: 'feed.health',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          health: healthFixture({
            providerId: 'synthetic-test',
            status: mode === 'waiting' ? 'connecting' : 'degraded',
            message,
            ...(mode === 'blocked' ? {} : { retryAt }),
          }),
        });
      });
      const notice = container.querySelector('.feed-notice');
      expect(notice?.textContent).toContain(message);
      expect(notice?.textContent).not.toContain('recovery is automatic');
      if (mode === 'blocked') {
        expect(notice?.querySelector('time')).toBeNull();
        expect(notice?.textContent).not.toContain('Next shared attempt');
      } else {
        expect(notice?.querySelector('time')?.dateTime).toBe(retryAt);
        expect(notice?.textContent).toContain('Next shared attempt no earlier than');
      }
      expect(state.clients).toHaveLength(1);
    },
  );

  it('clears evidence on pagehide and resynchronizes after a persisted page restore', async () => {
    const state = harness();
    await render(
      <LiveAirspaceApp loadServiceInfo={state.load} createRuntime={state.createRuntime} />,
    );
    await act(async () => {
      state.observe();
      state.synchronize();
    });
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(event));
    expect(state.clients).toHaveLength(2);
    await act(async () => state.observe());
    expect(container.querySelectorAll('tbody [data-freshness="current"]')).toHaveLength(0);
    await act(async () => state.synchronize());
    expect(container.querySelectorAll('tbody [data-freshness="current"]')).toHaveLength(1);
  });
});
