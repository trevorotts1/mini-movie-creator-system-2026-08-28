import { describe, expect, it } from "vitest";
import type { EpisodeCompositionConfig, EpisodicPlan } from "./types.js";
import { buildEpisodeCompositionRegistry, getCompositionForEpisode, shotDurationInFrames } from "./build.js";
import { formatEpisodeCode, RegistryPlanError, validatePlan } from "./validate.js";

/** Fixture shaped exactly like the DB rows: CORE-004 episodes + CORE-006 scenes/shots. */
function fixturePlan(): EpisodicPlan {
  return {
    series: { id: "ser_monica", title: "Monica", fps: 30, width: 1920, height: 1080 },
    episodes: [
      {
        id: "ep_002",
        seasonNumber: 1,
        episodeNumber: 2,
        scenes: [
          {
            sceneId: "sc_001",
            sequenceIndex: 1,
            shots: [
              { shotId: "sh_001", sequenceIndex: 1, targetDurationSeconds: 5 },
              { shotId: "sh_002", sequenceIndex: 2, targetDurationSeconds: 2.5 },
            ],
          },
          {
            sceneId: "sc_002",
            sequenceIndex: 2,
            shots: [{ shotId: "sh_003", sequenceIndex: 1, targetDurationSeconds: 8 }],
          },
        ],
      },
      {
        id: "ep_001",
        seasonNumber: 1,
        episodeNumber: 1,
        fpsOverride: 24,
        scenes: [
          {
            sceneId: "sc_101",
            sequenceIndex: 1,
            shots: [
              { shotId: "sh_101", sequenceIndex: 1, targetDurationSeconds: 4 },
              { shotId: "sh_102", sequenceIndex: 2, targetDurationSeconds: 1 },
              { shotId: "sh_103", sequenceIndex: 3, targetDurationSeconds: 0.5 },
            ],
          },
        ],
      },
    ],
  };
}

/** Asserts the cumulative layout invariants of one composition: scenes anchor
 * at the running cursor, shots anchor absolutely, no gaps or overlaps. */
function hasContiguousScenes(composition: EpisodeCompositionConfig): boolean {
  let cursor = 0;
  for (const scene of composition.scenes) {
    if (scene.sequenceFrom !== cursor) return false;
    let shotCursor = scene.sequenceFrom;
    for (const shot of scene.shots) {
      if (shot.sequenceFrom !== shotCursor) return false;
      shotCursor += shot.durationInFrames;
    }
    if (shotCursor !== scene.sequenceFrom + scene.durationInFrames) return false;
    cursor += scene.durationInFrames;
  }
  return cursor === composition.durationInFrames;
}

describe("formatEpisodeCode", () => {
  it("zero-pads season and episode to two digits", () => {
    expect(formatEpisodeCode(1, 2)).toBe("S01E02");
    expect(formatEpisodeCode(12, 345)).toBe("S12E345");
  });
});

describe("shotDurationInFrames", () => {
  it("rounds seconds * fps and never returns 0", () => {
    expect(shotDurationInFrames(5, 30)).toBe(150);
    expect(shotDurationInFrames(2.5, 30)).toBe(75);
    expect(shotDurationInFrames(0.01, 30)).toBe(1);
    expect(shotDurationInFrames(1, 24)).toBe(24);
  });
});

describe("buildEpisodeCompositionRegistry", () => {
  const registry = buildEpisodeCompositionRegistry(fixturePlan());

  it("resolves exactly one composition per episode", () => {
    expect(registry.compositions).toHaveLength(2);
    expect(registry.compositions.map((c) => c.episodeCode)).toEqual(["S01E01", "S01E02"]);
    for (const composition of registry.compositions) {
      expect(registry.byEpisodeCode.get(composition.episodeCode)).toBe(composition);
    }
  });

  it("builds composition ids from the episode code and carries DB identities", () => {
    const s01e01 = registry.byEpisodeCode.get("S01E01");
    expect(s01e01?.compositionId).toBe("S01E01");
    expect(s01e01?.seriesId).toBe("ser_monica");
    expect(s01e01?.episodeId).toBe("ep_001");
    expect(s01e01?.fps).toBe(24); // per-episode fps override
    expect(s01e01?.width).toBe(1920);
  });

  it("looks episodes up by code and by composition id", () => {
    const byCode = getCompositionForEpisode(registry, "S01E02");
    expect(byCode?.compositionId).toBe("S01E02");
    expect(getCompositionForEpisode(registry, "S01E02")).toBe(byCode);
    expect(getCompositionForEpisode(registry, "missing")).toBeUndefined();
  });

  it("lays scenes and shots out cumulatively with no gaps or overlaps", () => {
    for (const composition of registry.compositions) {
      expect(hasContiguousScenes(composition)).toBe(true);
    }
    const s01e02 = registry.byEpisodeCode.get("S01E02")!;
    // 5s + 2.5s = 7.5s = 225f; then 8s = 240f; total 465f at 30fps.
    expect(s01e02.scenes[0]?.sequenceFrom).toBe(0);
    expect(s01e02.scenes[0]?.durationInFrames).toBe(225);
    expect(s01e02.scenes[0]?.shots[0]?.sequenceFrom).toBe(0);
    expect(s01e02.scenes[0]?.shots[1]?.sequenceFrom).toBe(150);
    expect(s01e02.scenes[1]?.sequenceFrom).toBe(225);
    expect(s01e02.scenes[1]?.shots[0]?.sequenceFrom).toBe(225);
    expect(s01e02.scenes[1]?.shots[0]?.durationInFrames).toBe(240);
    expect(s01e02.durationInFrames).toBe(465);
  });

  it("supports the upstream local-frame conversion per shot", () => {
    // frames.mjs convention: local_f = global_s * fps − sequence_from, where
    // global_s is the absolute SECOND in the episode. Shot 2 starts at 5s
    // (frame 150): local_f = 5 * 30 − 150 = 0.
    const s01e02 = registry.byEpisodeCode.get("S01E02")!;
    const shot2 = s01e02.scenes[0]?.shots[1];
    expect(shot2).toBeDefined();
    const fps = 30;
    const localAtShotStart = 5 * fps - shot2!.sequenceFrom;
    expect(localAtShotStart).toBe(0);
    // Half a second (15 frames) into shot 2: local_f = 15.
    expect(5.5 * fps - shot2!.sequenceFrom).toBe(15);
  });

  it("honors per-episode fps override in frame math", () => {
    const s01e01 = registry.byEpisodeCode.get("S01E01")!;
    // 4s + 1s + 0.5s at 24fps = 96 + 24 + 12 = 132 frames.
    expect(s01e01.durationInFrames).toBe(132);
    expect(s01e01.scenes[0]?.shots[2]?.durationInFrames).toBe(12);
  });
});

describe("plan validation", () => {
  it("rejects duplicate episode codes", () => {
    const plan = fixturePlan();
    const episodes = [...plan.episodes];
    episodes[1] = { ...episodes[1]!, episodeNumber: 2 };
    const mutated: EpisodicPlan = { ...plan, episodes };
    expect(() => buildEpisodeCompositionRegistry(mutated)).toThrow(RegistryPlanError);
    expect(() => validatePlan(mutated)).toThrow(/duplicate episode code "S01E02"/);
  });

  it("rejects an episode with no scenes", () => {
    const plan = fixturePlan();
    (plan.episodes[0] as { scenes: unknown }).scenes = [];
    expect(() => validatePlan(plan)).toThrow(/no scenes/);
  });

  it("rejects a scene with no shots", () => {
    const plan = fixturePlan();
    (plan.episodes[0]!.scenes[0] as { shots: unknown }).shots = [];
    expect(() => validatePlan(plan)).toThrow(/no shots/);
  });

  it("rejects out-of-order scene sequence indexes", () => {
    const plan = fixturePlan();
    const episodes = [...plan.episodes];
    episodes[0] = { ...episodes[0]!, scenes: [...episodes[0]!.scenes].reverse() };
    const mutated: EpisodicPlan = { ...plan, episodes };
    expect(() => validatePlan(mutated)).toThrow(/out of order/);
  });

  it("rejects duplicate shot ids", () => {
    const plan = fixturePlan();
    (plan.episodes[0]!.scenes[1]!.shots[0] as { shotId: string }).shotId = "sh_001";
    expect(() => validatePlan(plan)).toThrow(/duplicate shot id "sh_001"/);
  });

  it("rejects a non-positive shot duration", () => {
    const plan = fixturePlan();
    (plan.episodes[0]!.scenes[0]!.shots[0] as { targetDurationSeconds: number }).targetDurationSeconds = 0;
    expect(() => validatePlan(plan)).toThrow(/targetDurationSeconds/);
  });

  it("rejects a bad composition-id prefix", () => {
    const plan = fixturePlan();
    (plan.series as { compositionIdPrefix?: string }).compositionIdPrefix = "9show";
    expect(() => validatePlan(plan)).toThrow(/compositionIdPrefix/);
  });

  it("rejects an empty plan", () => {
    expect(() => validatePlan({ series: { id: "s", fps: 30, width: 1920, height: 1080 }, episodes: [] })).toThrow(
      /no episodes/,
    );
  });

  it("accepts a series composition-id prefix in composition ids", () => {
    const plan = fixturePlan();
    (plan.series as { compositionIdPrefix?: string }).compositionIdPrefix = "Monica";
    const registry = buildEpisodeCompositionRegistry(plan);
    expect(registry.compositions[0]?.compositionId).toBe("MonicaS01E01");
    expect(getCompositionForEpisode(registry, "MonicaS01E01")).toBeDefined();
    expect(getCompositionForEpisode(registry, "S01E01")).toBeDefined();
  });
});