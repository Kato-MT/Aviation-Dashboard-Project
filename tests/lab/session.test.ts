import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import baselineCsv from '../../data/flight.csv?raw';
import { legacyCsvAdapter } from '../../src/adapters';
import { DEFAULT_INPUT_LIMITS } from '../../src/core';
import { LabSession, MAX_FAULT_SEED } from '../../src/features/lab/session';
import { LabSessionOwner } from '../../src/features/lab/owner';
import { DECLARED_FAULT_SCENARIOS } from '../../src/faults/scenarios';
import {
  genericFixedWingProfile,
  genericRotaryWingProfile,
  includedBaselineProfile,
} from '../../src/profiles';
import { generateSyntheticDocument } from '../../src/ui/generate';

let session: LabSession;
const baselineHash = 'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700';
beforeEach(() => {
  vi.useFakeTimers();
  session = new LabSession();
});
afterEach(() => {
  session.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingFile(name = 'older.csv') {
  let resolve!: (text: string) => void;
  const text = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  return { file: { name, size: 100, text }, resolve: (value: string) => resolve(value) };
}

describe('React Lab typed session', () => {
  it('constructs without starting work and exposes a stable external-store snapshot', async () => {
    const initial = session.getState();
    expect(session.getState()).toBe(initial);
    expect(initial.status).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await session.start();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    session.setReplayIndex(5);
    expect(listener).not.toHaveBeenCalled();
  });

  it('starts every exact advisory model disabled and keeps Configuration evidence in memory only', async () => {
    expect(session.getState()).toMatchObject({
      pointwiseModelSelection: {
        registryEntryId: 'generic-fixed-wing.robust-covariance',
        modelVersion: '1.0.0',
        intent: 'disabled',
      },
      temporalModelSelection: {
        registryEntryId: 'generic-fixed-wing.temporal-fault',
        modelVersion: '2.0.0',
        intent: 'disabled',
      },
      configurationStream: {
        phase: 'idle',
        sources: 0,
        receivedMessages: 0,
        sourceHealth: [],
        injectedFaultIds: [],
      },
    });
    await session.start();
    session.setModelSelection('robust-covariance', 'enabled');
    session.setModelSelection('temporal', 'enabled');
    session.setConfigurationStream({
      phase: 'complete',
      sources: 1,
      receivedMessages: 42,
      droppedMessages: 2,
      queueDepth: 0,
      reconnectAttempts: 0,
      maximumHeartbeatAgeMs: 120,
      sourceHealth: [
        {
          sourceId: 'synthetic-alpha',
          status: 'ended',
          receivedMessages: 42,
          duplicateMessages: 0,
          outOfOrderMessages: 0,
          missingMessages: 0,
          remoteQueueDepth: 0,
          remoteDroppedMessages: 2,
          localDroppedMessages: 0,
          reconnectAttempts: 0,
          heartbeatAgeMs: 120,
        },
      ],
      injectedFaultIds: ['latency', 'latency'],
    });
    session.stop();
    await session.start();
    expect(session.getState()).toMatchObject({
      pointwiseModelSelection: { intent: 'enabled' },
      temporalModelSelection: { intent: 'enabled' },
      configurationStream: {
        phase: 'complete',
        receivedMessages: 42,
        injectedFaultIds: ['latency'],
      },
    });
  });

  it('requires fresh pointwise opt-in after run or profile context changes', async () => {
    await session.start();
    session.setModelSelection('robust-covariance', 'enabled');
    session.setModelSelection('temporal', 'enabled');
    session.setProfile(genericFixedWingProfile.id);
    expect(session.getState().pointwiseModelSelection.intent).toBe('disabled');
    expect(session.getState().temporalModelSelection.intent).toBe('enabled');

    session.setModelSelection('robust-covariance', 'enabled');
    await session.loadGeneratedDemo();
    expect(session.getState().pointwiseModelSelection.intent).toBe('disabled');
    expect(session.getState().temporalModelSelection.intent).toBe('enabled');
  });

  it('bounds retained Configuration health and resets it on explicit session clear', async () => {
    await session.start();
    session.setModelSelection('temporal', 'enabled');
    session.setConfigurationStream({
      phase: 'failed',
      sources: 20,
      receivedMessages: 500,
      droppedMessages: 4,
      queueDepth: 3,
      reconnectAttempts: 0,
      maximumHeartbeatAgeMs: null,
      sourceHealth: Array.from({ length: 20 }, (_, index) => ({
        sourceId: `synthetic-${index}`,
        status: 'degraded',
        receivedMessages: 25,
        duplicateMessages: 0,
        outOfOrderMessages: 0,
        missingMessages: 0,
        remoteQueueDepth: 0,
        remoteDroppedMessages: 0,
        localDroppedMessages: 0,
        reconnectAttempts: 0,
      })),
      injectedFaultIds: Array.from({ length: 40 }, (_, index) => `fault-${index}`),
      issue: 'x'.repeat(700),
    });
    expect(session.getState().configurationStream.sourceHealth).toHaveLength(16);
    expect(session.getState().configurationStream.injectedFaultIds).toHaveLength(32);
    expect(session.getState().configurationStream.issue).toHaveLength(500);
    session.clear();
    expect(session.getState()).toMatchObject({
      pointwiseModelSelection: { intent: 'disabled' },
      temporalModelSelection: { intent: 'disabled' },
      configurationStream: { phase: 'idle', sourceHealth: [], injectedFaultIds: [] },
    });
  });

  it('preserves the exact golden dataset, rule findings and captured baseline', async () => {
    await session.start();
    const state = session.getState();
    expect(state.status).toBe('ready');
    expect(state.current?.run.samples).toHaveLength(85);
    expect(state.current?.run.quarantinedRows).toHaveLength(0);
    expect(state.current?.run.provenance.datasetSha256).toBe(baselineHash);
    const counts: Record<string, number> = {};
    for (const finding of state.current!.analysis.findings)
      counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
    expect(counts).toEqual({
      'baseline.overspeed': 5,
      'baseline.rapid-descent': 3,
      'baseline.fuel-change': 1,
    });
    expect(state.baseline?.run).toBe(state.current?.run);
    const current = state.current;
    await session.start();
    expect(session.getState().current).toBe(current);
  });

  it('invalidates an obsolete initial parse across stop/start', async () => {
    const oldStart = session.start();
    session.stop();
    const newStart = session.start();
    await Promise.all([oldStart, newStart]);
    expect(session.getState().status).toBe('ready');
    expect(session.getState().baseline?.run.provenance.datasetSha256).toBe(baselineHash);
  });

  it('rejects an oversized file before reading and clears active replay while retaining the captured baseline', async () => {
    await session.start();
    const baseline = session.getState().baseline;
    session.startReplay();
    const text = vi.fn(async () => baselineCsv);
    await session.loadFile({
      name: 'too-large.csv',
      size: DEFAULT_INPUT_LIMITS.maxBytes + 1,
      text,
    });
    expect(text).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({
      status: 'error',
      current: undefined,
      replayIndex: 0,
      replayPlaying: false,
      baseline,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -1])('rejects an invalid declared file size: %s', async (size) => {
    await session.start();
    const text = vi.fn(async () => '');
    await session.loadFile({ name: 'invalid.csv', size, text });
    expect(text).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('error');
  });

  it('checks decoded UTF-8 bytes even when a file reports a small size', async () => {
    await session.start();
    await session.loadFile({
      name: 'oversized.json',
      size: 10,
      text: async () => 'é'.repeat(DEFAULT_INPUT_LIMITS.maxBytes / 2 + 1),
    });
    expect(session.getState().status).toBe('error');
    expect(session.getState().current).toBeUndefined();
  });

  it('does not restore an old run when file reading fails', async () => {
    await session.start();
    await session.loadFile({
      name: 'unreadable.csv',
      size: 10,
      text: async () => {
        throw new Error('read failed');
      },
    });
    expect(session.getState().status).toBe('error');
    expect(session.getState().current).toBeUndefined();
    expect(session.getState().message).toContain('could not be read');
  });

  it('keeps fatal validation inspectable instead of displaying the previous analysis', async () => {
    await session.start();
    await session.loadText('{', 'json', 'Malformed JSON');
    expect(session.getState().status).toBe('blocked');
    expect(session.getState().current?.run.fatal).toBe(true);
    expect(session.getState().current?.analysis.blocked).toBe(true);
    expect(session.getState().current?.run.validationIssues.length).toBeGreaterThan(0);
    expect(session.getState().current?.run.provenance.datasetSha256).not.toBe(baselineHash);
  });

  it('contains unexpected adapter failure and permits the next load', async () => {
    await session.start();
    vi.spyOn(legacyCsvAdapter, 'parse').mockRejectedValueOnce(
      new Error('controlled parser failure'),
    );
    await session.loadIncludedBaseline();
    expect(session.getState().status).toBe('error');
    await session.loadIncludedBaseline();
    expect(session.getState().status).toBe('ready');
  });

  it('rejects completion of an older import after a newer load', async () => {
    await session.start();
    const older = pendingFile();
    const pending = session.loadFile(older.file);
    await session.loadText(baselineCsv, 'csv', 'Newer accepted input');
    const accepted = session.getState().current;
    older.resolve('invalid older input');
    await pending;
    expect(session.getState().current).toBe(accepted);
    expect(session.getState().current?.label).toBe('Newer accepted input');
  });

  it('rejects file completion after route exit while preserving the captured baseline', async () => {
    await session.start();
    const baseline = session.getState().baseline;
    const older = pendingFile();
    const pending = session.loadFile(older.file);
    session.stop();
    older.resolve(baselineCsv);
    await pending;
    expect(session.getState()).toMatchObject({
      status: 'idle',
      current: undefined,
      baseline,
      candidate: undefined,
      verification: undefined,
    });
    session.stop();
    await session.start();
    expect(session.getState().current).toBeUndefined();
    expect(session.getState().baseline).toBe(baseline);
  });

  it('retains loaded data, profile, cursor and export choice across navigation without resuming work', async () => {
    await session.start();
    const baseline = session.getState().baseline;
    session.setProfile(genericRotaryWingProfile.id);
    await session.loadGeneratedDemo();
    session.setSourceExport(true);
    session.setReplayInterval(600);
    session.setReplayIndex(12);
    session.startReplay();
    const current = session.getState().current;
    session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(session.getState()).toMatchObject({
      status: 'ready',
      current,
      baseline,
      profile: genericRotaryWingProfile,
      replayIndex: 12,
      replayPlaying: false,
      replayInterval: 600,
      includeSourceData: true,
    });
    const retained = session.getState();
    await session.start();
    expect(session.getState()).toBe(retained);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.getState()).toBe(retained);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explicitly clears retained data, cancels pending imports and stays empty on return', async () => {
    await session.start();
    session.setSourceExport(true);
    const older = pendingFile();
    const pending = session.loadFile(older.file);
    session.clear();
    older.resolve(baselineCsv);
    await pending;
    expect(session.getState()).toMatchObject({
      status: 'idle',
      current: undefined,
      baseline: undefined,
      candidate: undefined,
      verification: undefined,
      replayIndex: 0,
      replayPlaying: false,
      includeSourceData: false,
    });
    const cleared = session.getState();
    session.stop();
    await session.start();
    expect(session.getState()).toBe(cleared);
    await session.loadIncludedBaseline();
    expect(session.getState().current?.run.samples).toHaveLength(85);
  });

  it('keeps a failed import visible after returning instead of silently loading another dataset', async () => {
    await session.start();
    await session.loadFile({ name: 'oversized.csv', size: Infinity, text: vi.fn() });
    const failed = session.getState();
    session.stop();
    await session.start();
    expect(session.getState()).toBe(failed);
    expect(failed.status).toBe('error');
  });

  it('preserves the latest selected profile when a pending import is superseded', async () => {
    await session.start();
    const older = pendingFile();
    const pending = session.loadFile(older.file);
    session.setProfile(genericRotaryWingProfile.id);
    older.resolve(baselineCsv);
    await pending;
    expect(session.getState().profile).toBe(genericRotaryWingProfile);
    expect(session.getState().current).toBeUndefined();
  });

  it('uses declared JSON profiles, forces the preserved CSV profile and generates the chosen synthetic category', async () => {
    await session.start();
    await session.loadGeneratedDemo();
    expect(session.getState().profile).toBe(genericFixedWingProfile);
    expect(session.getState().current?.inputFormat).toBe('generated');
    session.setProfile(genericRotaryWingProfile.id);
    await session.loadGeneratedDemo();
    expect(session.getState().profile).toBe(genericRotaryWingProfile);
    await session.loadFile({
      name: 'fixed.JSON',
      size: 100,
      text: async () => generateSyntheticDocument(genericFixedWingProfile),
    });
    expect(session.getState().profile).toBe(genericFixedWingProfile);
    await session.loadText(baselineCsv, 'csv', 'CSV baseline');
    expect(session.getState().profile).toBe(includedBaselineProfile);
    const previous = session.getState();
    session.setProfile('unknown-profile');
    session.setProfile(includedBaselineProfile.id);
    expect(session.getState()).toBe(previous);
  });

  it('reanalyzes without replacing source provenance or the captured baseline', async () => {
    await session.start();
    const baseline = session.getState().baseline;
    const run = session.getState().current!.run;
    session.setProfile(genericFixedWingProfile.id);
    expect(session.getState().current?.run).toBe(run);
    expect(session.getState().current?.analysis.profileId).toBe(genericFixedWingProfile.id);
    expect(session.getState().baseline).toBe(baseline);
  });

  it('captures an equivalent candidate as a passing comparison with persisting findings', async () => {
    await session.start();
    expect(session.getState().baseline?.label).toContain('Included 85-record');
    session.captureCandidate();
    expect(session.getState().candidate?.run).toBe(session.getState().current?.run);
    expect(session.getState().verification).toMatchObject({
      schemaVersion: 'verification.v2',
      status: 'pass',
      summary: { resolved: 0, persisting: 9, newlyIntroduced: 0 },
    });
    expect(session.getState().comparisonIssue).toBeUndefined();
  });

  it('detects an introduced candidate finding and preserves the captured candidate snapshot', async () => {
    await session.start();
    const changed = baselineCsv.replace('00:10,800,120,99.6', '00:10,800,999,99.6');
    expect(changed).not.toBe(baselineCsv);
    await session.loadText(changed, 'csv', 'Overspeed candidate');
    const current = session.getState().current;
    session.captureCandidate();
    expect(session.getState().candidate).toMatchObject({
      run: current?.run,
      analysis: current?.analysis,
      label: 'Overspeed candidate',
    });
    expect(session.getState().verification?.status).toBe('fail');
    expect(session.getState().verification?.summary.newlyIntroduced).toBeGreaterThan(0);
  });

  it('completes a blocked comparison for fatal candidate validation evidence', async () => {
    await session.start();
    await session.loadText('{', 'json', 'Malformed candidate');
    session.captureCandidate();
    expect(session.getState().candidate?.analysis.blocked).toBe(true);
    expect(session.getState().verification?.status).toBe('blocked');
    expect(session.getState().comparisonIssue).toBeUndefined();
  });

  it('retains incompatible candidate evidence while reporting that comparison is unavailable', async () => {
    await session.start();
    await session.loadGeneratedDemo();
    session.captureCandidate();
    expect(session.getState().candidate?.label).toContain('generated run');
    expect(session.getState().verification).toBeUndefined();
    expect(session.getState().comparisonIssue).toContain('same profile ID and version');
  });

  it('recapturing the baseline clears stale comparison evidence', async () => {
    await session.start();
    session.captureCandidate();
    expect(session.getState().verification).toBeDefined();
    const current = session.getState().current;
    session.captureBaseline();
    expect(session.getState()).toMatchObject({
      baseline: { run: current?.run, analysis: current?.analysis, label: current?.label },
      candidate: undefined,
      verification: undefined,
      comparisonIssue: undefined,
    });
  });

  it('retains Diagnostics controls and normalizes stale dynamic filters for a new run', async () => {
    await session.start();
    session.setDiagnosticsFilters({
      severity: 'error',
      ruleId: 'missing-rule',
      sourceId: 'missing-source',
      search: 'descent',
    });
    session.setFaultScenario('range-excursion');
    session.setFaultSeed('42');
    await session.loadIncludedBaseline();
    expect(session.getState()).toMatchObject({
      diagnosticsFilters: {
        severity: 'error',
        ruleId: 'all',
        sourceId: 'all',
        search: 'descent',
      },
      faultScenarioId: 'range-excursion',
      faultSeed: '42',
    });
    session.clearDiagnosticsFilters();
    expect(session.getState().diagnosticsFilters).toEqual({
      severity: 'all',
      ruleId: 'all',
      sourceId: 'all',
      search: '',
    });
  });

  it('atomically creates a deterministic canonical candidate and its Verification result', async () => {
    await session.start();
    const source = session.getState().current!;
    session.setFaultScenario('range-excursion');
    session.setFaultSeed('42');
    session.startReplay();
    expect(await session.createFaultCandidate()).toBe(true);
    const first = session.getState();
    expect(first).toMatchObject({
      status: 'ready',
      faultStatus: 'idle',
      faultIssue: undefined,
      replayIndex: 0,
      replayPlaying: false,
      baseline: { run: source.run, analysis: source.analysis, label: source.label },
      current: { inputFormat: 'injected', label: 'Range excursion · seed 42' },
      candidate: { label: 'Range excursion · seed 42' },
      verification: { schemaVersion: 'verification.v2', status: 'fail' },
    });
    expect(first.current?.run).toBe(first.candidate?.run);
    expect(first.current?.run.provenance.datasetSha256).not.toBe(
      source.run.provenance.datasetSha256,
    );
    expect(vi.getTimerCount()).toBe(0);
    const candidateHash = first.current!.run.provenance.datasetSha256;

    session.clear();
    await session.loadIncludedBaseline();
    session.setFaultScenario('range-excursion');
    session.setFaultSeed('42');
    expect(await session.createFaultCandidate()).toBe(true);
    expect(session.getState().current?.run.provenance.datasetSha256).toBe(candidateHash);
  });

  it('creates a row-level CSV candidate with quarantined evidence and no baseline mutation', async () => {
    await session.start();
    const source = session.getState().current!;
    session.setFaultScenario('nonnumeric-csv-value');
    session.setFaultSeed('1337');
    expect(await session.createFaultCandidate()).toBe(true);
    const state = session.getState();
    expect(source.run.quarantinedRows).toHaveLength(0);
    expect(state.current?.run.quarantinedRows).toHaveLength(1);
    expect(state.current?.run.quarantinedRows[0]?.issues[0]?.code).toBe('NONNUMERIC_VALUE');
    expect(state.baseline?.run).toBe(source.run);
    expect(state.candidate?.run).toBe(state.current?.run);
    expect(state.verification).toBeDefined();
  });

  it.each(DECLARED_FAULT_SCENARIOS)(
    'publishes complete deterministic session evidence for $id',
    async (scenario) => {
      await session.start();
      const source = session.getState().current!;
      const sourceRunSnapshot = structuredClone(source.run);
      const sourceAnalysisSnapshot = structuredClone(source.analysis);
      const sourceText = source.sourceText;

      session.setFaultScenario(scenario.id);
      session.setFaultSeed('20260829');
      session.startReplay();
      expect(await session.createFaultCandidate()).toBe(true);

      const state = session.getState();
      expect(state.baseline).toMatchObject({
        run: source.run,
        analysis: source.analysis,
        label: source.label,
      });
      expect(state.current?.run).toBe(state.candidate?.run);
      expect(state.current?.analysis).toBe(state.candidate?.analysis);
      expect(state.current).toMatchObject({
        inputFormat: 'injected',
        label: `${scenario.label} · seed 20260829`,
      });
      expect(state.current?.run.metadata?.injectedFault).toEqual({
        scenarioId: scenario.id,
        seed: 20260829,
        target: scenario.target,
        expectedRuleIds: [...scenario.expectedRuleIds],
        synthetic: true,
      });
      expect(state.faultStatus).toBe('idle');
      expect(state.faultIssue).toBeUndefined();
      expect(state.replayPlaying).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      if (scenario.target === 'legacy-csv') {
        expect(state.current?.sourceText).toBeDefined();
        expect(state.current?.sourceText).not.toBe(sourceText);
      } else {
        expect(state.current?.sourceText).toBeUndefined();
      }
      expect(state.verification).toBeDefined();
      expect(state.comparisonIssue).toBeUndefined();

      expect(source.run).toEqual(sourceRunSnapshot);
      expect(source.analysis).toEqual(sourceAnalysisSnapshot);
      expect(source.sourceText).toBe(sourceText);
    },
  );

  it.each(['0', '-1', '1.5', 'not-a-number', String(MAX_FAULT_SEED + 1)])(
    'rejects invalid fault seed %s without changing prior run or comparison evidence',
    async (seed) => {
      await session.start();
      session.captureCandidate();
      const before = session.getState();
      session.setFaultSeed(seed);
      expect(await session.createFaultCandidate()).toBe(false);
      const after = session.getState();
      expect(after.current).toBe(before.current);
      expect(after.baseline).toBe(before.baseline);
      expect(after.candidate).toBe(before.candidate);
      expect(after.verification).toBe(before.verification);
      expect(after.faultIssue).toContain('whole-number seed');
    },
  );

  it('rejects candidate creation without a usable accepted run', async () => {
    await session.start();
    session.clear();
    expect(await session.createFaultCandidate()).toBe(false);
    expect(session.getState().faultIssue).toContain('Load and validate');

    await session.loadText('{', 'json', 'Malformed candidate source');
    const blocked = session.getState().current;
    expect(blocked?.analysis.blocked).toBe(true);
    expect(await session.createFaultCandidate()).toBe(false);
    expect(session.getState().current).toBe(blocked);
    expect(session.getState().faultIssue).toContain('nonfatal run with accepted synthetic samples');
  });

  it('contains an incompatible row-level scenario without replacing a generated source', async () => {
    await session.start();
    await session.loadGeneratedDemo();
    const before = session.getState();
    session.setFaultScenario('blank-csv-value');
    expect(await session.createFaultCandidate()).toBe(false);
    expect(session.getState().current).toBe(before.current);
    expect(session.getState().baseline).toBe(before.baseline);
    expect(session.getState().candidate).toBe(before.candidate);
    expect(session.getState().faultIssue).toContain('requires a legacy CSV source');
  });

  it('contains an unexpected candidate adapter failure without replacing settled evidence', async () => {
    await session.start();
    session.captureCandidate();
    const before = session.getState();
    session.setFaultScenario('blank-csv-value');
    vi.spyOn(legacyCsvAdapter, 'parse').mockRejectedValueOnce(
      new Error('Synthetic candidate adapter failure.'),
    );

    expect(await session.createFaultCandidate()).toBe(false);

    const after = session.getState();
    expect(after.current).toBe(before.current);
    expect(after.baseline).toBe(before.baseline);
    expect(after.candidate).toBe(before.candidate);
    expect(after.verification).toBe(before.verification);
    expect(after.comparisonIssue).toBe(before.comparisonIssue);
    expect(after.faultStatus).toBe('idle');
    expect(after.faultIssue).toBe('Synthetic candidate adapter failure.');
  });

  it('cancels a pending fault candidate on route exit without publishing partial evidence', async () => {
    await session.start();
    const before = session.getState();
    session.setFaultScenario('range-excursion');
    const pending = session.createFaultCandidate();
    session.stop();
    expect(await pending).toBe(false);
    expect(session.getState().current).toBe(before.current);
    expect(session.getState().candidate).toBe(before.candidate);
    expect(session.getState().verification).toBe(before.verification);
    expect(session.getState()).toMatchObject({
      faultStatus: 'idle',
      replayPlaying: false,
      faultIssue: 'Fault candidate creation was cancelled when the Lab closed.',
    });
  });

  it('cancels a pending fault candidate when Diagnostics closes without late publication', async () => {
    await session.start();
    session.captureCandidate();
    const before = session.getState();
    expect(before.candidate).toBeDefined();
    expect(before.verification).toBeDefined();
    session.setFaultScenario('range-excursion');

    const pending = session.createFaultCandidate();
    expect(session.getState().faultStatus).toBe('injecting');
    session.cancelFaultCandidate();

    expect(await pending).toBe(false);
    await Promise.resolve();
    const after = session.getState();
    expect(after.current).toBe(before.current);
    expect(after.baseline).toBe(before.baseline);
    expect(after.candidate).toBe(before.candidate);
    expect(after.verification).toBe(before.verification);
    expect(after).toMatchObject({
      faultStatus: 'idle',
      faultIssue: 'Fault candidate creation was cancelled when Diagnostics closed.',
      message: 'The pending fault candidate was cancelled when Diagnostics closed.',
    });
  });

  it('has one replay timer, preserves reset semantics, clamps scrubs and stops at the end', async () => {
    await session.start();
    session.startReplay();
    session.startReplay();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(session.getState().replayIndex).toBe(2);
    session.setReplayIndex(0);
    expect(session.getState().replayPlaying).toBe(true);
    session.scrub(33.9);
    expect(session.getState()).toMatchObject({ replayIndex: 33, replayPlaying: false });
    session.setReplayIndex(-5);
    expect(session.getState().replayIndex).toBe(0);
    session.setReplayIndex(999);
    expect(session.getState().replayIndex).toBe(84);
    session.setReplayIndex(NaN);
    expect(session.getState().replayIndex).toBe(84);
    session.startReplay();
    expect(session.getState().replayIndex).toBe(0);
    session.setReplayIndex(84);
    await vi.advanceTimersByTimeAsync(300);
    expect(session.getState().replayPlaying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads a bounded replay pace when playback starts', async () => {
    await session.start();
    session.setReplayInterval(150);
    session.setReplayInterval(5);
    expect(session.getState().replayInterval).toBe(150);
    session.startReplay();
    await vi.advanceTimersByTimeAsync(150);
    expect(session.getState().replayIndex).toBe(1);
    session.setReplayInterval(600);
    await vi.advanceTimersByTimeAsync(150);
    expect(session.getState().replayIndex).toBe(2);
    session.pauseReplay();
    session.startReplay();
    await vi.advanceTimersByTimeAsync(599);
    expect(session.getState().replayIndex).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getState().replayIndex).toBe(3);
  });

  it('seeks by original sample identity and ignores non-sample findings', async () => {
    await session.start();
    const finding = session
      .getState()
      .current!.analysis.findings.find((value) => value.sampleIndex !== undefined)!;
    session.seekFinding(finding);
    expect(
      session.getState().current?.run.samples[session.getState().replayIndex]?.sampleIndex,
    ).toBe(finding.sampleIndex);
    const before = session.getState().replayIndex;
    session.seekFinding({ ...finding, sampleIndex: undefined });
    session.seekFinding({ ...finding, sampleIndex: -50 });
    expect(session.getState().replayIndex).toBe(before);
  });

  it('does not allow inactive actions to start work or replace retained data', async () => {
    const initial = session.getState();
    await session.loadIncludedBaseline();
    await session.loadGeneratedDemo();
    await session.loadFile({ name: 'ignored.csv', size: 0, text: async () => '' });
    await session.loadText(baselineCsv, 'csv', 'ignored');
    session.setProfile(genericFixedWingProfile.id);
    session.setReplayIndex(4);
    session.setReplayInterval(600);
    session.setSourceExport(true);
    session.startReplay();
    session.pauseReplay();
    session.captureBaseline();
    session.captureCandidate();
    session.setDiagnosticsFilters({ severity: 'critical', search: 'ignored' });
    session.clearDiagnosticsFilters();
    session.setFaultScenario('range-excursion');
    session.setFaultSeed('42');
    await session.createFaultCandidate();
    expect(session.getState()).toBe(initial);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create a replay timer if a reset subscriber closes the Lab', async () => {
    await session.start();
    session.setReplayIndex(84);
    const unsubscribe = session.subscribe(() => session.stop());
    session.startReplay();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    expect(session.getState().replayPlaying).toBe(false);
  });
});

describe('lazy Lab ownership', () => {
  it('constructs no session until requested and shares it across route mounts', async () => {
    const owner = new LabSessionOwner();
    const create = vi.fn(() => session);
    owner.stop();
    expect(create).not.toHaveBeenCalled();
    expect(owner.acquire(create)).toBe(session);
    expect(owner.acquire(create)).toBe(session);
    expect(create).toHaveBeenCalledOnce();
    await session.start();
    session.startReplay();
    owner.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(owner.acquire(create).getState().current?.run.samples).toHaveLength(85);
    expect(create).toHaveBeenCalledOnce();
  });
});
