// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabCharts } from '../../src/features/lab/LabCharts';
import type { Finding, TelemetrySample } from '../../src/core';

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/ui/charts', () => ({
  TelemetryCharts: class {
    constructor(...args: unknown[]) {
      return engine.create(...args);
    }
  },
}));

let root: Root;
let container: HTMLDivElement;
let instances: Array<ReturnType<typeof fakeCharts>>;
function fakeCharts() {
  return { setRun: vi.fn(), setCursor: vi.fn(), destroy: vi.fn() };
}
const samples: TelemetrySample[] = [];
const findings: Finding[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  instances = [];
  engine.create.mockImplementation(() => {
    const owner = fakeCharts();
    instances.push(owner);
    return owner;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function view(cursor = 7, nextFindings = findings) {
  return <LabCharts samples={samples} findings={nextFindings} cursor={cursor} />;
}

describe('React Lab chart ownership', () => {
  it('owns three explicit canvases and changes cursor without rebuilding the dataset', async () => {
    await render(view());
    expect(container.querySelectorAll('canvas')).toHaveLength(3);
    expect(engine.create).toHaveBeenCalledOnce();
    const [canvases, theme] = engine.create.mock.calls[0]!;
    expect(Object.values(canvases).every((canvas) => canvas instanceof HTMLCanvasElement)).toBe(
      true,
    );
    expect(theme).toBe('light');
    const owner = instances[0]!;
    owner.setRun.mockClear();
    await render(view(12));
    expect(owner.setRun).not.toHaveBeenCalled();
    expect(owner.setCursor).toHaveBeenLastCalledWith(12);
    await render(<p>Closed</p>);
    expect(owner.destroy).toHaveBeenCalledOnce();
  });

  it('restores the same cursor after a profile changes the findings dataset', async () => {
    await render(view(42));
    const owner = instances[0]!;
    const previousCalls = owner.setCursor.mock.calls.length;
    const nextFindings: Finding[] = [];
    await render(view(42, nextFindings));
    expect(owner.setRun).toHaveBeenLastCalledWith(samples, nextFindings);
    expect(owner.setCursor).toHaveBeenCalledTimes(previousCalls + 1);
    expect(owner.setCursor).toHaveBeenLastCalledWith(42);
    expect(owner.setCursor.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      owner.setRun.mock.invocationCallOrder.at(-1)!,
    );
  });

  it.each(['constructor', 'dataset', 'cursor'])(
    'contains a %s failure and supports a clean retry',
    async (failure) => {
      if (failure === 'constructor')
        engine.create.mockImplementationOnce(() => {
          throw new Error('canvas unavailable');
        });
      await render(view());
      if (failure === 'dataset') {
        instances[0]!.setRun.mockImplementationOnce(() => {
          throw new Error('dataset draw failure');
        });
        await render(view(7, []));
      }
      if (failure === 'cursor') {
        instances[0]!.setCursor.mockImplementationOnce(() => {
          throw new Error('cursor draw failure');
        });
        await render(view(8));
      }
      expect(container.textContent).toContain('Charts unavailable');
      expect(container.textContent).toContain(
        'selected sample, findings and exports remain available',
      );
      expect(container.querySelectorAll('canvas')).toHaveLength(0);
      await act(async () => container.querySelector('button')!.click());
      expect(container.querySelectorAll('canvas')).toHaveLength(3);
      expect(container.textContent).not.toContain('Charts unavailable');
      expect(engine.create).toHaveBeenCalledTimes(2);
    },
  );

  it('releases the first Strict Mode owner and leaves only the current effect owner active', async () => {
    await render(<StrictMode>{view()}</StrictMode>);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(instances[1]!.destroy).not.toHaveBeenCalled();
    await render(<p>Closed</p>);
    expect(instances[1]!.destroy).toHaveBeenCalledOnce();
  });
});
