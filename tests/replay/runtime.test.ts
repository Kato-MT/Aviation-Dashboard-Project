import { describe, expect, it, vi } from 'vitest';

import {
  ReplayRuntime,
  loadBundledReplayScenario,
  type ReplayClockScheduler,
  type ReplayRuntimeState,
} from '../../src/replay';

function harness() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: ReplayClockScheduler = {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(handle) {
      callbacks.delete(handle as number);
    },
  };
  return {
    scheduler,
    now: () => now,
    advanceTo(value: number) {
      now = value;
      const [id, callback] = callbacks.entries().next().value as [number, () => void];
      callbacks.delete(id);
      callback();
    },
    timerCount: () => callbacks.size,
  };
}

function evidence(state: ReplayRuntimeState) {
  return {
    positionMs: state.positionMs,
    phase: state.session.phase,
    sequence: state.session.snapshot?.sequence,
    aircraft: state.session.snapshot?.aircraft.map((item) => ({
      id: item.aircraftId,
      altitude: item.barometricAltitudeFeet,
      speed: item.groundSpeedKnots,
    })),
    histories: [...state.session.histories].map(([id, history]) => [
      id,
      history.samples.map((sample) => sample.sequence),
      history.incompleteReasons,
    ]),
    transcript: state.transcript.map((entry) => ({
      index: entry.eventIndex,
      outcome: entry.outcome,
      phase: entry.phaseAfter,
    })),
  };
}

describe('synthetic airspace replay runtime', () => {
  it('rejects a structurally forged frozen manifest that did not pass replay parsing', () => {
    expect(() => new ReplayRuntime(Object.freeze({}) as never)).toThrow('parsed, frozen');
  });

  it('produces identical evidence for time-derived playback and direct seek', async () => {
    const manifest = await loadBundledReplayScenario('data-quality-gaps');
    const direct = new ReplayRuntime(manifest);
    direct.seek(70_000);

    const time = harness();
    const played = new ReplayRuntime(manifest, {
      monotonicNow: time.now,
      scheduler: time.scheduler,
    });
    played.play();
    time.advanceTo(70_000);

    expect(evidence(played.getState())).toEqual(evidence(direct.getState()));
    expect(played.getState().transcript.every((entry) => entry.matchesExpectation)).toBe(true);
    direct.dispose();
    played.dispose();
  });

  it('rebuilds fresh on backward seek and never leaks future receipts into history', async () => {
    const runtime = new ReplayRuntime(await loadBundledReplayScenario('data-quality-gaps'));
    runtime.seek(70_000);
    expect(runtime.getState().session.snapshot?.sequence).toBe(13);
    runtime.seek(40_000);
    expect(runtime.getState().session.snapshot?.sequence).toBe(12);
    expect(runtime.getState().transcript.map((entry) => entry.eventIndex)).toEqual([0, 1, 2]);
    expect(
      [...runtime.getState().session.histories.values()].flatMap((history) =>
        history.samples.map((sample) => sample.sequence),
      ),
    ).not.toContain(13);
    runtime.dispose();
  });

  it('records duplicate and out-of-order attempts without allowing them to replace accepted state', async () => {
    const runtime = new ReplayRuntime(await loadBundledReplayScenario('data-quality-gaps'));
    runtime.seek(55_000);
    expect(runtime.getState().session.snapshot?.sequence).toBe(12);
    expect(
      runtime
        .getState()
        .transcript.slice(-2)
        .map((entry) => entry.outcome),
    ).toEqual(['rejected', 'rejected']);
    runtime.seek(70_000);
    expect(runtime.getState().session.snapshot?.sequence).toBe(13);
    expect(runtime.getState().currentEvent).toMatchObject({
      label: 'Ordering recovers',
      outcome: 'accepted',
    });
    runtime.dispose();
  });

  it('retains last-valid evidence during outage, expires departed history and recovers explicitly', async () => {
    const runtime = new ReplayRuntime(await loadBundledReplayScenario('provider-outage-recovery'));
    runtime.selectAircraft('demo:provider-outage-recovery:1');
    runtime.seek(500_000);
    expect(runtime.getState().session).toMatchObject({
      phase: 'offline',
      selectedAircraftId: 'demo:provider-outage-recovery:1',
      snapshot: { sequence: 2 },
    });
    expect(runtime.getState().session.histories.has('demo:provider-outage-recovery:2')).toBe(true);

    runtime.seek(950_000);
    expect(runtime.getState().session.phase).toBe('offline');
    expect(runtime.getState().session.histories.size).toBe(0);
    expect(runtime.getState().session.snapshot?.sequence).toBe(2);

    runtime.seek(1_000_000);
    expect(runtime.getState().session).toMatchObject({
      phase: 'live',
      selectedAircraftId: 'demo:provider-outage-recovery:1',
      snapshot: { sequence: 3 },
    });
    expect(runtime.getState().session.histories.has('demo:provider-outage-recovery:2')).toBe(false);
    runtime.dispose();
  });

  it('supports event seeks and exact retained-receipt selection', async () => {
    const runtime = new ReplayRuntime(await loadBundledReplayScenario('nominal-regional'));
    runtime.seekEvent(3);
    expect(runtime.getState().positionMs).toBe(60_000);
    const aircraftId = 'demo:nominal-regional:1';
    runtime.selectAircraft(aircraftId);
    const history = runtime.getState().session.histories.get(aircraftId)!;
    const sequence = history.samples[0]!.sequence;
    runtime.selectHistorySample(aircraftId, sequence);
    expect(runtime.getState().session).toMatchObject({
      selectedAircraftId: aircraftId,
      selectedHistorySequence: sequence,
    });
    expect(() => runtime.seekEvent(-1)).toThrow('outside');
    expect(() => runtime.seekEvent(1.5)).toThrow('integer');
    runtime.dispose();
  });

  it('performs outage and recovery with no fetch or WebSocket construction', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error('Replay attempted network access.');
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const runtime = new ReplayRuntime(
        await loadBundledReplayScenario('provider-outage-recovery'),
      );
      runtime.seek(1_040_000);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runtime.getState().session.snapshot?.sequence).toBe(4);
      runtime.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('owns one timer and cannot publish from stale callbacks after disposal', async () => {
    const time = harness();
    const runtime = new ReplayRuntime(await loadBundledReplayScenario('nominal-regional'), {
      monotonicNow: time.now,
      scheduler: time.scheduler,
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.play();
    runtime.play();
    expect(time.timerCount()).toBe(1);
    runtime.dispose();
    runtime.dispose();
    expect(time.timerCount()).toBe(0);
    const calls = listener.mock.calls.length;
    expect(() => runtime.seek(30_000)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(calls);
  });
});
