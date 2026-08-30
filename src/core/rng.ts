/**
 * Deterministic PRNG: mulberry32 with TRUE state capture (O(1) restore).
 * Carried forward from Kronos Engine's rng.ts, but improved: KE restored by
 * replaying callCount; we capture the single uint32 register directly.
 */
export interface RNGState {
  s: number;
}

export interface RNG {
  /** Next float in [0, 1). */
  next(): number;
  /** Capture current internal state. */
  state(): RNGState;
  /** Restore internal state exactly. */
  restore(st: RNGState): void;
}

export function createRNG(seed: number): RNG {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state(): RNGState {
      return { s: a };
    },
    restore(st: RNGState): void {
      a = st.s >>> 0;
    },
  };
}
