/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  SEEDANCE_2_MINI_LIMITS,
  SEEDANCE_2_MINI_MODEL,
  buildSeedanceRequest,
  generationMode,
  seedanceRecordInfoUrl,
  SEEDANCE_CREATE_TASK_URL,
  validateSeedanceRequest,
  type SeedanceInput,
} from "./index.js";

const BASE: SeedanceInput = { prompt: "a locked character walks left to right" };

describe("generationMode", () => {
  it("classifies first-frame I2V", () => {
    expect(
      generationMode({ prompt: "x", firstFrameUrl: "https://a/b.png" }),
    ).toBe("first-frame-i2v");
  });

  it("classifies first+last-frame I2V", () => {
    expect(
      generationMode({
        prompt: "x",
        firstFrameUrl: "https://a/b.png",
        lastFrameUrl: "https://a/c.png",
      }),
    ).toBe("first-last-frame-i2v");
  });

  it("classifies multimodal-reference (images)", () => {
    expect(
      generationMode({
        prompt: "x",
        referenceImageUrls: ["https://a/b.png"],
      }),
    ).toBe("multimodal-reference");
  });

  it("classifies multimodal-reference (audio only)", () => {
    expect(
      generationMode({ prompt: "x", referenceAudioUrls: ["https://a/b.wav"] }),
    ).toBe("multimodal-reference");
  });

  it("defaults to multimodal-reference when nothing is set", () => {
    expect(generationMode({ prompt: "x" })).toBe("multimodal-reference");
  });
});

describe("validateSeedanceRequest — mode exclusivity", () => {
  it("accepts each mode alone", () => {
    expect(validateSeedanceRequest(BASE).ok).toBe(true);
    expect(
      validateSeedanceRequest({ ...BASE, firstFrameUrl: "https://a.png" }).mode,
    ).toBe("first-frame-i2v");
    expect(
      validateSeedanceRequest({
        ...BASE,
        firstFrameUrl: "https://a.png",
        lastFrameUrl: "https://b.png",
      }).mode,
    ).toBe("first-last-frame-i2v");
    expect(
      validateSeedanceRequest({ ...BASE, referenceImageUrls: ["https://a.png"] })
        .mode,
    ).toBe("multimodal-reference");
  });

  it("rejects first/last-frame combined with reference inputs", () => {
    const result = validateSeedanceRequest({
      ...BASE,
      firstFrameUrl: "https://a.png",
      referenceImageUrls: ["https://b.png"],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("mutually exclusive")),
    ).toBe(true);
  });

  it("rejects last_frame_url without first_frame_url", () => {
    const result = validateSeedanceRequest({
      ...BASE,
      lastFrameUrl: "https://b.png",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "input.last_frame_url")).toBe(
      true,
    );
  });

  it("treats an empty reference array as no reference inputs", () => {
    const result = validateSeedanceRequest({
      ...BASE,
      firstFrameUrl: "https://a.png",
      referenceImageUrls: [],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("first-frame-i2v");
  });
});

describe("validateSeedanceRequest — verified limits", () => {
  it("rejects a prompt shorter than 3 chars", () => {
    const result = validateSeedanceRequest({ prompt: "ab" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("input.prompt");
  });

  it("rejects a prompt over 20000 chars", () => {
    const result = validateSeedanceRequest({ prompt: "x".repeat(20001) });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("20000");
  });

  it("rejects out-of-enum resolution and aspect_ratio", () => {
    const result = validateSeedanceRequest({
      ...BASE,
      resolution: "1080p" as never,
      aspectRatio: "32:9" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("input.resolution");
    expect(result.errors.map((e) => e.field)).toContain("input.aspect_ratio");
  });

  it("rejects non-integer and out-of-range duration (PROVISIONAL 4-15)", () => {
    expect(validateSeedanceRequest({ ...BASE, duration: 3.5 }).ok).toBe(false);
    expect(validateSeedanceRequest({ ...BASE, duration: 2 }).ok).toBe(false);
    expect(validateSeedanceRequest({ ...BASE, duration: 16 }).ok).toBe(false);
    expect(validateSeedanceRequest({ ...BASE, duration: 15 }).ok).toBe(true);
  });

  it("enforces reference array caps (9 images / 3 videos / 3 audios)", () => {
    const imgs = Array.from({ length: 10 }, (_, i) => `https://a/${i}.png`);
    const result = validateSeedanceRequest({ ...BASE, referenceImageUrls: imgs });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("9");

    const vids = Array.from({ length: 4 }, (_, i) => `https://a/${i}.mp4`);
    expect(
      validateSeedanceRequest({ ...BASE, referenceVideoUrls: vids }).ok,
    ).toBe(false);

    const auds = Array.from({ length: 4 }, (_, i) => `https://a/${i}.wav`);
    expect(
      validateSeedanceRequest({ ...BASE, referenceAudioUrls: auds }).ok,
    ).toBe(false);
  });

  it("requires first/last frame values to be https URLs or asset refs", () => {
    expect(
      validateSeedanceRequest({ ...BASE, firstFrameUrl: "ftp://nope" }).ok,
    ).toBe(false);
    expect(
      validateSeedanceRequest({
        ...BASE,
        firstFrameUrl: "asset://asset-20260404242101-76djj",
      }).ok,
    ).toBe(true);
    expect(
      validateSeedanceRequest({ ...BASE, firstFrameUrl: "http://a.png" }).ok,
    ).toBe(true);
  });

  it("returns no mode when invalid", () => {
    const result = validateSeedanceRequest({ prompt: "" });
    expect(result.ok).toBe(false);
    expect(result.mode).toBeUndefined();
  });
});

describe("buildSeedanceRequest", () => {
  it("maps camelCase options to exact Kie snake_case fields", () => {
    const req = buildSeedanceRequest({
      ...BASE,
      firstFrameUrl: "https://a/first.png",
      lastFrameUrl: "https://a/last.png",
      resolution: "480p",
      aspectRatio: "9:16",
      duration: 10,
      generateAudio: false,
      nsfwChecker: false,
      webSearch: false,
      callbackUrl: "https://cb.example/hook",
    });
    expect(req.model).toBe(SEEDANCE_2_MINI_MODEL);
    expect(req.callBackUrl).toBe("https://cb.example/hook");
    expect(req.input.first_frame_url).toBe("https://a/first.png");
    expect(req.input.last_frame_url).toBe("https://a/last.png");
    expect(req.input.resolution).toBe("480p");
    expect(req.input.aspect_ratio).toBe("9:16");
    expect(req.input.duration).toBe(10);
    expect(req.input.generate_audio).toBe(false);
    expect(req.input.nsfw_checker).toBe(false);
    expect(req.input.web_search).toBe(false);
    expect(req.input.reference_image_urls).toBeUndefined();
  });

  it("omits unset optional fields entirely", () => {
    const req = buildSeedanceRequest(BASE);
    expect(Object.keys(req.input)).toEqual(["prompt"]);
    expect(req.callBackUrl).toBeUndefined();
  });

  it("copies reference arrays without aliasing", () => {
    const imgs = ["https://a/1.png"];
    const req = buildSeedanceRequest({ ...BASE, referenceImageUrls: imgs });
    req.input.reference_image_urls?.push("https://a/2.png");
    expect(imgs).toEqual(["https://a/1.png"]);
  });
});

describe("endpoints", () => {
  it("uses the Kie jobs API URLs", () => {
    expect(SEEDANCE_CREATE_TASK_URL).toBe(
      "https://api.kie.ai/api/v1/jobs/createTask",
    );
    expect(seedanceRecordInfoUrl("task_123")).toBe(
      "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_123",
    );
    expect(seedanceRecordInfoUrl("a b&c")).toBe(
      "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=a%20b%26c",
    );
  });
});

describe("capability limits — UNKNOWN/PROVISIONAL discipline", () => {
  it("every verified limit cites the live doc and date", () => {
    for (const [name, limit] of Object.entries(SEEDANCE_2_MINI_LIMITS)) {
      if (limit.status === "VERIFIED") {
        expect(limit.source.startsWith("https://"), name).toBe(true);
        expect(limit.verifiedOn).toBe("2026-08-28");
      } else {
        expect(limit.status, name).toBe("UNKNOWN");
        expect(limit.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("prompt bounds are the doc-stated 3/20000, not invented", () => {
    expect(SEEDANCE_2_MINI_LIMITS.promptLength.value).toEqual({
      min: 3,
      max: 20000,
    });
  });

  it("resolution enum is mini-specific (no 1080p/4k)", () => {
    expect(SEEDANCE_2_MINI_LIMITS.resolution.value).toEqual(["480p", "720p"]);
  });

  it("return_last_frame stays UNKNOWN — doc omits it from schema", () => {
    expect(SEEDANCE_2_MINI_LIMITS.returnLastFrame.status).toBe("UNKNOWN");
  });

  it("reference caps match the live schema", () => {
    expect(SEEDANCE_2_MINI_LIMITS.referenceImages.value.maxCount).toBe(9);
    expect(SEEDANCE_2_MINI_LIMITS.referenceVideos.value.maxCount).toBe(3);
    expect(SEEDANCE_2_MINI_LIMITS.referenceAudios.value.maxCount).toBe(3);
    expect(SEEDANCE_2_MINI_LIMITS.referenceVideos.value.totalPxRange).toEqual([
      409600, 927408,
    ]);
  });
});