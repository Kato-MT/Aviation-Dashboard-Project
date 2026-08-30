// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayApp } from '../../src/features/replay/ReplayApp';
import {
  BUNDLED_REPLAY_SCENARIOS,
  loadBundledReplayScenario,
  type ReplayScenarioId,
  type ValidatedReplayManifest,
} from '../../src/replay';

vi.mock('../../src/features/live/AirspaceMap', () => ({ AirspaceMap: () => null }));
vi.mock('../../src/features/live/LiveHistoryCharts', () => ({
  LiveHistoryCharts: () => null,
}));

let root: Root;
let container: HTMLDivElement;
const manifests = new Map<ReplayScenarioId, ValidatedReplayManifest>();

beforeAll(async () => {
  for (const scenario of BUNDLED_REPLAY_SCENARIOS) {
    manifests.set(scenario.id, await loadBundledReplayScenario(scenario.id, scenario.defaultSeed));
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Synthetic Replay must not fetch an observation service.');
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function loader() {
  return vi.fn(async (id: ReplayScenarioId) => manifests.get(id)!);
}

async function render(loadScenario = loader()) {
  await act(async () => {
    root.render(<ReplayApp loadScenario={loadScenario} />);
    await Promise.resolve();
  });
  expect(container.querySelector('#replay-main')).not.toBeNull();
  return loadScenario;
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

function select(label: string) {
  const control = [...container.querySelectorAll('label')]
    .find((entry) => entry.textContent?.startsWith(label))
    ?.querySelector<HTMLSelectElement>('select');
  expect(control, `select ${label}`).not.toBeNull();
  return control!;
}

async function choose(label: string, value: string) {
  const control = select(label);
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Synthetic Replay A+B workspace', () => {
  it('loads an explicitly synthetic, digest-identified scenario without Live requests', async () => {
    const loadScenario = await render();

    expect(loadScenario).toHaveBeenCalledWith('provider-outage-recovery', 20_260_830);
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('.replay-source-banner')?.textContent).toContain(
      'Wholly fictional observations',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Provider outage and recovery');
    expect(container.querySelector('.replay-identity')?.textContent).toContain(
      'SYNTHETIC UNCLASSIFIED',
    );
    expect(container.querySelectorAll('.replay-event-strip li')).toHaveLength(
      manifests.get('provider-outage-recovery')!.events.length,
    );
    expect(container.querySelector('.static-control')?.textContent).toBe('Atlanta');
    expect(container.querySelector('.replay-playback-status')?.textContent).toBe('Paused');
  });

  it('plays, pauses, changes speed, seeks deterministically, and releases its one timer', async () => {
    await render();
    await click('Play replay');
    expect(button('Pause replay')).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    await click('Pause replay');
    expect(vi.getTimerCount()).toBe(0);
    await choose('Playback speed', '4');
    expect(select('Playback speed').value).toBe('4');

    const range = container.querySelector<HTMLInputElement>('#replay-position')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        range,
        '90000',
      );
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.replay-current-event')?.textContent).toContain(
      'Synthetic outage',
    );
    expect(container.querySelector('.replay-current-event')?.textContent).toContain('offline');
    expect(container.querySelector('.replay-notice')?.textContent).toContain(
      'This state does not imply an aircraft fault',
    );
  });

  it('keeps table and exact receipt investigation linked while seeking event evidence', async () => {
    await render();
    await click('KEEP1');
    expect(container.querySelector('.selection-panel h2')?.textContent).toBe('KEEP1');
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(1);

    const eventButton = [...container.querySelectorAll('.replay-event-strip button')].find(
      (entry) => entry.textContent?.includes('Aircraft departs before outage'),
    );
    expect(eventButton).toBeDefined();
    await act(async () => (eventButton as HTMLButtonElement).click());
    expect(container.querySelector('.selection-panel h2')?.textContent).toBe('KEEP1');
    expect(container.querySelectorAll('.history-table tbody tr')).toHaveLength(2);
    expect(container.querySelector('.replay-current-event')?.textContent).toContain(
      'Aircraft departs before outage',
    );
  });

  it('loads a new scenario and seed only after explicit form submission', async () => {
    const loadScenario = await render();
    await choose('Scenario', 'data-quality-gaps');
    expect(loadScenario).toHaveBeenCalledTimes(1);
    await act(async () => {
      container
        .querySelector('.replay-configuration form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(loadScenario).toHaveBeenLastCalledWith('data-quality-gaps', 20_260_829);
    expect(container.querySelector('h1')?.textContent).toBe(
      'Observation quality and ordering gaps',
    );
    expect(container.querySelector('.replay-current-event')?.textContent).toContain(
      'Quality scenario begins',
    );
  });

  it('fails closed when a bundled scenario cannot be validated', async () => {
    const loadScenario = vi.fn(async () => {
      throw new Error('controlled invalid fixture');
    });
    await render(loadScenario);
    expect(container.querySelector('h1')?.textContent).toBe('Replay could not be validated');
    expect(container.textContent).toContain('No replay state was created');
    expect(fetch).not.toHaveBeenCalled();
  });
});
