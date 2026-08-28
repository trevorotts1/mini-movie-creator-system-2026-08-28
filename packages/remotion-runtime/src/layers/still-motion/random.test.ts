import { describe, expect, it } from "vitest";

import {
  applyEase,
  hashSeed,
  lerp,
  mulberry32,
  progress,
} from "./index.js";

describe("mulberry32 (deterministic RNG)", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect([a(), a()]).not.toEqual([b(), b()]);
  });

  it("stays within [0, 1) over many draws", () => {
    const next = mulberry32(0xc0ffee);
    for (let i = 0; i < 10_000; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("coerces negative/over-32-bit seeds to uint32 deterministically", () => {
    const a = mulberry32(-1)();
    const b = mulberry32(0xffffffff)();
    expect(a).toBe(b);
  });
});

describe("hashSeed (FNV-1a)", () => {
  it("is stable for the same input", () => {
    expect(hashSeed("SC04_SH07::slow push in")).toBe(hashSeed("SC04_SH07::slow push in"));
  });

  it("differs for different inputs", () => {
    expect(hashSeed("shot-a")).not.toBe(hashSeed("shot-b"));
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const input of ["", "a", "hello world", "x".repeat(1000)]) {
      const h = hashSeed(input);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

describe("progress", () => {
  it("is 0 at the first frame and 1 at the last", () => {
    expect(progress(0, 61)).toBe(0);
    expect(progress(60, 61)).toBe(1);
  });

  it("is 0.5 at the midpoint", () => {
    expect(progress(30, 61)).toBeCloseTo(0.5, 10);
  });

  it("clamps out-of-range frames", () => {
    expect(progress(-5, 61)).toBe(0);
    expect(progress(500, 61)).toBe(1);
  });

  it("returns 0 for single-frame sequences", () => {
    expect(progress(0, 1)).toBe(0);
    expect(progress(7, 1)).toBe(0);
  });
});

describe("lerp", () => {
  it("interpolates linearly", () => {
    expect(lerp(1, 2, 0)).toBe(1);
    expect(lerp(1, 2, 1)).toBe(2);
    expect(lerp(1, 2, 0.25)).toBeCloseTo(1.25, 12);
  });

  it("extrapolates when t is outside [0, 1]", () => {
    expect(lerp(0, 1, 2)).toBe(2);
    expect(lerp(0, 1, -1)).toBe(-1);
  });
});

describe("applyEase", () => {
  it("linear returns t unchanged", () => {
    expect(applyEase(0.3, "linear")).toBe(0.3);
  });

  it("all curves hit 0 at 0 and 1 at 1", () => {
    for (const ease of ["linear", "ease_in_out", "ease_out"] as const) {
      expect(applyEase(0, ease)).toBe(0);
      expect(applyEase(1, ease)).toBe(1);
    }
  });

  it("ease_in_out is slower at the ends than linear", () => {
    expect(applyEase(0.25, "ease_in_out")).toBeLessThan(0.25);
    expect(applyEase(0.75, "ease_in_out")).toBeGreaterThan(0.75);
  });

  it("ease_out is ahead of linear early", () => {
    expect(applyEase(0.25, "ease_out")).toBeGreaterThan(0.25);
  });

  it("is deterministic", () => {
    expect(applyEase(0.37, "ease_in_out")).toBe(applyEase(0.37, "ease_in_out"));
  });
});