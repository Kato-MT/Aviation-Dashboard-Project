// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';
import type { InvestigationReportV1 } from '../../src/export/investigationReport';
import {
  defaultInvestigationRunner,
  type InvestigationModelActivationEvidence,
  type InvestigationRunner,
  type InvestigationSettledSnapshot,
} from '../../src/features/lab/investigation';
import { LabApp } from '../../src/features/lab/LabApp';
import { LabSession } from '../../src/features/lab/session';

const ui = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock('../../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/dom')>()),
  downloadText: ui.download,
}));

vi.mock('../../src/features/lab/InvestigationCharts', () => ({
  InvestigationCharts: ({
    sampleIndex,
    onSeek,
  }: {
    sampleIndex: number;
    onSeek: (sampleIndex: number) => void;
  }) => (
    <section aria-label="Investigation charts" data-sample-index={sampleIndex}>
      <button type="button" onClick={() => onSeek(sampleIndex + 10)}>
        Seek chart forward
      </button>
    </section>
  ),
}));

const buildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-investigation-test',
  releaseSha: 'investigation-view-release',
  releaseStatus: 'exact-release',
  buildTarget: 'react-test',
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let snapshot60: InvestigationSettledSnapshot;
let snapshot80: InvestigationSettledSnapshot;
let activeSnapshot60: InvestigationSettledSnapshot;
let nominalSnapshot60: InvestigationSettledSnapshot;
let root: Root | undefined;
let container: HTMLDivElement;
let session: LabSession;

beforeAll(async () => {
  snapshot60 = await defaultInvestigationRunner(
    { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
    { robustCovariance: 'disabled', temporalModel: 'disabled' },
  );
  snapshot80 = await defaultInvestigationRunner(
    { scenarioId: 'gradual-drift', seed: 3102, sampleCount: 80, cadenceMs: 1_000 },
    { robustCovariance: 'disabled', temporalModel: 'disabled' },
  );
  activeSnapshot60 = await defaultInvestigationRunner(
    { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
    { robustCovariance: 'enabled', temporalModel: 'enabled' },
  );
  nominalSnapshot60 = await defaultInvestigationRunner(
    { scenarioId: 'nominal', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
    { robustCovariance: 'disabled', temporalModel: 'disabled' },
  );
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Investigation must remain network-free.');
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function app(createSession: () => LabSession): ReactNode {
  return (
    <LabApp createSession={createSession} subview="investigation" buildIdentity={buildIdentity} />
  );
}

async function renderInvestigation(runner: InvestigationRunner): Promise<void> {
  session = new LabSession({
    investigationRunner: runner,
    now: () => '2026-08-29T12:00:00.000Z',
  });
  await act(async () => root?.render(app(() => session)));
  await act(async () => {
    await vi.waitFor(() => expect(session.getState().status).toBe('ready'));
  });
}

function byId<T extends Element = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

function button(name: string): HTMLButtonElement {
  const element = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(element, name).toBeDefined();
  return element!;
}

async function click(name: string): Promise<void> {
  await act(async () => button(name).click());
}

async function setInput(selector: string, value: string): Promise<void> {
  const input = byId<HTMLInputElement>(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(setter).toBeDefined();
  await act(async () => {
    setter!.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function runAndSettle(): Promise<void> {
  await click('Run investigation');
  await act(async () => {
    await vi.waitFor(() => expect(session.getState().investigation.current).toBeDefined());
  });
}

type ModelEvidenceFamily = keyof InvestigationSettledSnapshot['modelEvidence'];

function withActivationEvidence(
  source: InvestigationSettledSnapshot,
  family: ModelEvidenceFamily,
  patch: Partial<InvestigationModelActivationEvidence>,
): InvestigationSettledSnapshot {
  return {
    ...source,
    modelIntents: {
      ...source.modelIntents,
      ...(patch.userSelection ? { [family]: patch.userSelection } : {}),
    },
    modelEvidence: {
      ...source.modelEvidence,
      [family]: {
        ...source.modelEvidence[family],
        ...patch,
      },
    },
  };
}

function withPointAbstention(
  source: InvestigationSettledSnapshot,
  sampleIndex: number,
  abstained: boolean,
): InvestigationSettledSnapshot {
  const snapshot = structuredClone(source);
  const point = snapshot.analysis.points.find((candidate) => candidate.sampleIndex === sampleIndex);
  const score = point?.model.score;
  if (!score) throw new Error(`Expected a model score at sample ${sampleIndex}.`);
  const mutableScore = score as { abstained: boolean; predictedLabel: string };
  mutableScore.abstained = abstained;
  if (abstained) mutableScore.predictedLabel = 'unknown';
  return snapshot;
}

function activationCard(family: 'temporal' | 'robust'): HTMLElement {
  const title = byId(`#investigation-${family}-activation-title`);
  const card = title.closest<HTMLElement>('article');
  expect(card).not.toBeNull();
  return card!;
}

function normalizedText(element: Element): string {
  return element.textContent?.replaceAll(/\s+/gu, ' ').trim() ?? '';
}

function descriptionValue(card: Element, label: string): string {
  const term = [...card.querySelectorAll('dt')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(term, label).toBeDefined();
  const description = term?.nextElementSibling;
  expect(description, `${label} description`).not.toBeNull();
  return normalizedText(description!);
}

describe('React Investigation evidence workbench', () => {
  it('renders the exact six-tab route order, request defaults, empty state, and privacy boundary', async () => {
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));

    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'Monitor',
      'Diagnostics',
      'Verification',
      'Investigation',
      'Campaign',
      'Configuration',
    ]);
    expect(byId('#lab-investigation-tab').getAttribute('aria-selected')).toBe('true');
    expect(byId('#investigation-status').textContent).toBe('Not run');
    expect(byId<HTMLSelectElement>('#investigation-scenario').value).toBe('gradual-drift');
    expect(byId<HTMLInputElement>('#investigation-seed').value).toBe('3101');
    expect(byId<HTMLInputElement>('#investigation-samples').value).toBe('180');
    expect(byId('#investigation-replay-position').textContent?.replaceAll(/\s/gu, '')).toBe('0/0');
    expect(button('Export minimized investigation JSON').disabled).toBe(true);
    expect(button('Capture comparison baseline').disabled).toBe(true);
    expect(container.textContent).toContain(
      'Generated source windows and browser state are excluded from the versioned report.',
    );
  });

  it('makes Analyzing observable and replaces results atomically at the fault onset', async () => {
    const pending = deferred<InvestigationSettledSnapshot>();
    await renderInvestigation(() => pending.promise);
    await setInput('#investigation-samples', '60');

    await act(async () => button('Run investigation').click());
    expect(byId('#investigation-status').textContent).toBe('Analyzing');
    expect(byId('.lab-investigation-view').getAttribute('aria-busy')).toBe('true');
    expect(button('Analyzing').disabled).toBe(true);

    await act(async () => pending.resolve(snapshot60));
    await act(async () => {
      await vi.waitFor(() => expect(session.getState().investigation.current).toBe(snapshot60));
    });

    const onset = snapshot60.scenario.faultTimeline!.onsetIndex;
    expect(byId('#investigation-status').textContent).toMatch(/rule indications/u);
    expect(byId('#investigation-replay-position').textContent).toContain(`${onset + 1} / 60`);
    expect(byId('[aria-label="Investigation charts"]').getAttribute('data-sample-index')).toBe(
      String(onset),
    );
    expect(byId('.lab-investigation-view').getAttribute('aria-busy')).toBe('false');
  });

  it('exposes expected, observed, predicted, and estimated state plus synchronized chart seek', async () => {
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    for (const label of [
      'Expected altitude',
      'Observed altitude',
      'Predicted altitude',
      'Estimated altitude',
      'Expected vertical rate',
      'Observed vertical rate',
      'Predicted vertical rate',
      'Estimated vertical rate',
    ]) {
      expect(container.textContent).toContain(label);
    }
    const before = session.getState().investigation.cursorPosition;
    await click('Seek chart forward');
    expect(session.getState().investigation.cursorPosition).toBe(before + 10);
    expect(byId('#investigation-replay-position').textContent).toContain(`${before + 11} / 60`);
    expect(container.textContent).toContain('Deterministic rules | authoritative');
    expect(container.textContent).toContain('Robust covariance | advisory');
    expect(container.textContent).toContain('Kalman innovation | supporting evidence');
    expect(container.textContent).toContain('Temporal model | advisory');
  });

  it('retains the last settled result under invalid input and marks request changes stale', async () => {
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    const settled = session.getState().investigation.current;

    await setInput('#investigation-seed', '0');
    await click('Run investigation');

    expect(session.getState().investigation.current).toBe(settled);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Investigation seed must be between 1 and 2147483647.',
    );
    expect(container.textContent).toContain(
      'The visible result is a settled snapshot from different controls or advisory intent.',
    );
  });

  it('retains incompatible baselines but refuses to render their waveform', async () => {
    const runner = vi
      .fn<InvestigationRunner>()
      .mockResolvedValueOnce(snapshot60)
      .mockResolvedValueOnce(snapshot80);
    await renderInvestigation(runner);
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    await click('Capture comparison baseline');

    expect(byId('#investigation-comparison-status').textContent).toContain('Overlay active');
    await setInput('#investigation-seed', '3102');
    await setInput('#investigation-samples', '80');
    await runAndSettle();

    expect(session.getState().investigation.baseline?.identity.sampleCount).toBe(60);
    expect(byId('#investigation-comparison-status').textContent).toContain(
      'Sample count differs: baseline 60, current 80.',
    );
    expect(byId<HTMLInputElement>('#investigation-comparison-overlay').disabled).toBe(true);
  });

  it('renders an identity mismatch as settled ineligible evidence instead of point-level model activity', async () => {
    const mismatch = withActivationEvidence(activeSnapshot60, 'temporalModel', {
      identityVerification: { artifact: 'mismatch', configuration: 'verified' },
      supported: false,
      eligible: false,
      active: false,
      reasons: [
        {
          code: 'ARTIFACT_IDENTITY_MISMATCH',
          detail: 'Observed temporal artifact identity does not match the registry contract.',
          channels: [],
        },
      ],
    });
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(mismatch));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    await act(async () => session.setInvestigationPosition(50));

    const card = activationCard('temporal');
    const cardText = normalizedText(card);
    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Ineligible');
    expect(descriptionValue(card, 'User intent')).toBe('Enabled');
    expect(descriptionValue(card, 'Artifact identity')).toBe('Mismatch');
    expect(descriptionValue(card, 'Configuration identity')).toBe('Verified');
    expect(cardText).toContain('ARTIFACT_IDENTITY_MISMATCH');
    expect(cardText).toContain(
      'Observed temporal artifact identity does not match the registry contract.',
    );
    expect(byId('#investigation-model-confidence').textContent).toBe('Ineligible');
    expect(byId('#investigation-hypotheses').textContent).toContain(
      'ineligible at activation time',
    );
  });

  it('renders a recomputed quality-gate failure as ineligible with stored and verified gate context', async () => {
    const gateFailure = withActivationEvidence(activeSnapshot60, 'temporalModel', {
      qualityGate: { state: 'failed', storedPassed: true, recomputedPassed: false },
      eligible: false,
      active: false,
      reasons: [
        {
          code: 'QUALITY_GATE_FAILED',
          detail: 'The recomputed temporal quality gate did not pass.',
          channels: [],
        },
      ],
    });
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(gateFailure));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    const card = activationCard('temporal');
    const cardText = normalizedText(card);
    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Ineligible');
    expect(descriptionValue(card, 'Quality gate')).toBe(
      'Failed | stored passed | recomputed failed',
    );
    expect(cardText).toContain('QUALITY_GATE_FAILED');
    expect(cardText).toContain('The recomputed temporal quality gate did not pass.');
    expect(cardText).toContain('Deterministic rules remain authoritative.');
  });

  it('keeps research-only model evidence visible but ineligible for activation', async () => {
    const researchOnly = withActivationEvidence(activeSnapshot60, 'temporalModel', {
      activationPurpose: 'research-evidence-only',
      eligible: false,
      active: false,
      reasons: [
        {
          code: 'RESEARCH_EVIDENCE_ONLY',
          detail: 'This exact model version is research evidence only and cannot activate.',
          channels: [],
        },
      ],
    });
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(researchOnly));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    const card = activationCard('temporal');
    const cardText = normalizedText(card);
    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Ineligible');
    expect(descriptionValue(card, 'Activation purpose')).toBe('Research evidence only');
    expect(cardText).toContain('RESEARCH_EVIDENCE_ONLY');
    expect(cardText).toContain('research evidence only and cannot activate');
    expect(byId('#investigation-model-confidence').textContent).toBe('Ineligible');
  });

  it('distinguishes unavailable activation evidence from a known incompatibility', async () => {
    const unavailable = withActivationEvidence(activeSnapshot60, 'temporalModel', {
      identityVerification: { artifact: 'unavailable', configuration: 'verified' },
      supported: false,
      eligible: false,
      active: false,
      reasons: [
        {
          code: 'ARTIFACT_IDENTITY_UNAVAILABLE',
          detail: 'Artifact verification evidence was unavailable when the run started.',
          channels: [],
        },
      ],
    });
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(unavailable));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Unavailable');
    expect(byId('#investigation-model-confidence').textContent).toBe('Unavailable');
    expect(normalizedText(activationCard('temporal'))).toContain(
      'Artifact verification evidence was unavailable when the run started.',
    );
    expect(byId('#investigation-hypotheses').textContent).toContain(
      'unavailable at activation time',
    );
  });

  it('surfaces robust-covariance context incompatibility and affected channels separately from the selected sample', async () => {
    const incompatible = withActivationEvidence(snapshot60, 'robustCovariance', {
      userSelection: 'enabled',
      contextLabel: 'Fixed-wing Investigation covariance projection',
      supported: false,
      eligible: false,
      active: false,
      reasons: [
        {
          code: 'SOURCE_ID_MISMATCH',
          detail: 'The generated scenario does not match the robust covariance source contract.',
          channels: ['barometricAltitude', 'fuelQuantity'],
        },
      ],
    });
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(incompatible));
    await act(async () => session.setModelSelection('robust-covariance', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    const card = activationCard('robust');
    const cardText = normalizedText(card);
    expect(byId('#investigation-robust-activation-state').textContent).toBe('Ineligible');
    expect(descriptionValue(card, 'User intent')).toBe('Enabled');
    expect(descriptionValue(card, 'Compatibility context')).toBe(
      'Fixed-wing Investigation covariance projection',
    );
    expect(cardText).toContain('SOURCE_ID_MISMATCH');
    expect(cardText).toContain('channels barometricAltitude, fuelQuantity');
    expect(container.textContent).toContain('Same-sample decisions');
  });

  it('keeps a disabled nominal run at sample zero distinct from temporal warmup', async () => {
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(nominalSnapshot60));
    await act(async () => session.setInvestigationScenario('nominal'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    expect(nominalSnapshot60.defaultSelectedIndex).toBe(0);
    expect(byId('#investigation-replay-position').textContent?.replaceAll(/\s/gu, '')).toBe('1/60');
    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Disabled');
    expect(byId('#investigation-model-confidence').textContent).toBe('Disabled');
    expect(byId('#investigation-hypotheses').textContent).toContain(
      'disabled by user intent for this settled run',
    );
    expect(byId('#investigation-hypotheses').textContent).not.toContain('warming up');
  });

  it('shows warmup and active selected-sample decisions under verified active run evidence', async () => {
    const warmupIndex = activeSnapshot60.analysis.points.findIndex((point) => !point.model.score);
    const scoredIndex = activeSnapshot60.analysis.points.findIndex((point) => point.model.score);
    expect(warmupIndex).toBeGreaterThanOrEqual(0);
    expect(scoredIndex).toBeGreaterThanOrEqual(0);
    const activeDecision = withPointAbstention(activeSnapshot60, scoredIndex, false);
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(activeDecision));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await act(async () => session.setModelSelection('robust-covariance', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();

    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Active');
    expect(byId('#investigation-robust-activation-state').textContent).toBe('Active');
    const card = activationCard('temporal');
    const cardText = normalizedText(card);
    expect(descriptionValue(card, 'User intent')).toBe('Enabled');
    expect(descriptionValue(card, 'Activation purpose')).toBe('Integrated advisory');
    expect(descriptionValue(card, 'Artifact identity')).toBe('Verified');
    expect(descriptionValue(card, 'Configuration identity')).toBe('Verified');
    expect(descriptionValue(card, 'Quality gate')).toBe(
      'Passed | stored passed | recomputed passed',
    );
    expect(cardText).toContain('No activation blockers.');
    expect(cardText).toContain('Deterministic rules remain authoritative.');

    await act(async () => session.setInvestigationPosition(warmupIndex));
    expect(byId('#investigation-model-confidence').textContent).toBe('Warmup');
    expect(byId('#investigation-hypotheses').textContent).toContain(
      'warming up the 40-sample causal window',
    );

    await act(async () => session.setInvestigationPosition(scoredIndex));
    expect(byId('#investigation-model-confidence').textContent).toMatch(/^\d+\.\d%$/u);
    const meters = [
      ...container.querySelectorAll<HTMLMeterElement>('#investigation-hypotheses meter'),
    ];
    expect(meters.length).toBeGreaterThan(0);
    const names = meters.map((meter) => meter.getAttribute('aria-label'));
    expect(names.every((name) => name?.endsWith('relative model similarity'))).toBe(true);
    expect(new Set(names).size).toBe(meters.length);

    await act(async () => session.setModelSelection('temporal', 'disabled'));
    expect(session.getState().investigation.current).toBe(activeDecision);
    expect(session.getState().investigation.resultSettingsStale).toBe(true);
    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Active');
  });

  it('labels a selected-sample model abstention without relabeling active run evidence', async () => {
    const scoredIndex = activeSnapshot60.analysis.points.findIndex((point) => point.model.score);
    expect(scoredIndex).toBeGreaterThanOrEqual(0);
    const abstained = withPointAbstention(activeSnapshot60, scoredIndex, true);
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(abstained));
    await act(async () => session.setModelSelection('temporal', 'enabled'));
    await act(async () => session.setModelSelection('robust-covariance', 'enabled'));
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    await act(async () => session.setInvestigationPosition(scoredIndex));

    expect(byId('#investigation-temporal-activation-state').textContent).toBe('Active');
    expect(byId('#investigation-model-confidence').textContent).toBe('Abstained');
    expect(byId('#investigation-model-confidence').nextElementSibling?.textContent).toContain(
      'relative similarity | unknown',
    );
    expect(byId('#investigation-hypotheses').textContent).toContain(
      'Unknown: the model abstained because support or confidence was insufficient.',
    );
  });

  it('downloads a privacy-minimized versioned report bound to exact build and settled evidence', async () => {
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    await click('Export minimized investigation JSON');

    expect(ui.download).toHaveBeenCalledTimes(1);
    const [filename, serialized, mediaType] = ui.download.mock.calls[0]!;
    expect(filename).toBe('temporal-investigation-gradual-drift-seed-3101.json');
    expect(mediaType).toBe('application/json');
    const report = JSON.parse(serialized as string) as InvestigationReportV1;
    expect(report).toMatchObject({
      reportSchemaVersion: 'investigation-report.v1',
      buildIdentities: { reactShell: buildIdentity },
      scenarioReproduction: { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 60 },
      exportPolicy: {
        sourceDataIncluded: false,
        samplesIncluded: false,
        pointsIncluded: false,
        seriesIncluded: false,
        measurementsIncluded: false,
        truthIncluded: false,
        perSampleLabelsIncluded: false,
        browserStateIncluded: false,
        endpointsIncluded: false,
      },
    });
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        visit(child);
      }
    };
    visit(report);
    for (const forbidden of [
      'samples',
      'points',
      'series',
      'measurements',
      'truth',
      'sourceData',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('resets all Investigation evidence without storage or data-plane access', async () => {
    const localStorage = vi.spyOn(Storage.prototype, 'setItem');
    await renderInvestigation(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    await setInput('#investigation-samples', '60');
    await runAndSettle();
    await click('Capture comparison baseline');

    await click('Clear Lab session');

    expect(byId('#investigation-status').textContent).toBe('Not run');
    expect(session.getState().investigation.current).toBeUndefined();
    expect(session.getState().investigation.baseline).toBeUndefined();
    expect(localStorage).not.toHaveBeenCalled();
  });
});
