import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defaultInvestigationRunner,
  type InvestigationRunner,
  type InvestigationSettledSnapshot,
} from '../../src/features/lab/investigation';
import { LabSession } from '../../src/features/lab/session';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function activeSession(runner: InvestigationRunner = defaultInvestigationRunner) {
  const session = new LabSession({
    investigationRunner: runner,
    now: () => '2026-08-29T12:00:00.000Z',
  });
  await session.start();
  return session;
}

let snapshot60: InvestigationSettledSnapshot;
let snapshot80: InvestigationSettledSnapshot;

beforeAll(async () => {
  snapshot60 = await defaultInvestigationRunner(
    { scenarioId: 'gradual-drift', seed: 3101, sampleCount: 60, cadenceMs: 1_000 },
    { robustCovariance: 'disabled', temporalModel: 'disabled' },
  );
  snapshot80 = await defaultInvestigationRunner(
    { scenarioId: 'gradual-drift', seed: 3102, sampleCount: 80, cadenceMs: 1_000 },
    { robustCovariance: 'disabled', temporalModel: 'disabled' },
  );
});

describe('LabSession Investigation ownership', () => {
  it('starts with the exact legacy request defaults and no retained result', async () => {
    const session = await activeSession();

    expect(session.getState().investigation).toMatchObject({
      scenarioId: 'gradual-drift',
      seedInput: '3101',
      sampleCountInput: '180',
      work: { phase: 'idle' },
      current: undefined,
      baseline: undefined,
      cursorPosition: 0,
      resultSettingsStale: false,
    });
    expect(Object.values(session.getState().investigation.overlays).every(Boolean)).toBe(true);
    session.stop();
  });

  it('validates controls before work and preserves settled evidence after an invalid request', async () => {
    const runner = vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60);
    const session = await activeSession(runner);
    session.setInvestigationSampleCountInput('60');
    expect(await session.runInvestigation()).toBe(true);
    const settled = session.getState().investigation.current;

    session.setInvestigationSeedInput('0');
    expect(await session.runInvestigation()).toBe(false);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(session.getState().investigation.current).toBe(settled);
    expect(session.getState().investigation.work).toEqual({
      phase: 'failed',
      issue: 'Investigation seed must be between 1 and 2147483647.',
    });
    session.stop();
  });

  it('publishes one immutable result atomically and selects the injected fault onset', async () => {
    const session = await activeSession(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    session.setInvestigationSampleCountInput('60');

    expect(await session.runInvestigation()).toBe(true);

    const state = session.getState().investigation;
    expect(state.work).toEqual({ phase: 'idle' });
    expect(state.current).toBe(snapshot60);
    expect(state.current?.analysis.points[state.cursorPosition]?.sampleIndex).toBe(
      snapshot60.scenario.faultTimeline?.onsetIndex,
    );
    expect(Object.isFrozen(state.current)).toBe(true);
    session.stop();
  });

  it('lets a newer run supersede an older run and ignores both late resolution and rejection', async () => {
    const first = deferred<InvestigationSettledSnapshot>();
    const second = deferred<InvestigationSettledSnapshot>();
    const runner = vi
      .fn<InvestigationRunner>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const session = await activeSession(runner);
    session.setInvestigationSampleCountInput('60');

    const firstRun = session.runInvestigation();
    session.setInvestigationSeedInput('3102');
    session.setInvestigationSampleCountInput('80');
    const secondRun = session.runInvestigation();
    second.resolve(snapshot80);
    expect(await secondRun).toBe(true);
    first.resolve(snapshot60);
    expect(await firstRun).toBe(false);

    expect(session.getState().investigation.current).toBe(snapshot80);
    expect(session.getState().investigation.work).toEqual({ phase: 'idle' });

    const third = deferred<InvestigationSettledSnapshot>();
    const fourth = deferred<InvestigationSettledSnapshot>();
    const rejectingRunner = vi
      .fn<InvestigationRunner>()
      .mockImplementationOnce(() => third.promise)
      .mockImplementationOnce(() => fourth.promise);
    const rejectingSession = await activeSession(rejectingRunner);
    rejectingSession.setInvestigationSampleCountInput('60');
    const staleFailure = rejectingSession.runInvestigation();
    rejectingSession.setInvestigationSeedInput('3102');
    rejectingSession.setInvestigationSampleCountInput('80');
    const currentRun = rejectingSession.runInvestigation();
    fourth.resolve(snapshot80);
    expect(await currentRun).toBe(true);
    third.reject(new Error('PRIVATE_STALE_FAILURE'));
    expect(await staleFailure).toBe(false);
    expect(rejectingSession.getState().investigation.current).toBe(snapshot80);
    expect(JSON.stringify(rejectingSession.getState())).not.toContain('PRIVATE_STALE_FAILURE');
    session.stop();
    rejectingSession.stop();
  });

  it('cancels hidden work, retains settled evidence, and never resumes it automatically', async () => {
    const pending = deferred<InvestigationSettledSnapshot>();
    const runner = vi
      .fn<InvestigationRunner>()
      .mockResolvedValueOnce(snapshot60)
      .mockImplementationOnce(() => pending.promise);
    const session = await activeSession(runner);
    session.setInvestigationSampleCountInput('60');
    expect(await session.runInvestigation()).toBe(true);
    session.setInvestigationSeedInput('3102');
    const hiddenRun = session.runInvestigation();

    session.leaveInvestigation('Investigation closed');
    expect(session.getState().investigation.work).toEqual({
      phase: 'idle',
      issue: 'Investigation closed. Pending analysis was cancelled.',
    });
    pending.resolve(snapshot80);
    expect(await hiddenRun).toBe(false);
    expect(session.getState().investigation.current).toBe(snapshot60);
    expect(runner).toHaveBeenCalledTimes(2);
    session.stop();
    await session.start();
    expect(runner).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it('invalidates pending work on stop and ignores the late callback', async () => {
    const pending = deferred<InvestigationSettledSnapshot>();
    const session = await activeSession(() => pending.promise);
    session.setInvestigationSampleCountInput('60');
    const run = session.runInvestigation();

    session.stop();
    pending.resolve(snapshot60);

    expect(await run).toBe(false);
    expect(session.getState().investigation.current).toBeUndefined();
    expect(session.getState().investigation.work).toEqual({
      phase: 'idle',
      issue: 'Investigation analysis was cancelled when the Lab closed.',
    });
  });

  it('captures exact chart-only comparison evidence and clamps cursor changes', async () => {
    const session = await activeSession(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    session.setInvestigationSampleCountInput('60');
    await session.runInvestigation();

    expect(session.captureInvestigationBaseline()).toBe(true);
    session.setInvestigationPosition(9999);
    const state = session.getState().investigation;

    expect(state.cursorPosition).toBe(59);
    expect(state.baseline).toMatchObject({
      capturedAt: '2026-08-29T12:00:00.000Z',
      scenarioId: 'gradual-drift',
      seed: 3101,
      identity: { profileId: 'generic-fixed-wing', cadenceMs: 1_000, sampleCount: 60 },
    });
    expect(Object.keys(state.baseline ?? {})).toEqual([
      'capturedAt',
      'scenarioId',
      'seed',
      'identity',
      'waveform',
    ]);
    expect(JSON.stringify(state.baseline)).not.toContain('measurements');
    session.stop();
  });

  it('marks settled evidence stale on request or model-intent change without rewriting it', async () => {
    const session = await activeSession(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    session.setInvestigationSampleCountInput('60');
    await session.runInvestigation();
    const settled = session.getState().investigation.current;

    session.setInvestigationSeedInput('3102');
    expect(session.getState().investigation.resultSettingsStale).toBe(true);
    session.setInvestigationSeedInput('3101');
    expect(session.getState().investigation.resultSettingsStale).toBe(false);
    session.setModelSelection('temporal', 'enabled');

    expect(session.getState().investigation.current).toBe(settled);
    expect(session.getState().investigation.current?.modelIntents.temporalModel).toBe('disabled');
    expect(session.getState().investigation.resultSettingsStale).toBe(true);
    session.stop();
  });

  it('clears all Investigation controls, evidence, baseline, and intent', async () => {
    const session = await activeSession(vi.fn<InvestigationRunner>().mockResolvedValue(snapshot60));
    session.setInvestigationSampleCountInput('60');
    session.setInvestigationOverlay('phases', false);
    session.setModelSelection('temporal', 'enabled');
    await session.runInvestigation();
    session.captureInvestigationBaseline();

    session.clear();

    expect(session.getState().investigation).toMatchObject({
      scenarioId: 'gradual-drift',
      seedInput: '3101',
      sampleCountInput: '180',
      work: { phase: 'idle' },
      current: undefined,
      baseline: undefined,
      cursorPosition: 0,
      resultSettingsStale: false,
    });
    expect(session.getState().temporalModelSelection.intent).toBe('disabled');
    expect(Object.values(session.getState().investigation.overlays).every(Boolean)).toBe(true);
    session.stop();
  });

  it('invalidates pending Investigation work on clear and ignores its late resolution', async () => {
    const pending = deferred<InvestigationSettledSnapshot>();
    const session = await activeSession(() => pending.promise);
    session.setInvestigationSampleCountInput('60');

    const run = session.runInvestigation();
    expect(session.getState().investigation.work).toEqual({ phase: 'analyzing' });

    session.clear();
    expect(session.getState().investigation).toMatchObject({
      work: { phase: 'idle' },
      current: undefined,
      baseline: undefined,
    });

    pending.resolve(snapshot60);

    expect(await run).toBe(false);
    expect(session.getState().investigation).toMatchObject({
      work: { phase: 'idle' },
      current: undefined,
      baseline: undefined,
    });
    expect(session.getState().message).toBe('Lab session data cleared. No records were persisted.');
    session.stop();
  });
});
