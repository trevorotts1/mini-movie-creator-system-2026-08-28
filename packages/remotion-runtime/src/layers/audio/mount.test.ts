import { describe, expect, it } from "vitest";
import { mountAudio, masterAudio, toMasterFrame, toMountedFrame } from "./mount.js";
import { placeAudio } from "./place.js";
import { verifySync } from "./sync.js";
import type { AudioTimelinePlan } from "./types.js";

/**
 * VID-003-shaped mount points (scene sequences of a 42s/30fps episode —
 * Short1Chess layout: hook 0–96, main 96–1128, loop 1122–1260).
 */
const MOUNTS = [
  { from: 0, durationInFrames: 96 },
  { from: 96, durationInFrames: 1032 },
  { from: 1122, durationInFrames: 138 },
] as const;

function plan(): AudioTimelinePlan {
  return {
    formatVersion: 1,
    inputs: [
      { id: "line-01", kind: "dialogue", path: "05 Audio/line-01.wav" },
      { id: "bed", kind: "music", path: "bed.wav" },
      { id: "sfx-thock", kind: "sfx", path: "thock.wav" },
    ],
    dialogue: [{ inputId: "line-01", startSec: 4.9, durationSec: 2 }],
    music: { inputId: "bed" },
    sfx: [{ inputId: "sfx-thock", atSec: 4.9 }],
  };
}

describe("mount: the VID-003 seam", () => {
  it("produces one placed timeline per sequence mount point", () => {
    for (const m of MOUNTS) {
      const mounted = mountAudio(plan(), 30, m.from, m.durationInFrames);
      expect(mounted.sequenceFrom).toBe(m.from);
      expect(mounted.timeline.sequenceFrom).toBe(m.from);
      expect(mounted.sync.inSync).toBe(true);
    }
  });

  it("a master cue maps to the same frame in every mount view (inverse conversions)", () => {
    const flat = placeAudio(plan(), 30, 0, 1260);
    const cueMaster = flat.sfx[0]!.startFrame; // 147
    for (const m of MOUNTS) {
      const mounted = mountAudio(plan(), 30, m.from, m.durationInFrames);
      expect(mounted.timeline.sfx[0]!.startFrame).toBe(cueMaster - m.from);
      // Round trip both ways, frames form.
      expect(toMasterFrame(mounted.timeline.sfx[0]!, m.from)).toBe(cueMaster);
      expect(toMountedFrame(cueMaster, m.from)).toBe(cueMaster - m.from);
    }
  });

  it("masterAudio places everything on the global grid with sequenceFrom 0", () => {
    const master = masterAudio(plan(), 30, 1260);
    expect(master.timeline.sequenceFrom).toBe(0);
    expect(master.timeline.dialogue[0]!.startFrame).toBe(147);
    expect(master.timeline.music!.startFrame).toBe(0);
    expect(master.sync.inSync).toBe(true);
    // Symmetric default fades → the master window is loop-friendly.
    expect(master.loop.loopFriendly).toBe(true);
  });

  it("mounted loop analysis runs over the mount's own window", () => {
    const loopMount = MOUNTS[2]!;
    const mounted = mountAudio(plan(), 30, loopMount.from, loopMount.durationInFrames);
    expect(mounted.loop.loopLengthFrames).toBe(138);
    // Dialogue placed at master 4.9s is BEFORE this mount — still on the grid,
    // just negative locally; loop analysis reports the position, sync stays true.
    expect(mounted.timeline.dialogue[0]!.startFrame).toBe(147 - 1122);
  });
});

describe("FISH-009 mix-plan compatibility", () => {
  it("accepts a FISH-009 MixPlan shape verbatim (structural 1:1)", () => {
    // Exactly the fields FISH-009's types.ts declares for a plan — no more.
    const fishPlan = {
      formatVersion: 1,
      inputs: [
        { id: "line-01", kind: "dialogue", path: "voice/line-01.wav" },
        { id: "bed", kind: "music", path: "music/ambient-pad.mp3" },
        { id: "sfx-door", kind: "sfx", path: "sfx/door.wav" },
      ],
      dialogue: [{ inputId: "line-01", startSec: 2.4, gainDb: -1, fadeInSec: 0.05 }],
      music: { inputId: "bed", gainDb: -9, duckDb: 12, highpassHz: 100 },
      sfx: [{ inputId: "sfx-door", atSec: 3.1, gainDb: -6 }],
      output: {
        path: "05 Audio/mix.wav",
        sampleRateHz: 48000,
        channelLayout: "stereo",
        limiterCeiling: 0.97,
        durationSec: 42,
      },
    } as const;
    // FISH-009 `output` block is mix-execution config — harmless extra data
    // here; placement reads inputs/dialogue/music/sfx only. TypeScript's
    // structural typing accepts the extra property via a cast boundary.
    const t = placeAudio(fishPlan as unknown as AudioTimelinePlan, 30, 0, 1260);
    expect(t.dialogue[0]!.gainDb).toBe(-1);
    expect(t.music!.gainDb).toBe(-9);
    expect(t.music!.duckDb).toBe(12);
    expect(t.music!.highpassHz).toBe(100);
    expect(t.sfx[0]!.gainDb).toBe(-6);
    expect(t.sfx[0]!.startFrame).toBe(93); // 3.1 × 30
    expect(verifySync(t).inSync).toBe(true);
  });

  it("keeps plan order as input index (FISH-009 argv order)", () => {
    const t = placeAudio(plan(), 30);
    expect(t.dialogue[0]!.inputIndex).toBe(0);
    expect(t.music!.inputIndex).toBe(1);
    expect(t.sfx[0]!.inputIndex).toBe(2);
  });
});