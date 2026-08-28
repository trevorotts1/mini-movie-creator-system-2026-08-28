// VID-013 acceptance tests — selective shot replacement (spec §20, §21, §32).
//
// The centerpiece is the composition diff test: replace one shot (new asset
// and/or trim) and PROVE via structural diff that only the targeted shot's
// inputs change — every other segment is passed through by reference, never
// regenerated.

import { describe, expect, it } from "vitest";
import {
  applyRetryShot,
  diffPlans,
  inputsKey,
  planRetryShot,
  replaceShot,
  timelineLayout,
  totalDurationFrames,
  validatePlan,
} from "./replace.js";
import {
  SHOT_LAYER_KINDS,
  ShotReplacementError,
  type EpisodicShotPlan,
  type ShotSegment,
} from "./types.js";

function seg(
  shotId: string,
  sequenceIndex: number,
  durationInFrames: number,
  inputs: ShotSegment["inputs"],
  sceneId = "SC01",
): ShotSegment {
  return {
    shotId,
    sceneId,
    sequenceIndex,
    durationInFrames,
    inputs,
  };
}

/** A 4-shot fixture plan, 30fps: 90 + 120 + 75 + 105 frames. */
function fixturePlan(): EpisodicShotPlan {
  return {
    episodeId: "S01E01",
    fps: 30,
    segments: [
      {
        shotId: "SH01",
        sceneId: "SC01",
        sequenceIndex: 1,
        durationInFrames: 90,
        inputs: {
          layerKind: "generated-video",
          assetRef: "ghl://media/S01E01_SH01_monica_closeup_v01.mp4",
          cameraMotion: "slow-push-in",
          captionRefs: ["cap://S01E01_SH01"],
          audioRefs: ["audio://S01E01_line01"],
        },
      },
      {
        shotId: "SH02",
        sceneId: "SC01",
        sequenceIndex: 2,
        durationInFrames: 120,
        inputs: {
          layerKind: "generated-video",
          assetRef: "ghl://media/S01E01_SH02_monica_reverse_v01.mp4",
        },
      },
      {
        shotId: "SH03",
        sceneId: "SC02",
        sequenceIndex: 3,
        durationInFrames: 75,
        inputs: {
          layerKind: "still-motion",
          assetRef: "ghl://media/S01E01_SH03_harris_wide_v01.png",
          cameraMotion: "pan-right",
        },
      },
      {
        shotId: "SH04",
        sceneId: "SC02",
        sequenceIndex: 4,
        durationInFrames: 105,
        inputs: { layerKind: "graphics" },
      },
    ],
  };
}

describe("timelineLayout + totalDurationFrames", () => {
  it("derives absolute frame ranges with zero gaps and zero overlap", () => {
    const layout = timelineLayout(fixturePlan());
    expect(layout.map((t) => t.segment.shotId)).toEqual([
      "SH01",
      "SH02",
      "SH03",
      "SH04",
    ]);
    expect(layout.map((t) => t.startFrame)).toEqual([0, 90, 210, 285]);
    expect(layout.map((t) => t.endFrame)).toEqual([90, 210, 285, 390]);
    expect(totalDurationFrames(fixturePlan())).toBe(390);
  });

  it("rejects duplicate shotIds and non-ascending sequence", () => {
    const dup = fixturePlan();
    const bad: EpisodicShotPlan = {
      ...dup,
      segments: [dup.segments[0]!, { ...dup.segments[1]!, shotId: "SH01" }],
    };
    expect(() => validatePlan(bad)).toThrow(ShotReplacementError);
    const unordered: EpisodicShotPlan = {
      ...dup,
      segments: [dup.segments[1]!, dup.segments[0]!],
    };
    expect(() => validatePlan(unordered)).toThrow(/sequenceIndex/);
  });
});

describe("replaceShot — composition diff proof (acceptance §32)", () => {
  it("new asset on SH02: ONLY SH02 changes; SH01/SH03/SH04 pass through by reference", () => {
    const before = fixturePlan();
    const after = replaceShot(before, {
      shotId: "SH02",
      assetRef: "ghl://media/S01E01_SH02_monica_reverse_v02.mp4",
    });
    // The acceptance proof: diff names exactly the targeted shot.
    expect(after.diff.changedShotIds).toEqual(["SH02"]);
    expect(after.diff.reflowedShotIds).toEqual([]);
    expect(after.diff.unchangedShotIds).toEqual(["SH01", "SH03", "SH04"]);
    expect(after.diff.durationDelta).toBe(0);

    // Pass-through is by reference: identical objects, provably untouched.
    const beforeById = new Map(before.segments.map((s) => [s.shotId, s]));
    for (const segAfter of after.plan.segments) {
      if (segAfter.shotId !== "SH02") {
        expect(segAfter).toBe(beforeById.get(segAfter.shotId));
      }
    }
    // Replaced segment keeps its slot; only the asset input changed.
    const replaced = after.plan.segments.find((s) => s.shotId === "SH02")!;
    expect(replaced.inputs.assetRef).toBe("ghl://media/S01E01_SH02_monica_reverse_v02.mp4");
    expect(replaced.durationInFrames).toBe(120);
    expect(replaced.sceneId).toBe("SC01");
  });

  it("new trim on SH01: fitted to slot — only SH01's inputs change, layout intact", () => {
    const before = fixturePlan();
    const after = replaceShot(before, {
      shotId: "SH01",
      trimInFrames: 30,
      trimOutFrames: 120,
    });
    expect(after.diff.changedShotIds).toEqual(["SH01"]);
    expect(after.diff.unchangedShotIds).toEqual(["SH02", "SH03", "SH04"]);
    expect(after.diff.totalDurationAfter).toBe(390);
    const replaced = after.plan.segments.find((s) => s.shotId === "SH01")!;
    expect(replaced.inputs.trimInFrames).toBe(30);
    expect(replaced.inputs.trimOutFrames).toBe(120);
    expect(replaced.durationInFrames).toBe(90); // fit-slot keeps the slot
    // Downstream placement untouched.
    const layout = timelineLayout(after.plan);
    expect(layout.map((t) => t.startFrame)).toEqual([0, 90, 210, 285]);
  });

  it("explicit duration reflows downstream START frames but never their inputs", () => {
    const before = fixturePlan();
    const after = replaceShot(before, {
      shotId: "SH02",
      assetRef: "ghl://media/S01E01_SH02_alt.mp4",
      durationPolicy: "explicit",
      durationInFrames: 60,
    });
    expect(after.diff.changedShotIds).toEqual(["SH02"]);
    // SH01 unchanged in place; SH03/SH04 reflowed (start shifts, inputs equal).
    expect(after.diff.unchangedShotIds).toEqual(["SH01"]);
    expect(after.diff.reflowedShotIds).toEqual(["SH03", "SH04"]);
    expect(after.diff.durationDelta).toBe(-60);

    const beforeById = new Map(before.segments.map((s) => [s.shotId, s]));
    const afterById = new Map(after.plan.segments.map((s) => [s.shotId, s]));
    for (const id of ["SH03", "SH04"]) {
      expect(afterById.get(id)!.durationInFrames).toBe(
        beforeById.get(id)!.durationInFrames,
      );
      expect(inputsKey(afterById.get(id)!.inputs)).toBe(
        inputsKey(beforeById.get(id)!.inputs),
      );
    }
    const layout = timelineLayout(after.plan);
    const sh03 = layout.find((t) => t.segment.shotId === "SH03")!;
    expect(sh03.startFrame).toBe(90 + 60);
  });

  it("replaced shot preserves unspecified inputs (cameraMotion, captionRefs, audioRefs)", () => {
    const before = fixturePlan();
    const after = replaceShot(before, {
      shotId: "SH01",
      assetRef: "ghl://media/S01E01_SH01_new.mp4",
    });
    const replaced = after.plan.segments.find((s) => s.shotId === "SH01")!;
    expect(replaced.inputs.cameraMotion).toBe("slow-push-in");
    expect(replaced.inputs.captionRefs).toEqual(["cap://S01E01_SH01"]);
    expect(replaced.inputs.audioRefs).toEqual(["audio://S01E01_line01"]);
  });

  it("layerKind swap generated-video -> still-motion is legal for the same shot", () => {
    const before = fixturePlan();
    const after = replaceShot(before, {
      shotId: "SH02",
      layerKind: "still-motion",
      assetRef: "ghl://media/S01E01_SH02_still.png",
      cameraMotion: "ken-burns",
    });
    expect(after.diff.changedShotIds).toEqual(["SH02"]);
    const replaced = after.plan.segments.find((s) => s.shotId === "SH02")!;
    expect(replaced.inputs.layerKind).toBe("still-motion");
    expect(replaced.inputs.cameraMotion).toBe("ken-burns");
  });

  it("rejects unknown shot, bad layer kind, invalid trim, and graphics-without-asset edges", () => {
    const plan = fixturePlan();
    expect(() =>
      replaceShot(plan, { shotId: "SH99", assetRef: "x://y" }),
    ).toThrow(/not found/);
    expect(() =>
      replaceShot(plan, { shotId: "SH01", layerKind: "vhs" as never }),
    ).toThrow(/layerKind/);
    expect(() =>
      replaceShot(plan, { shotId: "SH01", trimInFrames: 50, trimOutFrames: 50 }),
    ).toThrow(/must exceed/);
    expect(() =>
      replaceShot(plan, { shotId: "SH01", trimInFrames: -1 }),
    ).toThrow(/non-negative/);
    expect(() =>
      replaceShot(plan, {
        shotId: "SH04",
        layerKind: "generated-video",
        assetRef: "",
      }),
    ).toThrow(/requires assetRef/);
    expect(() =>
      replaceShot(plan, {
        shotId: "SH01",
        durationPolicy: "explicit",
        durationInFrames: 0,
      }),
    ).toThrow(/positive integer/);
  });
});

describe("diffPlans — comparability guards", () => {
  it("refuses to diff different episodes or fps", () => {
    const plan = fixturePlan();
    expect(() =>
      diffPlans(plan, { ...fixturePlan(), episodeId: "S01E02" }),
    ).toThrow(/different episodes/);
    expect(() => diffPlans(plan, { ...fixturePlan(), fps: 24 })).toThrow(
      /different fps/,
    );
  });

  it("refuses to diff when shot identity differs — replacement never adds/removes shots", () => {
    const plan = fixturePlan();
    const fewer: EpisodicShotPlan = { ...plan, segments: plan.segments.slice(0, 3) };
    expect(() => diffPlans(plan, fewer)).toThrow(/identities differ/);
  });

  it("identical plans diff to all-unchanged with zero delta", () => {
    const plan = fixturePlan();
    const d = diffPlans(plan, fixturePlan());
    expect(d.changedShotIds).toEqual([]);
    expect(d.reflowedShotIds).toEqual([]);
    expect(d.unchangedShotIds).toEqual(["SH01", "SH02", "SH03", "SH04"]);
    expect(d.durationDelta).toBe(0);
  });
});

describe("retry — targeted scope (spec §20)", () => {
  it("planRetryShot scopes regeneration to EXACTLY the failed shot", () => {
    const plan = fixturePlan();
    const retry = planRetryShot(plan, "SH03", {
      attempt: 2,
      reason: "QC FAIL: wardrobe drift",
    });
    expect(retry.regeneratesShotIds).toEqual(["SH03"]);
    expect(retry.preservedShotIds).toEqual(["SH01", "SH02", "SH04"]);
    expect(retry.attempt).toBe(2);
    expect(retry.reason).toBe("QC FAIL: wardrobe drift");
  });

  it("applyRetryShot replaces only the failed shot and the diff proves it", () => {
    const plan = fixturePlan();
    const retry = planRetryShot(plan, "SH03", { attempt: 2 });
    const after = applyRetryShot(plan, retry, {
      assetRef: "ghl://media/S01E01_SH03_harris_wide_v02.png",
      trimInFrames: 0,
      trimOutFrames: 75,
    });
    expect(after.retry.regeneratesShotIds).toEqual(["SH03"]);
    expect(after.diff.changedShotIds).toEqual(["SH03"]);
    expect(after.diff.unchangedShotIds).toEqual(["SH01", "SH02", "SH04"]);
    const replaced = after.plan.segments.find((s) => s.shotId === "SH03")!;
    expect(replaced.inputs.assetRef).toBe(
      "ghl://media/S01E01_SH03_harris_wide_v02.png",
    );
    expect(replaced.durationInFrames).toBe(75); // fit-slot
  });

  it("rejects retry for unknown shot and tampered retry scope", () => {
    const plan = fixturePlan();
    expect(() => planRetryShot(plan, "NOPE")).toThrow(/not found/);
    const retry = planRetryShot(plan, "SH02");
    const tampered = { ...retry, regeneratesShotIds: ["SH01", "SH02"] };
    expect(() =>
      applyRetryShot(plan, tampered, { assetRef: "ghl://x.mp4" }),
    ).toThrow(/exactly its own shot/);
    expect(() => planRetryShot(plan, "SH01", { attempt: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("trim fit semantics", () => {
  it("source window length drives the fit message; slot duration governs output", () => {
    const plan = fixturePlan();
    // 30fps episode, 120-frame slot, source at 60fps: 90 source frames at
    // 60fps == 45 output frames; the fit happens at the render seam, so the
    // slot duration is unchanged and only SH02's inputs move.
    const after = replaceShot(
      plan,
      { shotId: "SH02", trimInFrames: 0, trimOutFrames: 90 },
      { sourceFps: 60 },
    );
    expect(after.diff.changedShotIds).toEqual(["SH02"]);
    expect(after.diff.durationDelta).toBe(0);
    const replaced = after.plan.segments.find((s) => s.shotId === "SH02")!;
    expect(replaced.inputs.trimInFrames).toBe(0);
    expect(replaced.inputs.trimOutFrames).toBe(90);
  });

  it("partial trim update keeps the unspecified edge from the existing shot", () => {
    const plan = fixturePlan();
    const withTrim: EpisodicShotPlan = replaceShot(plan, {
      shotId: "SH02",
      trimInFrames: 10,
      trimOutFrames: 200,
    }).plan;
    const tightened = replaceShot(withTrim, { shotId: "SH02", trimOutFrames: 150 });
    const replaced = tightened.plan.segments.find((s) => s.shotId === "SH02")!;
    expect(replaced.inputs.trimInFrames).toBe(10); // preserved edge
    expect(replaced.inputs.trimOutFrames).toBe(150);
    expect(tightened.diff.changedShotIds).toEqual(["SH02"]);
  });
});

describe("SHOT_LAYER_KINDS (spec §22)", () => {
  it("exposes exactly the four visual layer kinds", () => {
    expect([...SHOT_LAYER_KINDS]).toEqual([
      "generated-video",
      "still-motion",
      "stock",
      "graphics",
    ]);
  });
});