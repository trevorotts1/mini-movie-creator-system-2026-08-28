import { describe, expect, it } from "vitest";

import {
  hashSeed,
  isStillMotionCandidate,
  placeStillShots,
  placeStillShot,
  stillMotionFrame,
  stillMotionFrames,
  effectiveSeed,
  StillMotionValidationError,
} from "./index.js";
import type { StillMotionSpec, StillPlacementCandidate } from "./index.js";

function candidate(overrides: Partial<StillPlacementCandidate> = {}): StillPlacementCandidate {
  return {
    shotId: "SC04_SH07",
    visualSource: "ai_still_motion",
    cameraMotion: "slow push in",
    src: "media/projects/S01E01/stills/sc04_sh07.png",
    durationInFrames: 60,
    ...overrides,
  };
}

/** Hand-built static spec for frame-math tests (no parser involvement). */
function staticSpec(): StillMotionSpec {
  return {
    kind: "static",
    scaleFrom: 1.12,
    scaleTo: 1.12,
    translateXFrom: 0,
    translateXTo: 0,
    translateYFrom: 0,
    translateYTo: 0,
    rotateFrom: 0,
    rotateTo: 0,
    ease: "ease_in_out",
    jitter: 0,
  };
}

describe("effectiveSeed", () => {
  it("uses the explicit seed when given", () => {
    expect(effectiveSeed(candidate({ seed: 123 }))).toBe(123);
  });

  it("derives a stable seed from shotId + motion text when omitted", () => {
    const derived = effectiveSeed(candidate());
    expect(derived).toBe(hashSeed("SC04_SH07::slow push in"));
    expect(effectiveSeed(candidate())).toBe(derived);
  });

  it("different shots derive different seeds", () => {
    expect(effectiveSeed(candidate({ shotId: "SC04_SH08" }))).not.toBe(
      effectiveSeed(candidate({ shotId: "SC04_SH09" })),
    );
  });

  it("rejects non-finite explicit seeds", () => {
    expect(() => effectiveSeed(candidate({ seed: Number.NaN }))).toThrow(
      StillMotionValidationError,
    );
  });
});

describe("validateStillCandidate", () => {
  it("accepts a well-formed candidate", () => {
    expect(() => placeStillShot(candidate())).not.toThrow();
  });

  it("rejects non-ai_still_motion sources (spec §22 layer ownership)", () => {
    for (const other of ["generated_character_video", "stock_broll", "native_graphics"] as const) {
      expect(() => placeStillShot(candidate({ visualSource: other }))).toThrow(
        /only serves "ai_still_motion"/,
      );
    }
  });

  it("rejects empty shotId and src", () => {
    expect(() => placeStillShot(candidate({ shotId: "" }))).toThrow(/shotId/);
    expect(() => placeStillShot(candidate({ src: "" }))).toThrow(/src/);
  });

  it("rejects invalid durations and start frames", () => {
    expect(() => placeStillShot(candidate({ durationInFrames: 0 }))).toThrow(/durationInFrames/);
    expect(() => placeStillShot(candidate({ durationInFrames: 1.5 }))).toThrow(/durationInFrames/);
    expect(() => placeStillShot(candidate({ startFrame: -1 }))).toThrow(/startFrame/);
    expect(() => placeStillShot(candidate({ startFrame: 2.2 }))).toThrow(/startFrame/);
  });

  it("allows startFrame 0 and single-frame shots", () => {
    expect(() => placeStillShot(candidate({ startFrame: 0, durationInFrames: 1 }))).not.toThrow();
  });
});

describe("placeStillShots", () => {
  it("places candidates in list order with resolved motion", () => {
    const placements = placeStillShots([
      candidate({ shotId: "s1", cameraMotion: "slow push in", durationInFrames: 45, startFrame: 0 }),
      candidate({ shotId: "s2", cameraMotion: "static", durationInFrames: 30, startFrame: 45 }),
    ]);
    expect(placements).toHaveLength(2);
    expect(placements[0]!.shotId).toBe("s1");
    expect(placements[0]!.startFrame).toBe(0);
    expect(placements[0]!.durationInFrames).toBe(45);
    expect(placements[0]!.motion.kind).toBe("zoom_in");
    expect(placements[1]!.shotId).toBe("s2");
    expect(placements[1]!.startFrame).toBe(45);
    expect(placements[1]!.motion.kind).toBe("static");
  });

  it("is deterministic across runs", () => {
    const a = placeStillShots([candidate(), candidate({ shotId: "s2", cameraMotion: "handheld" })]);
    const b = placeStillShots([candidate(), candidate({ shotId: "s2", cameraMotion: "handheld" })]);
    expect(a).toEqual(b);
  });
});

describe("stillMotionFrame (deterministic per-frame math)", () => {
  it("matches spec endpoints: first frame = from-values, last = to-values", () => {
    const spec: StillMotionSpec = {
      kind: "zoom_in",
      scaleFrom: 1.1,
      scaleTo: 1.3,
      translateXFrom: -1,
      translateXTo: 1,
      translateYFrom: 0,
      translateYTo: 0,
      rotateFrom: -0.5,
      rotateTo: 0.5,
      ease: "linear",
      jitter: 0,
    };
    const first = stillMotionFrame(spec, 0, 61, 9);
    expect(first.scale).toBeCloseTo(1.1, 12);
    expect(first.translateX).toBeCloseTo(-1, 12);
    expect(first.rotate).toBeCloseTo(-0.5, 12);
    const last = stillMotionFrame(spec, 60, 61, 9);
    expect(last.scale).toBeCloseTo(1.3, 12);
    expect(last.translateX).toBeCloseTo(1, 12);
    expect(last.rotate).toBeCloseTo(0.5, 12);
  });

  it("is identical for repeated evaluation (no hidden state)", () => {
    const spec = parseableSpec();
    const a = stillMotionFrame(spec, 17, 60, 5);
    const b = stillMotionFrame(spec, 17, 60, 5);
    expect(a).toEqual(b);
  });

  it("jitter is seeded: same seed + frame → identical frame", () => {
    const spec = { ...staticSpec(), jitter: 1 };
    const a = stillMotionFrame(spec, 12, 60, 77);
    const b = stillMotionFrame(spec, 12, 60, 77);
    expect(a).toEqual(b);
    expect(a.translateX).not.toBe(0); // jitter actually moved something
  });

  it("jitter differs across seeds", () => {
    const spec = { ...staticSpec(), jitter: 1 };
    const a = stillMotionFrame(spec, 12, 60, 77);
    const b = stillMotionFrame(spec, 12, 60, 78);
    expect(a.translateX).not.toBe(b.translateX);
  });

  it("jitter differs across frames (liveness)", () => {
    const spec = { ...staticSpec(), jitter: 1 };
    const a = stillMotionFrame(spec, 12, 60, 77);
    const b = stillMotionFrame(spec, 13, 60, 77);
    expect(a.translateX).not.toBe(b.translateX);
  });

  it("jitter never drops scale below 1.0 (edge-safety)", () => {
    const spec: StillMotionSpec = {
      ...staticSpec(),
      scaleFrom: 1.0,
      scaleTo: 1.0,
      jitter: 1,
    };
    for (let f = 0; f < 200; f++) {
      const frame = stillMotionFrame(spec, f, 200, 3);
      expect(frame.scale).toBeGreaterThanOrEqual(1.0);
    }
  });

  it("clamps frames outside the shot duration", () => {
    const spec = parseableSpec();
    const before = stillMotionFrame(spec, -4, 60, 2);
    const atZero = stillMotionFrame(spec, 0, 60, 2);
    expect(before.scale).toBe(atZero.scale);
  });

  it("single-frame stills hold the from-pose", () => {
    const frame = stillMotionFrame(parseableSpec(), 0, 1, 2);
    expect(frame.scale).toBeCloseTo(parseableSpec().scaleFrom, 12);
  });

  function parseableSpec(): StillMotionSpec {
    return {
      kind: "drift",
      scaleFrom: 1.12,
      scaleTo: 1.18,
      translateXFrom: 1.5,
      translateXTo: -0.75,
      translateYFrom: -1,
      translateYTo: 0.5,
      rotateFrom: 0.3,
      rotateTo: -0.15,
      ease: "ease_in_out",
      jitter: 0,
    };
  }
});

describe("stillMotionFrames (full-sequence evaluation)", () => {
  it("returns exactly durationInFrames frames", () => {
    const placement = placeStillShot(candidate({ durationInFrames: 45 }));
    expect(stillMotionFrames(placement)).toHaveLength(45);
  });

  it("renders the identical sequence for identical placements (acceptance: same inputs → same frames)", () => {
    const a = stillMotionFrames(placeStillShot(candidate({ cameraMotion: "handheld", seed: 42 })));
    const b = stillMotionFrames(placeStillShot(candidate({ cameraMotion: "handheld", seed: 42 })));
    expect(a).toEqual(b);
  });

  it("derived-seed placements (no explicit seed) also render identically", () => {
    const build = () =>
      stillMotionFrames(placeStillShot(candidate({ cameraMotion: "slow drift" })));
    expect(build()).toEqual(build());
  });
});

describe("isStillMotionCandidate", () => {
  it("true only for ai_still_motion", () => {
    expect(isStillMotionCandidate({ visualSource: "ai_still_motion" })).toBe(true);
    expect(isStillMotionCandidate({ visualSource: "stock_broll" })).toBe(false);
    expect(isStillMotionCandidate({ visualSource: "generated_character_video" })).toBe(false);
    expect(isStillMotionCandidate({ visualSource: "native_graphics" })).toBe(false);
  });
});