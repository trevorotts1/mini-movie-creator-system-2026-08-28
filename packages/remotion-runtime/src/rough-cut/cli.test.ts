// VID-012 acceptance tests — `mmcs rough-cut` command layer (spec §24).
//
// Acceptance: "`mmcs rough-cut` wired" — structural CommandSpec for the
// CORE-011 dispatcher, arg parsing, dry-run planning, and the error paths.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROUGH_CUT_SPEC,
  USAGE_ROUGH_CUT,
  executeRoughCut,
  formatRoughCutLines,
  parseRoughCutArgs,
} from "./cli.js";
import { makeFfmpegFixtureAdapter } from "./render.js";
import { ROUGH_CUT_PLAN_VERSION, type RoughCutPlan } from "./types.js";

const FIXTURE = { width: 320, height: 180 };

function makePlan(): RoughCutPlan {
  return {
    formatVersion: ROUGH_CUT_PLAN_VERSION,
    seriesId: "series-1",
    episodeId: "ep-1",
    episodeCode: "S01E01",
    format: "custom",
    custom: FIXTURE,
    fps: 30,
    shots: [
      {
        shotId: "S01E01_SC01_SH01",
        sequenceIndex: 1,
        targetDurationSeconds: 1,
        layerKind: "generated-video",
        assetRef: "ghl://media/projects/s1/hero.mp4",
      },
    ],
  };
}

const fixtureAdapter = makeFfmpegFixtureAdapter();

describe("ROUGH_CUT_SPEC", () => {
  it("exposes the §24 command name and a structural CommandSpec", () => {
    expect(ROUGH_CUT_SPEC.name).toBe("rough-cut");
    expect(ROUGH_CUT_SPEC.description).toMatch(/spec §21/);
    expect(ROUGH_CUT_SPEC.group).toBe("generation");
  });
});

describe("parseRoughCutArgs", () => {
  it("parses the episode id and flags", () => {
    expect(parseRoughCutArgs(["ep-1", "--dry-run"])).toEqual({
      episodeId: "ep-1",
      dryRun: true,
      json: false,
    });
    expect(parseRoughCutArgs(["--json", "ep-9"])).toEqual({
      episodeId: "ep-9",
      dryRun: false,
      json: true,
    });
    expect(parseRoughCutArgs([])).toEqual({ episodeId: undefined, dryRun: false, json: false });
  });
});

describe("executeRoughCut", () => {
  it("prints usage and exits 0 when no episode is given (discoverability)", async () => {
    const result = await executeRoughCut([], () => undefined, fixtureAdapter);
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe(USAGE_ROUGH_CUT);
  });

  it("reports an unknown episode with exit 1", async () => {
    const result = await executeRoughCut(["nope"], () => undefined, fixtureAdapter);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toMatch(/unknown episode 'nope'/);
  });

  it("plans without rendering under --dry-run", async () => {
    let rendered = false;
    const renderAdapter = {
      async render(_req: unknown) {
        rendered = true;
        throw new Error("must not render");
      },
    } as never;
    const result = await executeRoughCut(
      ["ep-1", "--dry-run"],
      () => makePlan(),
      renderAdapter,
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toMatch(/^\[mmcs\] rough-cut: READY/);
    expect(rendered).toBe(false);
  });

  it("renders + validates and reports the assembled result (exit 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmcs-roughcut-cli-"));
    try {
      const result = await executeRoughCut(
        ["ep-1"],
        () => makePlan(),
        fixtureAdapter,
        { outputDir: dir },
      );
      expect(result.exitCode).toBe(0);
      expect(result.lines[0]).toMatch(/S01E01 assembled/);
      expect(result.lines[2]).toMatch(/ffprobe-valid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits JSON when --json is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmcs-roughcut-cli-"));
    try {
      const result = await executeRoughCut(
        ["ep-1", "--json"],
        () => makePlan(),
        fixtureAdapter,
        { outputDir: dir },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.lines[0] ?? "");
      expect(parsed.fileName).toBe("S01E01_roughcut_v01.mp4");
      expect(parsed.probe.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps plan validation failures to exit 1 with the stable code", async () => {
    const bad = { ...makePlan(), shots: [] };
    const result = await executeRoughCut(["ep-1"], () => bad, fixtureAdapter);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toMatch(/PLAN_INVALID/);
  });
});

describe("formatRoughCutLines", () => {
  it("formats the human report deterministically", () => {
    const lines = formatRoughCutLines({
      fileName: "S01E01_roughcut_v01.mp4",
      compositionId: "S01E01",
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      totalFrames: 180,
      durationSeconds: 6,
      shotCount: 3,
      dialogueCount: 1,
      hasTempMusic: true,
    });
    expect(lines[0]).toBe(
      "[mmcs] rough-cut: S01E01 assembled — 1920x1080@30, 180 frames (6.00s)",
    );
    expect(lines[1]).toMatch(/3 shot\(s\), 1 dialogue line\(s\), temp music: yes/);
    expect(lines[2]).toContain("S01E01_roughcut_v01.mp4");
  });
});
