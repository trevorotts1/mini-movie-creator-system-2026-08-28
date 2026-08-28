/// <reference types="node" />
// VID-012 acceptance tests — rough-cut preview render (spec §21/§32).
//
// Acceptance (todo.md TASK-VID-012): "16:9 AND 9:16 rough cuts render …
// on fixture project" and "full episode assembles from shot plan + archived
// assets". These tests use the REAL system ffmpeg/ffprobe binaries (repo
// prerequisites) to prove the produced preview MP4s are ffprobe-valid at
// both master formats — no network, no provider spend, no committed media
// (outputs go to a temp dir and are removed after).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoughCutError } from "./errors.js";
import {
  ffprobeValidateRoughCut,
  makeFfmpegFixtureAdapter,
  planRoughCutRender,
  renderRoughCut,
  type RoughCutProbeReport,
} from "./render.js";
import { spawnFile } from "./spawn.js";
import { ROUGH_CUT_PLAN_VERSION, type RoughCutPlan } from "./types.js";

/** Small, fast fixture resolution for the ffmpeg fixture renders. */
const FIXTURE_16_9 = { width: 320, height: 180 };
const FIXTURE_9_16 = { width: 180, height: 320 };

function makePlan(
  over: Partial<RoughCutPlan> & { format?: "16:9" | "9:16"; custom?: never } = {},
): RoughCutPlan {
  return {
    formatVersion: ROUGH_CUT_PLAN_VERSION,
    seriesId: "series-1",
    episodeId: "ep-1",
    episodeCode: "S01E01",
    format: over.format ?? "16:9",
    custom: undefined,
    fps: 30,
    shots: [
      {
        shotId: "S01E01_SC01_SH01",
        sequenceIndex: 1,
        targetDurationSeconds: 1,
        layerKind: "generated-video",
        assetRef: "ghl://media/projects/s1/hero.mp4",
      },
      {
        shotId: "S01E01_SC01_SH02",
        sequenceIndex: 2,
        targetDurationSeconds: 0.75,
        layerKind: "still-motion",
        assetRef: "ghl://media/projects/s1/establish.jpg",
      },
      {
        shotId: "S01E01_SC01_SH03",
        sequenceIndex: 3,
        targetDurationSeconds: 0.5,
        layerKind: "graphics",
      },
    ],
    dialogue: [
      {
        dialogueId: "line-01",
        assetKey: "fish-cache:abc123",
        startSec: 0.4,
        durationSec: 1.2,
      },
    ],
    tempMusic: { assetRef: "ghl://media/library/music/bed-01.mp3" },
    ...over,
  };
}

describe("planRoughCutRender", () => {
  it("resolves composition, deterministic filename, and assembled timeline", () => {
    const plan = makePlan();
    const assembled = planRoughCutRender(plan, { outputDir: "/tmp/x" });
    expect(assembled.compositionId).toBe("S01E01");
    expect(assembled.fileName).toBe("S01E01_roughcut_v01.mp4");
    expect(assembled.outputPath).toBe("/tmp/x/S01E01_roughcut_v01.mp4");
    expect(assembled.timeline.totalFrames).toBe(68); // 30 + 22.5→23 + 15
  });
});

describe("renderRoughCut with the real-ffmpeg fixture adapter", () => {
  let dir: string;
  let adapter: ReturnType<typeof makeFfmpegFixtureAdapter>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcs-roughcut-"));
    adapter = makeFfmpegFixtureAdapter();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a 16:9 preview MP4 that passes the ffprobe gate (spec §32)", async () => {
    const plan = makePlan({ format: "16:9", custom: undefined });
    // The fixture adapter synthesizes at the timeline's own resolution; pin
    // the plan to the fixture resolution via custom so renders stay fast.
    const result = await renderRoughCut(
      { ...plan, format: "custom", custom: FIXTURE_16_9 },
      { render: adapter },
      { outputDir: dir },
    );
    expect(result.fileName).toBe("S01E01_roughcut_v01.mp4");
    expect(result.probe.ok).toBe(true);
    expect(result.probe.codec).toBe("h264");
    expect(result.probe.width).toBe(FIXTURE_16_9.width);
    expect(result.probe.height).toBe(FIXTURE_16_9.height);
    expect(result.probe.durationSeconds).toBeGreaterThan(2);
    expect(result.durationSeconds).toBeCloseTo(result.probe.durationSeconds ?? -1, 1);
    expect(result.shotCount).toBe(3);
    expect(result.dialogueCount).toBe(1);
    expect(result.hasTempMusic).toBe(true);
    const info = statSync(result.output);
    expect(info.size).toBeGreaterThan(0);
    // Real output carries real probe data: re-probe independently.
    const again = await ffprobeValidateRoughCut(result.output);
    expect(again.ok).toBe(true);
  });

  it("renders a 9:16 preview MP4 that passes the ffprobe gate (spec §32)", async () => {
    const result = await renderRoughCut(
      { ...makePlan({ format: "9:16" }), format: "custom", custom: FIXTURE_9_16 },
      { render: adapter },
      { outputDir: dir, version: 2 },
    );
    expect(result.probe.ok).toBe(true);
    expect(result.probe.width).toBe(FIXTURE_9_16.width);
    expect(result.probe.height).toBe(FIXTURE_9_16.height);
    expect(result.fileName).toBe("S01E01_roughcut_v02.mp4");
  });

  it("keeps the frame math deterministic across two renders of one plan", async () => {
    const plan = { ...makePlan(), format: "custom" as const, custom: FIXTURE_16_9 };
    const first = planRoughCutRender(plan, { outputDir: dir, version: 3 });
    const second = planRoughCutRender(plan, { outputDir: dir, version: 3 });
    expect(first.timeline).toEqual(second.timeline);
    expect(first.fileName).toBe(second.fileName);
  });

  it("rejects an invalid plan before any render happens", async () => {
    await expect(
      renderRoughCut(
        makePlan({ shots: [] }),
        { render: adapter },
        { outputDir: dir },
      ),
    ).rejects.toThrow(RoughCutError);
  });

  it("throws OUTPUT_INVALID when the rendered file fails the ffprobe gate", async () => {
    const brokenAdapter = async () => ({
      output: join(dir, "does-not-exist.mp4"),
      renderSeconds: 0,
    });
    const failingValidate = async (): Promise<RoughCutProbeReport> => ({
      ok: false,
      error: "probe: no such file",
    });
    await expect(
      renderRoughCut(
        { ...makePlan(), format: "custom", custom: FIXTURE_16_9 },
        { render: brokenAdapter, validate: failingValidate },
        { outputDir: dir },
      ),
    ).rejects.toThrow(/ffprobe gate/);
  });
});

describe("ffprobeValidateRoughCut", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcs-roughcut-probe-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails a missing file with a structured report (not a throw)", async () => {
    const report = await ffprobeValidateRoughCut(join(dir, "nope.mp4"));
    expect(report.ok).toBe(false);
    expect(report.error).toBeDefined();
  });

  it("fails a non-media file with a structured report", async () => {
    const path = join(dir, "not-a-video.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "this is not an mp4");
    const report = await ffprobeValidateRoughCut(path);
    expect(report.ok).toBe(false);
  });
});

describe("spawnFile timeout guard", () => {
  it("rejects invalid timeoutMs instead of arming a broken timer", async () => {
    await expect(
      spawnFile("true", [], { timeoutMs: 0, allowNonZero: true }),
    ).rejects.toThrow(/invalid timeoutMs/);
    await expect(
      spawnFile("true", [], { timeoutMs: Number.NaN, allowNonZero: true }),
    ).rejects.toThrow(/invalid timeoutMs/);
    await expect(
      spawnFile("true", [], { timeoutMs: 9_999_999, allowNonZero: true }),
    ).rejects.toThrow(/invalid timeoutMs/);
  });
});
