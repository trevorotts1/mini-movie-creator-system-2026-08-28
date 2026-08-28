import { describe, expect, it } from "vitest";
import { placeAudio, toFrame } from "./place.js";
import { analyzeAudioLoop, checkLoopFriendly, eventEndFrame, loopLengthFrames } from "./loop.js";
import { verifySync } from "./sync.js";
import type { AudioTimelinePlan } from "./types.js";

/**
 * Loop-shaped plan: 42s composition at 30fps (the upstream short length,
 * e.g. Short1Chess durationInFrames 1260 = 42 × 30). The bed fades are
 * symmetric so the seam wraps.
 */
function loopPlan(fadeSec = 1.5): AudioTimelinePlan {
  return {
    formatVersion: 1,
    inputs: [
      { id: "line-01", kind: "dialogue", path: "05 Audio/line-01.wav" },
      { id: "bed", kind: "music", path: "bed.wav" },
      { id: "sfx-thock", kind: "sfx", path: "thock.wav" },
    ],
    dialogue: [{ inputId: "line-01", startSec: 4.9, durationSec: 2 }],
    music: { inputId: "bed", fadeInSec: fadeSec, fadeOutSec: fadeSec },
    sfx: [{ inputId: "sfx-thock", atSec: 37.4 }],
  };
}

describe("loop: last-frame == frame-0 convention", () => {
  it("places every event inside a 42s/30fps loop window", () => {
    const total = 42 * 30; // 1260 frames — Short1Chess length
    const t = placeAudio(loopPlan(), 30, 0, total);
    expect(t.totalFrames).toBe(1260);
    for (const event of t.events) {
      expect(event.startFrame).toBeGreaterThanOrEqual(0);
      const end = eventEndFrame(event);
      if (end !== null) expect(end).toBeLessThanOrEqual(total);
    }
    const report = analyzeAudioLoop(t);
    expect(report.loopFriendly).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("reports lastFrame = loopLength − 1 as the frame that must equal frame 0", () => {
    const t = placeAudio(loopPlan(), 30, 0, 1260);
    const report = analyzeAudioLoop(t);
    expect(report.loopLengthFrames).toBe(1260);
    expect(report.lastFrame).toBe(1259);
    // Convention: frame 0 and lastFrame carry the SAME bed amplitude —
    // symmetric fades guarantee it.
    expect(t.music?.fadeInFrames).toBe(t.music?.fadeOutFrames);
  });

  it("flags asymmetric bed fades as a seam discontinuity", () => {
    const plan = loopPlan();
    plan.music = { inputId: "bed", fadeInSec: 1.5, fadeOutSec: 3 };
    const t = placeAudio(plan, 30, 0, 1260);
    const report = analyzeAudioLoop(t);
    expect(report.loopFriendly).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("BED_SEAM_ASYMMETRIC");
  });

  it("flags a bed that does not start on the loop origin", () => {
    const plan = loopPlan();
    // Force an off-grid bed by mutating the placed event.
    const t = placeAudio(plan, 30, 0, 1260);
    const bed = t.music!;
    bed.startFrame = 10;
    const report = analyzeAudioLoop(t);
    expect(report.issues.map((i) => i.code)).toContain("BED_OFF_GRID");
  });

  it("flags events overflowing the loop window (no silent truncation)", () => {
    const plan = loopPlan();
    // SFX at global 41.9s + 0.5s clip ends at 42.4s → past the 42s window.
    plan.sfx = [{ inputId: "sfx-thock", atSec: 41.9, durationSec: 0.5 }];
    const t = placeAudio(plan, 30, 0, 1260);
    const report = analyzeAudioLoop(t);
    expect(report.loopFriendly).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain("OVERFLOW");
  });

  it("treats a bed-less timeline as loop-friendly when events fit (bed optional)", () => {
    const plan = loopPlan();
    delete plan.music;
    const t = placeAudio(plan, 30, 0, 1260);
    const report = analyzeAudioLoop(t);
    expect(t.music).toBeNull();
    expect(report.loopFriendly).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it("reports UNKNOWN_LENGTH when the composition length is not declared", () => {
    const t = placeAudio(loopPlan(), 30, 0, 0);
    const report = analyzeAudioLoop(t);
    expect(report.issues.map((i) => i.code)).toContain("UNKNOWN_LENGTH");
    expect(report.loopFriendly).toBe(false);
  });

  it("derives the loop length from events when totalFrames is unknown", () => {
    const plan = loopPlan();
    delete plan.music;
    plan.dialogue = [{ inputId: "line-01", startSec: 4.9, durationSec: 2 }];
    plan.sfx = [{ inputId: "sfx-thock", atSec: 37.4, durationSec: 1 }];
    const t = placeAudio(plan, 30, 0, 0);
    // Max end = 37.4s + 1s = 38.4s → frame 1152.
    expect(loopLengthFrames(t)).toBe(toFrame(38.4, 30));
    expect(loopLengthFrames(t)).toBe(1152);
  });

  it("checkLoopFriendly is the same analysis (kept as the named acceptance hook)", () => {
    const t = placeAudio(loopPlan(), 30, 0, 1260);
    expect(checkLoopFriendly(t)).toEqual(analyzeAudioLoop(t));
  });
});

describe("sync: audio ↔ picture frame grid", () => {
  it("places cues on the exact frame their master seconds compute to", () => {
    // Upstream sfx-plan.json style cues (Short1Chess: 4.90s, 12.57s, 12.62s).
    const plan: AudioTimelinePlan = {
      formatVersion: 1,
      inputs: [
        { id: "sfx-a", kind: "sfx", path: "a.wav" },
        { id: "sfx-b", kind: "sfx", path: "b.wav" },
        { id: "sfx-c", kind: "sfx", path: "c.wav" },
      ],
      sfx: [
        { inputId: "sfx-a", atSec: 4.9 },
        { inputId: "sfx-b", atSec: 12.57 },
        { inputId: "sfx-c", atSec: 12.62 },
      ],
    };
    const t = placeAudio(plan, 30, 0, 1260);
    expect(t.sfx[0]?.startFrame).toBe(147); // 4.9 × 30
    expect(t.sfx[1]?.startFrame).toBe(377); // 12.57 × 30 = 377.1 → 377
    expect(t.sfx[2]?.startFrame).toBe(379); // 12.62 × 30 = 378.6 → 379 (half-up)
    expect(verifySync(t).inSync).toBe(true);
  });

  it("keeps plan seconds ↔ placed frames consistent under re-derivation (sync test)", () => {
    const t = placeAudio(loopPlan(), 30, 96, 1032);
    const report = verifySync(t);
    expect(report.inSync).toBe(true);
    for (const event of t.events) {
      // Independent re-derivation of the upstream conversion.
      expect(event.startFrame).toBe(Math.floor(event.sourceSec * t.fps + 0.5) - t.sequenceFrom);
    }
  });

  it("sequence mount shifts frames, never the cue's master time", () => {
    const flat = placeAudio(loopPlan(), 30, 0, 1260);
    const mounted = placeAudio(loopPlan(), 30, 96, 1032);
    for (let i = 0; i < flat.events.length; i++) {
      const master = flat.events[i]!;
      const local = mounted.events[i]!;
      expect(local.startFrame).toBe(master.startFrame - 96);
      expect(local.sourceSec).toBe(master.sourceSec); // audit echo unchanged
    }
  });

  it("sync survives a JSON round-trip (the plan is durable data)", () => {
    const original = placeAudio(loopPlan(), 30, 96, 1032);
    const roundTripped = JSON.parse(JSON.stringify(original)) as typeof original;
    expect(verifySync(roundTripped).inSync).toBe(true);
  });
});