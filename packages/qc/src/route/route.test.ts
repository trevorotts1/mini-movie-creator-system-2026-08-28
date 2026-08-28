/// <reference types="node" />

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { isAutomatedRoute, selectQcRoute } from "./decide.js";
import {
  DEFAULT_QC_FRAME_COUNT,
  QcFrameError,
  extractRepresentativeFrames,
  frameFileName,
  planFrames,
  representativeTimestamps,
  timestampToFrameNumber,
  verifyPng,
} from "./frames.js";
import { runShotReview } from "./review.js";
import { QC_REVIEW_ROUTES, type QcVisionModelProfile } from "./types.js";

/** Registry-style profiles straight from CAP-002's seed shape. */
const GLM_VIDEO_CAPABLE: QcVisionModelProfile = {
  provider: "openrouter",
  modelId: "z-ai/glm-5.3-flash",
  vision: true,
  videoInput: true,
};

const DEEPSEEK_IMAGE_ONLY: QcVisionModelProfile = {
  provider: "openrouter",
  modelId: "deepseek/deepseek-v4-flash-vision-exp",
  vision: true,
  videoInput: false,
};

const TEXT_ONLY: QcVisionModelProfile = {
  provider: "openrouter",
  modelId: "text-only/model",
  vision: false,
  videoInput: false,
};

describe("selectQcRoute", () => {
  it("routes video-capable models to direct video review", () => {
    const decision = selectQcRoute(GLM_VIDEO_CAPABLE);
    expect(decision.route).toBe("video-direct");
    expect(decision.modelId).toBe("z-ai/glm-5.3-flash");
    expect(decision.provider).toBe("openrouter");
    expect(decision.reason).toContain("videoInput");
    expect(isAutomatedRoute(decision)).toBe(true);
  });

  it("routes vision-only models to FFmpeg frame extraction", () => {
    const decision = selectQcRoute(DEEPSEEK_IMAGE_ONLY);
    expect(decision.route).toBe("extracted-frames");
    expect(decision.reason).toContain("vision");
    expect(isAutomatedRoute(decision)).toBe(true);
  });

  it("returns unavailable for profiles with no vision capability", () => {
    const decision = selectQcRoute(TEXT_ONLY);
    expect(decision.route).toBe("unavailable");
    expect(isAutomatedRoute(decision)).toBe(false);
  });

  it("treats undocumented capability as false (missing fields)", () => {
    const decision = selectQcRoute({ modelId: "mystery/model" });
    expect(decision.route).toBe("unavailable");
    expect(decision.provider).toBeNull();
  });

  it("forceVideoExtraction demotes video-direct to extracted-frames", () => {
    const decision = selectQcRoute(GLM_VIDEO_CAPABLE, { forceVideoExtraction: true });
    expect(decision.route).toBe("extracted-frames");
    expect(decision.reason).toContain("forced");
  });

  it("forceVideoExtraction cannot invent capability", () => {
    expect(selectQcRoute(TEXT_ONLY, { forceVideoExtraction: true }).route).toBe("unavailable");
  });

  it("throws on a profile without a modelId", () => {
    expect(() => selectQcRoute({ modelId: "" })).toThrow(/modelId/);
    // @ts-expect-error — probing runtime defense against malformed profiles
    expect(() => selectQcRoute({})).toThrow(/modelId/);
  });

  it("covers every declared route name in QC_REVIEW_ROUTES", () => {
    expect(QC_REVIEW_ROUTES).toEqual(["video-direct", "extracted-frames", "unavailable"]);
  });
});

describe("frame planning", () => {
  it("converts seconds to frame numbers like upstream frames.mjs", () => {
    expect(timestampToFrameNumber(1.5, 30)).toBe(45);
    expect(timestampToFrameNumber(10 / 3, 30)).toBe(100);
  });

  it("names frames <stem>-f<NNNN>.png zero-padded to 4 digits", () => {
    expect(frameFileName("qc-frame", 7)).toBe("qc-frame-f0007.png");
    expect(frameFileName("qc-frame", 1234)).toBe("qc-frame-f1234.png");
  });

  it("plans evenly-spaced representative timestamps inside [0, duration)", () => {
    const timestamps = representativeTimestamps(10, 30, 4);
    expect(timestamps).toHaveLength(4);
    expect(timestamps[0]).toBe(0);
    for (const t of timestamps) expect(t).toBeLessThan(10);
    // ascending
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1] as number);
    }
  });

  it("dedupes frames when the clip is shorter than one frame interval per pick", () => {
    // 4 frames wanted from a 2-frame clip → only 2 distinct frames exist
    const planned = planFrames({ durationSeconds: 2 / 30, fps: 30 });
    const numbers = planned.map((f) => f.frameNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([0, 1]);
  });

  it("defaults to DEFAULT_QC_FRAME_COUNT and validates inputs", () => {
    expect(DEFAULT_QC_FRAME_COUNT).toBe(4);
    expect(() => representativeTimestamps(0, 30)).toThrow(QcFrameError);
    expect(() => representativeTimestamps(10, 0)).toThrow(QcFrameError);
    expect(() => representativeTimestamps(-1, 30)).toThrow(QcFrameError);
  });
});

describe("extractRepresentativeFrames (injected dump, real files)", () => {
  const FACTS = { durationSeconds: 4, fps: 25 };

  /** Write a tiny real PNG (8-byte magic + payload) so verifyPng hits disk. */
  async function writeFakePng(out: string): Promise<void> {
    const body = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fake-image-body"),
    ]);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, body);
  }

  it("dumps one PNG per planned frame and verifies each", async () => {
    const dumped: { ts: number; out: string }[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-"));

    const result = await extractRepresentativeFrames(
      "/media/shot-01.mp4",
      { outputDir: dir, facts: FACTS },
      {
        dumpFrame: async (video, ts, out) => {
          dumped.push({ ts, out });
          await writeFakePng(out);
          void video;
        },
      },
    );

    const PNG_LENGTH = 8 + "fake-image-body".length;
    expect(dumped).toHaveLength(4);
    expect(result.frames).toHaveLength(4);
    for (const frame of result.frames) {
      expect(frame.bytes).toBe(PNG_LENGTH);
      expect(frame.filePath.endsWith(frame.fileName)).toBe(true);
      expect(frame.frameNumber).toBe(timestampToFrameNumber(frame.timestampSeconds, 25));
    }
    // verifyPng accepts a good PNG independently of the extraction run
    const first = result.frames[0];
    expect(first).toBeDefined();
    if (first) await expect(verifyPng(first.filePath)).resolves.toBe(PNG_LENGTH);
  });

  it("refuses to clobber existing frame files without overwrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-clobber-"));
    // Pre-write the first planned frame so the run collides with it.
    const planned = planFrames(FACTS);
    const first = planned[0];
    expect(first).toBeDefined();
    if (!first) return;
    await writeFakePng(path.join(dir, first.fileName));

    await expect(
      extractRepresentativeFrames(
        "/media/shot-01.mp4",
        { outputDir: dir, facts: FACTS },
        { dumpFrame: writeFakePng },
      ),
    ).rejects.toThrow(/overwrite/);
  });

  it("fails when a dumped frame is not a PNG (verification catches it)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-empty-"));
    await expect(
      extractRepresentativeFrames(
        "/media/shot-01.mp4",
        { outputDir: dir, facts: FACTS },
        {
          dumpFrame: async () => {
            /* dumps nothing — file never appears */
          },
        },
      ),
    ).rejects.toThrow(QcFrameError);
  });

  it("accepts a non-PNG file as invalid (magic-byte check)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-badpng-"));
    const notPng = path.join(dir, "not.png");
    await writeFile(notPng, Buffer.from("plain text, not an image"));
    await expect(verifyPng(notPng)).rejects.toThrow(/not a PNG/);
    const empty = path.join(dir, "empty.png");
    await writeFile(empty, Buffer.alloc(0));
    await expect(verifyPng(empty)).rejects.toThrow(/empty/);
  });
});

describe("runShotReview — both branches end to end", () => {
  const FACTS = { durationSeconds: 8, fps: 30 };

  it("video-direct branch: reviewer receives the video itself, no frames extracted", async () => {
    const seen: string[] = [];
    const outcome = await runShotReview(
      {
        videoPath: "/media/shot-02.mp4",
        profile: GLM_VIDEO_CAPABLE,
        facts: FACTS,
        videoReviewer: async (input) => {
          seen.push(`video:${input.videoPath}:${input.modelId}`);
          return { verdict: "PASS", route: "video-direct" };
        },
        frameReviewer: async () => {
          throw new Error("frame reviewer must not run on the video-direct branch");
        },
      },
      { dumpFrame: async () => void 0 },
    );

    expect(outcome.decision.route).toBe("video-direct");
    expect(outcome.review).toEqual({ verdict: "PASS", route: "video-direct" });
    expect(outcome.frames).toEqual([]);
    expect(outcome.facts).toEqual(FACTS);
    expect(seen).toEqual(["video:/media/shot-02.mp4:z-ai/glm-5.3-flash"]);
  });

  it("extracted-frames branch: FFmpeg extracts frames, image reviewer receives them", async () => {
    const dumpedFiles: string[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-review-"));
    const outcome = await runShotReview(
      {
        videoPath: "/media/shot-03.mp4",
        profile: DEEPSEEK_IMAGE_ONLY,
        facts: FACTS,
        frames: { outputDir: dir },
        videoReviewer: async () => {
          throw new Error("video reviewer must not run on the extraction branch");
        },
        frameReviewer: async (input) => ({
          verdict: "FAIL",
          route: "extracted-frames" as const,
          frameCount: input.frames.length,
          model: input.modelId,
        }),
      },
      {
        dumpFrame: async (_v, _ts, out) => {
          dumpedFiles.push(out);
          const body = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from("frame-bytes"),
          ]);
          await mkdir(path.dirname(out), { recursive: true });
          await writeFile(out, body);
        },
      },
    );

    expect(outcome.decision.route).toBe("extracted-frames");
    expect(outcome.review).toEqual({
      verdict: "FAIL",
      route: "extracted-frames",
      frameCount: 4,
      model: "deepseek/deepseek-v4-flash-vision-exp",
    });
    expect(outcome.frames).toHaveLength(4);
    expect(dumpedFiles).toHaveLength(4);
    // every extracted frame carries its verified file path + byte count
    for (const frame of outcome.frames) {
      expect(frame.filePath).toBeTruthy();
      expect(frame.bytes).toBeGreaterThan(0);
    }
  });

  it("unavailable route: no reviewer runs, review is null (human REVIEW handoff)", async () => {
    const outcome = await runShotReview({
      videoPath: "/media/shot-04.mp4",
      profile: TEXT_ONLY,
      facts: FACTS,
      videoReviewer: async () => {
        throw new Error("must not run");
      },
      frameReviewer: async () => {
        throw new Error("must not run");
      },
    });
    expect(outcome.decision.route).toBe("unavailable");
    expect(outcome.review).toBeNull();
    expect(outcome.frames).toEqual([]);
    expect(outcome.facts).toBeNull();
  });

  it("video-capable profile can still be forced through extraction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qc-route-forced-"));
    const outcome = await runShotReview(
      {
        videoPath: "/media/shot-05.mp4",
        profile: GLM_VIDEO_CAPABLE,
        facts: FACTS,
        frames: { outputDir: dir },
        forceVideoExtraction: true,
        videoReviewer: async () => {
          throw new Error("must not run");
        },
        frameReviewer: async (input) => ({ frames: input.frames.length }),
      },
      {
        dumpFrame: async (_v, _ts, out) => {
          const body = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from("forced-frame"),
          ]);
          await mkdir(path.dirname(out), { recursive: true });
          await writeFile(out, body);
        },
      },
    );
    expect(outcome.decision.route).toBe("extracted-frames");
    expect(outcome.review).toEqual({ frames: 4 });
  });

  it("probes facts when none are provided (probe port injected)", async () => {
    let probed = 0;
    const outcome = await runShotReview(
      {
        videoPath: "/media/shot-06.mp4",
        profile: GLM_VIDEO_CAPABLE,
        videoReviewer: async (input) => input.facts,
        frameReviewer: async () => null,
      },
      { probeFacts: async () => (probed++, FACTS) },
    );
    expect(probed).toBe(1);
    expect(outcome.facts).toEqual(FACTS);
  });
});
