/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_FLASH_ASPECT_RATIOS,
  AGNES_FLASH_LIMITS,
  AGNES_FLASH_MODEL,
  AGNES_FLASH_MODEL_DISCOVERY,
  AGNES_VIDEO_2_5_FLASH,
  AgnesFlashSubmitError,
  agnesFlashRetrieveUrl,
  buildAgnesFlashRequest,
  detectFlashMode,
  flashPromptCeiling,
  submitAgnesFlash,
  validateAgnesFlashInput,
  type AgnesFlashInput,
} from "./index.js";

const BASE: AgnesFlashInput = { prompt: "a locked character walks left to right" };

describe("runtime model ID discovery (runbook §11.1)", () => {
  it("uses the live-verified 2.5 ID, never the stale v2.0 doc ID", () => {
    expect(AGNES_FLASH_MODEL).toBe("agnes-video-2.5-flash");
    expect(AGNES_FLASH_MODEL_DISCOVERY.staleModelId).toBe("agnes-video-v2.0");
    expect(AGNES_FLASH_MODEL_DISCOVERY.modelId).toBe(AGNES_FLASH_MODEL);
    expect(AGNES_FLASH_MODEL_DISCOVERY.modelId).not.toContain("v2.0");
  });

  it("records the discovery source and date", () => {
    expect(AGNES_FLASH_MODEL_DISCOVERY.verifiedOn).toBe("2026-08-28");
    expect(AGNES_FLASH_MODEL_DISCOVERY.sourceUrl).toBe(
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash",
    );
    expect(AGNES_FLASH_MODEL_DISCOVERY.discoveredVia).toContain("live");
  });

  it("capability record cites the same source/date", () => {
    expect(AGNES_VIDEO_2_5_FLASH.lastVerifiedAt).toBe("2026-08-28");
    expect(AGNES_VIDEO_2_5_FLASH.sourceUrls).toContain(
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash",
    );
    expect(AGNES_VIDEO_2_5_FLASH.modelId).toBe(AGNES_FLASH_MODEL);
  });
});

describe("capability limits — VERIFIED values match live docs", () => {
  it("every verified limit cites the live doc and date", () => {
    for (const [name, limit] of Object.entries(AGNES_FLASH_LIMITS)) {
      if (limit.status === "VERIFIED") {
        expect(limit.source.startsWith("https://"), name).toBe(true);
        expect(limit.verifiedOn).toBe("2026-08-28");
      } else {
        expect(limit.status, name).toBe("UNKNOWN");
        expect(limit.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("duration is doc-stated 4-12 with default 5", () => {
    expect(AGNES_FLASH_LIMITS.durationSeconds.value).toEqual({ min: 4, max: 12 });
    expect(AGNES_FLASH_LIMITS.defaultDurationSeconds.value).toBe(5);
  });

  it("size is fixed 720P only", () => {
    expect(AGNES_FLASH_LIMITS.size.value).toEqual(["720P"]);
    expect(AGNES_VIDEO_2_5_FLASH.output.resolutions).toEqual(["720P"]);
  });

  it("reference images max 5; videos unsupported", () => {
    expect(AGNES_FLASH_LIMITS.maxReferenceImages.value).toBe(5);
    expect(AGNES_FLASH_LIMITS.referenceVideos.value.supported).toBe(false);
    expect(AGNES_VIDEO_2_5_FLASH.references.videosSupported).toBe(false);
  });

  it("first/last frame supported; n=1 only", () => {
    expect(AGNES_FLASH_LIMITS.firstFrame.value).toBe(true);
    expect(AGNES_FLASH_LIMITS.lastFrame.value).toBe(true);
    expect(AGNES_FLASH_LIMITS.outputs.value).toBe(1);
  });

  it("aspect ratio table matches the doc pixel table", () => {
    expect(AGNES_FLASH_ASPECT_RATIOS).toEqual([
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
    ]);
    expect(AGNES_VIDEO_2_5_FLASH.output.aspectRatios).toEqual(
      AGNES_FLASH_ASPECT_RATIOS,
    );
  });
});

describe("prompt ceiling is UNKNOWN — never invented", () => {
  it("hard prompt ceiling stays null in the capability record", () => {
    expect(AGNES_VIDEO_2_5_FLASH.prompt.hardMaxCharacters).toBeNull();
    expect(AGNES_VIDEO_2_5_FLASH.prompt.recommendedMaxCharacters).toBeNull();
    expect(AGNES_FLASH_LIMITS.promptLength.status).toBe("UNKNOWN");
  });

  it("flashPromptCeiling() reports UNKNOWN", () => {
    expect(flashPromptCeiling()).toEqual({
      hardMaxCharacters: null,
      status: "UNKNOWN",
    });
  });

  it("validation accepts a very long prompt (no invented ceiling enforced)", () => {
    const longPrompt = "x".repeat(50_000);
    const result = validateAgnesFlashInput({
      ...BASE,
      prompt: longPrompt,
    });
    expect(result.ok).toBe(true);
    expect(result.errors.filter((e) => e.field === "input.prompt").length).toBe(0);
  });

  it("Flash is valid final footage — never preview-only", () => {
    expect(AGNES_VIDEO_2_5_FLASH.validFinalFootage).toBe(true);
  });
});

describe("detectFlashMode", () => {
  it("text default with nothing set", () => {
    expect(detectFlashMode(BASE)).toBe("text");
  });

  it("keyframe when a frame is present", () => {
    expect(detectFlashMode({ ...BASE, firstFrameUrl: "https://a/b.png" })).toBe(
      "keyframe",
    );
  });

  it("reference when references are present", () => {
    expect(
      detectFlashMode({ ...BASE, referenceImageUrls: ["https://a/b.png"] }),
    ).toBe("reference");
  });

  it("explicit mode wins", () => {
    expect(detectFlashMode({ ...BASE, mode: "text", firstFrameUrl: "https://a/b.png" })).toBe(
      "text",
    );
  });
});

describe("validateAgnesFlashInput", () => {
  it("accepts a plain text request", () => {
    const result = validateAgnesFlashInput(BASE);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("text");
  });

  it("rejects missing prompt", () => {
    const result = validateAgnesFlashInput({ prompt: "" });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.prompt");
  });

  it("rejects out-of-range duration", () => {
    const result = validateAgnesFlashInput({ ...BASE, seconds: 13 });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.seconds");
  });

  it("seconds bound is inclusive 4..12", () => {
    expect(validateAgnesFlashInput({ ...BASE, seconds: 4 }).ok).toBe(true);
    expect(validateAgnesFlashInput({ ...BASE, seconds: 12 }).ok).toBe(true);
  });

  it("rejects non-720p size", () => {
    const result = validateAgnesFlashInput({ ...BASE, size: "960P" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("720P");
  });

  it("rejects unknown aspect ratio", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      aspectRatio: "2:3" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.aspect_ratio");
  });

  it("accepts keyframe with first frame only", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
  });

  it("accepts keyframe with both frames", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
      lastFrameUrl: "https://a/l.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
  });

  it("accepts last frame alone (doc: keyframe requires at least one frame)", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      lastFrameUrl: "https://a/l.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
  });

  it("rejects frame mode claiming keyframe with zero frames", () => {
    const result = validateAgnesFlashInput({ ...BASE, mode: "keyframe" });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input");
  });

  it("accepts up to 5 reference images", () => {
    const imgs = Array.from({ length: 5 }, (_, i) => `https://a/${i}.png`);
    expect(
      validateAgnesFlashInput({ ...BASE, referenceImageUrls: imgs }).ok,
    ).toBe(true);
  });

  it("rejects 6 reference images (doc: length must not exceed 5)", () => {
    const imgs = Array.from({ length: 6 }, (_, i) => `https://a/${i}.png`);
    const result = validateAgnesFlashInput({ ...BASE, referenceImageUrls: imgs });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("5");
  });

  it("rejects any non-empty videos array (not supported on Flash)", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      referenceVideoUrls: ["https://a/v.mp4"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("not supported");
  });

  it("rejects combining frames with reference inputs", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
      referenceImageUrls: ["https://a/r.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input");
  });

  it("rejects non-URL reference images", () => {
    const result = validateAgnesFlashInput({
      ...BASE,
      referenceImageUrls: ["ftp://a/b.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.images");
  });

  it("accepts asset:// references", () => {
    expect(
      validateAgnesFlashInput({
        ...BASE,
        referenceImageUrls: ["asset://asset-a1b2c3"],
      }).ok,
    ).toBe(true);
  });

  it("does not enforce an audio max count (UNKNOWN)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://a/${i}.wav`);
    const result = validateAgnesFlashInput({ ...BASE, referenceAudioUrls: many });
    expect(result.ok).toBe(true);
  });

  it("rejects non-integer seed", () => {
    const result = validateAgnesFlashInput({ ...BASE, seed: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.seed");
  });
});

describe("buildAgnesFlashRequest", () => {
  it("builds the exact wire body with seconds as string", () => {
    const req = buildAgnesFlashRequest({ ...BASE, seconds: 7 });
    expect(req).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: BASE.prompt,
      mode: "text",
      seconds: "7",
      n: 1,
    });
    expect(typeof req.seconds).toBe("string");
  });

  it("defaults mode to text when nothing is set", () => {
    expect(buildAgnesFlashRequest(BASE).mode).toBe("text");
  });

  it("maps keyframe and reference fields verbatim", () => {
    const req = buildAgnesFlashRequest({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
      lastFrameUrl: "https://a/l.png",
    });
    expect(req).toMatchObject({
      model: "agnes-video-2.5-flash",
      mode: "keyframe",
      first_frame: "https://a/f.png",
      last_frame: "https://a/l.png",
      n: 1,
    });
    const ref = buildAgnesFlashRequest({
      ...BASE,
      referenceImageUrls: ["https://a/r.png"],
      referenceAudioUrls: ["https://a/s.wav"],
    });
    expect(ref).toMatchObject({
      mode: "reference",
      images: ["https://a/r.png"],
      audios: ["https://a/s.wav"],
    });
  });

  it("does not alias reference arrays", () => {
    const imgs = ["https://a/1.png"];
    const req = buildAgnesFlashRequest({ ...BASE, referenceImageUrls: imgs });
    req.images?.push("https://a/2.png");
    expect(imgs).toEqual(["https://a/1.png"]);
  });

  it("omits empty reference arrays from the wire body (mode=text forbids them)", () => {
    const req = buildAgnesFlashRequest({
      ...BASE,
      referenceImageUrls: [],
      referenceAudioUrls: [],
    });
    expect(req.mode).toBe("text");
    expect(req).not.toHaveProperty("images");
    expect(req).not.toHaveProperty("audios");
  });

  it("keeps empty arrays out even in explicit reference mode (validator rejects that input)", () => {
    // Validator: mode=reference with zero non-empty refs is an error, so the
    // builder must never emit an images/audios field that could HTTP 400.
    const req = buildAgnesFlashRequest({
      ...BASE,
      mode: "reference",
      referenceImageUrls: [],
    });
    expect(req).not.toHaveProperty("images");
    expect(req).not.toHaveProperty("audios");
  });
});

describe("submitAgnesFlash", () => {
  it("returns videoId + exact request + mode + prompt count", async () => {
    const client = {
      createVideo: async (body: { model: string }) => {
        expect(body.model).toBe("agnes-video-2.5-flash");
        return { videoId: "vid_123" };
      },
    };
    const result = await submitAgnesFlash(
      { ...BASE, firstFrameUrl: "https://a/f.png" },
      client,
    );
    expect(result.videoId).toBe("vid_123");
    expect(result.model).toBe("agnes-video-2.5-flash");
    expect(result.mode).toBe("keyframe");
    expect(result.promptCharacterCount).toBe(BASE.prompt.length);
  });

  it("throws AgnesFlashSubmitError on invalid input without calling client", async () => {
    let called = false;
    const client = {
      createVideo: async () => {
        called = true;
        return { videoId: "vid_x" };
      },
    };
    await expect(
      submitAgnesFlash({ ...BASE, seconds: 99 }, client),
    ).rejects.toThrow(AgnesFlashSubmitError);
    expect(called).toBe(false);
  });

  it("throws when the client returns no videoId", async () => {
    const client = {
      createVideo: async () => ({ videoId: "" }),
    };
    await expect(submitAgnesFlash(BASE, client)).rejects.toThrow(
      "no videoId",
    );
  });
});

describe("retrieval URL", () => {
  it("always carries model_name (required for keyframe/reference)", () => {
    expect(agnesFlashRetrieveUrl("vid_1")).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=vid_1&model_name=agnes-video-2.5-flash",
    );
    expect(agnesFlashRetrieveUrl("a b&c")).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=a%20b%26c&model_name=agnes-video-2.5-flash",
    );
  });
});
