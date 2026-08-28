/// <reference types="node" />
// VID-014 acceptance tests — final render pipeline (spec §21, §3.5, §23).
//
// Acceptance (todo.md TASK-VID-014):
//   1. approved rough cut → final render at series/episode resolution
//   2. 720p-source upscale never labeled native 1080p (metadata flag test)
//   3. `mmcs final` wired (CLI command layer, structural CommandSpec)
//   4. fixture final render completes and passes VID-015 ffprobe
//      (real ffprobe binary against a real fixture mp4)
// Gate rule (spec §3.5): no final render before rough-cut approval.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GATES,
  finalFileName,
  finalFolderSegments,
  isSafeEpisodeCode,
  sanitizeTitleLeaf,
  sidecarFileName,
  sidecarFolderSegments,
  type FinalRenderSpec,
  type GateSnapshot,
  type PlannedShot,
} from "./contract.js";
import {
  RESOLUTION_1080P,
  RESOLUTION_720P,
  computeShotQuality,
  episodeTier,
  is720Class,
  isNative1080,
  masterResolutionFor,
  renderResolutionFor,
  tierFor,
} from "./upscale.js";
import {
  FinalRenderError,
  compositionIdFor,
  planFinalRender,
  runFinalRender,
  type ArchivePort,
  type MediaValidator,
  type RenderAdapter,
} from "./pipeline.js";
import { FINAL_SPEC, executeFinal, formatReportLines, parseFinalArgs } from "./cli.js";
import {
  FIXTURE_RESOLUTION,
  ffprobeValidate,
  makeFfmpegFixtureAdapter,
} from "./ffprobe-fixture.js";

const APPROVED: GateSnapshot = {
  gate: "rough-cut",
  state: "APPROVED",
  approvedAt: "2026-08-28T12:00:00.000Z",
};
const PENDING: GateSnapshot = {
  gate: "rough-cut",
  state: "PENDING",
  approvedAt: null,
};

function gatePort(state: GateSnapshot["state"]): (gate: string) => GateSnapshot {
  return (gate) =>
    gate === "rough-cut"
      ? state === "APPROVED"
        ? APPROVED
        : PENDING
      : { gate: "rough-cut", state: "PENDING", approvedAt: null };
}

const SHOT_1080: PlannedShot = {
  shotId: "S01E01_SC01_SH01_hero",
  source: { width: 1920, height: 1080 },
  provider: "agnes",
  providerModel: "agnes-video-2.5-flash",
};
const SHOT_720: PlannedShot = {
  shotId: "S01E01_SC01_SH02_broll",
  source: { width: 1280, height: 720 },
  provider: "kie",
  providerModel: "seedance-2-mini",
};

function makeSpec(over: Partial<FinalRenderSpec> = {}): FinalRenderSpec {
  return {
    seriesId: "series-1",
    episodeId: "ep-1",
    episodeCode: "S01E01",
    episodeTitle: "Pilot",
    format: { series: "16:9" },
    composition: {
      episodeId: "ep-1",
      shots: [SHOT_1080, SHOT_720],
      fps: 30,
      durationSeconds: 12,
    },
    ...over,
  };
}

/** Stub render adapter: "renders" instantly, returns the requested output. */
const stubRender: RenderAdapter = async (request) => ({
  output: request.output,
  renderSeconds: 0.5,
});

const okProbe: MediaValidator = async () => ({
  ok: true,
  codec: "h264",
  durationSeconds: 12,
  resolution: RESOLUTION_1080P,
  bitrateKbps: 4500,
});

describe("gate 5 — no final render before rough-cut approval (spec §3.5)", () => {
  it("plan is not renderable while the gate is PENDING", () => {
    const plan = planFinalRender(makeSpec(), gatePort("PENDING"));
    expect(plan.renderable).toBe(false);
    expect(plan.blockedReason).toContain("PENDING");
    expect(plan.blockedReason).toContain("no final render before approval");
  });

  it("runFinalRender refuses with GATE_NOT_APPROVED and never renders", async () => {
    let renderCalls = 0;
    const spyRender: RenderAdapter = async (req) => {
      renderCalls += 1;
      return stubRender(req);
    };
    await expect(
      runFinalRender(makeSpec(), {
        approvals: gatePort("PENDING"),
        render: spyRender,
        validate: okProbe,
      }),
    ).rejects.toMatchObject({ code: "GATE_NOT_APPROVED" });
    expect(renderCalls).toBe(0);
  });

  it("renderable once the gate is APPROVED", () => {
    const plan = planFinalRender(makeSpec(), gatePort("APPROVED"));
    expect(plan.renderable).toBe(true);
    expect(plan.gate.approvedAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("gate ids match the six spec §3 gates with rough-cut as gate 5", () => {
    expect(GATES).toEqual([
      "concept",
      "script",
      "character",
      "storyboard",
      "rough-cut",
      "canon",
    ]);
    expect(GATES.indexOf("rough-cut")).toBe(4);
  });
});

describe("resolution — series/episode formats (spec §23)", () => {
  it("16:9 series default renders at 1920x1080", () => {
    const plan = planFinalRender(makeSpec(), gatePort("APPROVED"));
    expect(plan.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it("9:16 episode override wins over the 16:9 series default (1080x1920)", () => {
    const plan = planFinalRender(
      makeSpec({ format: { series: "16:9", episode: "9:16" } }),
      gatePort("APPROVED"),
    );
    expect(plan.resolution).toEqual({ width: 1080, height: 1920 });
  });

  it("custom format requires a resolution — missing one is INVALID_SPEC", () => {
    expect(() =>
      planFinalRender(
        makeSpec({ format: { series: "custom" } }),
        gatePort("APPROVED"),
      ),
    ).toThrowError(/custom/);
    const plan = planFinalRender(
      makeSpec({
        format: { series: "custom", custom: { width: 2048, height: 858 } },
      }),
      gatePort("APPROVED"),
    );
    expect(plan.resolution).toEqual({ width: 2048, height: 858 });
  });

  it("masterResolutionFor maps the three spec §23 options", () => {
    expect(masterResolutionFor("16:9")).toEqual(RESOLUTION_1080P);
    expect(masterResolutionFor("9:16")).toEqual({ width: 1080, height: 1920 });
    const custom = { width: 1440, height: 1440 };
    expect(masterResolutionFor("custom", custom)).toEqual(custom);
  });

  it("renderResolutionFor: timeline mode uses the master; native (scale=1) passes through", () => {
    expect(renderResolutionFor("timeline", "16:9")).toEqual(RESOLUTION_1080P);
    const composition = { width: 1280, height: 720 };
    expect(renderResolutionFor("native", "16:9", composition)).toEqual(composition);
  });
});

describe("720p-source upscale metadata flag (spec §21 core rule)", () => {
  it("a 720p source upscaled to the 1080p timeline is 'upscaled-720p' — NEVER 'native-1080p'", () => {
    const tier = tierFor(RESOLUTION_720P, RESOLUTION_1080P);
    expect(tier).toBe("upscaled-720p");
    expect(tier).not.toBe("native-1080p");
  });

  it("per-shot metadata flag: upscaled=true with an honest tier for the 720p shot", () => {
    const records = computeShotQuality(
      [SHOT_1080, SHOT_720],
      RESOLUTION_1080P,
      "timeline",
    );
    const byId = new Map(records.map((r) => [r.shotId, r]));
    const upscaled = byId.get(SHOT_720.shotId)!;
    expect(upscaled.upscaled).toBe(true);
    expect(upscaled.qualityTier).toBe("upscaled-720p");
    expect(upscaled.qualityTier).not.toBe("native-1080p");
    const native = byId.get(SHOT_1080.shotId)!;
    expect(native.upscaled).toBe(false);
    expect(native.qualityTier).toBe("native-1080p");
  });

  it("episode tier for a mixed native-1080 + upscaled-720 composition is 'mixed-source'", () => {
    const records = computeShotQuality(
      [SHOT_1080, SHOT_720],
      RESOLUTION_1080P,
      "timeline",
    );
    expect(episodeTier(records)).toBe("mixed-source");
  });

  it("all-720p composition upscaled to 1080p is 'upscaled-720p' at episode level", () => {
    const records = computeShotQuality([SHOT_720, SHOT_720], RESOLUTION_1080P);
    expect(episodeTier(records)).toBe("upscaled-720p");
  });

  it("below-720p upscale is 'upscaled-lower'", () => {
    expect(tierFor({ width: 640, height: 360 }, RESOLUTION_1080P)).toBe("upscaled-lower");
    const records = computeShotQuality(
      [{ ...SHOT_720, source: { width: 640, height: 360 } }],
      RESOLUTION_1080P,
    );
    expect(episodeTier(records)).toBe("upscaled-lower");
  });

  it("a ≥1080p source upscaled to a bigger master is 'upscaled-higher' — honest, never mislabeled", () => {
    // 1080p native source enlarged to a 4K master: not native at output,
    // not a 720 upscale — its own honest tier.
    expect(tierFor(RESOLUTION_1080P, { width: 3840, height: 2160 })).toBe("upscaled-higher");
    expect(tierFor(RESOLUTION_1080P, { width: 3840, height: 2160 })).not.toBe("native-1080p");
    expect(tierFor(RESOLUTION_1080P, { width: 3840, height: 2160 })).not.toBe("upscaled-720p");
    const records = computeShotQuality(
      [{ ...SHOT_1080, source: RESOLUTION_1080P }],
      { width: 3840, height: 2160 },
    );
    expect(episodeTier(records)).toBe("upscaled-higher");
  });

  it("classification helpers split the quality bands correctly", () => {
    expect(isNative1080(RESOLUTION_1080P)).toBe(true);
    expect(isNative1080(RESOLUTION_720P)).toBe(false);
    expect(is720Class(RESOLUTION_720P)).toBe(true);
    expect(is720Class(RESOLUTION_1080P)).toBe(false);
  });

  it("native mode (scale=1) never upscales — each shot renders at its own source", () => {
    const records = computeShotQuality([SHOT_720], RESOLUTION_1080P, "native");
    expect(records[0]!.upscaled).toBe(false);
    expect(records[0]!.renderedAt).toEqual(RESOLUTION_720P);
    expect(records[0]!.qualityTier).toBe("native-720p");
  });

  it("full pipeline metadata carries the flag into the production report", async () => {
    const report = await runFinalRender(makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
    });
    expect(report.upscaledShotCount).toBe(1);
    const upscaled = report.shotQuality.find((q) => q.shotId === SHOT_720.shotId)!;
    expect(upscaled.upscaled).toBe(true);
    expect(upscaled.qualityTier).not.toBe("native-1080p");
    expect(report.qualityTier).toBe("mixed-source");
  });
});

describe("final render pipeline — deterministic naming and archive plan (spec §17/§19)", () => {
  it("final filename is deterministic S01E01_final_v01.mp4 (provenance in DB, not the name)", () => {
    expect(finalFileName("S01E01", 1)).toBe("S01E01_final_v01.mp4");
    expect(finalFileName("S01E12", 3)).toBe("S01E12_final_v03.mp4");
    expect(sidecarFileName("S01E01", 1)).toBe("S01E01_final_v01.mp4.metadata.json");
  });

  it("folders follow the GHL layout: <Episode>/08 Final and <Episode>/09 QC Metadata", () => {
    expect(finalFolderSegments("S01E01", "Pilot")).toEqual([
      "S01E01 - Pilot",
      "08 Final",
    ]);
    expect(sidecarFolderSegments("S01E01")).toEqual(["S01E01", "09 QC Metadata"]);
  });

  it("composition id is deterministic and filesystem-safe", () => {
    expect(compositionIdFor(makeSpec())).toBe("final-s01e01");
    expect(compositionIdFor(makeSpec({ episodeCode: "S02E10" }))).toBe("final-s02e10");
  });

  it("isSafeEpisodeCode rejects traversal and unsafe tokens, accepts spec codes", () => {
    expect(isSafeEpisodeCode("S01E01")).toBe(true);
    expect(isSafeEpisodeCode("a.b-c_d")).toBe(true);
    expect(isSafeEpisodeCode("../../evil")).toBe(false);
    expect(isSafeEpisodeCode("with/slash")).toBe(false);
    expect(isSafeEpisodeCode("with\\backslash")).toBe(false);
    expect(isSafeEpisodeCode(".hidden")).toBe(false);
    expect(isSafeEpisodeCode("..dots")).toBe(false);
    expect(isSafeEpisodeCode(" leading")).toBe(false);
    expect(isSafeEpisodeCode("trailing ")).toBe(false);
    expect(isSafeEpisodeCode("")).toBe(false);
    expect(isSafeEpisodeCode("a".repeat(64))).toBe(true);
    expect(isSafeEpisodeCode("a".repeat(65))).toBe(false);
  });

  it("planFinalRender REFUSES a path-traversal episodeCode (INVALID_SPEC, nothing built)", () => {
    for (const evil of ["../../evil", "a/b", "a\\b", ".hidden", ".."]) {
      expect(() =>
        planFinalRender(makeSpec({ episodeCode: evil }), gatePort("APPROVED")),
      ).toThrowError(/safe filename token/);
    }
  });

  it("sanitizeTitleLeaf neutralizes hostile titles (no traversal, no control chars)", () => {
    expect(sanitizeTitleLeaf("../../etc/passwd")).not.toContain("/");
    expect(sanitizeTitleLeaf("..\\..\\win")).not.toContain("\\");
    expect(finalFolderSegments("S01E01", "../../etc/passwd")[0]).toBe(
      "S01E01 - -..-etc-passwd",
    );
    // leading dots/spaces stripped — no hidden segments
    expect(sanitizeTitleLeaf(".hidden")).toBe("hidden");
    expect(sanitizeTitleLeaf(" . leading")).toBe("leading");
    // control characters (C0/DEL/C1) dropped
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x9f]) {
      const out = sanitizeTitleLeaf(`a${String.fromCharCode(code)}b`);
      expect(out).toBe("ab");
    }
    // trailing dots/spaces stripped (Windows-safe)
    expect(sanitizeTitleLeaf("name...")).toBe("name");
    expect(sanitizeTitleLeaf("name . ")).toBe("name");
    // length cap never leaves a trailing dot
    const capped = sanitizeTitleLeaf("x".repeat(119) + ".y");
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped.endsWith(".")).toBe(false);
    // empty/hostile-only titles fall back to the bare episode code
    expect(finalFolderSegments("S01E01", "..")[0]).toBe("S01E01");
    expect(sidecarFolderSegments("S01E01", ".")[0]).toBe("S01E01");
  });
});

describe("pipeline steps — render → ffprobe → report → archive", () => {
  it("renders, validates, reports, and archives with a working archive port", async () => {
    const renderRequests: string[] = [];
    const archiveRequests: { folder: readonly string[]; fileName: string }[] = [];
    const archive: ArchivePort = async (req) => {
      archiveRequests.push({ folder: req.folderSegments, fileName: req.fileName });
      return { archived: true, ghlFileId: "file-123", ghlUrl: "https://files.example/final.mp4" };
    };
    const report = await runFinalRender(makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: async (req) => {
        renderRequests.push(req.compositionId);
        return stubRender(req);
      },
      validate: okProbe,
      archive,
    });
    expect(renderRequests).toEqual(["final-s01e01"]);
    expect(report.archived).toBe(true);
    expect(report.ghlFileId).toBe("file-123");
    expect(report.durableFinalUrl).toBe("https://files.example/final.mp4");
    expect(archiveRequests[0]!.folder).toEqual(["S01E01 - Pilot", "08 Final"]);
    expect(archiveRequests[0]!.fileName).toBe("S01E01_final_v01.mp4");
    expect(report.qcStatus).toBe("PASSED");
    expect(report.ffprobe.ok).toBe(true);
    // Production report names providers/models (spec §21).
    expect(report.providers).toEqual(["agnes", "kie"]);
    expect(report.providerModels).toEqual(["agnes-video-2.5-flash", "seedance-2-mini"]);
  });

  it("failed ffprobe validation stops the pipeline before archival", async () => {
    let archived = 0;
    await expect(
      runFinalRender(makeSpec(), {
        approvals: gatePort("APPROVED"),
        render: stubRender,
        validate: async () => ({ ok: false, error: "moov atom not found" }),
        archive: async () => {
          archived += 1;
          return { archived: true };
        },
      }),
    ).rejects.toMatchObject({ code: "FFPROBE_FAILED" });
    expect(archived).toBe(0);
  });

  it("failed archive is ARCHIVE_FAILED", async () => {
    await expect(
      runFinalRender(makeSpec(), {
        approvals: gatePort("APPROVED"),
        render: stubRender,
        validate: okProbe,
        archive: async () => ({ archived: false, error: "25 MB limit" }),
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_FAILED" });
  });

  it("renderer failure surfaces as RENDER_FAILED", async () => {
    await expect(
      runFinalRender(makeSpec(), {
        approvals: gatePort("APPROVED"),
        render: async () => {
          throw new Error("bundle crashed");
        },
        validate: okProbe,
      }),
    ).rejects.toMatchObject({ code: "RENDER_FAILED" });
  });

  it("invalid specs throw INVALID_SPEC before any port runs", () => {
    expect(() => planFinalRender(makeSpec({ episodeCode: "  " }), gatePort("APPROVED"))).toThrowError(
      /episodeCode/,
    );
    expect(() => planFinalRender(makeSpec({ composition: { episodeId: "e", shots: [], fps: 30, durationSeconds: 1 } }), gatePort("APPROVED"))).toThrowError(
      /no shots/,
    );
    expect(() =>
      planFinalRender(
        makeSpec({ composition: { episodeId: "e", shots: [SHOT_1080], fps: 0, durationSeconds: 1 } }),
        gatePort("APPROVED"),
      ),
    ).toThrowError(/fps/);
  });
});

describe("fixture final render passes real ffprobe (VID-015 contract)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcs-final-render-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("system ffmpeg produces a fixture the system ffprobe validates", { timeout: 90_000 }, async () => {
    const output = join(dir, "fixture-final.mp4");
    const render = makeFfmpegFixtureAdapter();
    const rendered = await render({
      compositionId: "fixture",
      serveUrl: "fixture",
      scale: 1,
      resolution: FIXTURE_RESOLUTION,
      fps: 24,
      durationSeconds: 1,
      output,
      codec: "h264",
    });
    expect(statSync(rendered.output).size).toBeGreaterThan(0);

    const probe = await ffprobeValidate(rendered.output);
    expect(probe.ok).toBe(true);
    expect(probe.codec).toBe("h264");
    expect(probe.resolution).toEqual(FIXTURE_RESOLUTION);
    expect(probe.durationSeconds).toBeGreaterThan(0);
  });

  it("corrupted output FAILS the ffprobe gate (truncated-file detection)", async () => {
    const bad = join(dir, "truncated.mp4");
    const render = makeFfmpegFixtureAdapter();
    await render({
      compositionId: "fixture",
      serveUrl: "fixture",
      scale: 1,
      resolution: FIXTURE_RESOLUTION,
      fps: 24,
      durationSeconds: 1,
      output: bad,
      codec: "h264",
    });
    rmSync(bad);
    // Truncation: recreate a damaged file that ffprobe must reject.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bad, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const probe = await ffprobeValidate(bad);
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeTruthy();
  });

  it("end-to-end fixture render through the full pipeline with real ffprobe", { timeout: 90_000 }, async () => {
    const report = await runFinalRender(
      makeSpec({
        outputDir: dir,
        composition: {
          episodeId: "ep-1",
          shots: [
            { ...SHOT_1080, source: FIXTURE_RESOLUTION },
            { ...SHOT_720, source: FIXTURE_RESOLUTION },
          ],
          fps: 24,
          durationSeconds: 1,
        },
      }),
      {
        approvals: gatePort("APPROVED"),
        render: makeFfmpegFixtureAdapter(),
        validate: ffprobeValidate,
        archive: async (req) => ({
          archived: true,
          ghlFileId: "fixture-file",
          ghlUrl: `https://files.example/${req.fileName}`,
        }),
      },
    );
    expect(report.ffprobe.ok).toBe(true);
    expect(report.ffprobe.codec).toBe("h264");
    expect(statSync(join(dir, "S01E01_final_v01.mp4")).size).toBeGreaterThan(0);
    expect(report.archived).toBe(true);
    expect(report.durableFinalUrl).toContain("S01E01_final_v01.mp4");
  });
});

describe("mmcs final — CLI wiring (spec §24)", () => {
  it("registers the exact spec §24 verb", () => {
    expect(FINAL_SPEC.name).toBe("final");
    expect(FINAL_SPEC.group).toBe("generation");
    expect(FINAL_SPEC.description.length).toBeGreaterThan(0);
  });

  it("bare `mmcs final` prints usage and exits 0 (discoverability)", async () => {
    const result = await executeFinal([], () => makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain("Usage: mmcs final");
  });

  it("unknown episode exits 1 with a named error", async () => {
    const result = await executeFinal(["nope"], () => undefined, {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("unknown episode 'nope'");
  });

  it("--dry-run reports READY without rendering", async () => {
    let renderCalls = 0;
    const result = await executeFinal(["ep-1", "--dry-run"], () => makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: async (req) => {
        renderCalls += 1;
        return stubRender(req);
      },
      validate: okProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain("READY");
    expect(result.lines[0]).toContain("S01E01_final_v01.mp4");
    expect(result.lines[0]).toContain("08 Final");
    expect(renderCalls).toBe(0);
  });

  it("--dry-run on an unapproved rough cut exits 1 naming the gate", async () => {
    const result = await executeFinal(["ep-1", "--dry-run"], () => makeSpec(), {
      approvals: gatePort("PENDING"),
      render: stubRender,
      validate: okProbe,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("BLOCKED");
    expect(result.lines[0]).toContain("no final render before approval");
  });

  it("full run prints the production report with the quality line", async () => {
    const result = await executeFinal(["ep-1"], () => makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
archive: async () => ({ archived: true, ghlFileId: "f1", ghlUrl: "https://files.example/x.mp4" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("S01E01 rendered — 16:9 1920x1080");
    expect(result.lines.join("\n")).toContain("1/2 shot(s) upscaled");
    expect(result.lines.join("\n")).toContain("never labeled native");
  });

  it("--native flag switches the spec to scale=1 native mode", async () => {
    const specs: FinalRenderSpec[] = [];
    const result = await executeFinal(["ep-1", "--dry-run", "--native"], () => {
      const s = makeSpec();
      specs.push(s);
      return s;
    }, {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(specs[0]!.mode).toBe("native");
  });

  it("--json emits the production report as one JSON line", async () => {
    const result = await executeFinal(["ep-1", "--json"], () => makeSpec(), {
      approvals: gatePort("APPROVED"),
      render: stubRender,
      validate: okProbe,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines[0]!) as { episodeCode: string; qualityTier: string };
    expect(parsed.episodeCode).toBe("S01E01");
    expect(parsed.qualityTier).toBe("mixed-source");
  });

  it("parseFinalArgs splits positionals from flags", () => {
    expect(parseFinalArgs(["ep-1", "--dry-run", "--native", "--json"])).toEqual({
      episodeId: "ep-1",
      dryRun: true,
      native: true,
      json: true,
    });
    expect(parseFinalArgs(["--json", "ep-2"])).toEqual({
      episodeId: "ep-2",
      dryRun: false,
      native: false,
      json: true,
    });
    expect(parseFinalArgs([]).episodeId).toBeUndefined();
  });

  it("formatReportLines always states the upscale rule", () => {
    const lines = formatReportLines({
      episodeCode: "S01E01",
      aspectRatio: "16:9",
      resolution: { width: 1920, height: 1080 },
      durationSeconds: 12,
      qualityTier: "upscaled-720p",
      upscaledShotCount: 2,
      shotCount: 2,
      archived: false,
    });
    expect(lines.join("\n")).toContain("upscaled-720p");
    expect(lines.join("\n")).toContain("never labeled native");
  });
});