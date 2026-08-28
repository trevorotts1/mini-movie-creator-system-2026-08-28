import { describe, expect, it } from "vitest";
import {
  getWanProfile,
  isWanModel,
  WAN_3_0_MODEL,
  WAN_3_0_PRIME_MODEL,
  WAN_3_0_VIDEO,
  WAN_3_0_VIDEO_PRIME,
} from "./capability.js";
import { buildCreateTaskBody, estimateWanCost } from "./request.js";
import { detectWanMode, validateWanInput, WanValidationErrorList } from "./validate.js";
import { submitWanVideo, WanSubmitError } from "./adapter.js";
import type { WanClientPort } from "./adapter.js";
import type { WanVideoInput } from "./types.js";

// ---------------------------------------------------------------------------
// capability registry record — the LIVE-VERIFIED baseline
// ---------------------------------------------------------------------------

describe("Wan 3.0 capability profile (live-verified 2026-08-28)", () => {
  it("carries the spec baseline: 20,000-char prompt, ≤10/≤5/≤5 refs, ≤30s, 480P/720P/1080P", () => {
    const p = getWanProfile(WAN_3_0_MODEL);
    expect(p.provider).toBe("kie");
    expect(p.kind).toBe("video");
    expect(p.confidence).toBe("VERIFIED");
    expect(p.prompt.hardMaxCharacters).toBe(20_000);
    expect(p.references.maxImages).toBe(10);
    expect(p.references.maxVideos).toBe(5);
    expect(p.references.maxAudio).toBe(5);
    expect(p.output.maxDurationSeconds).toBe(30);
    expect(p.output.resolutions).toEqual(["480P", "720P", "1080P"]);
    expect(p.lastVerifiedAt).toBe("2026-08-28");
    expect(p.sourceUrls.length).toBeGreaterThan(0);
  });

  it("records verified mode incompatibilities (frames vs references, file vs link)", () => {
    const incompat = WAN_3_0_VIDEO.references.incompatibleCombinations;
    expect(incompat).toContain("first_frame_url+reference_*_urls");
    expect(incompat).toContain("last_frame_url+reference_*_urls");
    expect(incompat).toContain("reference_file_urls+reference_link_urls");
  });

  it("records verified pricing: 8/16/32 credits per second ($0.04/$0.08/$0.16)", () => {
    expect(WAN_3_0_VIDEO.pricing.creditsPerSecondByResolution).toEqual({
      "480P": 8,
      "720P": 16,
      "1080P": 32,
    });
    expect(WAN_3_0_VIDEO.pricing.usdPerSecondByResolution["1080P"]).toBe(0.16);
    expect(WAN_3_0_VIDEO.pricing.billedOnInputVideoSecondsToo).toBe(true);
  });

  it("exposes both model slugs and prime pricing", () => {
    expect(isWanModel("wan/3-0-video")).toBe(true);
    expect(isWanModel("wan/3-0-video-prime")).toBe(true);
    expect(isWanModel("wan/2-5-text-to-video")).toBe(false);
    expect(isWanModel("seedance")).toBe(false);
    expect(WAN_3_0_PRIME_MODEL).toBe("wan/3-0-video-prime");
    expect(WAN_3_0_VIDEO_PRIME.pricing.usdPerSecondByResolution["1080P"]).toBe(0.252);
  });
});

// ---------------------------------------------------------------------------
// validation — everything rejects BEFORE a provider call
// ---------------------------------------------------------------------------

const GOOD: WanVideoInput = {
  prompt: "A kitten running across a rooftop under the moonlight, cinematic quality.",
  duration: 5,
};

describe("validateWanInput", () => {
  it("accepts a plain text-to-video request and detects the mode", () => {
    const { mode } = validateWanInput(GOOD);
    expect(mode).toBe("text_to_video");
    expect(detectWanMode({ prompt: "x" })).toBe("text_to_video");
    expect(detectWanMode({ prompt: "x", firstFrameUrl: "https://a/b.png" })).toBe("first_frame");
    expect(
      detectWanMode({ prompt: "x", firstFrameUrl: "https://a/b.png", lastFrameUrl: "https://a/c.png" }),
    ).toBe("first_last_frame");
    expect(detectWanMode({ prompt: "x", referenceImageUrls: ["https://a/b.png"] })).toBe("multimodal_reference");
    expect(detectWanMode({ prompt: "x", referenceFileUrls: ["https://a/b.pdf"] })).toBe("file_to_video");
    expect(detectWanMode({ prompt: "x", referenceLinkUrls: ["https://a/page"] })).toBe("link_to_video");
  });

  it("rejects a prompt over 20,000 characters with the limit + actual count", () => {
    const input: WanVideoInput = { prompt: "あ".repeat(20_001) };
    try {
      validateWanInput(input);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WanValidationErrorList);
      const list = err as WanValidationErrorList;
      expect(list.errors[0]?.field).toBe("prompt");
      expect(list.errors[0]?.limit).toBe(20_000);
      expect(list.errors[0]?.actual).toBe(20_001);
    }
  });

  it("accepts exactly 20,000 characters (boundary)", () => {
    expect(() => validateWanInput({ prompt: "あ".repeat(20_000) })).not.toThrow();
  });

  it("rejects 11 reference images (max 10) before any provider call", () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/ref${i}.png`);
    try {
      validateWanInput({ prompt: "scene", referenceImageUrls: urls });
      expect.unreachable("should have thrown");
    } catch (err) {
      const list = err as WanValidationErrorList;
      expect(list.errors[0]?.field).toBe("reference_image_urls");
      expect(list.errors[0]?.limit).toBe(10);
      expect(list.errors[0]?.actual).toBe(11);
    }
  });

  it("rejects 6 reference videos and 6 reference audio clips", () => {
    const six = Array.from({ length: 6 }, (_, i) => `https://cdn.example.com/m${i}`);
    expect(() => validateWanInput({ prompt: "s", referenceVideoUrls: six })).toThrow(/reference_video_urls/);
    expect(() => validateWanInput({ prompt: "s", referenceAudioUrls: six })).toThrow(/reference_audio_urls/);
  });

  it("rejects first/last-frame inputs combined with multimodal references (verified incompatibility)", () => {
    const input: WanVideoInput = {
      prompt: "s",
      firstFrameUrl: "https://cdn.example.com/first.png",
      referenceImageUrls: ["https://cdn.example.com/char.png"],
    };
    try {
      validateWanInput(input);
      expect.unreachable("should have thrown");
    } catch (err) {
      const list = err as WanValidationErrorList;
      expect(list.errors.map((e) => e.message).join(" ")).toMatch(
        /cannot be combined with multimodal reference/,
      );
      expect(list.errors[0]?.field).toBe("input");
    }
  });

  it("rejects last-frame-only combined with references", () => {
    expect(() =>
      validateWanInput({
        prompt: "s",
        lastFrameUrl: "https://cdn.example.com/last.png",
        referenceVideoUrls: ["https://cdn.example.com/v.mp4"],
      }),
    ).toThrow(WanValidationErrorList);
  });

  it("rejects file+link reference combination", () => {
    try {
      validateWanInput({
        prompt: "s",
        referenceFileUrls: ["https://cdn.example.com/deck.pdf"],
        referenceLinkUrls: ["https://example.com/page"],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const list = err as WanValidationErrorList;
      expect(list.errors[0]?.message).toMatch(/mutually exclusive/);
    }
  });

  it("rejects file/link combined with frame inputs", () => {
    expect(() =>
      validateWanInput({
        prompt: "s",
        firstFrameUrl: "https://cdn.example.com/f.png",
        referenceFileUrls: ["https://cdn.example.com/deck.pdf"],
      }),
    ).toThrow(WanValidationErrorList);
  });

  it("rejects durations outside [2,30] but accepts -1 sentinel and bounds", () => {
    expect(() => validateWanInput({ prompt: "s", duration: 1 })).toThrow(/duration/);
    expect(() => validateWanInput({ prompt: "s", duration: 31 })).toThrow(/duration/);
    expect(() => validateWanInput({ prompt: "s", duration: 2 })).not.toThrow();
    expect(() => validateWanInput({ prompt: "s", duration: 30 })).not.toThrow();
    expect(() => validateWanInput({ prompt: "s", duration: -1 })).not.toThrow();
    expect(() => validateWanInput({ prompt: "s", duration: 5.5 })).toThrow(/integer/);
  });

  it("enforces input-video-duration + duration ≤ 30 when reference videos are declared", () => {
    const input: WanVideoInput = {
      prompt: "s",
      duration: 20,
      referenceVideoUrls: ["https://cdn.example.com/v.mp4"],
    };
    expect(() => validateWanInput(input, WAN_3_0_MODEL, { referenceVideoSeconds: 15 })).toThrow(
      /must not exceed 30s/,
    );
    // 10 + 20 ≤ 30: fine.
    expect(() => validateWanInput(input, WAN_3_0_MODEL, { referenceVideoSeconds: 10 })).not.toThrow();
  });

  it("rejects unknown resolutions/aspect ratios and out-of-range seeds", () => {
    expect(() => validateWanInput({ ...GOOD, resolution: "2160P" as never })).toThrow(/resolution/);
    expect(() => validateWanInput({ ...GOOD, aspectRatio: "21:9" as never })).toThrow(/aspect_ratio/);
    expect(() => validateWanInput({ ...GOOD, seed: -1 })).toThrow(/seed/);
    expect(() => validateWanInput({ ...GOOD, seed: 2_147_483_648 })).toThrow(/seed/);
    expect(() => validateWanInput({ ...GOOD, seed: 42 })).not.toThrow();
  });

  it("requires a prompt for text-to-video but allows empty prompt with media", () => {
    expect(() => validateWanInput({ prompt: "" })).toThrow(/prompt is required/);
    expect(() =>
      validateWanInput({ prompt: "", firstFrameUrl: "https://cdn.example.com/f.png" }),
    ).not.toThrow();
  });

  it("rejects non-http URLs in every URL field", () => {
    expect(() => validateWanInput({ prompt: "s", firstFrameUrl: "file:///etc/passwd" })).toThrow(
      /http\(s\) URL/,
    );
    expect(() =>
      validateWanInput({ prompt: "s", referenceImageUrls: ["not-a-url"] }),
    ).toThrow(WanValidationErrorList);
  });

  it("reports ALL problems in one pass, not just the first", () => {
    try {
      validateWanInput({ prompt: "x".repeat(20_500), duration: 99, resolution: "480P" === "480P" ? ("4KP" as never) : "480P" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const list = err as WanValidationErrorList;
      const fields = list.errors.map((e) => e.field);
      expect(fields).toContain("prompt");
      expect(fields).toContain("duration");
      expect(fields).toContain("resolution");
    }
  });
});

// ---------------------------------------------------------------------------
// request building — exact verified wire schema
// ---------------------------------------------------------------------------

describe("buildCreateTaskBody", () => {
  it("emits the documented text-to-video body (snake_case input, defaults filled)", () => {
    const body = buildCreateTaskBody(
      { prompt: "Under the moonlight, a little cat is running on the roof." },
      WAN_3_0_MODEL,
    );
    expect(body).toEqual({
      model: "wan/3-0-video",
      input: {
        prompt: "Under the moonlight, a little cat is running on the roof.",
        resolution: "1080P",
        aspect_ratio: "adaptive",
        duration: 5,
        audio: true,
      },
    });
  });

  it("maps multimodal reference fields to their verified wire names", () => {
    const body = buildCreateTaskBody(
      {
        prompt: "Video 1 holds image 3 and is playing a song on the chair in image 4.",
        referenceImageUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
        referenceVideoUrls: ["https://cdn.example.com/role.mp4"],
        referenceAudioUrls: ["https://cdn.example.com/voice.mp3"],
        resolution: "720P",
        duration: 8,
        audio: false,
        seed: 12345,
      },
      WAN_3_0_MODEL,
    );
    expect(body.input.reference_image_urls).toHaveLength(2);
    expect(body.input.reference_video_urls).toEqual(["https://cdn.example.com/role.mp4"]);
    expect(body.input.reference_audio_urls).toEqual(["https://cdn.example.com/voice.mp3"]);
    expect(body.input.resolution).toBe("720P");
    expect(body.input.duration).toBe(8);
    expect(body.input.audio).toBe(false);
    expect(body.input.seed).toBe(12345);
    expect(body.input.first_frame_url).toBeUndefined();
  });

  it("maps first/last frame fields and honors callBackUrl", () => {
    const body = buildCreateTaskBody(
      {
        prompt: "transition",
        firstFrameUrl: "https://cdn.example.com/first.jpg",
        lastFrameUrl: "https://cdn.example.com/last.jpg",
        resolution: "1080P",
        duration: 8,
      },
      WAN_3_0_MODEL,
      "https://hooks.example.com/mmcs",
    );
    expect(body.callBackUrl).toBe("https://hooks.example.com/mmcs");
    expect(body.input.first_frame_url).toBe("https://cdn.example.com/first.jpg");
    expect(body.input.last_frame_url).toBe("https://cdn.example.com/last.jpg");
    expect(body.input.reference_image_urls).toBeUndefined();
  });

  it("omits empty prompt rather than sending an empty string", () => {
    const body = buildCreateTaskBody({ prompt: "", firstFrameUrl: "https://c/f.png" });
    expect(body.input.prompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pricing — verified per-resolution rates
// ---------------------------------------------------------------------------

describe("estimateWanCost", () => {
  it("prices 5s of 1080P at 160 credits / $0.80", () => {
    const est = estimateWanCost({ prompt: "s" }, WAN_3_0_MODEL);
    expect(est).toEqual({
      billedSeconds: 5,
      resolution: "1080P",
      credits: 160,
      usd: 0.8,
      model: WAN_3_0_MODEL,
    });
  });

  it("prices 30s of 480P at 240 credits / $1.20", () => {
    const est = estimateWanCost({ prompt: "s", duration: 30, resolution: "480P" });
    expect(est?.credits).toBe(240);
    expect(est?.usd).toBe(1.2);
  });

  it("bills reference-video input seconds on top of output seconds", () => {
    const est = estimateWanCost({ prompt: "s", duration: 10 }, WAN_3_0_MODEL, 15);
    expect(est?.billedSeconds).toBe(25);
    expect(est?.credits).toBe(25 * 32);
  });

  it("returns null for model-chosen duration (-1)", () => {
    expect(estimateWanCost({ prompt: "s", duration: -1 })).toBeNull();
  });

  it("prices prime at its verified rates", () => {
    const est = estimateWanCost({ prompt: "s", duration: 10, resolution: "720P" }, WAN_3_0_PRIME_MODEL);
    expect(est?.credits).toBe(252);
    expect(est?.usd).toBe(1.26);
  });
});

// ---------------------------------------------------------------------------
// adapter — submit path with a stubbed client port
// ---------------------------------------------------------------------------

function stubClient(overrides: Partial<Parameters<WanClientPort["createTask"]>[0]> = {}) {
  const calls: Array<Parameters<WanClientPort["createTask"]>[0]> = [];
  const client: WanClientPort = {
    async createTask(body) {
      calls.push(body);
      return { taskId: "task_wan_test_1" };
    },
  };
  return { client, calls };
}

describe("submitWanVideo", () => {
  it("submits a valid request and returns taskId + audit fields", async () => {
    const { client, calls } = stubClient();
    const result = await submitWanVideo(
      client,
      { prompt: "hero shot, cinematic", duration: 6, resolution: "720P" },
      { model: WAN_3_0_MODEL },
    );
    expect(result.taskId).toBe("task_wan_test_1");
    expect(result.model).toBe("wan/3-0-video");
    expect(result.mode).toBe("text_to_video");
    expect(result.promptCharacterCount).toBe(20);
    expect(result.estimate?.resolution).toBe("720P");
    expect(calls[0]?.model).toBe("wan/3-0-video");
  });

  it("rejects an over-limit prompt WITHOUT calling the provider", async () => {
    const { client, calls } = stubClient();
    await expect(
      submitWanVideo(client, { prompt: "x".repeat(20_001) }),
    ).rejects.toBeInstanceOf(WanValidationErrorList);
    expect(calls).toHaveLength(0);
  });

  it("rejects too many reference images WITHOUT calling the provider", async () => {
    const { client, calls } = stubClient();
    const urls = Array.from({ length: 11 }, (_, i) => `https://c/${i}.png`);
    await expect(
      submitWanVideo(client, { prompt: "s", referenceImageUrls: urls }),
    ).rejects.toBeInstanceOf(WanValidationErrorList);
    expect(calls).toHaveLength(0);
  });

  it("wraps client transport failures in WanSubmitError", async () => {
    const client: WanClientPort = {
      async createTask() {
        throw new Error("boom");
      },
    };
    await expect(submitWanVideo(client, { prompt: "s" })).rejects.toBeInstanceOf(WanSubmitError);
  });

  it("refuses an unknown model id", async () => {
    const { client, calls } = stubClient();
    await expect(
      submitWanVideo(client, { prompt: "s" }, { model: "not-wan" as never }),
    ).rejects.toBeInstanceOf(WanSubmitError);
    expect(calls).toHaveLength(0);
  });

  it("passes referenceVideoSeconds through to validation and pricing", async () => {
    const { client, calls } = stubClient();
    const input: WanVideoInput = {
      prompt: "ref-driven scene",
      duration: 25,
      referenceVideoUrls: ["https://cdn.example.com/v.mp4"],
    };
    await expect(
      submitWanVideo(client, input, { referenceVideoSeconds: 10 }),
    ).rejects.toThrow(/must not exceed 30s/);
    expect(calls).toHaveLength(0);
  });
});