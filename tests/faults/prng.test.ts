import { describe, expect, it } from 'vitest';
import { createSeededRandom, deterministicIndex } from '../../src/faults/prng';

describe('createSeededRandom', () => {
  it('produces repeatable sequences for the same seed', () => {
    const rng1 = createSeededRandom(12345);
    const rng2 = createSeededRandom(12345);

    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());

    expect(seq1).toEqual(seq2);
  });

  it('produces numbers strictly within range [0, 1)', () => {
    const rng = createSeededRandom(42);
    for (let i = 0; i < 1000; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('treats seeds as unsigned 32-bit integers', () => {
    const rngNegative = createSeededRandom(-1);
    const rngUnsigned = createSeededRandom(0xffffffff); // 4294967295

    const seq1 = Array.from({ length: 5 }, () => rngNegative());
    const seq2 = Array.from({ length: 5 }, () => rngUnsigned());

    expect(seq1).toEqual(seq2);

    const rngFloat = createSeededRandom(42.8);
    const rngInt = createSeededRandom(42);
    expect(Array.from({ length: 5 }, () => rngFloat())).toEqual(
      Array.from({ length: 5 }, () => rngInt()),
    );
  });

  it('generates different sequences for different seeds', () => {
    const rng1 = createSeededRandom(1);
    const rng2 = createSeededRandom(2);

    const seq1 = Array.from({ length: 5 }, () => rng1());
    const seq2 = Array.from({ length: 5 }, () => rng2());

    expect(seq1).not.toEqual(seq2);
  });
});

describe('deterministicIndex', () => {
  it('throws an error for non-positive length', () => {
    expect(() => deterministicIndex(42, 0)).toThrow(
      'Cannot select a fault location from an empty run.',
    );
    expect(() => deterministicIndex(42, -10)).toThrow(
      'Cannot select a fault location from an empty run.',
    );
  });

  it('returns valid index within bounds with default margin 0', () => {
    for (let seed = 0; seed < 50; seed++) {
      const idx = deterministicIndex(seed, 10);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(10);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });

  it('always returns index 0 when length is 1 regardless of margin or seed', () => {
    for (let seed = 0; seed < 10; seed++) {
      expect(deterministicIndex(seed, 1, 0)).toBe(0);
      expect(deterministicIndex(seed, 1, 5)).toBe(0);
    }
  });

  it('respects specified margin constraints', () => {
    const length = 100;
    const margin = 15;
    for (let seed = 0; seed < 100; seed++) {
      const idx = deterministicIndex(seed, length, margin);
      expect(idx).toBeGreaterThanOrEqual(15);
      expect(idx).toBeLessThan(100 - 15);
    }
  });

  it('clamps negative margin to 0', () => {
    const length = 10;
    for (let seed = 0; seed < 20; seed++) {
      const idxNegativeMargin = deterministicIndex(seed, length, -5);
      const idxZeroMargin = deterministicIndex(seed, length, 0);
      expect(idxNegativeMargin).toBe(idxZeroMargin);
      expect(idxNegativeMargin).toBeGreaterThanOrEqual(0);
      expect(idxNegativeMargin).toBeLessThan(10);
    }
  });

  it('clamps oversized margin to floor((length - 1) / 2)', () => {
    const length = 10;
    // safeMargin should be floor(9 / 2) = 4
    // available should be max(1, 10 - 8) = 2
    // range of valid indices: [4, 5]
    for (let seed = 0; seed < 50; seed++) {
      const idx = deterministicIndex(seed, length, 50);
      expect(idx).toBeGreaterThanOrEqual(4);
      expect(idx).toBeLessThanOrEqual(5);
    }
  });

  it('is deterministic for identical inputs', () => {
    const idx1 = deterministicIndex(99, 50, 5);
    const idx2 = deterministicIndex(99, 50, 5);
    expect(idx1).toBe(idx2);
  });
});
