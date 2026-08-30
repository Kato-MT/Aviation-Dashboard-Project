// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APPLICATION_VERSION } from '../../src/core/constants';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';
import type { ConfigurationReportV1 } from '../../src/export/configurationReport';
import { LabApp } from '../../src/features/lab/LabApp';
import { LabSession } from '../../src/features/lab/session';
import {
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
} from '../../src/model-registry';

const ui = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock('../../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/dom')>()),
  downloadText: ui.download,
}));

const buildIdentity: Readonly<EvidenceBuildIdentity> = Object.freeze({
  applicationVersion: '3.0.0-react-test',
  releaseSha: 'configuration-view-release',
  releaseStatus: 'exact-release',
  buildTarget: 'react-test',
});

let root: Root | undefined;
let container: HTMLDivElement;
let session: LabSession;
let createSession: ReturnType<typeof vi.fn<() => LabSession>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Configuration must remain network-free.');
    }),
  );
  session = new LabSession();
  createSession = vi.fn(() => session);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  expect(vi.getTimerCount()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function configurationApp(): ReactNode {
  return (
    <LabApp createSession={createSession} subview="configuration" buildIdentity={buildIdentity} />
  );
}

async function renderConfiguration(strict = false): Promise<void> {
  await act(async () => {
    root?.render(strict ? <StrictMode>{configurationApp()}</StrictMode> : configurationApp());
  });
  await settleConfiguration();
}

async function settleConfiguration(): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      expect(session.getState().status).toBe('ready');
      expect(definitionValue('Quality gate', section('#config-pointwise-title'))).toBe('passed');
      expect(byId('#temporal-model-state').textContent).toBe('Supported, user disabled');
    });
  });
}

function byId<T extends Element = HTMLElement>(selector: string): T {
  const result = container.querySelector<T>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}

function section(headingSelector: string): HTMLElement {
  const result = byId(headingSelector).closest<HTMLElement>('section');
  expect(result, headingSelector).not.toBeNull();
  return result!;
}

function definitionValue(label: string, scope: ParentNode = container): string | null {
  const term = [...scope.querySelectorAll('dt')].find((entry) => entry.textContent === label);
  expect(term, label).toBeDefined();
  return term!.parentElement?.querySelector('dd')?.textContent ?? null;
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}

async function clickButton(label: string): Promise<void> {
  await act(async () => button(label).click());
}

async function clickCheckbox(selector: string): Promise<void> {
  await act(async () => byId<HTMLInputElement>(selector).click());
}

async function selectValue(selector: string, value: string): Promise<void> {
  const select = byId<HTMLSelectElement>(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  expect(setter).toBeDefined();
  await act(async () => {
    setter!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function generateFixedWingRun(): Promise<void> {
  await clickButton('Generate synthetic demo');
  await act(async () => {
    await vi.waitFor(() => {
      expect(session.getState().status).toBe('ready');
      expect(session.getState().profile.id).toBe('generic-fixed-wing');
      expect(byId('#model-state').textContent).toBe('Supported, user disabled');
    });
  });
}

function downloadedConfiguration(): ConfigurationReportV1 {
  const call = ui.download.mock.calls.at(-1);
  expect(call).toBeDefined();
  expect(call![0]).toMatch(/^configuration-.+\.json$/u);
  expect(call![2]).toBe('application/json');
  return JSON.parse(call![1] as string) as ConfigurationReportV1;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) collectKeys(child, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe('React Configuration evidence and lifecycle', () => {
  it('renders exact build, model, profile, rule, provenance, and adapter mapping evidence', async () => {
    await renderConfiguration();

    expect(definitionValue('React shell')).toBe(buildIdentity.applicationVersion);
    expect(definitionValue('Build identity')).toBe(buildIdentity.releaseSha);
    expect(definitionValue('Deterministic engine')).toBe(APPLICATION_VERSION);
    expect(byId('#config-schema').textContent).toBe('telemetry.v1');
    expect(byId('#config-adapter').textContent).toBe('legacy-csv@2.0.0');
    expect(byId('#config-profile').textContent).toBe('Included Baseline');
    expect(byId('#config-profile-version').textContent).toBe('1.0.0');
    expect(byId('#config-hash').textContent).toBe(
      'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
    );

    expect(byId('#temporal-registry-entry').textContent).toBe(
      'generic-fixed-wing.temporal-fault@2.0.0',
    );
    expect(byId('#temporal-artifact-hash').textContent).toBe(
      temporalFaultRegistryEntry.identities.artifactSha256,
    );
    expect(byId('#temporal-config-hash').textContent).toBe(
      temporalFaultRegistryEntry.identities.configurationSha256,
    );
    expect(container.textContent).toContain(
      robustCovarianceRegistryEntry.identities.artifactSha256,
    );
    expect(container.textContent).toContain(
      robustCovarianceRegistryEntry.identities.configurationSha256,
    );

    const mappingTable = [...container.querySelectorAll('table')].find(
      (table) =>
        table.querySelector('caption')?.textContent === 'Adapter field and unit mapping evidence',
    );
    expect(mappingTable?.textContent).toContain('altitude_ft');
    expect(mappingTable?.textContent).toContain('adapter-default');
    expect(container.textContent).toContain('speed kts · adapter-default');
    expect(byId('#rule-count').textContent).toBe('12');
    const rapidDescent = [...byId('#rules-body').querySelectorAll('tr')].find((row) =>
      row.textContent?.includes('baseline.rapid-descent'),
    );
    expect(rapidDescent?.textContent).toContain('decrease altitude <= 900 in 20s');
    expect(section('#config-profile-title').textContent).toContain('altitudeftYes0 to 60000');
  });

  it('keeps all advisory models off by default and fails pointwise eligibility closed', async () => {
    await renderConfiguration();

    const pointwise = byId<HTMLInputElement>('#learned-model-enabled');
    const temporal = byId<HTMLInputElement>('#temporal-model-enabled');
    expect(session.getState().pointwiseModelSelection.intent).toBe('disabled');
    expect(session.getState().temporalModelSelection.intent).toBe('disabled');
    expect(pointwise.checked).toBe(false);
    expect(pointwise.disabled).toBe(true);
    expect(byId('#model-state').textContent).toBe('Ineligible, disabled');
    expect(temporal.checked).toBe(false);
    expect(temporal.disabled).toBe(false);
    expect(byId('#temporal-model-state').textContent).toBe('Supported, user disabled');
  });

  it('activates verified temporal evidence only after explicit user opt-in', async () => {
    await renderConfiguration();
    const temporal = byId<HTMLInputElement>('#temporal-model-enabled');

    await clickCheckbox('#temporal-model-enabled');

    expect(temporal.checked).toBe(true);
    expect(session.getState().temporalModelSelection.intent).toBe('enabled');
    expect(byId('#temporal-model-state').textContent).toBe('Supported and active');
    expect(definitionValue('Authority', section('#config-temporal-title'))).toBe(
      'Deterministic rules',
    );
  });

  it('activates robust pointwise comparison only for a compatible generated fixed-wing run', async () => {
    await renderConfiguration();
    await generateFixedWingRun();
    const pointwise = byId<HTMLInputElement>('#learned-model-enabled');

    expect(pointwise.disabled).toBe(false);
    expect(pointwise.checked).toBe(false);
    await clickCheckbox('#learned-model-enabled');

    expect(pointwise.checked).toBe(true);
    expect(session.getState().pointwiseModelSelection.intent).toBe('enabled');
    expect(byId('#model-state').textContent).toBe('Supported and active');
    expect(byId('#model-score').textContent).toContain('active advisory');
  });

  it('resets pointwise selection when the run or selected profile context changes', async () => {
    await renderConfiguration();
    await clickCheckbox('#temporal-model-enabled');
    await generateFixedWingRun();
    await clickCheckbox('#learned-model-enabled');
    expect(session.getState().pointwiseModelSelection.intent).toBe('enabled');
    expect(session.getState().temporalModelSelection.intent).toBe('enabled');

    await selectValue('#profile-select', 'generic-rotary-wing');

    expect(session.getState().profile.id).toBe('generic-rotary-wing');
    expect(session.getState().pointwiseModelSelection.intent).toBe('disabled');
    expect(byId<HTMLInputElement>('#learned-model-enabled').checked).toBe(false);
    expect(byId<HTMLInputElement>('#learned-model-enabled').disabled).toBe(true);
    expect(byId('#model-state').textContent).toBe('Ineligible, disabled');
    expect(session.getState().temporalModelSelection.intent).toBe('enabled');
    expect(byId('#temporal-model-state').textContent).toBe('Supported and active');
    expect(container.textContent).toContain(
      'The selected analysis profile differs from the run-declared profile.',
    );
  });

  it('exports minimized Configuration evidence even when diagnostic source export is enabled', async () => {
    await renderConfiguration();
    await clickCheckbox('#include-source-export');
    await act(async () => {
      session.setConfigurationStream({
        phase: 'stopped',
        sources: 1,
        receivedMessages: 12,
        droppedMessages: 2,
        queueDepth: 0,
        reconnectAttempts: 1,
        maximumHeartbeatAgeMs: 30,
        sourceHealth: [
          {
            sourceId: 'PRIVATE_SOURCE_SENTINEL',
            status: 'nominal',
            receivedMessages: 12,
            duplicateMessages: 0,
            outOfOrderMessages: 0,
            missingMessages: 0,
            remoteQueueDepth: 0,
            remoteDroppedMessages: 0,
            localDroppedMessages: 0,
            reconnectAttempts: 1,
          },
        ],
        injectedFaultIds: ['latency'],
        issue: 'wss://PRIVATE_ENDPOINT_SENTINEL',
      });
    });

    await clickButton('Export minimized configuration JSON');
    const report = downloadedConfiguration();
    const serialized = JSON.stringify(report);
    const keys = collectKeys(report);

    expect(session.getState().includeSourceData).toBe(true);
    expect(report.exportPolicy).toEqual({
      sourceDataIncluded: false,
      streamPayloadsIncluded: false,
      note: 'Uploaded source data, stream payloads, per-source state, and browser state are excluded.',
    });
    expect(report.run.state).toBe('ready');
    expect(report.simulator).toMatchObject({
      phase: 'stopped',
      aggregateTotals: { sourceCount: 1, receivedMessages: 12, droppedMessages: 2 },
      injectedFaultIds: ['latency'],
    });
    expect(report.models.find((model) => model.family === 'temporal')).toMatchObject({
      key: 'generic-fixed-wing.temporal-fault@2.0.0',
      identityVerification: { artifact: 'verified', configuration: 'verified' },
      active: false,
      authority: 'deterministic-rules',
    });
    for (const forbidden of [
      'samples',
      'sources',
      'raw',
      'sourceText',
      'sourceHealth',
      'sourceId',
      'measurements',
      'payloads',
      'browserState',
      'issue',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(serialized).not.toContain('PRIVATE_SOURCE_SENTINEL');
    expect(serialized).not.toContain('PRIVATE_ENDPOINT_SENTINEL');
  });

  it('starts, stops, restarts, and disposes simulator resources when Configuration unmounts', async () => {
    await renderConfiguration();
    expect(vi.getTimerCount()).toBe(0);

    await clickButton('Run in-browser demo');
    expect(byId('#stream-state').textContent).toBe('Demo active');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await clickButton('Stop simulator');
    expect(byId('#stream-state').textContent).toBe('Stopped');
    expect(session.getState().configurationStream.phase).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);

    await clickButton('Run in-browser demo');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => {
      root?.render(
        <LabApp
          createSession={createSession}
          subview="diagnostics"
          buildIdentity={buildIdentity}
        />,
      );
    });

    expect(session.getState().configurationStream.phase).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts under StrictMode and releases every simulator timer on unmount', async () => {
    await renderConfiguration(true);

    await clickButton('Run in-browser demo');
    expect(byId('#stream-state').textContent).toBe('Demo active');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => root?.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
