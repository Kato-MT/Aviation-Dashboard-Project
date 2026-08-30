import { describe, expect, it, vi } from 'vitest';

import { ReplayVirtualClock, type ReplayClockScheduler } from '../../src/replay';

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
    setNow(value: number) {
      now = value;
    },
    fire() {
      const [id, callback] = callbacks.entries().next().value as [number, () => void];
      callbacks.delete(id);
      callback();
    },
    firstCallback: () => callbacks.values().next().value as (() => void) | undefined,
    timerCount: () => callbacks.size,
  };
}

describe('deterministic replay virtual clock', () => {
  it('derives position from monotonic elapsed time across play, speed, pause and resume', () => {
    const state = harness();
    const clock = new ReplayVirtualClock(2_000, {
      monotonicNow: state.now,
      scheduler: state.scheduler,
      tickIntervalMs: 100,
    });
    clock.play();
    clock.play();
    expect(state.timerCount()).toBe(1);
    state.setNow(250);
    state.fire();
    expect(clock.getState()).toMatchObject({ positionMs: 250, playing: true, speed: 1 });
    clock.setSpeed(2);
    state.setNow(500);
    state.fire();
    expect(clock.getState().positionMs).toBe(750);
    clock.pause();
    expect(state.timerCount()).toBe(0);
    state.setNow(900);
    expect(clock.getState().positionMs).toBe(750);
    clock.play();
    state.setNow(1_000);
    state.fire();
    expect(clock.getState().positionMs).toBe(950);
  });

  it('reaches equal virtual state despite different timer callback cadence', () => {
    const sparse = harness();
    const dense = harness();
    const sparseClock = new ReplayVirtualClock(1_000, {
      monotonicNow: sparse.now,
      scheduler: sparse.scheduler,
    });
    const denseClock = new ReplayVirtualClock(1_000, {
      monotonicNow: dense.now,
      scheduler: dense.scheduler,
    });
    sparseClock.play();
    sparse.setNow(700);
    sparse.fire();
    denseClock.play();
    for (const time of [100, 250, 400, 700]) {
      dense.setNow(time);
      dense.fire();
    }
    expect(sparseClock.getState().positionMs).toBe(700);
    expect(denseClock.getState().positionMs).toBe(700);
  });

  it('clamps seeks, stops exactly at the end and requires an explicit reset before replaying', () => {
    const state = harness();
    const clock = new ReplayVirtualClock(1_000, {
      monotonicNow: state.now,
      scheduler: state.scheduler,
    });
    clock.seek(-50);
    expect(clock.getState().positionMs).toBe(0);
    clock.seek(2_000);
    expect(clock.getState()).toMatchObject({ positionMs: 1_000, playing: false });
    clock.play();
    expect(state.timerCount()).toBe(0);
    clock.seek(900);
    clock.play();
    state.setNow(200);
    state.fire();
    expect(clock.getState()).toMatchObject({ positionMs: 1_000, playing: false });
    expect(state.timerCount()).toBe(0);
  });

  it('cancels one owned timer and prevents stale callbacks after idempotent disposal', () => {
    const state = harness();
    const clock = new ReplayVirtualClock(1_000, {
      monotonicNow: state.now,
      scheduler: state.scheduler,
    });
    const listener = vi.fn();
    clock.subscribe(listener);
    clock.play();
    const stale = state.firstCallback()!;
    clock.dispose();
    clock.dispose();
    expect(state.timerCount()).toBe(0);
    const calls = listener.mock.calls.length;
    state.setNow(500);
    stale();
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(clock.getState()).toMatchObject({ disposed: true, playing: false });
  });

  it('rejects invalid construction, position, speed and monotonic readings', () => {
    expect(() => new ReplayVirtualClock(0)).toThrow('duration');
    expect(() => new ReplayVirtualClock(1_000, { tickIntervalMs: 1 })).toThrow('tick interval');
    const state = harness();
    const clock = new ReplayVirtualClock(1_000, {
      monotonicNow: state.now,
      scheduler: state.scheduler,
    });
    expect(() => clock.seek(Number.NaN)).toThrow('finite');
    expect(() => clock.setSpeed(3 as never)).toThrow('1, 2 or 4');
    state.setNow(Number.NaN);
    expect(() => clock.play()).toThrow('monotonic time');
  });
});
