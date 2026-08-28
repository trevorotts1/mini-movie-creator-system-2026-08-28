/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  constraintsFromCapabilityProfile,
  desiredShotCount,
  estimateBeatDurationSeconds,
  estimateShotCost,
  FORTY_FIVE_SECOND_SCENE,
  KEYFRAME_STRATEGIES,
  planDurations,
  planSceneShots,
  planShotSequence,
  ShotPlannerValidationError,
  splitToWindow,
  TYPICAL_SHOT_COUNT_MAX,
  TYPICAL_SHOT_COUNT_MIN,
  type PlannedScene,
  type ShotSpecificationRecord,
  type VideoModelConstraints,
} from "./index.js";

const AGNES_FLASH: VideoModelConstraints = {
  provider: "agnes",
  modelId: "agnes-video-2.5-flash",
  minDurationSeconds: 4,
  maxDurationSeconds: 12,
  pricing: { unit: "usd-per-output-second-720p", amount: 0.025, currency: "USD" },
};

const WAN_30: VideoModelConstraints = {
  provider: "kie",
  modelId: "wan/3-0-video",
  minDurationSeconds: 2,
  maxDurationSeconds: 30,
  pricing: { unit: "usd-per-second-480p", amount: 0.05, currency: "USD" },
};

const UNKNOWN_LIMITS: VideoModelConstraints = {
  provider: "agnes",
  modelId: "agnes-unverified-model",
  minDurationSeconds: null,
  maxDurationSeconds: null,
  pricing: { unit: null, amount: null, currency: "USD" },
};

const SPEC12_REQUIRED_FIELDS: readonly (keyof ShotSpecificationRecord)[] = [
  "shot_id",
  "scene_id",
  "sequence_index",
  "target_duration",
  "characters",
  "character_versions",
  "location",
  "wardrobe",
  "props",
  "dialogue",
  "action",
  "emotion",
  "camera_angle",
  "camera_motion",
  "lens_style",
  "lighting",
  "start_state",
  "end_state",
  "continuity_requirements",
  "reference_assets",
  "keyframe_strategy",
  "preferred_provider",
  "fallback_provider",
  "prompt_source",
  "prompt_compiled",
  "prompt_character_count",
  "estimated_cost",
  "approval_status",
  "generation_status",
  "qc_status",
];

describe("planSceneShots — 45s fixture (spec §7 acceptance)", () => {
  const result = planSceneShots(FORTY_FIVE_SECOND_SCENE, { model: AGNES_FLASH });

  it("produces 5–8 shots for the 45-second reference scene", () => {
    expect(result.shots.length).toBeGreaterThanOrEqual(TYPICAL_SHOT_COUNT_MIN);
    expect(result.shots.length).toBeLessThanOrEqual(TYPICAL_SHOT_COUNT_MAX);
    expect(result.shots.length).toBeGreaterThanOrEqual(5);
    expect(result.shots.length).toBeLessThanOrEqual(8);
  });

  it("every shot fits the selected model duration window", () => {
    for (const shot of result.shots) {
      expect(shot.target_duration).toBeLessThanOrEqual(12);
      expect(shot.target_duration).toBeGreaterThanOrEqual(4);
    }
  });

  it("shot durations sum to the scene duration (±0.1s rounding)", () => {
    const sum = result.shots.reduce((s, x) => s + x.target_duration, 0);
    expect(Math.abs(sum - 45)).toBeLessThanOrEqual(0.1);
  });

  it("numbers shots deterministically SC04_SH01..N in sequence order", () => {
    expect(result.shots[0]?.shot_id).toBe("SC04_SH01");
    expect(result.shots.map((s) => s.sequence_index)).toEqual(
      result.shots.map((_, i) => i + 1),
    );
    const ids = result.shots.map((s) => s.shot_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^SC04_SH\d{2}$/.test(id))).toBe(true);
  });

  it("covers every beat exactly once via source_beat_ids", () => {
    const covered = result.shots.flatMap((s) => s.source_beat_ids).sort();
    expect(covered).toEqual(
      FORTY_FIVE_SECOND_SCENE.beats.map((b) => b.id).sort(),
    );
  });

  it("opens with an establishing shot and varies camera grammar", () => {
    expect(result.shots[0]?.camera_angle).toContain("wide");
    const angles = new Set(result.shots.map((s) => s.camera_angle));
    expect(angles.size).toBeGreaterThan(1);
  });

  it("carries untrusted dialogue verbatim as data", () => {
    const lines = result.shots.flatMap((s) => s.dialogue);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.text.startsWith("You told me the ledger"))).toBe(true);
  });
});

describe("Shot Specification Record — spec §12 fields", () => {
  const result = planSceneShots(FORTY_FIVE_SECOND_SCENE, { model: AGNES_FLASH });

  it("every shot record has every required §12 field present", () => {
    for (const shot of result.shots) {
      for (const field of SPEC12_REQUIRED_FIELDS) {
        expect(shot, `${shot.shot_id} missing ${field}`).toHaveProperty(field);
        const value = shot[field];
        expect(value, `${shot.shot_id}.${field} must not be undefined`).not.toBeUndefined();
      }
    }
  });

  it("populates identity/version, wardrobe, and continuity from the scene cast", () => {
    const monica = result.shots
      .flatMap((s) => s.character_versions)
      .find((v) => v.characterId === "CHAR_MONICA_BENNETT_001");
    expect(monica?.identityVersion).toBe("v1");
    expect(monica?.wardrobeVersion).toBe("business-blue-v1");
    const continuity = result.shots.flatMap((s) => s.continuity_requirements);
    expect(continuity.some((c) => c.includes("wardrobe: business-blue-v1"))).toBe(true);
    expect(continuity.some((c) => c.includes("hair: long-braids-v1"))).toBe(true);
  });

  it("routing defaults to Agnes Flash preferred / Agnes regular fallback (spec §13)", () => {
    for (const shot of result.shots) {
      expect(shot.preferred_provider).toBe("agnes");
      expect(shot.preferred_model).toBe("agnes-video-2.5-flash");
      expect(shot.fallback_provider).toBe("agnes");
      expect(shot.fallback_model).toBe("agnes-video-2.5");
    }
  });

  it("prompt compilation is deferred (null) with prompt_source tracking beats", () => {
    for (const shot of result.shots) {
      expect(shot.prompt_compiled).toBeNull();
      expect(shot.prompt_character_count).toBeNull();
      expect(shot.prompt_source).toMatch(/^beat:B\d{2}/);
    }
  });

  it("gate-4 statuses: PENDING_STORYBOARD / PLANNED / NOT_RUN", () => {
    for (const shot of result.shots) {
      expect(shot.approval_status).toBe("PENDING_STORYBOARD");
      expect(shot.generation_status).toBe("PLANNED");
      expect(shot.qc_status).toBe("NOT_RUN");
    }
  });

  it("keyframe_strategy is one of the spec §8 strategies", () => {
    for (const shot of result.shots) {
      expect(KEYFRAME_STRATEGIES).toContain(shot.keyframe_strategy);
    }
  });

  it("estimates cost from the pricing slice (0.025/s × duration)", () => {
    for (const shot of result.shots) {
      expect(shot.estimated_cost).not.toBeNull();
      expect(shot.estimated_cost).toBeCloseTo(0.025 * shot.target_duration, 4);
    }
  });

  it("estimated_cost stays null when pricing is UNKNOWN — never invented", () => {
    const result = planSceneShots(FORTY_FIVE_SECOND_SCENE, { model: UNKNOWN_LIMITS });
    for (const shot of result.shots) {
      expect(shot.estimated_cost).toBeNull();
    }
    expect(result.warnings.some((w) => w.includes("UNKNOWN"))).toBe(true);
  });
});

describe("model duration limits (spec §7)", () => {
  it("12s-max model splits the 45s scene into more shots than an 8s scene needs", () => {
    const plan = planDurations(45, desiredShotCount(45), AGNES_FLASH);
    expect(plan.shotCount).toBeGreaterThanOrEqual(4);
    expect(Math.max(...plan.durations)).toBeLessThanOrEqual(12);
    expect(Math.min(...plan.durations)).toBeGreaterThanOrEqual(4);
  });

  it("30s-max Wan window absorbs the whole 45s scene only when limits allow — else splits", () => {
    // 45s > 30s max → must split regardless of desired count.
    const plan = planDurations(45, 1, WAN_30);
    expect(plan.shotCount).toBeGreaterThanOrEqual(2);
    expect(Math.max(...plan.durations)).toBeLessThanOrEqual(30);
    expect(Math.min(...plan.durations)).toBeGreaterThanOrEqual(2);
  });

  it("scene inside the window collapses to one shot", () => {
    const plan = planDurations(8, desiredShotCount(8), AGNES_FLASH);
    expect(plan.shotCount).toBe(1);
    expect(plan.durations).toEqual([8]);
  });

  it("raises the shot count until every shot clears the model minimum", () => {
    // 5s scene in a 4–12s window: 1 shot of 5s is legal; a 3-way split (1.7s)
    // would violate min 4 → count must stay low.
    const plan = planDurations(5, 3, AGNES_FLASH);
    expect(Math.min(...plan.durations)).toBeGreaterThanOrEqual(4);
  });

  it("lengthens sub-minimum shots to the model minimum (sum may exceed scene by padding)", () => {
    const plan = planDurations(10, 5, { ...AGNES_FLASH, pricing: null });
    for (const d of plan.durations) expect(d).toBeGreaterThanOrEqual(4);
  });

  it("null (UNKNOWN) limits are treated as unconstrained with a warning", () => {
    const plan = planDurations(45, 6, UNKNOWN_LIMITS);
    expect(plan.usedUnknownLimits).toBe(true);
    expect(plan.shotCount).toBe(6);
  });

  it("throws on scene duration below the model minimum", () => {
    expect(() => planDurations(3, 1, AGNES_FLASH)).toThrow(
      ShotPlannerValidationError,
    );
  });

  it("throws when limits are inverted", () => {
    expect(() =>
      planDurations(45, 6, { ...AGNES_FLASH, minDurationSeconds: 20, maxDurationSeconds: 12 }),
    ).toThrow(ShotPlannerValidationError);
  });

  it("splitToWindow splits an over-max duration into feasible parts", () => {
    const parts = splitToWindow(20, AGNES_FLASH);
    expect(parts.length).toBe(2);
    expect(Math.max(...parts)).toBeLessThanOrEqual(12);
    expect(Math.abs(parts.reduce((s, x) => s + x, 0) - 20)).toBeLessThanOrEqual(0.1);
  });

  it("rejects non-positive scene durations and bad counts", () => {
    expect(() => planDurations(0, 6, AGNES_FLASH)).toThrow(ShotPlannerValidationError);
    expect(() => planDurations(45, 0, AGNES_FLASH)).toThrow(ShotPlannerValidationError);
    expect(() =>
      planSceneShots({ ...FORTY_FIVE_SECOND_SCENE, durationSeconds: -1 }, { model: AGNES_FLASH }),
    ).toThrow(ShotPlannerValidationError);
  });
});

describe("beat estimation", () => {
  it("dialogue length extends beat duration", () => {
    const short = estimateBeatDurationSeconds({
      id: "B1",
      type: "dialogue",
      description: "x",
      characters: ["C1"],
      dialogue: [{ characterId: "C1", text: "Hi." }],
    });
    const long = estimateBeatDurationSeconds({
      id: "B2",
      type: "dialogue",
      description: "x",
      characters: ["C1"],
      dialogue: [
        {
          characterId: "C1",
          text: "I have told you a hundred times that the ledger was closed for good.",
        },
      ],
    });
    expect(long).toBeGreaterThan(short);
  });

  it("durationHintSeconds wins when positive", () => {
    expect(
      estimateBeatDurationSeconds({
        id: "B1",
        type: "insert",
        description: "x",
        characters: [],
        durationHintSeconds: 9.5,
      }),
    ).toBe(9.5);
  });

  it("desired count lands in the 5–8 band around 45s", () => {
    expect(desiredShotCount(45)).toBeGreaterThanOrEqual(5);
    expect(desiredShotCount(45)).toBeLessThanOrEqual(8);
    expect(desiredShotCount(10)).toBeGreaterThanOrEqual(3);
  });
});

describe("cost estimation", () => {
  it("amount × seconds for per-second units", () => {
    expect(estimateShotCost(10, AGNES_FLASH)).toBeCloseTo(0.25, 4);
    expect(estimateShotCost(10, WAN_30)).toBeCloseTo(0.5, 4);
  });

  it("null for unknown units or amounts", () => {
    expect(
      estimateShotCost(10, { ...AGNES_FLASH, pricing: { unit: "usd-per-generation", amount: 1, currency: "USD" } }),
    ).toBeNull();
    expect(
      estimateShotCost(10, { ...AGNES_FLASH, pricing: { unit: null, amount: null, currency: "USD" } }),
    ).toBeNull();
  });
});

describe("profile adapter", () => {
  it("maps a capability-registry-shaped profile preserving UNKNOWN nulls", () => {
    const constraints = constraintsFromCapabilityProfile({
      provider: "agnes",
      modelId: "agnes-video-2.5-flash",
      output: { minDurationSeconds: 4, maxDurationSeconds: 12 },
      pricing: { unit: "usd-per-output-second-720p", amount: 0.025, currency: "USD" },
    });
    expect(constraints.minDurationSeconds).toBe(4);
    expect(constraints.maxDurationSeconds).toBe(12);
    const unknown = constraintsFromCapabilityProfile({
      provider: "agnes",
      modelId: "x",
      output: { minDurationSeconds: null, maxDurationSeconds: null },
    });
    expect(unknown.minDurationSeconds).toBeNull();
    expect(unknown.maxDurationSeconds).toBeNull();
    expect(unknown.pricing).toBeNull();
  });
});

describe("sequence renumbering", () => {
  it("renumbers after a splice and keeps ids deterministic", () => {
    const result = planSceneShots(FORTY_FIVE_SECOND_SCENE, { model: AGNES_FLASH });
    const sliced = planShotSequence(result.shots.slice(1));
    expect(sliced[0]?.shot_id).toBe("SC04_SH01");
    expect(sliced[0]?.sequence_index).toBe(1);
    expect(sliced).toHaveLength(result.shots.length - 1);
  });

  it("throws on duplicate shot ids", () => {
    const result = planSceneShots(FORTY_FIVE_SECOND_SCENE, { model: AGNES_FLASH });
    const duped = [result.shots[0] as ShotSpecificationRecord, result.shots[0] as ShotSpecificationRecord];
    expect(() => planShotSequence(duped)).toThrow(ShotPlannerValidationError);
  });
});

describe("beat/starvation regression — shots must never exceed beats", () => {
  const THREE_BEAT_SCENE: PlannedScene = {
    ...FORTY_FIVE_SECOND_SCENE,
    sceneId: "SC_THREE_BEAT",
    beats: FORTY_FIVE_SECOND_SCENE.beats.slice(0, 3),
  };

  it("3-beat 45s scene with UNKNOWN limits yields 3 shots, not a crash", () => {
    // Before the fix: planDurations honored the desired count (6) with only
    // 3 beats → shots 4–6 had empty beat groups → TypeError on lead.type.
    const result = planSceneShots(THREE_BEAT_SCENE, { model: UNKNOWN_LIMITS });
    expect(result.shots).toHaveLength(3);
    expect(result.warnings.some((w) => w.includes("beat"))).toBe(true);
    const covered = result.shots.flatMap((s) => s.source_beat_ids).sort();
    expect(covered).toEqual(["B01", "B02", "B03"]);
    const sum = result.shots.reduce((s, x) => s + x.target_duration, 0);
    expect(Math.abs(sum - 45)).toBeLessThanOrEqual(0.1);
  });

  it("3-beat 45s scene with a 12s-max model throws an actionable window error (4 shots needed > 3 beats)", () => {
    // 45s needs ceil(45/12)=4 shots in a 4–12s window, but only 3 beats
    // exist → must throw a validation error naming the fix, never a TypeError.
    expect(() => planSceneShots(THREE_BEAT_SCENE, { model: AGNES_FLASH })).toThrow(
      ShotPlannerValidationError,
    );
    try {
      planSceneShots(THREE_BEAT_SCENE, { model: AGNES_FLASH });
    } catch (e) {
      expect((e as Error).message).toContain("add beats");
    }
  });
});

describe("input validation", () => {
  it("rejects unsafe shotIdPrefix (asset-naming safety, spec §19)", () => {
    expect(() =>
      planSceneShots(FORTY_FIVE_SECOND_SCENE, {
        model: AGNES_FLASH,
        shotIdPrefix: "../evil",
      }),
    ).toThrow(ShotPlannerValidationError);
    expect(() =>
      planSceneShots(FORTY_FIVE_SECOND_SCENE, {
        model: AGNES_FLASH,
        shotIdPrefix: "SC04/../../escape",
      }),
    ).toThrow(ShotPlannerValidationError);
  });

  it("rejects NaN scene duration instead of emitting NaN durations", () => {
    expect(() =>
      planSceneShots(
        { ...FORTY_FIVE_SECOND_SCENE, durationSeconds: Number.NaN },
        { model: AGNES_FLASH },
      ),
    ).toThrow(ShotPlannerValidationError);
    expect(() =>
      planSceneShots(
        { ...FORTY_FIVE_SECOND_SCENE, durationSeconds: Number.POSITIVE_INFINITY },
        { model: AGNES_FLASH },
      ),
    ).toThrow(ShotPlannerValidationError);
  });

  it("rejects empty-beat scenes and unsafe scene ids", () => {
    expect(() =>
      planSceneShots({ ...FORTY_FIVE_SECOND_SCENE, beats: [] }, { model: AGNES_FLASH }),
    ).toThrow(ShotPlannerValidationError);
    expect(() =>
      planSceneShots(
        { ...FORTY_FIVE_SECOND_SCENE, sceneId: "bad id!" },
        { model: AGNES_FLASH },
      ),
    ).toThrow(ShotPlannerValidationError);
  });

  it("a scene with durationSeconds 0 estimates duration from beats", () => {
    const result = planSceneShots(
      { ...FORTY_FIVE_SECOND_SCENE, durationSeconds: 0 },
      { model: AGNES_FLASH },
    );
    const sum = result.shots.reduce((s, x) => s + x.target_duration, 0);
    expect(sum).toBeGreaterThanOrEqual(40);
    expect(sum).toBeLessThanOrEqual(50);
  });
});