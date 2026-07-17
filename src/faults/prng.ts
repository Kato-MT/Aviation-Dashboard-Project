/** Deterministic 32-bit generator suitable for repeatable synthetic fault placement. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function deterministicIndex(seed: number, length: number, margin = 0): number {
  if (length <= 0) throw new Error('Cannot select a fault location from an empty run.');
  const safeMargin = Math.min(Math.max(0, margin), Math.floor((length - 1) / 2));
  const available = Math.max(1, length - safeMargin * 2);
  return safeMargin + Math.floor(createSeededRandom(seed)() * available);
}
