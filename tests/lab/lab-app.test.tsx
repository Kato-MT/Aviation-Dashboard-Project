// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineCsv from '../../data/flight.csv?raw';
import { LabApp } from '../../src/features/lab/LabApp';
import {
  defaultInvestigationRunner,
  type InvestigationSettledSnapshot,
} from '../../src/features/lab/investigation';
import { LabSessionOwner } from '../../src/features/lab/owner';
import { LabSession } from '../../src/features/lab/session';
import { genericRotaryWingProfile } from '../../src/profiles';
import type { VersionedDiagnosticReport } from '../../src/export/reports';

const engine = vi.hoisted(() => ({ create: vi.fn(), download: vi.fn() }));
vi.mock('../../src/ui/charts', () => ({
  TelemetryCharts: class {
    constructor() {
      return engine.create();
    }
  },
}));
vi.mock('../../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/dom')>()),
  downloadText: engine.download,
}));
let root: Root;
let container: HTMLDivElement;
let session: LabSession;
let owner: LabSessionOwner;
let createSession: ReturnType<typeof vi.fn<() => LabSession>>;
let activeCharts: Set<object>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  history.replaceState({}, '', '/live.html#lab-monitor');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('The synthetic Lab must not fetch data.');
    }),
  );
  activeCharts = new Set();
  engine.create.mockImplementation(() => {
    const chart = {
      setRun: vi.fn(),
      setCursor: vi.fn(),
      destroy: vi.fn(() => activeCharts.delete(chart)),
    };
    activeCharts.add(chart);
    return chart;
  });
  session = new LabSession();
  owner = new LabSessionOwner();
  createSession = vi.fn(() => session);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(activeCharts.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(node: ReactNode = <LabApp createSession={createSession} owner={owner} />) {
  await act(async () => root.render(node));
  await settleInput();
}
async function settleInput() {
  await act(async () => {
    await vi.waitFor(() => expect(session.getState().status).not.toBe('loading'));
  });
}
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settleInput();
}
async function importFile(file: Pick<File, 'name' | 'size' | 'text'> | undefined) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settleInput();
}
function report(): VersionedDiagnosticReport {
  return JSON.parse(engine.download.mock.calls.at(-1)![1]);
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(setter).toBeDefined();
  setter!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('React-owned Monitor, Diagnostics, Verification, Investigation and Configuration workflows', () => {
  it('renders the exact golden baseline and keeps the full legacy workflow reachable', async () => {
    await render();
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('85');
    expect(container.querySelector('#metric-quarantined')?.textContent).toBe('0');
    expect(container.querySelector('#metric-findings')?.textContent).toBe('9');
    expect(container.querySelector('#metric-hash')?.textContent).toBe('b3b50781');
    expect(container.querySelectorAll('.lab-findings li')).toHaveLength(9);
    expect(container.querySelectorAll('[data-severity="warning"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-severity="error"]')).toHaveLength(3);
    expect(container.querySelector('.source-banner')?.textContent).toContain(
      'Separate from public aircraft surveillance',
    );
    expect(container.querySelector('a[href="./v2.html"]')).not.toBeNull();
    expect(activeCharts.size).toBe(1);
    expect(container.querySelector('#lab-main')).not.toBeNull();
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(session.getState().current?.run.samples).toHaveLength(85);
  });

  it('removes the legacy oracle link from the standalone React offline package', async () => {
    await render(<LabApp createSession={createSession} owner={owner} legacyOracleHref={null} />);

    expect(container.querySelector('a[href="./v2.html"]')).toBeNull();
    expect(container.querySelector('.lab-migration-note')?.textContent).toContain(
      'Self-contained React Lab',
    );
    expect(container.querySelector('.lab-migration-note')?.textContent).toContain(
      'not bundled or linked from this file',
    );
  });

  it('exports findings and provenance with source samples excluded unless explicitly selected', async () => {
    await render();
    await click('Export findings CSV');
    expect(engine.download.mock.calls.at(-1)![0]).toMatch(/-findings\.csv$/);
    expect(engine.download.mock.calls.at(-1)![1].split('\r\n')).toHaveLength(10);
    await click('Export diagnostic JSON');
    expect(report().run.provenance.datasetSha256).toBe(
      'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
    );
    expect(report().run.samples).toBeUndefined();
    expect(report().run.sources).toBeUndefined();
    expect(report().exportPolicy.sourceDataIncluded).toBe(false);
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await click('Export diagnostic JSON');
    expect(report().run.samples).toHaveLength(85);
    expect(report().exportPolicy.sourceDataIncluded).toBe(true);
  });

  it('owns one replay timer, supports finding seeks and releases activity when leaving the Lab', async () => {
    await render();
    await click('Start replay');
    expect(button('Start replay').disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(container.querySelector('#lab-replay-position')?.textContent).toBe('3 / 85');
    await click('Pause replay');
    expect(vi.getTimerCount()).toBe(0);
    const finding = session.getState().current!.analysis.findings[0]!;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.lab-finding-actions button')!.click(),
    );
    expect(
      session.getState().current!.run.samples[session.getState().replayIndex]?.sampleIndex,
    ).toBe(finding.sampleIndex);
    await click('Reset replay');
    expect(container.querySelector('#lab-replay-position')?.textContent).toBe('1 / 85');
    await click('Start replay');
    await render(<p>Live workspace</p>);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeCharts.size).toBe(0);
  });

  it('retains the session on reentry and does not reload data or resume replay automatically', async () => {
    await render();
    const profile = container.querySelector<HTMLSelectElement>('.lab-inputs select')!;
    await act(async () => {
      profile.value = genericRotaryWingProfile.id;
      profile.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Generate synthetic demo');
    await act(async () => {
      session.scrub(42);
      session.setSourceExport(true);
    });
    const current = session.getState().current;
    await click('Start replay');
    await render(<p>Live workspace</p>);
    const paused = session.getState().replayIndex;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await render();
    expect(createSession).toHaveBeenCalledOnce();
    expect(session.getState().current).toBe(current);
    expect(session.getState().replayIndex).toBe(paused);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(button('Start replay').disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeCharts.size).toBe(1);
    await click('Clear Lab session');
    expect(container.textContent).toContain('No telemetry loaded');
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
    await render(<p>Live workspace</p>);
    await render();
    expect(container.textContent).toContain('No telemetry loaded');
    await click('Load included baseline');
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('85');
  });

  it('contains malformed and unreadable imports and allows the same input control to recover', async () => {
    await render();
    const current = session.getState().current;
    await importFile(undefined);
    expect(session.getState().current).toBe(current);
    await importFile({ name: 'broken.json', size: 1, text: async () => '{' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('blocked');
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('0');
    expect(container.querySelector('.lab-validation')?.textContent).toContain('SCHEMA_MISMATCH');
    expect(button('Start replay').disabled).toBe(true);
    await importFile({
      name: 'unreadable.csv',
      size: 10,
      text: async () => {
        throw new Error('read failed');
      },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be read');
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
    await importFile({
      name: 'baseline.csv',
      size: baselineCsv.length,
      text: async () => baselineCsv,
    });
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('85');
    expect(activeCharts.size).toBe(1);
  });

  it('renders quarantined hostile input only as text and keeps source values out of default exports', async () => {
    await render();
    const csv =
      'timestamp,altitude_ft,speed_kts,fuel_pct\n<img src=x onerror=alert(1)>,1000,100,90\n00:10,1100,105,89.9';
    await importFile({ name: 'hostile.csv', size: csv.length, text: async () => csv });
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('1');
    expect(container.querySelector('#metric-quarantined')?.textContent).toBe('1');
    expect(container.querySelector('.lab-validation')?.textContent).toContain('INVALID_TIMESTAMP');
    expect(container.querySelector('img')).toBeNull();
    await click('Export diagnostic JSON');
    expect(report().run.quarantinedRows[0]?.raw).toBeUndefined();
  });

  it('filters Diagnostics evidence without mutating findings and exports the unfiltered set', async () => {
    await render(<LabApp createSession={createSession} owner={owner} subview="diagnostics" />);
    expect(activeCharts.size).toBe(0);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Diagnostics',
    );
    const original = session.getState().current!.analysis.findings;
    const originalSnapshot = structuredClone(original);
    expect(container.querySelectorAll('.lab-diagnostics-findings li')).toHaveLength(9);

    const [severity, rule, source] = [
      ...container.querySelectorAll<HTMLSelectElement>('.lab-diagnostics-filter-fields select'),
    ];
    expect(rule?.options).toHaveLength(4);
    expect(source?.options.length).toBeGreaterThan(1);
    await act(async () => {
      severity!.value = 'error';
      severity!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('.lab-diagnostics-findings li')).toHaveLength(3);
    expect(session.getState().current!.analysis.findings).toBe(original);

    const search = container.querySelector<HTMLInputElement>(
      '.lab-diagnostics-filter-fields input[type="search"]',
    )!;
    await act(async () => {
      setReactInputValue(search, 'no matching evidence');
    });
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.lab-diagnostics-findings li')).toHaveLength(0),
    );
    expect(container.querySelector('.lab-empty-state')?.textContent).toContain('No findings match');
    await click('Clear filters');
    expect(container.querySelectorAll('.lab-diagnostics-findings li')).toHaveLength(9);
    expect(session.getState().current!.analysis.findings).toEqual(originalSnapshot);

    await act(async () => session.setDiagnosticsFilters({ severity: 'error' }));
    await click('Export all findings CSV');
    expect(engine.download.mock.calls.at(-1)![0]).toMatch(/-findings\.csv$/);
    expect(engine.download.mock.calls.at(-1)![1].split('\r\n')).toHaveLength(10);
  });

  it('creates a CSV fault candidate, exposes safe quarantine evidence and exports its stimulus', async () => {
    history.replaceState({}, '', '/live.html#lab-diagnostics');
    await render(<LabApp createSession={createSession} owner={owner} subview="diagnostics" />);
    const scenario = container.querySelector<HTMLSelectElement>('.lab-fault-builder select')!;
    await act(async () => {
      scenario.value = 'nonnumeric-csv-value';
      scenario.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Create candidate and verify');
    await vi.waitFor(() => expect(session.getState().faultStatus).toBe('idle'));
    expect(location.hash).toBe('#lab-verification');
    expect(session.getState().current?.run.quarantinedRows).toHaveLength(1);
    expect(session.getState().baseline?.run.quarantinedRows).toHaveLength(0);
    expect(container.querySelectorAll('.lab-quarantine-evidence li')).toHaveLength(1);
    expect(container.querySelector('.lab-quarantine-evidence')?.textContent).toContain(
      'NONNUMERIC_VALUE',
    );
    expect(container.querySelector('.lab-quarantine-evidence')?.textContent).not.toContain(
      'not-a-number',
    );

    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    expect(container.querySelector('.lab-verification-runs')?.textContent).toContain(
      'Nonnumeric CSV value · seed 1337',
    );
    await render(<LabApp createSession={createSession} owner={owner} subview="monitor" />);
    await click('Export diagnostic JSON');
    expect(report().injectedFaults).toEqual([
      expect.objectContaining({
        scenarioId: 'nonnumeric-csv-value',
        seed: 1337,
        target: 'legacy-csv',
        synthetic: true,
      }),
    ]);
    expect(report().injectedFaults[0]?.expectedRuleIds).toContain('data.value.nonnumeric');
    expect(report().run.samples).toBeUndefined();
    expect(report().run.quarantinedRows[0]?.raw).toBeUndefined();
  });

  it('contains invalid and source-incompatible fault controls without navigation', async () => {
    history.replaceState({}, '', '/live.html#lab-diagnostics');
    await render(<LabApp createSession={createSession} owner={owner} subview="diagnostics" />);
    const before = session.getState().current;
    const seed = container.querySelector<HTMLInputElement>('.lab-fault-builder input')!;
    await act(async () => {
      setReactInputValue(seed, '0');
    });
    await click('Create candidate and verify');
    expect(container.querySelector('.lab-inline-error[role="alert"]')?.textContent).toContain(
      'whole-number seed',
    );
    expect(session.getState().current).toBe(before);
    expect(location.hash).toBe('#lab-diagnostics');

    await click('Generate synthetic demo');
    expect(container.querySelector('.lab-diagnostics-result')?.textContent).toContain(
      'This analysis has no findings.',
    );
    expect(container.querySelector('.lab-diagnostics-findings .lab-empty-state')?.textContent).toBe(
      'This analysis has no findings.',
    );
    const scenario = container.querySelector<HTMLSelectElement>('.lab-fault-builder select')!;
    await act(async () => {
      scenario.value = 'blank-csv-value';
      scenario.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('.lab-inline-warning')?.textContent).toContain(
      'needs a legacy CSV source',
    );
    expect(button('Create candidate and verify').disabled).toBe(true);
  });

  it('cancels Diagnostics work and cannot hijack navigation after the subview closes', async () => {
    history.replaceState({}, '', '/live.html#lab-diagnostics');
    await render(<LabApp createSession={createSession} owner={owner} subview="diagnostics" />);
    let resolve!: (created: boolean) => void;
    vi.spyOn(session, 'createFaultCandidate').mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const cancel = vi.spyOn(session, 'cancelFaultCandidate');
    await click('Create candidate and verify');
    await render(<LabApp createSession={createSession} owner={owner} subview="monitor" />);
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => resolve(true));
    expect(location.hash).toBe('#lab-diagnostics');
    expect(container.querySelector('#lab-monitor')).not.toBeNull();
  });

  it('stops replay on pagehide and restores only activity eligibility after a persisted pageshow', async () => {
    await render();
    await click('Start replay');
    await act(async () =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    expect(vi.getTimerCount()).toBe(0);
    const retained = session.getState().current;
    await act(async () =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })),
    );
    await click('Start replay');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    expect(session.getState().current).toBe(retained);
    expect(vi.getTimerCount()).toBe(0);
    await click('Start replay');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('invalidates pending Investigation work on pagehide and rejects its late result', async () => {
    const settled = await defaultInvestigationRunner(
      { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
      { robustCovariance: 'disabled', temporalModel: 'disabled' },
    );
    let resolveInvestigation!: (snapshot: InvestigationSettledSnapshot) => void;
    session = new LabSession({
      investigationRunner: () =>
        new Promise<InvestigationSettledSnapshot>((resolve) => {
          resolveInvestigation = resolve;
        }),
    });
    createSession = vi.fn(() => session);
    await render(<LabApp createSession={createSession} owner={owner} subview="investigation" />);

    await click('Run investigation');
    expect(session.getState().investigation.work).toEqual({ phase: 'analyzing' });
    await act(async () =>
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    expect(session.getState().investigation.work).toEqual({
      phase: 'idle',
      issue: 'Investigation analysis was cancelled when the Lab closed.',
    });

    await act(async () => {
      resolveInvestigation(settled);
      await Promise.resolve();
    });
    expect(session.getState().investigation.current).toBeUndefined();
  });

  it('handles Strict Mode setup and cleanup without duplicate session ownership or charts', async () => {
    await render(
      <StrictMode>
        <LabApp createSession={createSession} owner={owner} />
      </StrictMode>,
    );
    expect(createSession).toHaveBeenCalledOnce();
    expect(container.querySelector('#metric-accepted')?.textContent).toBe('85');
    expect(activeCharts.size).toBe(1);
    await click('Start replay');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('renders a passing comparison, canonical requirement evidence and a minimized export', async () => {
    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    expect(activeCharts.size).toBe(0);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Verification',
    );
    await click('Compare current with baseline');
    expect(container.querySelector<HTMLElement>('.lab-verification-outcome')?.dataset.outcome).toBe(
      'pass',
    );
    expect(container.querySelector('#verification-outcome-title')?.textContent).toBe(
      'Verification passed',
    );
    expect(
      container.querySelector('#classification-resolved')?.parentElement?.textContent,
    ).toContain('0');
    expect(
      container.querySelector('#classification-persisting')?.parentElement?.textContent,
    ).toContain('9');
    expect(container.querySelectorAll('.lab-classification-group:nth-child(2) li')).toHaveLength(9);
    expect(container.querySelectorAll('.lab-requirement-evidence li')).toHaveLength(8);
    expect(container.querySelector('.lab-requirement-evidence')?.textContent).toContain(
      'FDW-VER-008',
    );
    await click('Export minimized verification JSON');
    const exported = report();
    expect(exported.verification?.schemaVersion).toBe('verification.v2');
    expect(exported.verification?.status).toBe('pass');
    expect(exported.run.samples).toBeUndefined();
    expect(exported.run.sources).toBeUndefined();
    expect(exported.exportPolicy.sourceDataIncluded).toBe(false);
    expect(engine.download.mock.calls.at(-1)![0]).toMatch(/-verification-report\.json$/);
  });

  it('TC-VER-007 displays and exports a nominal zero-finding candidate', async () => {
    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    const nominal =
      'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,1000,100,90\n00:10,1100,105,89.9';
    await act(async () => session.loadText(nominal, 'csv', 'Nominal candidate'));
    await settleInput();
    expect(session.getState().current?.analysis.findings).toHaveLength(0);
    await click('Compare current with baseline');
    expect(container.querySelector('#verification-outcome-title')?.textContent).toBe(
      'Verification passed',
    );
    expect(session.getState().verification).toMatchObject({
      status: 'pass',
      candidate: { findingCount: 0 },
      summary: { resolved: 9, persisting: 0, newlyIntroduced: 0 },
    });
    const requirement = [...container.querySelectorAll('.lab-requirement-evidence li')].find(
      (item) => item.textContent?.includes('FDW-VER-008'),
    );
    expect(requirement?.textContent).toContain('pass');
    expect(requirement?.textContent).toContain('zero findings');
    await click('Export minimized verification JSON');
    expect(report().verification?.candidate.findingCount).toBe(0);
    expect(report().run.samples).toBeUndefined();
  });

  it('renders regression and blocked outcomes as distinct evidence states', async () => {
    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    const changed = baselineCsv.replace('00:10,800,120,99.6', '00:10,800,999,99.6');
    await act(async () => session.loadText(changed, 'csv', 'Overspeed candidate'));
    await settleInput();
    await click('Compare current with baseline');
    expect(container.querySelector<HTMLElement>('.lab-verification-outcome')?.dataset.outcome).toBe(
      'fail',
    );
    expect(container.querySelector('#verification-outcome-title')?.textContent).toBe(
      'Regression detected',
    );
    expect(session.getState().verification?.summary.newlyIntroduced).toBeGreaterThan(0);

    await act(async () => session.loadText('{', 'json', 'Malformed candidate'));
    await settleInput();
    await click('Compare current with baseline');
    expect(container.querySelector<HTMLElement>('.lab-verification-outcome')?.dataset.outcome).toBe(
      'blocked',
    );
    expect(container.querySelector('#verification-outcome-title')?.textContent).toBe(
      'Verification blocked',
    );
    expect(container.querySelector('.lab-verification-outcome')?.textContent).toContain(
      'not proof of improvement',
    );
  });

  it('retains incompatible candidate evidence and explains why comparison is unavailable', async () => {
    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    await act(async () => session.loadGeneratedDemo());
    await settleInput();
    await click('Compare current with baseline');
    expect(session.getState().candidate).toBeDefined();
    expect(session.getState().verification).toBeUndefined();
    expect(container.querySelector<HTMLElement>('.lab-verification-outcome')?.dataset.outcome).toBe(
      'unavailable',
    );
    expect(container.querySelector('#verification-outcome-title')?.textContent).toBe(
      'Comparison unavailable',
    );
    expect(container.querySelector('.lab-verification-runs')?.textContent).toContain(
      'generated run',
    );
  });

  it('unmounts Monitor charts and pauses replay while preserving session state on subview changes', async () => {
    await render();
    await click('Start replay');
    expect(vi.getTimerCount()).toBe(1);
    const current = session.getState().current;
    await render(<LabApp createSession={createSession} owner={owner} subview="diagnostics" />);
    expect(vi.getTimerCount()).toBe(0);
    expect(activeCharts.size).toBe(0);
    expect(session.getState().current).toBe(current);
    expect(session.getState().replayPlaying).toBe(false);
    expect(container.querySelector('.lab-diagnostics-view')).not.toBeNull();
    await render(<LabApp createSession={createSession} owner={owner} subview="verification" />);
    expect(activeCharts.size).toBe(0);
    await render(<LabApp createSession={createSession} owner={owner} subview="monitor" />);
    expect(activeCharts.size).toBe(1);
    expect(session.getState().current).toBe(current);
  });

  it('supports wrapped arrow, Home and End keyboard navigation between Lab tabs', async () => {
    await render();
    const monitor = container.querySelector<HTMLAnchorElement>('#lab-monitor-tab')!;
    const diagnostics = container.querySelector<HTMLAnchorElement>('#lab-diagnostics-tab')!;
    const verification = container.querySelector<HTMLAnchorElement>('#lab-verification-tab')!;
    const investigation = container.querySelector<HTMLAnchorElement>('#lab-investigation-tab')!;
    const campaign = container.querySelector<HTMLAnchorElement>('#lab-campaign-tab')!;
    const configuration = container.querySelector<HTMLAnchorElement>('#lab-configuration-tab')!;
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
    monitor.focus();
    await act(async () =>
      monitor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(document.activeElement).toBe(diagnostics);
    expect(location.hash).toBe('#lab-diagnostics');
    await act(async () =>
      diagnostics.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(document.activeElement).toBe(verification);
    expect(location.hash).toBe('#lab-verification');
    await act(async () =>
      verification.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(investigation);
    expect(location.hash).toBe('#lab-investigation');
    await act(async () =>
      investigation.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(campaign);
    expect(location.hash).toBe('#lab-campaign');
    await act(async () =>
      campaign.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    expect(document.activeElement).toBe(configuration);
    expect(location.hash).toBe('#lab-configuration');
    await act(async () =>
      configuration.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(monitor);
    expect(location.hash).toBe('#lab-monitor');
    await act(async () =>
      monitor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(document.activeElement).toBe(configuration);
    expect(location.hash).toBe('#lab-configuration');
    await act(async () =>
      configuration.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
    );
    expect(document.activeElement).toBe(monitor);
    expect(location.hash).toBe('#lab-monitor');
    await act(async () => vi.runOnlyPendingTimersAsync());
  });
});
