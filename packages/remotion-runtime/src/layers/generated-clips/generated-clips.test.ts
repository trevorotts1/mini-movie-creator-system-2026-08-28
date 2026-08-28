import { describe, expect, it } from "vitest";

import {
  assembleGeneratedClips,
  InvalidGeneratedClipError,
  MissingGeneratedClipError,
} from "./index.js";
import type { ArchivedClip, ShotPlanEntry } from "./index.js";
import { GENERATED_VIDEO_ASSET_TYPE, CLIP_ARCHIVED_STATE } from "./types.js";

const FPS = 30; // upstream shorts fps

/** Archived clip fixture — GHL-resolved, as GHL-005/CORE-007 would store. */
function archivedClip(overrides: Partial<ArchivedClip> = {}): ArchivedClip {
  return {
    assetId: "ASSET_SH07",
    sourceUrl:
      "https://storage.gohighlevel.com/media/S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
    ghlFileId: "ghl-file-123",
    checksum: "abc123",
    provider: "kie",
    providerModel: "seedance-2-mini",
    assetType: GENERATED_VIDEO_ASSET_TYPE,
    assetState: CLIP_ARCHIVED_STATE,
    durationSeconds: 6,
    fps: 24,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

/** Resolver over an asset map, keyed by shot.assetId then shot.shotId. */
function mapResolver(
  assets: Record<string, ArchivedClip>,
): { resolve: (shot: ShotPlanEntry) => ArchivedClip | undefined; hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    resolve(shot) {
      const key = shot.assetId ?? shot.shotId;
      hits.push(key);
      return assets[key];
    },
  };
}

/** The 3-shot mocked plan from the acceptance criteria. */
function threeShotPlan(): ShotPlanEntry[] {
  return [
    {
      shotId: "S01E03_SC04_SH01",
      sceneId: "S01E03_SC04",
      sequenceIndex: 0,
      targetDurationSeconds: 6,
      assetId: "ASSET_SH01",
    },
    {
      shotId: "S01E03_SC04_SH02",
      sceneId: "S01E03_SC04",
      sequenceIndex: 1,
      targetDurationSeconds: 8,
      assetId: "ASSET_SH02",
    },
    {
      shotId: "S01E03_SC04_SH07",
      sceneId: "S01E03_SC04",
      sequenceIndex: 2,
      targetDurationSeconds: 7,
      assetId: "ASSET_SH07",
    },
  ];
}

describe("assembleGeneratedClips — 3-shot mocked sequence (acceptance)", () => {
  it("assembles 3 shots into ordered, contiguous timeline slots", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({
        assetId: "ASSET_SH01",
        durationSeconds: 6,
        providerModel: "agnes-video-2.5-flash",
        provider: "agnes",
      }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02", durationSeconds: 8 }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07", durationSeconds: 7 }),
    });

    const assembled = await assembleGeneratedClips(
      threeShotPlan(),
      resolve,
      FPS,
    );

    expect(assembled.clips).toHaveLength(3);
    // Order follows sequenceIndex: SH01 → SH02 → SH07.
    expect(assembled.clips.map((c) => c.shotId)).toEqual([
      "S01E03_SC04_SH01",
      "S01E03_SC04_SH02",
      "S01E03_SC04_SH07",
    ]);
    // Contiguous slots: 0–6, 6–14, 14–21.
    expect(assembled.clips[0]).toMatchObject({
      inSeconds: 0,
      outSeconds: 6,
      assetId: "ASSET_SH01",
    });
    expect(assembled.clips[1]).toMatchObject({
      inSeconds: 6,
      outSeconds: 14,
    });
    expect(assembled.clips[2]).toMatchObject({
      inSeconds: 14,
      outSeconds: 21,
    });
    expect(assembled.durationSeconds).toBeCloseTo(21, 9);
    expect(assembled.durationInFrames).toBe(21 * FPS);
    // Every placed clip keeps its GHL provenance verbatim.
    expect(assembled.clips[0]?.sourceUrl).toContain(
      "S01E03_SC04_SH07_monica_closeup",
    ) /* per-shot url checked below */;
    expect(assembled.clips[2]?.ghlFileId).toBe("ghl-file-123");
    expect(assembled.clips[2]?.fullyCovered).toBe(true);
  });

  it("converts seconds → Remotion frames per local_f discipline (fps 30)", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ durationSeconds: undefined }),
      ASSET_SH02: archivedClip({ durationSeconds: 8 }),
      ASSET_SH07: archivedClip({ durationSeconds: 7 }),
    });
    const assembled = await assembleGeneratedClips(threeShotPlan(), resolve, FPS);

    // from = round(in_s * fps): 0, 180, 420 — the slot each Sequence sits at.
    expect(assembled.clips.map((c) => c.fromFrame)).toEqual([0, 180, 420]);
    // Slot lengths are the plan's target durations in frames.
    expect(assembled.clips.map((c) => c.durationInFrames)).toEqual([180, 240, 210]);
    // local frame of the global start inside each Sequence == 0 by construction:
    // local_f = round(in_s * fps) − fromFrame.
    for (const clip of assembled.clips) {
      const localF = Math.round(clip.inSeconds * FPS) - clip.fromFrame;
      expect(localF).toBe(0);
    }
  });

  it("resolves via the caller's asset lookup (assetId key)", async () => {
    const { resolve, hits } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02" }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });
    await assembleGeneratedClips(threeShotPlan(), resolve, FPS);
    expect(hits).toEqual(["ASSET_SH01", "ASSET_SH02", "ASSET_SH07"]);
  });
});

describe("assembleGeneratedClips — missing/invalid assets", () => {
  it("rejects a shot with no archived asset and NAMES the shot", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
      // ASSET_SH02 missing — generation never archived.
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });

    const err = await assembleGeneratedClips(
      threeShotPlan(),
      resolve,
      FPS,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingGeneratedClipError);
    const missing = err as MissingGeneratedClipError;
    expect(missing.shotId).toBe("S01E03_SC04_SH02");
    expect(missing.sceneId).toBe("S01E03_SC04");
    expect(missing.message).toContain("S01E03_SC04_SH02");
  });

  it("rejects a temporary (non-ARCHIVED) asset — never place temp URLs", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({
        assetState: "REVIEW",
        sourceUrl: "https://temp-provider.example/clip.mp4?expire=1h",
      }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02" }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });

    const err = await assembleGeneratedClips(threeShotPlan(), resolve, FPS).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(InvalidGeneratedClipError);
    const invalid = err as InvalidGeneratedClipError;
    expect(invalid.shotId).toBe("S01E03_SC04_SH01");
    expect(invalid.message).toContain("ARCHIVED");
  });

  it("rejects a non-video asset type placed for a generated shot", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetType: "AI_STILL" }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02" }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });

    const err = await assembleGeneratedClips(threeShotPlan(), resolve, FPS).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(InvalidGeneratedClipError);
    expect((err as InvalidGeneratedClipError).message).toContain("GENERATED_VIDEO");
  });
});

describe("assembleGeneratedClips — placement semantics", () => {
  const plan = threeShotPlan();

  it("flags under-length clips (loop/hold) and over-length (trim)", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01", durationSeconds: 4 }), // 4 < 6
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02", durationSeconds: 9 }), // 9 > 8
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07", durationSeconds: undefined }),
    });
    const assembled = await assembleGeneratedClips(plan, resolve, FPS);

    expect(assembled.clips[0]?.fullyCovered).toBe(false); // needs loop/hold
    expect(assembled.clips[1]?.fullyCovered).toBe(true); // will be trimmed to slot
    // Unknown length is treated as exact coverage; ffprobe (VID-015) owns truth.
    expect(assembled.clips[2]?.fullyCovered).toBe(true);
  });

  it("honors explicit inSeconds overrides and keeps the cursor past them", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02" }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });
    const withGap: ShotPlanEntry[] = [
      { ...plan[0]!, inSeconds: 2 },
      { ...plan[1]! }, // derived after explicit shot → starts at 8
      { ...plan[2]! },
    ];
    const assembled = await assembleGeneratedClips(withGap, resolve, FPS);

    expect(assembled.clips[0]?.inSeconds).toBe(2);
    expect(assembled.clips[1]?.inSeconds).toBe(8); // 2 + 6
    expect(assembled.clips[2]?.inSeconds).toBe(16); // 8 + 8
    expect(assembled.durationSeconds).toBeCloseTo(23, 9);
  });

  it("places unordered input by sequenceIndex (plan arrives unsorted)", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
      ASSET_SH02: archivedClip({ assetId: "ASSET_SH02" }),
      ASSET_SH07: archivedClip({ assetId: "ASSET_SH07" }),
    });
    const unsorted = [plan[2]!, plan[0]!, plan[1]!];
    const assembled = await assembleGeneratedClips(unsorted, resolve, FPS);

    expect(assembled.clips.map((c) => c.shotId)).toEqual([
      "S01E03_SC04_SH01",
      "S01E03_SC04_SH02",
      "S01E03_SC04_SH07",
    ]);
  });

  it("supports async resolvers (DB-backed callers)", async () => {
    const resolve = async (shot: ShotPlanEntry) =>
      shot.assetId === "ASSET_SH02" ? undefined : archivedClip({ assetId: shot.assetId ?? shot.shotId });

    const err = await assembleGeneratedClips(plan, resolve, FPS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingGeneratedClipError);
    expect((err as MissingGeneratedClipError).shotId).toBe("S01E03_SC04_SH02");
  });

  it("rejects invalid fps", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
    });
    await expect(
      assembleGeneratedClips([plan[0]!], resolve, 0),
    ).rejects.toThrow(/Invalid fps/);
    await expect(
      assembleGeneratedClips([plan[0]!], resolve, Number.NaN),
    ).rejects.toThrow(/Invalid fps/);
  });

  it("rejects non-positive slot durations", async () => {
    const { resolve } = mapResolver({
      ASSET_SH01: archivedClip({ assetId: "ASSET_SH01" }),
    });
    await expect(
      assembleGeneratedClips([{ ...plan[0]!, targetDurationSeconds: 0 }], resolve, FPS),
    ).rejects.toThrow(/targetDurationSeconds/);
  });
});