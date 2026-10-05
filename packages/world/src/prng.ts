export type Prng = () => number;

/**
 * FNV-1a over the seed string, so a readable seed like 'ta-xua-v1' maps to a
 * stable 32-bit integer across runtimes.
 */
export const hashSeed = (seed: string): number => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * mulberry32. Written out instead of taking a dependency: the small
 * alternatives ship no types, and determinism is a correctness requirement
 * here — every player must generate a byte-identical world, so the algorithm
 * stays visible and pinned.
 */
export const createPrng = (seed: string | number): Prng => {
  let state = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
