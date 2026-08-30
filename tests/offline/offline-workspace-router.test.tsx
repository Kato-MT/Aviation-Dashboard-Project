// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';
import { LabSessionOwner } from '../../src/features/lab/owner';
import { labSubviewMetadata, type LabSubview } from '../../src/features/lab/routes';
import {
  OfflineWorkspaceRouter,
  offlineWorkspaceFromHash,
  offlineWorkspaceRouteFromHash,
} from '../../src/features/offline/OfflineWorkspaceRouter';

const buildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'offline',
});

const views = vi.hoisted(() => ({
  replay: vi.fn(),
  lab: vi.fn(),
  evidence: vi.fn(),
}));

vi.mock('../../src/features/replay/ReplayApp', () => ({ ReplayApp: () => views.replay() }));
vi.mock('../../src/features/lab/LabApp', () => ({ LabApp: (props: unknown) => views.lab(props) }));
vi.mock('../../src/features/evidence/EvidenceApp', () => ({
  EvidenceApp: (props: unknown) => views.evidence(props),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState({}, '', '/index.html');
  views.replay.mockReturnValue(<main id="replay-main">Replay workspace</main>);
  views.lab.mockReturnValue(<main id="lab-main">Lab workspace</main>);
  views.evidence.mockReturnValue(<main id="evidence-main">Evidence workspace</main>);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode = <OfflineWorkspaceRouter buildIdentity={buildIdentity} />) {
  await act(async () => root.render(node));
}

async function navigate(hash: string) {
  await act(async () => {
    history.replaceState({}, '', `/index.html${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

function mainText(): string | null | undefined {
  return container.querySelector('main')?.textContent;
}

describe('standalone offline workspace routing', () => {
  it.each(['', '#live', '#airspace-main', '#unknown'])(
    'resolves %s to the safe Live boundary',
    (hash) => {
      expect(offlineWorkspaceFromHash(hash)).toBe('live');
    },
  );

  it.each(['#replay', '#replay-main', '#replay-event-3'])('resolves %s to Replay', (hash) => {
    expect(offlineWorkspaceFromHash(hash)).toBe('replay');
  });

  it.each([
    '#lab',
    '#lab-main',
    '#lab-monitor',
    '#lab-diagnostics',
    '#lab-verification',
    '#lab-investigation',
    '#lab-campaign',
    '#lab-configuration',
  ])('resolves %s to the Lab', (hash) => {
    expect(offlineWorkspaceFromHash(hash)).toBe('lab');
  });

  it.each(['#evidence', '#evidence-main', '#evidence-map', '#source-evidence'])(
    'resolves %s to Evidence',
    (hash) => expect(offlineWorkspaceFromHash(hash)).toBe('evidence'),
  );

  it('opens on a truthful unavailable view without mounting a network workspace', async () => {
    await render();

    expect(mainText()).toContain('Live Airspace is unavailable offline');
    expect(mainText()).toContain('no capability to open that feed');
    expect(document.title).toBe('Live Airspace unavailable | Flight Diagnostics Workbench');
    expect(container.querySelector('.development-label')?.textContent).toBe(
      'Self-contained offline package',
    );
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#airspace-main');
    expect(views.replay).not.toHaveBeenCalled();
    expect(views.lab).not.toHaveBeenCalled();
    expect(views.evidence).not.toHaveBeenCalled();
  });

  it('retains one Lab owner across every subview and suppresses the unbundled v2 link', async () => {
    history.replaceState({}, '', '/index.html#lab-monitor');
    await render();

    const first = views.lab.mock.calls.at(-1)![0] as {
      owner: LabSessionOwner;
      subview: LabSubview;
      legacyOracleHref: string | null;
    };
    expect(first.subview).toBe('monitor');
    expect(first.legacyOracleHref).toBeNull();
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#lab-main');

    for (const subview of Object.keys(labSubviewMetadata) as LabSubview[]) {
      await navigate(labSubviewMetadata[subview].hash);
      const props = views.lab.mock.calls.at(-1)![0] as {
        owner: LabSessionOwner;
        subview: LabSubview;
      };
      expect(props.owner).toBe(first.owner);
      expect(props.subview).toBe(subview);
      expect(document.title).toBe(labSubviewMetadata[subview].documentTitle);
    }

    await navigate('#lab-main');
    expect((views.lab.mock.calls.at(-1)![0] as { subview: LabSubview }).subview).toBe(
      'configuration',
    );
    expect(document.title).toBe(labSubviewMetadata.configuration.documentTitle);
    await navigate('#replay');
    await navigate('#lab');
    expect((views.lab.mock.calls.at(-1)![0] as { owner: LabSessionOwner }).owner).toBe(first.owner);
  });

  it('passes only static evidence capability and updates navigation, title, and skip anchor', async () => {
    await render();
    await navigate('#replay');
    expect(mainText()).toBe('Replay workspace');
    expect(document.title).toBe('Synthetic Replay | Flight Diagnostics Workbench');
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#replay-main');

    await navigate('#evidence');
    expect(mainText()).toBe('Evidence workspace');
    expect(views.evidence).toHaveBeenCalledWith({ buildIdentity, staticOnly: true });
    expect(document.title).toBe('Evidence | Flight Diagnostics Workbench');
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#evidence-main');
  });

  it('stops the retained Lab owner on pagehide and unmount', async () => {
    const stop = vi.spyOn(LabSessionOwner.prototype, 'stop');
    await render();
    await act(async () =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(stop).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it('contains a route render failure without starting a network fallback', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    views.replay.mockImplementation(() => {
      throw new Error('controlled offline Replay failure');
    });
    history.replaceState({}, '', '/index.html#replay');
    await render();

    expect(mainText()).toContain('Offline workspace unavailable');
    expect(mainText()).toContain('No fallback network capability was started');
    expect(container.querySelector('.workspace-recovery-links a')?.getAttribute('href')).toBe(
      '#live',
    );
    await navigate('#evidence');
    expect(mainText()).toBe('Evidence workspace');
    expect(consoleError).toHaveBeenCalled();
  });

  it('preserves an active Lab subview for accessibility anchors', () => {
    expect(offlineWorkspaceRouteFromHash('#lab-main', 'investigation')).toEqual({
      workspace: 'lab',
      labSubview: 'investigation',
    });
    expect(offlineWorkspaceRouteFromHash('#lab-campaign')).toEqual({
      workspace: 'lab',
      labSubview: 'campaign',
    });
  });
});
