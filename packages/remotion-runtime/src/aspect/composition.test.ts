import { describe, expect, it } from "vitest";
import { compositionsFromPlan } from "./composition.js";

describe("compositionsFromPlan", () => {
  it("generates 16:9 and 9:16 compositions from the same plan", () => {
    const plan = {
      series: { aspectRatio: "16:9" },
      episodes: [{ episodeId: "e2", aspectRatio: "9:16" }],
    };
    const comps = compositionsFromPlan(plan, ["e1", "e2"], { fps: 30, durationInSeconds: 12 });
    expect(comps).toHaveLength(2);

    const land = comps[0]!;
    expect(land.id).toBe("episode-e1-16x9");
    expect(land.aspectRatioId).toBe("16:9");
    expect(land.width).toBe(1920);
    expect(land.height).toBe(1080);
    expect(land.fps).toBe(30);
    expect(land.durationInFrames).toBe(12 * 30);
    expect(land.safeArea.width).toBeLessThan(land.width);
    expect(land.captionZone.y + land.captionZone.height).toBeLessThanOrEqual(land.height);

    const port = comps[1]!;
    expect(port.id).toBe("episode-e2-9x16");
    expect(port.aspectRatioId).toBe("9:16");
    expect(port.width).toBe(1080);
    expect(port.height).toBe(1920);
    expect(port.fps).toBe(land.fps);
    expect(port.durationInFrames).toBe(land.durationInFrames);
  });

  it("same plan, both episodes 16:9 -> identical canvases, distinct ids", () => {
    const comps = compositionsFromPlan({ series: { aspectRatio: "16:9" } }, ["e1", "e2"], {
      fps: 24,
      durationInSeconds: 5,
    });
    expect(comps[0]).toMatchObject({ width: 1920, height: 1080, fps: 24, durationInFrames: 120 });
    expect(comps[1]!.id).toBe("episode-e2-16x9");
    expect(comps[1]!.width).toBe(1920);
  });

  it("rounds fractional durations to whole frames", () => {
    const comps = compositionsFromPlan({}, ["e1"], { fps: 30, durationInSeconds: 1.5 });
    expect(comps[0]!.durationInFrames).toBe(45);
  });

  it("supports per-episode duration overrides", () => {
    const comps = compositionsFromPlan({}, ["e1", "e2"], {
      fps: 30,
      durationInSeconds: 10,
      durationsByEpisode: { e2: 20 },
    });
    expect(comps[0]!.durationInFrames).toBe(300);
    expect(comps[1]!.durationInFrames).toBe(600);
  });

  it("rejects bad fps / duration", () => {
    expect(() => compositionsFromPlan({}, ["e1"], { fps: 0 })).toThrow(/invalid fps/);
    expect(() => compositionsFromPlan({}, ["e1"], { durationInSeconds: -1 })).toThrow(/invalid durationInSeconds/);
    expect(() =>
      compositionsFromPlan({}, ["e1"], { durationsByEpisode: { e1: -5 } }),
    ).toThrow(/invalid duration for episode "e1"/);
  });
});
