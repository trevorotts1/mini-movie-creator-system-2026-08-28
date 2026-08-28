import { describe, expect, it } from "vitest";

import {
  DEFAULT_FRAME_COUNT,
  DEFAULT_SCALE,
  FramePlanError,
  buildFramePlan,
  evenFrameIndices,
  evenTimestamps,
  frameFileName,
  intervalFrameIndices,
  intervalTimestamps,
  lastFrameIndex,
  resolveFrameIndices,
  resolveTimestamps,
  timestampToFrameNumber,
} from "./plan.js";

describe("timestampToFrameNumber", () => {
  it("converts global seconds to local frame numbers (sequence_from = 0)", () => {
    expect(timestampToFrameNumber(0, 30)).toBe(0);
    expect(timestampToFrameNumber(1.5, 30)).toBe(45);
    expect(timestampToFrameNumber(2 / 30, 30)).toBe(2);
  });

  it("rounds to nearest frame (local_f = global_s * fps)", () => {
    // 3.333s at 30fps = 99.99 -> 100
    expect(timestampToFrameNumber(10 / 3, 30)).toBe(100);
    // 1.2499s at 24fps = 29.9976 -> 30
    expect(timestampToFrameNumber(1.2499, 24)).toBe(30);
  });
});

describe("frameFileName", () => {
  it("4-digit zero-pads like upstream frames.mjs (<id>-f<NNNN>.png)", () => {
    expect(frameFileName("frames", 0)).toBe("frames-f0000.png");
    expect(frameFileName("frames", 140)).toBe("frames-f0140.png");
    expect(frameFileName("frames", 12345)).toBe("frames-f12345.png");
  });
});

describe("lastFrameIndex", () => {
  it("floor(duration*fps) - 1, epsilon-safe", () => {
    expect(lastFrameIndex(10, 30)).toBe(299);
    expect(lastFrameIndex(2, 30)).toBe(59);
    // 0.1s at 30fps = 3.0 frames exactly (float 2.9999998) -> 2
    expect(lastFrameIndex(0.1, 30)).toBe(2);
  });

  it("never returns a frame at-or-past EOF", () => {
    expect(lastFrameIndex(1, 30)).toBe(29); // not 30
  });

  it("rejects invalid durations/fps", () => {
    expect(() => lastFrameIndex(0, 30)).toThrow(FramePlanError);
    expect(() => lastFrameIndex(-1, 30)).toThrow(FramePlanError);
    expect(() => lastFrameIndex(1, 0)).toThrow(FramePlanError);
  });
});

describe("evenFrameIndices", () => {
  it("spans first..last for count >= 2", () => {
    expect(evenFrameIndices(5, 10)).toEqual([0, 3, 5, 8, 10]);
  });

  it("single frame targets the first frame", () => {
    expect(evenFrameIndices(1, 10)).toEqual([0]);
  });

  it("default count constant is 4", () => {
    expect(DEFAULT_FRAME_COUNT).toBe(4);
  });

  it("caps at available frames without duplicates", () => {
    expect(evenFrameIndices(8, 2)).toEqual([0, 1, 2]);
  });

  it("rejects non-integer or < 1 counts", () => {
    expect(() => evenFrameIndices(0, 10)).toThrow(FramePlanError);
    expect(() => evenFrameIndices(1.5, 10)).toThrow(FramePlanError);
    expect(() => evenFrameIndices(-2, 10)).toThrow(FramePlanError);
  });
});

describe("intervalFrameIndices", () => {
  it("steps from 0 and always includes the last frame", () => {
    // 2s interval at 30fps = 60-frame step over a 300-frame clip.
    expect(intervalFrameIndices(2, 30, 299)).toEqual([0, 60, 120, 180, 240, 299]);
  });

  it("partial last interval still covers the end", () => {
    expect(intervalFrameIndices(4, 30, 299)).toEqual([0, 120, 240, 299]);
  });

  it("interval larger than duration yields first + last", () => {
    expect(intervalFrameIndices(100, 30, 299)).toEqual([0, 299]);
  });

  it("sub-frame intervals clamp to 1 frame", () => {
    expect(intervalFrameIndices(0.01, 30, 5)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects non-positive intervals", () => {
    expect(() => intervalFrameIndices(0, 30, 10)).toThrow(FramePlanError);
    expect(() => intervalFrameIndices(-1, 30, 10)).toThrow(FramePlanError);
  });
});

describe("resolveFrameIndices", () => {
  it("count mode delegates to evenFrameIndices", () => {
    expect(resolveFrameIndices({ mode: "count", count: 3 }, 30, 90)).toEqual([0, 45, 90]);
  });

  it("interval mode delegates to intervalFrameIndices", () => {
    expect(resolveFrameIndices({ mode: "interval", intervalSeconds: 5 }, 30, 360)).toEqual([
      0, 150, 300, 360,
    ]);
  });

  it("timestamps mode converts to the frame grid, dedupes and sorts", () => {
    expect(resolveFrameIndices({ mode: "timestamps", timestamps: [5, 0, 5, 2] }, 30, 299)).toEqual([
      0, 60, 150,
    ]);
  });

  it("timestamps mode clamps out-of-range values instead of dropping them", () => {
    expect(resolveFrameIndices({ mode: "timestamps", timestamps: [0, 999, 5] }, 30, 299)).toEqual([
      0, 150, 299,
    ]);
  });

  it("rejects negative timestamps and empty lists", () => {
    expect(() => resolveFrameIndices({ mode: "timestamps", timestamps: [-1] }, 30, 10)).toThrow(
      FramePlanError,
    );
    expect(() => resolveFrameIndices({ mode: "timestamps", timestamps: [] }, 30, 10)).toThrow(
      FramePlanError,
    );
  });
});

// Timestamp-level helpers kept as the public conversion surface (spec §21
// local_f = global_s * fps − sequence_from); plan internals work on the grid.
describe("timestamp conveniences", () => {
  it("evenTimestamps mirrors evenFrameIndices converted back to seconds", () => {
    // 3 timestamps over 9s@10fps: frames [0, 45, 89] -> 0, 4.5, 8.9
    expect(evenTimestamps(3, 9, 10)).toEqual([0, 4.5, 8.9]);
  });

  it("intervalTimestamps mirrors intervalFrameIndices", () => {
    // 10s@10fps = 100 frames; 2s interval = 20-frame step: 0,20,...,80,99
    expect(intervalTimestamps(2, 10, 10)).toEqual([0, 2, 4, 6, 8, 9.9]);
  });

  it("resolveTimestamps mirrors resolveFrameIndices", () => {
    // 5s @10fps -> frame 50 -> 5.0s; 999s clamps to last frame 99 -> 9.9s.
    expect(resolveTimestamps({ mode: "timestamps", timestamps: [0, 999, 5] }, 10, 10)).toEqual([
      0, 5, 9.9,
    ]);
  });
});

describe("buildFramePlan", () => {
  it("builds planned frames with frames.mjs names and scale", () => {
    const plan = buildFramePlan({ mode: "count", count: 3 }, { durationSeconds: 9, fps: 10 });
    expect(plan.fps).toBe(10);
    expect(plan.scale).toBe(DEFAULT_SCALE);
    // 9s@10fps = 90 frames; last usable index 89.
    expect(plan.frames.map((f) => f.frameNumber)).toEqual([0, 45, 89]);
    expect(plan.frames.map((f) => f.timestampSeconds)).toEqual([0, 4.5, 8.9]);
    expect(plan.frames.map((f) => f.fileName)).toEqual([
      "frames-f0000.png",
      "frames-f0045.png",
      "frames-f0089.png",
    ]);
    expect(plan.frames.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it("supports scale override (frames.mjs --scale)", () => {
    const plan = buildFramePlan(
      { mode: "timestamps", timestamps: [1] },
      { durationSeconds: 5, fps: 10 },
      { scale: 0.5 },
    );
    expect(plan.scale).toBe(0.5);
    expect(plan.frames[0]?.frameNumber).toBe(10);
  });

  it("collapses duplicate frame numbers after rounding to the frame grid", () => {
    // 0.001s and 0.002s both round to frame 0 at 30fps.
    const plan = buildFramePlan(
      { mode: "timestamps", timestamps: [0.001, 0.002] },
      { durationSeconds: 2, fps: 30 },
    );
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]?.frameNumber).toBe(0);
  });

  it("never plans a seek at t=duration (EOF)", () => {
    const plan = buildFramePlan({ mode: "count", count: 4 }, { durationSeconds: 2, fps: 30 });
    for (const frame of plan.frames) {
      expect(frame.timestampSeconds).toBeLessThan(2);
      expect(frame.frameNumber).toBeLessThanOrEqual(59);
    }
  });

  it("rejects invalid fps and scale", () => {
    expect(() => buildFramePlan({ mode: "count", count: 2 }, { durationSeconds: 5, fps: 0 })).toThrow(
      FramePlanError,
    );
    expect(() =>
      buildFramePlan({ mode: "count", count: 2 }, { durationSeconds: 5, fps: 30 }, { scale: -1 }),
    ).toThrow(FramePlanError);
  });
});