import { describe, expect, it } from "vitest";

import {
  HANDHELD_JITTER,
  MOTION_BASE_SCALE,
  MOTION_MAX_TRAVEL_PERCENT,
  MOTION_ZOOM_RANGE,
  parseCameraMotion,
  parseDirection,
  parseMotionKind,
} from "./index.js";

describe("parseMotionKind (§12 camera_motion text)", () => {
  it("maps planner camera-grammar strings to kinds", () => {
    expect(parseMotionKind("slow push in")).toBe("zoom_in");
    expect(parseMotionKind("static")).toBe("static");
    expect(parseMotionKind("crane down")).toBe("crane");
    expect(parseMotionKind("tracking")).toBe("tracking");
    expect(parseMotionKind("handheld drift")).toBe("handheld");
    expect(parseMotionKind("whip pan")).toBe("whip_pan");
  });

  it("maps zoom/pan/tilt/drift vocabulary", () => {
    expect(parseMotionKind("zoom in")).toBe("zoom_in");
    expect(parseMotionKind("zoom-out")).toBe("zoom_out");
    expect(parseMotionKind("pull back")).toBe("zoom_out");
    expect(parseMotionKind("pan right")).toBe("pan");
    expect(parseMotionKind("tilt up")).toBe("tilt");
    expect(parseMotionKind("slow drift")).toBe("drift");
  });

  it("is case-insensitive and trims", () => {
    expect(parseMotionKind("  PUSH IN  ")).toBe("zoom_in");
    expect(parseMotionKind("Handheld Drift")).toBe("handheld");
  });

  it("empty or whitespace text is static", () => {
    expect(parseMotionKind("")).toBe("static");
    expect(parseMotionKind("   ")).toBe("static");
  });

  it("unrecognized text falls back to drift, never static", () => {
    expect(parseMotionKind("moody Establishing 2.5s")).toBe("drift");
    expect(parseMotionKind("something completely unknown")).toBe("drift");
  });
});

describe("parseDirection", () => {
  it("extracts horizontal direction", () => {
    expect(parseDirection("pan left")).toEqual({ horizontal: -1, vertical: 0 });
    expect(parseDirection("pan right")).toEqual({ horizontal: 1, vertical: 0 });
  });

  it("extracts vertical direction", () => {
    expect(parseDirection("tilt up")).toEqual({ horizontal: 0, vertical: -1 });
    expect(parseDirection("crane down")).toEqual({ horizontal: 0, vertical: 1 });
  });

  it("no direction words → zeros", () => {
    expect(parseDirection("slow push in")).toEqual({ horizontal: 0, vertical: 0 });
  });
});

describe("parseCameraMotion (deterministic spec resolution)", () => {
  it("static → base scale, no travel, no jitter", () => {
    const spec = parseCameraMotion("static", 60, 1);
    expect(spec.kind).toBe("static");
    expect(spec.scaleFrom).toBe(MOTION_BASE_SCALE);
    expect(spec.scaleTo).toBe(MOTION_BASE_SCALE);
    expect(spec.translateXFrom).toBe(0);
    expect(spec.translateYFrom).toBe(0);
    expect(spec.jitter).toBe(0);
  });

  it("push in zooms from base to base+range", () => {
    const spec = parseCameraMotion("slow push in", 60, 1);
    expect(spec.kind).toBe("zoom_in");
    expect(spec.scaleFrom).toBeCloseTo(MOTION_BASE_SCALE, 12);
    expect(spec.scaleTo).toBeCloseTo(MOTION_BASE_SCALE + MOTION_ZOOM_RANGE, 12);
  });

  it("pull out zooms the opposite way", () => {
    const spec = parseCameraMotion("pull back", 60, 1);
    expect(spec.kind).toBe("zoom_out");
    expect(spec.scaleFrom).toBeCloseTo(MOTION_BASE_SCALE + MOTION_ZOOM_RANGE, 12);
    expect(spec.scaleTo).toBeCloseTo(MOTION_BASE_SCALE, 12);
  });

  it("pan respects a stated direction", () => {
    const right = parseCameraMotion("pan right", 60, 7);
    expect(right.kind).toBe("pan");
    expect(right.translateXFrom).toBeGreaterThan(0);
    expect(right.translateXTo).toBeLessThan(0);
    const left = parseCameraMotion("pan left", 60, 7);
    expect(left.translateXFrom).toBeLessThan(0);
  });

  it("pan travel never exceeds the edge-safe cap", () => {
    for (let seed = 0; seed < 50; seed++) {
      const spec = parseCameraMotion("pan", 60, seed);
      expect(Math.abs(spec.translateXFrom)).toBeLessThanOrEqual(MOTION_MAX_TRAVEL_PERCENT + 1e-9);
      expect(Math.abs(spec.translateXTo)).toBeLessThanOrEqual(MOTION_MAX_TRAVEL_PERCENT + 1e-9);
      expect(Math.min(spec.scaleFrom, spec.scaleTo)).toBeGreaterThanOrEqual(1.0);
    }
  });

  it("handheld carries full jitter", () => {
    const spec = parseCameraMotion("handheld", 60, 3);
    expect(spec.jitter).toBe(1);
  });

  it("static and zoom kinds carry no jitter", () => {
    expect(parseCameraMotion("static", 60, 3).jitter).toBe(0);
    expect(parseCameraMotion("slow push in", 60, 3).jitter).toBe(0);
  });

  it("is deterministic: same text + duration + seed → identical spec", () => {
    const a = parseCameraMotion("slow drift", 90, 11);
    const b = parseCameraMotion("slow drift", 90, 11);
    expect(a).toEqual(b);
  });

  it("varies across seeds where text leaves the direction open", () => {
    const specs = new Set(
      Array.from({ length: 30 }, (_, seed) => {
        const s = parseCameraMotion("slow drift", 90, seed);
        return `${s.translateXFrom.toFixed(4)}|${s.translateYFrom.toFixed(4)}`;
      }),
    );
    expect(specs.size).toBeGreaterThan(5);
  });

  it("unknown text gets a safe varied drift, not a crash", () => {
    const spec = parseCameraMotion("moody hero moment", 90, 5);
    expect(spec.kind).toBe("drift");
    expect(spec.scaleFrom).toBeGreaterThanOrEqual(1.0);
    expect(Math.abs(spec.translateXFrom)).toBeLessThanOrEqual(MOTION_MAX_TRAVEL_PERCENT + 1e-9);
  });

  it("empty/undefined motion resolves to static", () => {
    expect(parseCameraMotion(undefined, 60, 1).kind).toBe("static");
    expect(parseCameraMotion("", 60, 1).kind).toBe("static");
  });

  it("rejects invalid durations", () => {
    expect(() => parseCameraMotion("static", 0, 1)).toThrow(RangeError);
    expect(() => parseCameraMotion("static", -5, 1)).toThrow(RangeError);
    expect(() => parseCameraMotion("static", Number.NaN, 1)).toThrow(RangeError);
  });

  it("jitter constants stay edge-safe (handheld amplitude below travel cap)", () => {
    expect(HANDHELD_JITTER.translate).toBeLessThan(MOTION_MAX_TRAVEL_PERCENT);
  });
});