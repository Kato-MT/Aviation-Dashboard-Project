// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceRouter,
  workspaceFromHash,
  workspaceRouteFromHash,
} from '../../src/features/workbench/WorkspaceRouter';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';

const buildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  releaseStatus: 'unreleased',
  buildTarget: 'local-mock',
});

const views = vi.hoisted(() => ({
  live: vi.fn(),
  replay: vi.fn(),
  lab: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock('../../src/features/live/LiveAirspaceApp', () => ({ LiveAirspaceApp: () => views.live() }));
vi.mock('../../src/features/replay/ReplayApp', () => ({ ReplayApp: () => views.replay() }));
vi.mock('../../src/features/lab/LabApp', () => ({ LabApp: (props: unknown) => views.lab(props) }));
vi.mock('../../src/features/evidence/OnlineEvidenceApp', () => ({
  OnlineEvidenceApp: (props: unknown) => views.evidence(props),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState({}, '', '/live.html');
  views.live.mockReturnValue(<main>Live workspace</main>);
  views.replay.mockReturnValue(<main>Replay workspace</main>);
  views.lab.mockReturnValue(<main>Lab workspace</main>);
  views.evidence.mockReturnValue(<main>Evidence workspace</main>);
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
async function render(node: ReactNode = <WorkspaceRouter buildIdentity={buildIdentity} />) {
  await act(async () => root.render(node));
}
async function navigate(hash: string) {
  await act(async () => {
    history.replaceState({}, '', '/live.html' + hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
function mainText() {
  return container.querySelector('main')?.textContent;
}

describe('workbench workspace navigation', () => {
  it.each(['', '#live', '#airspace-main', '#unknown'])('resolves %s to Live', (hash) => {
    expect(workspaceFromHash(hash)).toBe('live');
  });
  it.each(['#replay', '#replay-main', '#replay-event-4'])('resolves %s to Replay', (hash) => {
    expect(workspaceFromHash(hash)).toBe('replay');
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
    expect(workspaceFromHash(hash)).toBe('lab');
  });
  it.each(['#evidence', '#evidence-main', '#evidence-map', '#source-evidence'])(
    'resolves %s to Evidence',
    (hash) => {
      expect(workspaceFromHash(hash)).toBe('evidence');
    },
  );

  it('defaults to Live, lazy-loads other workspaces and preserves the Lab owner', async () => {
    await render();
    expect(mainText()).toBe('Live workspace');
    expect(views.replay).not.toHaveBeenCalled();
    expect(views.lab).not.toHaveBeenCalled();
    expect(views.evidence).not.toHaveBeenCalled();
    await navigate('#replay');
    expect(mainText()).toBe('Replay workspace');
    expect(document.title).toBe('Synthetic Replay | Flight Diagnostics Workbench');
    await navigate('#evidence');
    expect(mainText()).toBe('Evidence workspace');
    expect(views.evidence).toHaveBeenCalledWith({ buildIdentity });
    expect(document.title).toBe('Evidence | Flight Diagnostics Workbench');
    await navigate('#lab');
    expect(mainText()).toBe('Lab workspace');
    expect(document.title).toBe('Diagnostics Lab | Flight Diagnostics Workbench');
    const owner = views.lab.mock.calls[0]![0].owner;
    await navigate('#lab-main');
    expect(mainText()).toBe('Lab workspace');
    await navigate('');
    expect(mainText()).toBe('Live workspace');
    expect(document.title).toBe('Live Airspace | Flight Diagnostics Workbench');
    await navigate('#lab');
    expect(views.lab.mock.calls.at(-1)![0].owner).toBe(owner);
  });

  it('routes canonical Lab subviews while accessibility anchors retain the active workflow', async () => {
    expect(workspaceRouteFromHash('#lab-verification')).toEqual({
      workspace: 'lab',
      labSubview: 'verification',
    });
    expect(workspaceRouteFromHash('#lab-diagnostics')).toEqual({
      workspace: 'lab',
      labSubview: 'diagnostics',
    });
    expect(workspaceRouteFromHash('#lab-configuration')).toEqual({
      workspace: 'lab',
      labSubview: 'configuration',
    });
    expect(workspaceRouteFromHash('#lab-investigation')).toEqual({
      workspace: 'lab',
      labSubview: 'investigation',
    });
    expect(workspaceRouteFromHash('#lab-campaign')).toEqual({
      workspace: 'lab',
      labSubview: 'campaign',
    });
    expect(workspaceRouteFromHash('#lab-main', 'verification')).toEqual({
      workspace: 'lab',
      labSubview: 'verification',
    });
    history.replaceState({}, '', '/live.html#lab-verification');
    await render();
    expect(views.lab.mock.calls.at(-1)![0].subview).toBe('verification');
    expect(document.title).toBe('Verification | Diagnostics Lab | Flight Diagnostics Workbench');
    expect(container.querySelector('.workbench-nav [aria-current="page"]')?.textContent).toBe(
      'Diagnostics Lab',
    );
    const owner = views.lab.mock.calls.at(-1)![0].owner;
    await navigate('#lab-main');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'verification' });
    expect(document.title).toBe('Verification | Diagnostics Lab | Flight Diagnostics Workbench');
    await navigate('#lab-monitor');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'monitor' });
    expect(document.title).toBe('Diagnostics Lab | Flight Diagnostics Workbench');
    await navigate('#lab-diagnostics');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'diagnostics' });
    expect(document.title).toBe('Diagnostics | Diagnostics Lab | Flight Diagnostics Workbench');
    await navigate('#lab-investigation');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'investigation' });
    expect(document.title).toBe('Investigation | Diagnostics Lab | Flight Diagnostics Workbench');
    await navigate('#lab-campaign');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'campaign' });
    expect(document.title).toBe('Campaign | Diagnostics Lab | Flight Diagnostics Workbench');
    await navigate('#lab-configuration');
    expect(views.lab.mock.calls.at(-1)![0]).toMatchObject({ owner, subview: 'configuration' });
    expect(document.title).toBe('Configuration | Diagnostics Lab | Flight Diagnostics Workbench');
  });

  it('does not rerender an active workspace when a same-view skip anchor changes the hash', async () => {
    history.replaceState({}, '', '/live.html#evidence');
    await render();
    expect(views.evidence).toHaveBeenCalledOnce();
    await navigate('#evidence-main');
    expect(views.evidence).toHaveBeenCalledOnce();
    expect(mainText()).toBe('Evidence workspace');
  });

  it('recovers a failed Lab subview without replacing the retained session owner', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    views.lab.mockImplementation((props: { subview: string }) => {
      if (props.subview === 'verification') throw new Error('controlled Verification failure');
      return <main>Lab Monitor recovered</main>;
    });
    history.replaceState({}, '', '/live.html#lab-verification');
    await render();
    expect(mainText()).toContain('Workspace unavailable');
    const owner = views.lab.mock.calls.at(-1)![0].owner;
    await navigate('#lab-monitor');
    expect(mainText()).toBe('Lab Monitor recovered');
    expect(views.lab.mock.calls.at(-1)![0].owner).toBe(owner);
    expect(error).toHaveBeenCalled();
  });

  it.each([
    ['#replay-main', 'Replay workspace'],
    ['#lab-main', 'Lab workspace'],
    ['#evidence-map', 'Evidence workspace'],
  ])('opens %s without mounting Live first', async (hash, expected) => {
    history.replaceState({}, '', `/live.html${hash}`);
    await render();
    expect(mainText()).toBe(expected);
    expect(views.live).not.toHaveBeenCalled();
  });

  it('contains render failure and permits switching to a different workspace', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    views.live.mockImplementation(() => {
      throw new Error('controlled render failure');
    });
    await render();
    expect(mainText()).toContain('Workspace unavailable');
    expect(container.querySelector('.workbench-nav')).not.toBeNull();
    expect(container.querySelector('.workspace-recovery-links a')?.getAttribute('href')).toBe(
      '#live',
    );
    await navigate('#lab');
    expect(mainText()).toBe('Lab workspace');
    expect(error).toHaveBeenCalled();
  });
});
