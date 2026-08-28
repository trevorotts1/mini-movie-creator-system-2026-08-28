/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_REGULAR_ASPECT_RATIOS,
  AGNES_REGULAR_LIMITS,
  AGNES_REGULAR_MODEL,
  AGNES_REGULAR_MODEL_DISCOVERY,
  AGNES_REGULAR_SIZES,
  AGNES_VIDEO_2_5_REGULAR,
  AgnesRegularSubmitError,
  agnesRegularRetrieveUrl,
  buildAgnesRegularRequest,
  detectRegularMode,
  regularExcessImageCount,
  regularPromptCeiling,
  submitAgnesRegular,
  validateAgnesRegularInput,
  type AgnesRegularInput,
} from "./index.js";

const BASE: AgnesRegularInput = {
  prompt: "a locked character walks left to right",
};

describe("runtime model ID discovery (runbook §11.1)", () => {
  it("uses the live-verified 2.5 ID, never the stale v2.0 doc ID", () => {
    expect(AGNES_REGULAR_MODEL).toBe("agnes-video-2.5");
    expect(AGNES_REGULAR_MODEL_DISCOVERY.staleModelId).toBe("agnes-video-v2.0");
    expect(AGNES_REGULAR_MODEL_DISCOVERY.modelId).toBe(AGNES_REGULAR_MODEL);
    expect(AGNES_REGULAR_MODEL_DISCOVERY.modelId).not.toContain("v2.0");
  });

  it("records the discovery source and date", () => {
    expect(AGNES_REGULAR_MODEL_DISCOVERY.verifiedOn).toBe("2026-08-28");
    expect(AGNES_REGULAR_MODEL_DISCOVERY.sourceUrl).toBe(
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
    );
    expect(AGNES_REGULAR_MODEL_DISCOVERY.discoveredVia).toContain("live");
  });

  it("capability record cites the same source/date", () => {
    expect(AGNES_VIDEO_2_5_REGULAR.lastVerifiedAt).toBe("2026-08-28");
    expect(AGNES_VIDEO_2_5_REGULAR.sourceUrls).toContain(
      "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
    );
    expect(AGNES_VIDEO_2_5_REGULAR.modelId).toBe(AGNES_REGULAR_MODEL);
  });
});

describe("capability limits — VERIFIED values match live docs", () => {
  it("every verified limit cites the live doc and date", () => {
    for (const [name, limit] of Object.entries(AGNES_REGULAR_LIMITS)) {
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
    expect(AGNES_REGULAR_LIMITS.durationSeconds.value).toEqual({
      min: 4,
      max: 12,
    });
    expect(AGNES_REGULAR_LIMITS.defaultDurationSeconds.value).toBe(5);
  });

  it("accepts all three size tiers (720P / 960P / 2K)", () => {
    expect(AGNES_REGULAR_SIZES).toEqual(["720P", "960P", "2K"]);
    expect(AGNES_VIDEO_2_5_REGULAR.output.resolutions).toEqual([
      "720P",
      "960P",
      "2K",
    ]);
  });

  it("pricing is per-size 0.025 / 0.040 / 0.055 USD per second", () => {
    expect(AGNES_REGULAR_LIMITS.listUsdPerSecond.value).toEqual({
      "720P": 0.025,
      "960P": 0.04,
      "2K": 0.055,
    });
  });

  it("first/last frame supported; n=1 only", () => {
    expect(AGNES_REGULAR_LIMITS.firstFrame.value).toBe(true);
    expect(AGNES_REGULAR_LIMITS.lastFrame.value).toBe(true);
    expect(AGNES_REGULAR_LIMITS.outputs.value).toBe(1);
  });

  it("aspect ratio list matches the doc table", () => {
    expect(AGNES_REGULAR_ASPECT_RATIOS).toEqual([
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
    ]);
    expect(AGNES_VIDEO_2_5_REGULAR.output.aspectRatios).toEqual(
      AGNES_REGULAR_ASPECT_RATIOS,
    );
  });
});

describe("UNKNOWN limits — never invented, never enforced", () => {
  it("hard prompt ceiling stays null in the capability record", () => {
    expect(AGNES_VIDEO_2_5_REGULAR.prompt.hardMaxCharacters).toBeNull();
    expect(
      AGNES_VIDEO_2_5_REGULAR.prompt.recommendedMaxCharacters,
    ).toBeNull();
    expect(AGNES_REGULAR_LIMITS.promptLength.status).toBe("UNKNOWN");
  });

  it("reference-image hard cap stays UNKNOWN (the 5 is a billing allowance)", () => {
    expect(AGNES_REGULAR_LIMITS.maxReferenceImages.status).toBe("UNKNOWN");
    expect(AGNES_VIDEO_2_5_REGULAR.references.maxImages).toBeNull();
    // The free-allowance billing rule is still recorded as VERIFIED.
    expect(AGNES_REGULAR_LIMITS.freeImageAllowance.value).toBe(5);
    expect(AGNES_VIDEO_2_5_REGULAR.references.freeImageAllowance).toBe(5);
  });

  it("reference videos are supported on regular (unlike Flash)", () => {
    expect(
      AGNES_VIDEO_2_5_REGULAR.references.referenceVideosSupported,
    ).toBe(true);
  });

  it("regularPromptCeiling() reports UNKNOWN", () => {
    expect(regularPromptCeiling()).toEqual({
      hardMaxCharacters: null,
      status: "UNKNOWN",
    });
  });

  it("validation accepts a very long prompt (no invented ceiling enforced)", () => {
    const longPrompt = "x".repeat(50_000);
    const result = validateAgnesRegularInput({
      ...BASE,
      prompt: longPrompt,
    });
    expect(result.ok).toBe(true);
    expect(result.errors.filter((e) => e.field === "input.prompt").length).toBe(
      0,
    );
  });

  it("validation accepts more than 5 reference images (no invented cap)", () => {
    const imgs = Array.from({ length: 8 }, (_, i) => `https://a/${i}.png`);
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceImageUrls: imgs,
    });
    expect(result.ok).toBe(true);
    // …but the billing rule still counts 3 as billable beyond the allowance.
    expect(regularExcessImageCount({ ...BASE, referenceImageUrls: imgs })).toBe(
      3,
    );
  });

  it("does not enforce audio/video max counts (UNKNOWN)", () => {
    const manyAudios = Array.from(
      { length: 12 },
      (_, i) => `https://a/${i}.wav`,
    );
    const manyVideos = Array.from({ length: 4 }, (_, i) => ({
      url: `https://a/${i}.mp4`,
    }));
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceAudioUrls: manyAudios,
      referenceVideos: manyVideos,
    });
    expect(result.ok).toBe(true);
  });
});

describe("detectRegularMode", () => {
  it("text default with nothing set", () => {
    expect(detectRegularMode(BASE)).toBe("text");
  });

  it("keyframe when a frame is present", () => {
    expect(
      detectRegularMode({ ...BASE, firstFrameUrl: "https://a/b.png" }),
    ).toBe("keyframe");
  });

  it("reference when references are present", () => {
    expect(
      detectRegularMode({ ...BASE, referenceImageUrls: ["https://a/b.png"] }),
    ).toBe("reference");
  });

  it("reference when only videos are present", () => {
    expect(
      detectRegularMode({
        ...BASE,
        referenceVideos: [{ url: "https://a/v.mp4" }],
      }),
    ).toBe("reference");
  });

  it("explicit mode wins", () => {
    expect(
      detectRegularMode({
        ...BASE,
        mode: "text",
        firstFrameUrl: "https://a/b.png",
      }),
    ).toBe("text");
  });
});

describe("validateAgnesRegularInput", () => {
  it("accepts a plain text request", () => {
    const result = validateAgnesRegularInput(BASE);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("text");
  });

  it("rejects missing prompt", () => {
    const result = validateAgnesRegularInput({ prompt: "" });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.prompt");
  });

  it("rejects out-of-range duration", () => {
    const result = validateAgnesRegularInput({ ...BASE, seconds: 13 });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.seconds");
  });

  it("seconds bound is inclusive 4..12", () => {
    expect(validateAgnesRegularInput({ ...BASE, seconds: 4 }).ok).toBe(true);
    expect(validateAgnesRegularInput({ ...BASE, seconds: 12 }).ok).toBe(true);
  });

  it("accepts each documented size tier and rejects others", () => {
    expect(validateAgnesRegularInput({ ...BASE, size: "720P" }).ok).toBe(true);
    expect(validateAgnesRegularInput({ ...BASE, size: "960P" }).ok).toBe(true);
    expect(validateAgnesRegularInput({ ...BASE, size: "2K" }).ok).toBe(true);
    const result = validateAgnesRegularInput({
      ...BASE,
      size: "1280x720" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.size");
  });

  it("rejects unknown aspect ratio", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      aspectRatio: "2:3" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.aspect_ratio");
  });

  it("accepts keyframe with first frame only", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
  });

  it("accepts last frame alone (doc: keyframe requires at least one frame)", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      lastFrameUrl: "https://a/l.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
  });

  it("rejects keyframe mode with zero frames", () => {
    const result = validateAgnesRegularInput({ ...BASE, mode: "keyframe" });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input");
  });

  it("accepts reference images", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceImageUrls: ["https://a/r.png"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("reference");
  });

  it("rejects combining frames with reference inputs", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
      referenceImageUrls: ["https://a/r.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input");
  });

  it("rejects non-URL reference images", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceImageUrls: ["ftp://a/b.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.images");
  });

  it("accepts asset:// references", () => {
    expect(
      validateAgnesRegularInput({
        ...BASE,
        referenceImageUrls: ["asset://asset-a1b2c3"],
      }).ok,
    ).toBe(true);
  });

  it("rejects non-integer seed", () => {
    const result = validateAgnesRegularInput({ ...BASE, seed: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.seed");
  });

  it("rejects an explicit reference request with only empty arrays", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      mode: "reference",
      referenceImageUrls: [],
      referenceVideos: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input");
  });

  it("treats empty reference arrays as absent (infers text mode)", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceImageUrls: [],
      referenceVideos: [],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("text");
  });
});

describe("reference-video path (regular-only capability)", () => {
  it("validates a well-formed videos[] entry", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceVideos: [
        {
          url: "https://a/ref.mp4",
          startSeconds: 2,
          requireAudio: true,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("reference");
  });

  it("rejects a videos[] entry without url", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceVideos: [{ startSeconds: 1 } as never],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.videos[0]");
  });

  it("rejects a videos[] entry with a bad URL", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceVideos: [{ url: "gopher://a/v.mp4" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain(
      "input.videos[0].url",
    );
  });

  it("rejects negative start_seconds and non-boolean require_audio", () => {
    const result = validateAgnesRegularInput({
      ...BASE,
      referenceVideos: [
        { url: "https://a/v.mp4", startSeconds: -1, requireAudio: "yes" as never },
      ],
    });
    expect(result.ok).toBe(false);
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain("input.videos[0].start_seconds");
    expect(fields).toContain("input.videos[0].require_audio");
  });

  it("wire body maps videos[] to snake_case objects verbatim", () => {
    const req = buildAgnesRegularRequest({
      ...BASE,
      referenceVideos: [
        { url: "https://a/ref.mp4", startSeconds: 3, requireAudio: true },
        { url: "asset://asset-abc" },
      ],
    });
    expect(req.videos).toEqual([
      {
        url: "https://a/ref.mp4",
        start_seconds: 3,
        require_audio: true,
      },
      { url: "asset://asset-abc" },
    ]);
  });

  it("mocked submit round-trips a reference-video request through the client port", async () => {
    let captured: unknown;
    const client = {
      createVideo: async (body: { model: string; videos?: unknown[] }) => {
        captured = body;
        return { videoId: "vid_reg_1" };
      },
    };
    const input: AgnesRegularInput = {
      prompt: "match this locked character's motion",
      referenceVideos: [
        { url: "https://a/ref.mp4", startSeconds: 0, requireAudio: false },
      ],
      seconds: 8,
      size: "2K",
    };
    const result = await submitAgnesRegular(input, client);

    expect(result.videoId).toBe("vid_reg_1");
    expect(result.model).toBe("agnes-video-2.5");
    expect(result.mode).toBe("reference");
    expect(result.promptCharacterCount).toBe(input.prompt.length);
    expect(result.excessImageCount).toBe(0);

    const wire = captured as Record<string, unknown>;
    expect(wire["model"]).toBe("agnes-video-2.5");
    expect(wire["mode"]).toBe("reference");
    expect(wire["seconds"]).toBe("8");
    expect(wire["size"]).toBe("2K");
    expect(wire["videos"]).toEqual([
      {
        url: "https://a/ref.mp4",
        start_seconds: 0,
        require_audio: false,
      },
    ]);
  });
});

describe("buildAgnesRegularRequest", () => {
  it("builds the exact wire body with seconds as string", () => {
    const req = buildAgnesRegularRequest({ ...BASE, seconds: 7 });
    expect(req).toEqual({
      model: "agnes-video-2.5",
      prompt: BASE.prompt,
      mode: "text",
      seconds: "7",
      n: 1,
    });
    expect(typeof req.seconds).toBe("string");
  });

  it("defaults mode to text when nothing is set", () => {
    expect(buildAgnesRegularRequest(BASE).mode).toBe("text");
  });

  it("maps keyframe and reference fields verbatim", () => {
    const req = buildAgnesRegularRequest({
      ...BASE,
      firstFrameUrl: "https://a/f.png",
      lastFrameUrl: "https://a/l.png",
    });
    expect(req).toMatchObject({
      model: "agnes-video-2.5",
      mode: "keyframe",
      first_frame: "https://a/f.png",
      last_frame: "https://a/l.png",
      n: 1,
    });
    const ref = buildAgnesRegularRequest({
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
    const req = buildAgnesRegularRequest({ ...BASE, referenceImageUrls: imgs });
    req.images?.push("https://a/2.png");
    expect(imgs).toEqual(["https://a/1.png"]);
  });

  it("excess image count follows the free allowance (first 5 free)", () => {
    expect(regularExcessImageCount(BASE)).toBe(0);
    expect(
      regularExcessImageCount({
        ...BASE,
        referenceImageUrls: Array.from({ length: 5 }, () => "https://a.png"),
      }),
    ).toBe(0);
    expect(
      regularExcessImageCount({
        ...BASE,
        referenceImageUrls: Array.from({ length: 7 }, () => "https://a.png"),
      }),
    ).toBe(2);
  });
});

describe("submitAgnesRegular", () => {
  it("returns videoId + exact request + mode + prompt count", async () => {
    const client = {
      createVideo: async (body: { model: string }) => {
        expect(body.model).toBe("agnes-video-2.5");
        return { videoId: "vid_123" };
      },
    };
    const result = await submitAgnesRegular(
      { ...BASE, firstFrameUrl: "https://a/f.png" },
      client,
    );
    expect(result.videoId).toBe("vid_123");
    expect(result.model).toBe("agnes-video-2.5");
    expect(result.mode).toBe("keyframe");
    expect(result.promptCharacterCount).toBe(BASE.prompt.length);
  });

  it("throws AgnesRegularSubmitError on invalid input without calling client", async () => {
    let called = false;
    const client = {
      createVideo: async () => {
        called = true;
        return { videoId: "vid_x" };
      },
    };
    await expect(
      submitAgnesRegular({ ...BASE, seconds: 99 }, client),
    ).rejects.toThrow(AgnesRegularSubmitError);
    expect(called).toBe(false);
  });

  it("throws when the client returns no videoId", async () => {
    const client = {
      createVideo: async () => ({ videoId: "" }),
    };
    await expect(submitAgnesRegular(BASE, client)).rejects.toThrow(
      "no videoId",
    );
  });
});

describe("retrieval URL", () => {
  it("always carries model_name", () => {
    expect(agnesRegularRetrieveUrl("vid_1")).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=vid_1&model_name=agnes-video-2.5",
    );
    expect(agnesRegularRetrieveUrl("a b&c")).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=a%20b%26c&model_name=agnes-video-2.5",
    );
  });
});
