import { describe, expect, it } from "vitest";
import {
  AudioPlanError,
  isValidAudioPlan,
  validateAudioPlan,
} from "./validate.js";
import {
  DEFAULT_BED_GAIN_DB,
  DEFAULT_DUCK_DB,
  DEFAULT_FADE_SEC,
  DEFAULT_HIGHPASS_HZ,
  DEFAULT_LINE_GAIN_DB,
  placeAudio,
  toFrame,
} from "./place.js";
import type { AudioTimelinePlan } from "./types.js";

/** A minimal valid plan (one of each kind) for happy-path tests. */
function basePlan(): AudioTimelinePlan {
  return {
    formatVersion: 1,
    inputs: [
      { id: "line-01", kind: "dialogue", path: "05 Audio/line-01.wav" },
      { id: "bed", kind: "music", path: "media/library/music/ambient-pad.wav" },
      { id: "sfx-thock", kind: "sfx", path: "media/library/sfx/chess-piece-thock.wav" },
    ],
    dialogue: [{ inputId: "line-01", startSec: 4.9 }],
    music: { inputId: "bed" },
    sfx: [{ inputId: "sfx-thock", atSec: 4.9 }],
  };
}

describe("toFrame", () => {
  it("converts master seconds to the upstream frame grid at 30fps", () => {
    // frames.mjs / Short1Chess convention: global_s * fps, rounded to the frame.
    expect(toFrame(0, 30)).toBe(0);
    expect(toFrame(4.9, 30)).toBe(147); // 4.9 * 30 exactly
    expect(toFrame(1 / 60, 30)).toBe(1); // half-up rounding, not banker's
    expect(toFrame(1.5 / 30, 30)).toBe(2); // exact .5 → up
  });

  it("rounds half-up deterministically (no banker drift)", () => {
    // 2.5 frames exact → 3; 3.5 → 4. Same direction every time.
    expect(toFrame(2.5 / 30, 30)).toBe(3);
    expect(toFrame(3.5 / 30, 30)).toBe(4);
    expect(toFrame(4.5 / 60, 60)).toBe(5);
  });
});

describe("placeAudio", () => {
  it("places dialogue + music + sfx from the mix plan onto the frame grid", () => {
    const t = placeAudio(basePlan(), 30);
    expect(t.dialogue).toHaveLength(1);
    expect(t.music).not.toBeNull();
    expect(t.sfx).toHaveLength(1);
    expect(t.events).toHaveLength(3);
    expect(t.fps).toBe(30);
    expect(t.sequenceFrom).toBe(0);
  });

  it("applies the upstream conversion with a sequence mount offset", () => {
    const plan = basePlan();
    // Global 4.9s at 30fps = frame 147; mounted at from=96 (Short1Chess main scene).
    const t = placeAudio(plan, 30, 96, 1032);
    expect(t.dialogue[0]?.startFrame).toBe(147 - 96); // 51
    expect(t.sfx[0]?.startFrame).toBe(147 - 96);
    // The bed places at the loop origin: master 0s → frame 0 − mount.
    expect(t.music?.startFrame).toBe(0 - 96);
  });

  it("defaults bed gain/duck/fade/highpass to the upstream mixer values", () => {
    const t = placeAudio(basePlan(), 30);
    const bed = t.music;
    expect(bed?.gainDb).toBe(DEFAULT_BED_GAIN_DB); // -7 (felt-not-heard)
    expect(bed?.duckDb).toBe(DEFAULT_DUCK_DB); // 9
    expect(bed?.fadeInFrames).toBe(toFrame(DEFAULT_FADE_SEC, 30)); // 1.5s
    expect(bed?.fadeOutFrames).toBe(toFrame(DEFAULT_FADE_SEC, 30));
    expect(bed?.highpassHz).toBe(DEFAULT_HIGHPASS_HZ); // 90
  });

  it("defaults dialogue/sfx gain to 0 dB and no fades", () => {
    const t = placeAudio(basePlan(), 30);
    expect(t.dialogue[0]?.gainDb).toBe(DEFAULT_LINE_GAIN_DB);
    expect(t.dialogue[0]?.fadeInFrames).toBe(0);
    expect(t.dialogue[0]?.fadeOutFrames).toBe(0);
    expect(t.sfx[0]?.gainDb).toBe(0);
  });

  it("converts declared durations to frames and records the input index", () => {
    const plan = basePlan();
    if (plan.dialogue) plan.dialogue[0]!.durationSec = 2.5;
    if (plan.sfx) plan.sfx[0]!.durationSec = 0.4;
    const t = placeAudio(plan, 30);
    expect(t.dialogue[0]?.durationFrames).toBe(75); // 2.5 * 30
    expect(t.sfx[0]?.durationFrames).toBe(12); // 0.4 * 30
    expect(t.dialogue[0]?.inputIndex).toBe(0);
    expect(t.music?.inputIndex).toBe(1);
    expect(t.sfx[0]?.inputIndex).toBe(2);
  });

  it("is deterministic: identical plans produce identical timelines", () => {
    const a = JSON.stringify(placeAudio(basePlan(), 30, 96, 1032));
    const b = JSON.stringify(placeAudio(basePlan(), 30, 96, 1032));
    expect(a).toBe(b);
  });

  it("rejects an unknown input id", () => {
    const plan = basePlan();
    plan.dialogue = [{ inputId: "ghost", startSec: 1 }];
    expect(() => placeAudio(plan, 30)).toThrow(AudioPlanError);
    expect(() => placeAudio(plan, 30)).toThrow(/unknown input id/);
  });

  it("rejects kind mismatches (sfx cue pointing at a music input)", () => {
    const plan = basePlan();
    plan.sfx = [{ inputId: "bed", atSec: 2 }];
    expect(() => placeAudio(plan, 30)).toThrow(/expected "sfx"/);
  });

  it("rejects non-finite or out-of-range fps and negative sequenceFrom", () => {
    expect(() => placeAudio(basePlan(), 0)).toThrow(/fps/);
    expect(() => placeAudio(basePlan(), -30)).toThrow(/fps/);
    expect(() => placeAudio(basePlan(), 30, -1)).toThrow(/sequenceFrom/);
  });
});

describe("plan validation", () => {
  it("accepts a valid plan", () => {
    expect(isValidAudioPlan(basePlan())).toBe(true);
    expect(() => validateAudioPlan(basePlan())).not.toThrow();
  });

  it("rejects wrong formatVersion", () => {
    const plan = basePlan() as unknown as Record<string, unknown>;
    plan.formatVersion = 2;
    expect(() => validateAudioPlan(plan as never)).toThrow(/formatVersion/);
  });

  it("rejects empty inputs and duplicate ids", () => {
    const empty = basePlan();
    empty.inputs = [];
    expect(() => validateAudioPlan(empty)).toThrow(/inputs must not be empty/);

    const dup = basePlan();
    dup.inputs = [
      { id: "x", kind: "sfx", path: "a.wav" },
      { id: "x", kind: "sfx", path: "b.wav" },
    ];
    expect(() => validateAudioPlan(dup)).toThrow(/duplicate input id/);
  });

  it("rejects control characters in paths (untrusted data never reaches argv/graphs)", () => {
    const plan = basePlan();
    plan.inputs[0]!.path = "bad\npath.wav";
    expect(() => validateAudioPlan(plan)).toThrow(/control characters/);
  });

  it("rejects input ids unsafe for graph labels", () => {
    const plan = basePlan();
    plan.inputs[0]!.id = "bad id;drop";
    expect(() => validateAudioPlan(plan)).toThrow(/must match/);
  });

  it("rejects non-finite numbers everywhere", () => {
    const plan = basePlan();
    (plan.dialogue![0] as { startSec: number }).startSec = Number.NaN;
    expect(() => validateAudioPlan(plan)).toThrow(/finite/);
  });

  it("rejects out-of-range gains and fades", () => {
    const plan = basePlan();
    plan.music = { inputId: "bed", gainDb: -500 };
    expect(() => validateAudioPlan(plan)).toThrow(/out of range/);

    const plan2 = basePlan();
    plan2.music = { inputId: "bed", fadeInSec: 999 };
    expect(() => validateAudioPlan(plan2)).toThrow(/out of range/);
  });

  it("allows bed+SFX-only and dialogue-only plans (bed optional, dialogue optional)", () => {
    const noBed: AudioTimelinePlan = {
      formatVersion: 1,
      inputs: [
        { id: "line-01", kind: "dialogue", path: "a.wav" },
        { id: "sfx", kind: "sfx", path: "b.wav" },
      ],
      dialogue: [{ inputId: "line-01", startSec: 0 }],
      sfx: [{ inputId: "sfx", atSec: 1 }],
    };
    expect(() => placeAudio(noBed, 30)).not.toThrow();
    expect(placeAudio(noBed, 30).music).toBeNull();

    const bedOnly: AudioTimelinePlan = {
      formatVersion: 1,
      inputs: [{ id: "bed", kind: "music", path: "bed.wav" }],
      music: { inputId: "bed" },
    };
    const t = placeAudio(bedOnly, 30);
    expect(t.dialogue).toHaveLength(0);
    expect(t.sfx).toHaveLength(0);
    expect(t.music).not.toBeNull();
  });
});