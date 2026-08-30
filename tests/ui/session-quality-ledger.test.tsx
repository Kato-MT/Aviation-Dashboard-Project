// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionQualityLedger } from '../../src/features/live/SessionQualityLedger';
import type { LiveQualityEvent } from '../../src/live/types';

let container: HTMLDivElement;
let root: Root;

function qualityEvent(
  sequence: number,
  overrides: Partial<LiveQualityEvent> = {},
): LiveQualityEvent {
  return {
    code: 'LIVE-DQ-001',
    regionId: 'atlanta',
    aircraftId: `test0${sequence}`,
    timestamp: `2026-08-29T12:00:0${sequence}.000Z`,
    message: `Quality transition ${sequence}`,
    kind: 'stale-contact',
    ...overrides,
  };
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('SessionQualityLedger', () => {
  it('shows a clear regional-session boundary and an explicit empty state', async () => {
    await render(<SessionQualityLedger events={[]} />);

    const section = container.querySelector('section');
    const heading = container.querySelector('h3');
    expect(heading?.textContent).toBe('Regional session quality');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(container.textContent).toContain(
      'These events describe the quality of data received in this regional browser session.',
    );
    expect(container.textContent).toContain(
      'They do not describe aircraft condition, maintenance, or safety.',
    );
    expect(container.textContent).toContain(
      'No quality transitions recorded in this browser session.',
    );
    expect(container.querySelector('ol')).toBeNull();
  });

  it('orders events newest first and caps the visible ledger at five', async () => {
    const events = [1, 6, 3, 5, 2, 4].map((sequence) => qualityEvent(sequence));
    await render(<SessionQualityLedger events={events} />);

    const rows = [...container.querySelectorAll('.quality-event')];
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
      'Quality transition 6',
      'Quality transition 5',
      'Quality transition 4',
      'Quality transition 3',
      'Quality transition 2',
    ]);
    expect(container.textContent).not.toContain('Quality transition 1');
    expect(container.querySelector('.investigation-section-heading span')?.textContent).toBe(
      '5 latest',
    );
  });

  it('renders visible kind, code, region, aircraft, message, and accessible time evidence', async () => {
    const event = qualityEvent(1, {
      code: 'LIVE-DQ-004',
      regionId: 'central-georgia',
      aircraftId: 'a1b2c3',
      timestamp: '2026-08-29T14:32:18.000Z',
      message: 'Provider time moved backward relative to the previous snapshot.',
      kind: 'provider-time-regression',
    });
    await render(<SessionQualityLedger events={[event]} />);

    expect(container.querySelector('.quality-event-kind')?.textContent).toBe(
      'Provider time regression',
    );
    expect(container.querySelector('code')?.textContent).toBe('LIVE-DQ-004');
    expect(container.textContent).toContain('Region central-georgia');
    expect(container.textContent).toContain('Aircraft A1B2C3');
    expect(container.textContent).toContain(event.message);
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(event.timestamp);
    expect(time?.textContent).toBe('2026-08-29 14:32:18.000 UTC');
    expect(container.querySelector('.quality-event')?.getAttribute('data-quality-kind')).toBe(
      'provider-time-regression',
    );
  });

  it('omits the aircraft metadata for a region-wide event and labels every event kind in text', async () => {
    const kinds: ReadonlyArray<
      readonly [LiveQualityEvent['kind'], LiveQualityEvent['code'], string]
    > = [
      ['stale-contact', 'LIVE-DQ-001', 'Stale contact'],
      ['stale-position', 'LIVE-DQ-002', 'Stale position'],
      ['missing-position', 'LIVE-DQ-003', 'Missing position'],
      ['provider-time-regression', 'LIVE-DQ-004', 'Provider time regression'],
      ['upstream-degraded', 'LIVE-DQ-005', 'Upstream degraded'],
      ['time-uncertain', 'LIVE-DQ-006', 'Time uncertain'],
    ];

    for (const [kind, code, label] of kinds) {
      await render(
        <SessionQualityLedger
          events={[
            qualityEvent(1, {
              kind,
              code,
              aircraftId: undefined,
            }),
          ]}
        />,
      );
      expect(container.querySelector('.quality-event-kind')?.textContent).toBe(label);
      expect(container.textContent).not.toContain('Aircraft ');
    }
  });
});
