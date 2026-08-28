/**
 * Deterministic RNG + easing for the still-motion layer.
 *
 * No `Math.random` anywhere: every random-looking number comes from a
 * mulberry32 PRNG seeded explicitly. Same seed → same sequence, so renders
 * are byte-identical across runs (acceptance: "same inputs → same frames,
 * seeded").
 */

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  // Coerce to uint32 like the canonical implementation.
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable string hash (FNV-1a 32-bit). Used to derive a seed from shot id +
 * motion text when the caller does not pass one, so the derived seed is a
 * pure function of the inputs — never of time or environment.
 */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Linear interpolation. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Map `frame` into [0, 1] over [0, totalFrames - 1]; clamped. */
export function progress(frame: number, totalFrames: number): number {
  if (totalFrames <= 1) return 0;
  return Math.min(1, Math.max(0, frame / (totalFrames - 1)));
}

/** Easing curves for motion programs. */
export function applyEase(t: number, ease: "linear" | "ease_in_out" | "ease_out"): number {
  if (ease === "linear") return t;
  if (ease === "ease_out") return 1 - (1 - t) * (1 - t);
  // ease_in_out: cubic — matches the upstream `EASE_INOUT` feel.
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}