// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvidenceBuildIdentity, EvidenceOperations } from '../../src/evidence/types';
import { EvidenceApp } from '../../src/features/evidence/EvidenceApp';
import type { OperationsProviderState, RegionOperations } from '../../src/operations/contract';
import { operationsFixture, OPERATIONS_CHECKED_AT } from '../support/operationsFixture';

const buildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'local-mock',
});

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

function withProviderState(state: OperationsProviderState): EvidenceOperations {
  const base = operationsFixture();
  const reason = {
    live: 'PROVIDER_LIVE',
    degraded: 'PROVIDER_DEGRADED',
    disabled: 'PROVIDER_DISABLED',
    connecting: 'PROVIDER_CONNECTING',
    empty: 'PROVIDER_EMPTY',
    'rate-limited': 'PROVIDER_RATE_LIMITED',
    retrying: 'PROVIDER_RETRYING',
    unavailable: 'PROVIDER_UNAVAILABLE',
  } as const;
  const regions = [
    { ...base.regions[0], provider: { state, reasonCodes: [reason[state]] } },
    base.regions[1],
    base.regions[2],
  ] as const satisfies readonly [RegionOperations, RegionOperations, RegionOperations];
  return { ...base, regions };
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

describe('Evidence workspace', () => {
  it('renders truthful static evidence without making an automatic request', async () => {
    const loadOperations = vi.fn(async () => operationsFixture());
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);

    expect(loadOperations).not.toHaveBeenCalled();
    expect(container.querySelector('main#evidence-main')).not.toBeNull();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('nav[aria-label="Evidence chain"] ol')).not.toBeNull();
    expect(container.querySelectorAll('section[aria-labelledby]')).toHaveLength(5);
    expect(container.querySelectorAll('table caption')).toHaveLength(2);
    expect(container.textContent).toContain('No operational request has been made');
    expect(container.textContent).toContain('ADSB.lol · ODbL 1.0');
    expect(container.textContent).toContain('Session-only observation detail');
    expect(container.textContent).toContain('Implementation, execution, and release gate ledger');
    expect(container.textContent).toContain('No exact v3 artifact');
  });

  it('does not call fetch when the default Evidence route opens', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await render(<EvidenceApp buildIdentity={buildIdentity} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a static-only offline boundary with no health action or loader use', async () => {
    const loadOperations = vi.fn(async () => operationsFixture());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await render(
      <EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} staticOnly />,
    );

    expect(container.querySelector('[data-health-state="static-only"]')).not.toBeNull();
    expect(container.querySelectorAll('.evidence-health-actions')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(loadOperations).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Bundled build and schema identity');
    expect(container.textContent).toContain('Regional map identity and licenses');
    expect(container.textContent).toContain('Release gates');
  });

  it('runs one explicit operations check and renders every bounded contract section', async () => {
    const projection = operationsFixture();
    const loadOperations = vi.fn(async () => projection);
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
    await act(async () => button('Check service health once').click());

    expect(loadOperations).toHaveBeenCalledOnce();
    expect(loadOperations).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(container.querySelector('[data-health-state="available"]')).not.toBeNull();
    expect(container.querySelector('.evidence-health-announcement')?.textContent).toContain(
      'Application state is Available',
    );
    expect(container.textContent).toContain('Synthetic integration feed');
    expect(container.textContent).toContain(OPERATIONS_CHECKED_AT);
    expect(container.textContent).toContain('PROVIDER_LIVE');
    expect(container.textContent).toContain('DELIVERY_HEALTHY');
    expect(container.textContent).toContain('FRESHNESS_CURRENT');
    expect(container.textContent).toContain('Worker-isolate admission counters');
    expect(container.textContent).toContain('Acknowledgments');
    expect(container.textContent).toContain('Rate-limit rejections');
    expect(container.textContent).toContain('No global availability percentage');
    expect(container.querySelectorAll('.evidence-health-table tbody tr')).toHaveLength(3);
  });

  it.each(['empty', 'rate-limited', 'disabled', 'retrying'] as const)(
    'renders the provider %s classification as semantic text and a reason code',
    async (state) => {
      const loadOperations = vi.fn(async () => withProviderState(state));
      await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
      await act(async () => button('Check service health once').click());

      expect(container.querySelector(`[data-status="${state}"]`)?.textContent).toBe(
        statusText(state),
      );
      expect(container.textContent).toContain(`PROVIDER_${state.replace('-', '_').toUpperCase()}`);
    },
  );

  it('distinguishes partial regions, unavailable application, stale data, and degraded delivery', async () => {
    const base = operationsFixture();
    const partial: EvidenceOperations = {
      ...base,
      application: { state: 'partial', reasonCodes: ['APPLICATION_PARTIAL_REGIONS'] },
      regions: [
        {
          ...base.regions[0],
          freshness: {
            state: 'stale',
            reasonCodes: ['FRESHNESS_STALE'],
            observationAgeSeconds: 90,
          },
          delivery: {
            state: 'degraded',
            reasonCodes: ['DELIVERY_DEGRADED_TIMEOUTS'],
          },
        },
        base.regions[1],
        {
          ...base.regions[2],
          availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
          provider: { state: 'unavailable', reasonCodes: ['PROVIDER_UNAVAILABLE'] },
          delivery: { state: 'unavailable', reasonCodes: ['DELIVERY_UNAVAILABLE'] },
          freshness: {
            state: 'unavailable',
            reasonCodes: ['FRESHNESS_UNAVAILABLE'],
            observationAgeSeconds: null,
          },
          windows: null,
        },
      ],
    };
    const loadOperations = vi.fn(async () => partial);
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
    await act(async () => button('Check service health once').click());

    expect(container.textContent).toContain('APPLICATION_PARTIAL_REGIONS');
    expect(container.textContent).toContain('FRESHNESS_STALE');
    expect(container.textContent).toContain('DELIVERY_DEGRADED_TIMEOUTS');
    expect(container.textContent).toContain('REGION_READ_UNAVAILABLE');

    const unavailableRegion = (region: Readonly<RegionOperations>): RegionOperations => ({
      ...region,
      availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
    });
    const unavailable: EvidenceOperations = {
      ...partial,
      application: { state: 'unavailable', reasonCodes: ['APPLICATION_UNAVAILABLE'] },
      regions: [
        unavailableRegion(partial.regions[0]),
        unavailableRegion(partial.regions[1]),
        unavailableRegion(partial.regions[2]),
      ],
    };
    await render(
      <EvidenceApp buildIdentity={buildIdentity} loadOperations={vi.fn(async () => unavailable)} />,
    );
    await act(async () => button('Check service health once').click());
    expect(container.textContent).toContain('APPLICATION_UNAVAILABLE');
  });

  it('keeps static evidence visible when operations are unavailable', async () => {
    const loadOperations = vi.fn(async () => {
      throw new Error('offline');
    });
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
    await act(async () => button('Check service health once').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Operational health unavailable',
    );
    expect(container.textContent).toContain('Bundled build and schema identity');
    expect(container.textContent).toContain('Regional map identity and licenses');
    expect(container.textContent).toContain('Release gates');
  });

  it('rejects a response that does not match the static build identity', async () => {
    const projection = operationsFixture();
    const loadOperations = vi.fn(async () => ({
      ...projection,
      identity: { ...projection.identity, releaseSha: 'b'.repeat(40) },
    }));
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
    await act(async () => button('Check service health once').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'did not match this build identity',
    );
  });

  it('aborts an in-flight operations request when the route unmounts', async () => {
    let signal: AbortSignal | undefined;
    const loadOperations = vi.fn(
      (requestSignal?: AbortSignal) =>
        new Promise<EvidenceOperations>(() => {
          signal = requestSignal;
        }),
    );
    await render(<EvidenceApp buildIdentity={buildIdentity} loadOperations={loadOperations} />);
    await act(async () => button('Check service health once').click());
    expect(signal?.aborted).toBe(false);

    await render(<p>Another route</p>);
    expect(signal?.aborted).toBe(true);
  });

  it('distinguishes an explicitly supplied exact release identity', async () => {
    await render(
      <EvidenceApp
        buildIdentity={{
          applicationVersion: '3.0.0',
          releaseSha: 'abc1234',
          releaseStatus: 'exact-release',
          buildTarget: 'production',
        }}
        loadOperations={vi.fn(async () => operationsFixture())}
      />,
    );
    expect(container.querySelector('[data-release-status="exact-release"]')?.textContent).toContain(
      'Exact release identity supplied',
    );
    expect(container.textContent).not.toContain('No published v3 release');
  });
});

function statusText(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
