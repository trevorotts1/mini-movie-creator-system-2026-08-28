import { describe, expect, it } from "vitest";
import { resolveAspectPlan, seriesDefaultConfig } from "./plan.js";
import { DEFAULT_ASPECT_RATIO, DEFAULT_RESOLUTION_TIER } from "./types.js";

describe("resolveAspectPlan", () => {
  it("builtin default: 16:9/1080p when nothing configured", () => {
    const resolved = resolveAspectPlan({}, ["s1", "s2"]);
    expect(resolved).toHaveLength(2);
    for (const r of resolved) {
      expect(r.source).toBe("builtin-default");
      expect(r.aspectRatio.id).toBe(DEFAULT_ASPECT_RATIO);
      expect(r.canvas).toMatchObject({ width: 1920, height: 1080 });
    }
  });

  it("series default applies to every episode", () => {
    const resolved = resolveAspectPlan(
      { series: { aspectRatio: "9:16", resolutionTier: "720p" } },
      ["s1", "s2"],
    );
    for (const r of resolved) {
      expect(r.source).toBe("series-default");
      expect(r.canvas).toMatchObject({ width: 720, height: 1280 });
    }
  });

  it("per-episode override wins over series default", () => {
    const resolved = resolveAspectPlan(
      {
        series: { aspectRatio: "16:9", resolutionTier: "1080p" },
        episodes: [{ episodeId: "s2", aspectRatio: "9:16" }],
      },
      ["s1", "s2"],
    );
    expect(resolved[0]).toMatchObject({ source: "series-default", canvas: { width: 1920, height: 1080 } });
    expect(resolved[1]).toMatchObject({ source: "episode-override", canvas: { width: 1080, height: 1920 } });
  });

  it("partial override keeps series values for missing fields", () => {
    const resolved = resolveAspectPlan(
      {
        series: { aspectRatio: "16:9", resolutionTier: "720p" },
        episodes: [{ episodeId: "s2", resolutionTier: "1080p" }],
      },
      ["s1", "s2"],
    );
    expect(resolved[1]!.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(resolved[1]!.source).toBe("episode-override");
  });

  it("same plan can produce both 16:9 and 9:16 output", () => {
    const plan = {
      series: { aspectRatio: "16:9" },
      episodes: [{ episodeId: "e2", aspectRatio: "9:16" }],
    };
    const resolved = resolveAspectPlan(plan, ["e1", "e2"]);
    // 16:9 first, then per-episode 9:16 override; both from one plan.
    expect(resolved.map((r) => r.canvas)).toEqual([
      { width: 1920, height: 1080, aspectRatioId: "16:9" },
      { width: 1080, height: 1920, aspectRatioId: "9:16" },
    ]);
  });

  it("rejects an override for an unknown episode", () => {
    expect(() =>
      resolveAspectPlan({ episodes: [{ episodeId: "ghost", aspectRatio: "9:16" }] }, ["e1"]),
    ).toThrow(/unknown episode "ghost"/);
  });

  it("rejects duplicate override entries", () => {
    expect(() =>
      resolveAspectPlan(
        { episodes: [{ episodeId: "e1" }, { episodeId: "e1", aspectRatio: "9:16" }] },
        ["e1"],
      ),
    ).toThrow(/duplicate episode override/);
  });

  it("rejects duplicate episode ids in the plan list", () => {
    expect(() => resolveAspectPlan({}, ["e1", "e1"])).toThrow(/duplicate episode ids/);
  });

  it("rejects invalid ratios in series or override", () => {
    expect(() => resolveAspectPlan({ series: { aspectRatio: "nope" } }, ["e1"])).toThrow();
    expect(() =>
      resolveAspectPlan({ episodes: [{ episodeId: "e1", aspectRatio: "0:0" }] }, ["e1"]),
    ).toThrow();
  });
});

describe("seriesDefaultConfig", () => {
  it("returns defaults when series omitted", () => {
    expect(seriesDefaultConfig()).toEqual({
      aspectRatioId: DEFAULT_ASPECT_RATIO,
      resolutionTier: DEFAULT_RESOLUTION_TIER,
    });
  });

  it("returns series values otherwise", () => {
    expect(seriesDefaultConfig({ aspectRatio: "9:16", resolutionTier: "1440p" })).toEqual({
      aspectRatioId: "9:16",
      resolutionTier: "1440p",
    });
  });
});
