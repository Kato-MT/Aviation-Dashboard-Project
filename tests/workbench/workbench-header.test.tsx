// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkbenchHeader,
  type WorkbenchWorkspace,
} from '../../src/features/workbench/WorkbenchHeader';

let container: HTMLDivElement;
let root: Root;

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

const cases: Array<{
  workspace: WorkbenchWorkspace;
  label: string;
  skipHref: string;
  skipText: string;
}> = [
  {
    workspace: 'live',
    label: 'Live Airspace',
    skipHref: '#airspace-main',
    skipText: 'Skip to airspace workspace',
  },
  {
    workspace: 'replay',
    label: 'Synthetic Replay',
    skipHref: '#replay-main',
    skipText: 'Skip to Replay workspace',
  },
  {
    workspace: 'lab',
    label: 'Diagnostics Lab',
    skipHref: '#lab-main',
    skipText: 'Skip to Lab workspace',
  },
  {
    workspace: 'evidence',
    label: 'Evidence',
    skipHref: '#evidence-main',
    skipText: 'Skip to Evidence workspace',
  },
];

describe('four-workspace header', () => {
  it.each(cases)('labels and links the $workspace workspace', async (entry) => {
    await act(async () => root.render(<WorkbenchHeader workspace={entry.workspace} />));

    const links = [...container.querySelectorAll<HTMLAnchorElement>('.workbench-nav a')];
    expect(links.map((link) => link.textContent)).toEqual([
      'Live Airspace',
      'Synthetic Replay',
      'Diagnostics Lab',
      'Evidence',
    ]);
    expect(links.find((link) => link.getAttribute('aria-current') === 'page')?.textContent).toBe(
      entry.label,
    );
    const skip = container.querySelector<HTMLAnchorElement>('.skip-link');
    expect(skip?.getAttribute('href')).toBe(entry.skipHref);
    expect(skip?.textContent).toBe(entry.skipText);
  });

  it('preserves the online development label by default', async () => {
    await act(async () => root.render(<WorkbenchHeader workspace="live" />));

    expect(container.querySelector('.development-label')?.textContent).toBe('Development preview');
  });

  it('labels an offline runtime without changing navigation or skip-link semantics', async () => {
    await act(async () => root.render(<WorkbenchHeader workspace="evidence" runtime="offline" />));

    expect(container.querySelector('.development-label')?.textContent).toBe(
      'Self-contained offline package',
    );
    expect(container.querySelectorAll('.workbench-nav a')).toHaveLength(4);
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#evidence-main');
    expect(container.querySelector('.skip-link')?.textContent).toBe('Skip to Evidence workspace');
  });
});
