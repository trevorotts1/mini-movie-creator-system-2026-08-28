// VID-012 acceptance tests — rough-cut assembly (spec §21/§23/§32).
//
// Acceptance (todo.md TASK-VID-012):
//   1. shot sequence + dialogue + temp music assemble deterministically
//   2. deterministic frame math (upstream `local_f = round(global_s * fps)
//      − sequence_from` discipline; byte-identical timelines for equal plans)
//   3. 16:9 AND 9:16 resolutions resolve from the same plan shape (§23)
//   4. plan validation rejects structural defects without parsing content

import { describe, expect, it } from "vitest";

import {
  assembleRoughCut,
  framesForSeconds,
  resolutionForFormat,
  roughCutFileName,
  validateRoughCutPlan,
} from "./assemble.js";
import { RoughCutError } from "./errors.js";
import {
  RESOLUTION_16_9,
  RESOLUTION_9_16,
  ROUGH_CUT_PLAN_VERSION,
  type RoughCutPlan,
} from "./types.js";

function makePlan(over: Partial<RoughCutPlan> = {}): RoughCutPlan {
  return {
    formatVersion: ROUGH_CUT_PLAN_VERSION,
    seriesId: "series-1",
    episodeId: "ep-1",
    episodeCode: "S01E01",
    format: "16:9",
    shots: [
      {
        shotId: "S01E01_SC01_SH01",
        sequenceIndex: 1,
        targetDurationSeconds: 2.5,
        layerKind: "generated-video",
        assetRef: "ghl://media/projects/s1/S01E01_SC01_SH01.mp4",
      },
      {
        shotId: "S01E01_SC01_SH02",
        sequenceIndex: 2,
        targetDurationSeconds: 1.5,
        layerKind: "still-motion",
        assetRef: "ghl://media/projects/s1/S01E01_SC01_SH02.jpg",
      },
      {
        shotId: "S01E01_SC02_SH03",
        sequenceIndex: 3,
        targetDurationSeconds: 2,
        layerKind: "graphics",
      },
    ],
    dialogue: [
      {
        dialogueId: "line-01",
        assetKey: "fish-cache:abc123",
        startSec: 0.4,
        durationSec: 2.1,
      },
    ],
    tempMusic: { assetRef: "ghl://media/library/music/bed-01.mp3", gainDb: -7 },
    ...over,
  };
}

describe("framesForSeconds", () => {
  it("rounds once, half-up, on the fps grid", () => {
    expect(framesForSeconds(0, 30)).toBe(0);
    expect(framesForSeconds(1, 30)).toBe(30);
    expect(framesForSeconds(2.5, 30)).toBe(75);
    expect(framesForSeconds(0.0334, 30)).toBe(1); // 1.002 → 1
  });

  it("rejects negative seconds and out-of-range fps", () => {
    expect(() => framesForSeconds(-1, 30)).toThrow(RoughCutError);
    expect(() => framesForSeconds(1, 0)).toThrow(RoughCutError);
    expect(() => framesForSeconds(1, 300)).toThrow(RoughCutError);
    expect(() => framesForSeconds(Number.NaN, 30)).toThrow(RoughCutError);
  });
});

describe("assembleRoughCut", () => {
  it("places shots back-to-back with integer frame boundaries", () => {
    const timeline = assembleRoughCut(makePlan());
    expect(timeline.segments.map((s) => s.shotId)).toEqual([
      "S01E01_SC01_SH01",
      "S01E01_SC01_SH02",
      "S01E01_SC02_SH03",
    ]);
    // 2.5s → 75f, 1.5s → 45f, 2s → 60f @30fps
    expect(timeline.segments[0]!).toMatchObject({ sequenceFrom: 0, durationInFrames: 75 });
    expect(timeline.segments[1]!).toMatchObject({ sequenceFrom: 75, durationInFrames: 45 });
    expect(timeline.segments[2]!).toMatchObject({ sequenceFrom: 120, durationInFrames: 60 });
    expect(timeline.totalFrames).toBe(180);
    expect(timeline.durationSeconds).toBeCloseTo(6, 10);
  });

  it("keeps no gaps or overlaps: shot n+1 starts at shot n's out frame", () => {
    const timeline = assembleRoughCut(makePlan());
    for (let i = 1; i < timeline.segments.length; i++) {
      expect(timeline.segments[i]!.sequenceFrom).toBe(
        timeline.segments[i - 1]!.globalOutFrame,
      );
    }
  });

  it("sorts by sequenceIndex regardless of input order", () => {
    const plan = makePlan();
    const shuffled = assembleRoughCut({ ...plan, shots: [...plan.shots].reverse() });
    const ordered = assembleRoughCut(plan);
    expect(shuffled).toEqual(ordered);
  });

  it("converts dialogue master seconds once via round(seconds * fps)", () => {
    const timeline = assembleRoughCut(makePlan());
    expect(timeline.dialogue[0]!.startFrame).toBe(Math.round(0.4 * 30)); // 12
    expect(timeline.dialogue[0]!.durationFrames).toBe(Math.round(2.1 * 30)); // 63
    expect(timeline.dialogue[0]!.sourceSec).toBe(0.4);
    expect(timeline.dialogue[0]!.assetKey).toBe("fish-cache:abc123");
  });

  it("pins the temp music bed to frame 0 with the upstream default gain", () => {
    const timeline = assembleRoughCut(makePlan());
    expect(timeline.tempMusic).toEqual({
      assetRef: "ghl://media/library/music/bed-01.mp3",
      gainDb: -7,
    });
    const noMusic = assembleRoughCut(makePlan({ tempMusic: undefined }));
    expect(noMusic.tempMusic).toBeNull();
  });

  it("resolves master resolutions for 16:9 and 9:16 from the same plan", () => {
    expect(assembleRoughCut(makePlan()).resolution).toEqual(RESOLUTION_16_9);
    expect(assembleRoughCut(makePlan({ format: "9:16" })).resolution).toEqual(RESOLUTION_9_16);
  });

  it("is byte-identical for identical plans (determinism)", () => {
    const a = JSON.stringify(assembleRoughCut(makePlan()));
    const b = JSON.stringify(assembleRoughCut(makePlan()));
    expect(a).toBe(b);
  });

  it("emits a zero-frame-safe segment (min 1 frame) for a sub-frame shot", () => {
    const timeline = assembleRoughCut(
      makePlan({
        shots: [
          {
            shotId: "tiny",
            sequenceIndex: 0,
            targetDurationSeconds: 0.001,
            layerKind: "graphics",
          },
        ],
      }),
    );
    expect(timeline.totalFrames).toBe(1);
  });
});

describe("validateRoughCutPlan", () => {
  it("accepts a valid plan silently", () => {
    expect(() => validateRoughCutPlan(makePlan())).not.toThrow();
  });

  it("rejects a wrong formatVersion", () => {
    expect(() => validateRoughCutPlan(makePlan({ formatVersion: 2 as never }))).toThrow(
      /formatVersion/,
    );
  });

  it("rejects duplicate sequenceIndex", () => {
    const broken = makePlan({
      shots: [
        {
          shotId: "a",
          sequenceIndex: 1,
          targetDurationSeconds: 1,
          layerKind: "generated-video",
          assetRef: "ghl://a.mp4",
        },
        {
          shotId: "b",
          sequenceIndex: 1,
          targetDurationSeconds: 1,
          layerKind: "generated-video",
          assetRef: "ghl://b.mp4",
        },
      ],
    });
    expect(() => validateRoughCutPlan(broken)).toThrow(/duplicate sequenceIndex/);
  });

  it("rejects asset-bearing shots without an assetRef", () => {
    const broken = makePlan({
      shots: [
        {
          shotId: "S01E01_SC01_SH01",
          sequenceIndex: 1,
          targetDurationSeconds: 1,
          layerKind: "generated-video",
        },
      ],
    });
    expect(() => validateRoughCutPlan(broken)).toThrow(/requires an archived assetRef/);
  });

  it("accepts graphics shots without an assetRef", () => {
    expect(() => validateRoughCutPlan(makePlan())).not.toThrow();
  });

  it("rejects unknown layer kinds and formats", () => {
    const broken = makePlan({
      shots: [
        {
          shotId: "S01E01_SC01_SH01",
          sequenceIndex: 1,
          targetDurationSeconds: 1,
          layerKind: "hologram" as never,
          assetRef: "ghl://a.mp4",
        },
      ],
    });
    expect(() => validateRoughCutPlan(broken)).toThrow(/layerKind/);
    expect(() => validateRoughCutPlan(makePlan({ format: "4:3" as never }))).toThrow(/format/);
  });

  it("rejects custom format without a custom resolution", () => {
    expect(() => validateRoughCutPlan(makePlan({ format: "custom" }))).toThrow(/custom/);
  });

  it("rejects an empty shot list and empty ids", () => {
    expect(() => validateRoughCutPlan(makePlan({ shots: [] }))).toThrow(/shots/);
    expect(() => validateRoughCutPlan(makePlan({ episodeCode: "  " }))).toThrow(/episodeCode/);
  });
});

describe("resolutionForFormat", () => {
  it("maps §23 formats to master resolutions", () => {
    expect(resolutionForFormat("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(resolutionForFormat("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(resolutionForFormat("custom", { width: 1440, height: 1080 })).toEqual({
      width: 1440,
      height: 1080,
    });
    expect(() => resolutionForFormat("custom")).toThrow(RoughCutError);
    expect(() => resolutionForFormat("custom", { width: 0, height: 100 })).toThrow(RoughCutError);
  });
});

describe("roughCutFileName", () => {
  it("is deterministic and versioned", () => {
    expect(roughCutFileName("S01E01")).toBe("S01E01_roughcut_v01.mp4");
    expect(roughCutFileName("S01E01", 2)).toBe("S01E01_roughcut_v02.mp4");
  });
});
