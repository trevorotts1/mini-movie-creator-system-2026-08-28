import { describe, expect, it } from "vitest";
import {
  CROSSFADE_DEFAULT_DURATION_FRAMES,
  CUT_OVERLAP_FRAMES,
  WIPE_DEFAULT_DURATION_FRAMES,
  clampOverlap,
  planShotPlacements,
  resolveOverlapFrames,
} from "./overlap";
import type { TransitionPlan, TransitionShot } from "./types";

function shot(id: string, durationInFrames: number, transition?: TransitionShot["transition"]): TransitionShot {
  return transition === undefined ? { id, durationInFrames } : { id, durationInFrames, transition };
}

describe("resolveOverlapFrames", () => {
  it("cut is always zero overlap, even with a declared duration", () => {
    expect(resolveOverlapFrames({ kind: "cut", durationFrames: 30 }, "cut")).toBe(CUT_OVERLAP_FRAMES);
    expect(resolveOverlapFrames(undefined, "cut")).toBe(CUT_OVERLAP_FRAMES);
  });

  it("crossfade uses declared duration, defaults otherwise", () => {
    expect(resolveOverlapFrames({ kind: "crossfade", durationFrames: 24 }, "crossfade")).toBe(24);
    expect(resolveOverlapFrames({ kind: "crossfade" }, "crossfade")).toBe(CROSSFADE_DEFAULT_DURATION_FRAMES);
  });

  it("wipe uses declared duration, defaults otherwise", () => {
    expect(
      resolveOverlapFrames({ kind: "wipe", direction: "left-to-right", durationFrames: 15 }, "wipe"),
    ).toBe(15);
    expect(resolveOverlapFrames({ kind: "wipe", direction: "top-to-bottom" }, "wipe")).toBe(
      WIPE_DEFAULT_DURATION_FRAMES,
    );
  });

  it("declines non-positive or non-integer durations back to the default", () => {
    expect(resolveOverlapFrames({ kind: "crossfade", durationFrames: 0 }, "crossfade")).toBe(
      CROSSFADE_DEFAULT_DURATION_FRAMES,
    );
    expect(resolveOverlapFrames({ kind: "crossfade", durationFrames: -5 }, "crossfade")).toBe(
      CROSSFADE_DEFAULT_DURATION_FRAMES,
    );
    expect(resolveOverlapFrames({ kind: "crossfade", durationFrames: 2.5 }, "crossfade")).toBe(
      CROSSFADE_DEFAULT_DURATION_FRAMES,
    );
  });
});

describe("clampOverlap", () => {
  it("clamps to the shorter adjacent shot and never goes negative", () => {
    expect(clampOverlap(30, 20, 25)).toBe(20);
    expect(clampOverlap(12, 20, 25)).toBe(12);
    expect(clampOverlap(0, 20, 25)).toBe(0);
    expect(clampOverlap(-4, 20, 25)).toBe(0);
  });
});

describe("planShotPlacements — frame-exact overlap math", () => {
  it("places sequential shots without overlap when all transitions are cut", () => {
    const plan: TransitionPlan = { fps: 30, shots: [shot("a", 90), shot("b", 60), shot("c", 30)] };
    const timeline = planShotPlacements(10, plan.shots);
    expect(timeline.totalDurationInFrames).toBe(180);
    expect(timeline.placements).toEqual([
      { shotId: "a", sequenceIndex: 0, globalIn: 0, globalOut: 90, durationInFrames: 90 },
      { shotId: "b", sequenceIndex: 1, globalIn: 90, globalOut: 150, durationInFrames: 60 },
      { shotId: "c", sequenceIndex: 2, globalIn: 150, globalOut: 180, durationInFrames: 30 },
    ]);
    expect(timeline.boundaries).toEqual([
      {
        shotIndex: 1,
        outgoingShotId: "a",
        incomingShotId: "b",
        kind: "cut",
        overlapFrames: 0,
        overlapStart: 90,
        overlapEnd: 90,
      },
      {
        shotIndex: 2,
        outgoingShotId: "b",
        incomingShotId: "c",
        kind: "cut",
        overlapFrames: 0,
        overlapStart: 150,
        overlapEnd: 150,
      },
    ]);
  });

  it("crossfade pulls the incoming shot back by exactly the declared overlap", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        shot("a", 90),
        shot("b", 60, { kind: "crossfade", durationFrames: 12 }),
        shot("c", 30, { kind: "crossfade", durationFrames: 10 }),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    expect(timeline.placements[1]).toEqual({
      shotId: "b",
      sequenceIndex: 1,
      globalIn: 90 - 12,
      globalOut: 90 - 12 + 60,
      durationInFrames: 60,
    });
    expect(timeline.placements[2]).toEqual({
      shotId: "c",
      sequenceIndex: 2,
      globalIn: 90 - 12 + 60 - 10,
      globalOut: 90 - 12 + 60 - 10 + 30,
      durationInFrames: 30,
    });
    // total = (90 + 60 + 30) - (12 + 10) = 158
    expect(timeline.totalDurationInFrames).toBe(158);
    expect(timeline.placements[0]!.globalIn).toBe(0);
  });

  it("the incoming shot is visible for its full duration; overlap only re-uses the outgoing tail", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        shot("a", 100, { kind: "crossfade", durationFrames: 20 }),
        shot("b", 50, { kind: "wipe", durationFrames: 5, direction: "left-to-right" }),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    const [a, b] = timeline.placements;
    expect(a!.globalOut - a!.globalIn).toBe(100);
    expect(b!.globalOut - b!.globalIn).toBe(50);
    expect(a!.globalOut).toBe(100);
    expect(b!.globalIn).toBe(a!.globalOut - 5); // incoming pulled back by the wipe overlap
    expect(timeline.boundaries[0]!.overlapEnd).toBe(100);
  });

  it("overlap never exceeds the shorter of the two adjacent shots", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        shot("long", 100),
        shot("short", 8, { kind: "crossfade", durationFrames: 30 }),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    expect(timeline.boundaries[0]!.overlapFrames).toBe(8);
    expect(timeline.placements[1]!.globalIn).toBe(100 - 8);
    expect(timeline.totalDurationInFrames).toBe(100 + 8 - 8);
  });

  it("a transition declared on the first shot has no boundary and is ignored", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        shot("a", 60, { kind: "crossfade", durationFrames: 12 }),
        shot("b", 60),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    expect(timeline.boundaries).toHaveLength(1);
    expect(timeline.boundaries[0]!.shotIndex).toBe(1);
    // shot 0 starts at frame 0 regardless
    expect(timeline.placements[0]).toEqual({
      shotId: "a",
      sequenceIndex: 0,
      globalIn: 0,
      globalOut: 60,
      durationInFrames: 60,
    });
  });

  it("omitted transition means default cut (zero overlap)", () => {
    const plan: TransitionPlan = { fps: 30, shots: [shot("a", 24), shot("b", 24), shot("c", 24)] };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    expect(timeline.boundaries.map((b) => b.kind)).toEqual(["cut", "cut"]);
    expect(timeline.totalDurationInFrames).toBe(72);
  });

  it("empty plan produces empty timeline", () => {
    const timeline = planShotPlacements(30, []);
    expect(timeline.placements).toEqual([]);
    expect(timeline.boundaries).toEqual([]);
    expect(timeline.totalDurationInFrames).toBe(0);
  });

  it("wipe boundary carries the declared direction", () => {
    const plan: TransitionPlan = {
      fps: 25,
      shots: [
        shot("a", 50),
        shot("b", 50, { kind: "wipe", direction: "bottom-to-top", durationFrames: 10 }),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    expect(timeline.boundaries[0]).toMatchObject({
      kind: "wipe",
      direction: "bottom-to-top",
      overlapFrames: 10,
    });
  });

  it("placements and boundaries are internally consistent (frame accounting identities)", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        shot("a", 90),
        shot("b", 60, { kind: "crossfade", durationFrames: 12 }),
        shot("c", 60, { kind: "wipe", durationFrames: 8, direction: "right-to-left" }),
      ],
    };
    const timeline = planShotPlacements(plan.fps, plan.shots);
    // Adjacent placements share the boundary: incoming.globalIn === outgoing.globalOut - overlap
    for (const boundary of timeline.boundaries) {
      const incoming = timeline.placements[boundary.shotIndex]!;
      const outgoing = timeline.placements[boundary.shotIndex - 1]!;
      expect(incoming.globalIn).toBe(outgoing.globalOut - boundary.overlapFrames);
      expect(boundary.overlapStart).toBe(incoming.globalIn);
      expect(boundary.overlapEnd).toBe(outgoing.globalOut);
    }
    // Placements are strictly monotonic and gapless apart from overlaps.
    for (let i = 1; i < timeline.placements.length; i++) {
      expect(timeline.placements[i]!.globalIn).toBeGreaterThanOrEqual(
        timeline.placements[i - 1]!.globalIn,
      );
    }
    // Total duration equals sum of durations minus sum of overlaps.
    const sumDurations = plan.shots.reduce((s, x) => s + x.durationInFrames, 0);
    const sumOverlaps = timeline.boundaries.reduce((s, x) => s + x.overlapFrames, 0);
    expect(timeline.totalDurationInFrames).toBe(sumDurations - sumOverlaps);
  });
});
