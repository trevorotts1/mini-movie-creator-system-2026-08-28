/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  SEEDANCE_2_MINI_MODEL,
  SEEDANCE_MODES,
  SEEDANCE_MAX_REFERENCE_IMAGES,
  SeedanceValidationError,
  buildSeedanceInput,
  buildSeedanceTaskRequest,
  inferSeedanceMode,
  isCallbackUrl,
  isReferenceUrl,
  validateSeedanceRequest,
  type SeedanceMode,
  type SeedanceRequest,
} from "./index.js";

const PROMPT = "A locked recurring character walks through a rainy neon alley";
const IMG = "https://assets.example.com/frames/first.png";
const IMG2 = "https://assets.example.com/frames/last.png";
const REF1 = "https://assets.example.com/refs/character-master.png";
const VID = "https://assets.example.com/refs/motion.mp4";
const AUD = "https://assets.example.com/refs/voice.wav";
const ASSET = "asset://abc123";

/** Valid request for the given mode; tests mutate from these baselines. */
function baseRequest(mode: SeedanceMode): SeedanceRequest {
  switch (mode) {
    case "text-to-video":
      return { mode, prompt: PROMPT };
    case "first-frame":
      return { mode, prompt: PROMPT, firstFrameUrl: IMG };
    case "first-last-frame":
      return { mode, prompt: PROMPT, firstFrameUrl: IMG, lastFrameUrl: IMG2 };
    case "multimodal-reference":
      return { mode, prompt: PROMPT, referenceImageUrls: [REF1] };
  }
}

describe("mode is explicit per request", () => {
  it("exposes the four documented modes and no default mode", () => {
    expect(SEEDANCE_MODES).toEqual([
      "text-to-video",
      "first-frame",
      "first-last-frame",
      "multimodal-reference",
    ]);
    // SeedanceRequest.mode is required — compile-time proof via a type hole.
    const missing = {} as unknown as SeedanceRequest;
    expect(() => validateSeedanceRequest(missing)).toThrow(SeedanceValidationError);
  });

  it("rejects an unknown mode string", () => {
    const bad = { ...baseRequest("text-to-video"), mode: "both" } as unknown as SeedanceRequest;
    try {
      validateSeedanceRequest(bad);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SeedanceValidationError);
      const codes = (err as SeedanceValidationError).errors.map((e) => e.code);
      expect(codes).toContain("MODE_REQUIRED");
    }
  });

  it("each mode's baseline request passes validation", () => {
    for (const mode of SEEDANCE_MODES) {
      expect(() => validateSeedanceRequest(baseRequest(mode))).not.toThrow();
    }
  });

  it("declared mode must match the fields present (no silent remap)", () => {
    // first/last frames supplied but declared t2v — rejected, not remapped.
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), firstFrameUrl: IMG }),
    ).toThrow(SeedanceValidationError);
    // references supplied but declared first-frame — rejected.
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("first-frame"), referenceImageUrls: [REF1] }),
    ).toThrow(/mutually exclusive|MUTUALLY_EXCLUSIVE_MODES|not part of/);
  });
});

describe("pre-flight rejection of mutually exclusive mode combinations", () => {
  it("rejects first/last-frame fields combined with reference images", () => {
    for (const mode of ["first-frame", "first-last-frame"] as const) {
      const request = { ...baseRequest(mode), referenceImageUrls: [REF1] };
      try {
        validateSeedanceRequest(request);
        expect.unreachable(`expected rejection for ${mode} + referenceImageUrls`);
      } catch (err) {
        expect(err).toBeInstanceOf(SeedanceValidationError);
        const issue = (err as SeedanceValidationError).errors.find(
          (e) => e.code === "MUTUALLY_EXCLUSIVE_MODES",
        );
        expect(issue).toBeDefined();
        expect(issue?.field).toBe("mode");
      }
    }
  });

  it("rejects first-frame combined with each reference kind", () => {
    for (const [field, value] of [
      ["referenceImageUrls", [REF1]],
      ["referenceVideoUrls", [VID]],
      ["referenceAudioUrls", [AUD]],
    ] as const) {
      const request = { ...baseRequest("first-frame"), [field]: value } as SeedanceRequest;
      expect(() => validateSeedanceRequest(request)).toThrow(/MUTUALLY_EXCLUSIVE_MODES/);
    }
  });

  it("rejects last_frame_url without first_frame_url (not a documented scenario)", () => {
    expect(() => validateSeedanceRequest({ mode: "first-frame", prompt: PROMPT, lastFrameUrl: IMG2 }))
      .toThrow(/LAST_FRAME_WITHOUT_FIRST|not a supported Seedance scenario/);
  });

  it("rejects multimodal-reference mode that carries first-frame inputs", () => {
    const request = { ...baseRequest("multimodal-reference"), firstFrameUrl: IMG, lastFrameUrl: IMG2 };
    expect(() => validateSeedanceRequest(request)).toThrow(/MUTUALLY_EXCLUSIVE_MODES/);
  });

  it("rejects web_search outside text-to-video", () => {
    expect(() => validateSeedanceRequest({ ...baseRequest("first-frame"), webSearch: true })).toThrow(
      /web_search is t2v-only/,
    );
    expect(() => validateSeedanceRequest({ ...baseRequest("text-to-video"), webSearch: true })).not.toThrow();
  });

  it("reports every violation in one pass, not just the first", () => {
    const request: SeedanceRequest = {
      mode: "text-to-video",
      prompt: "ab",
      firstFrameUrl: IMG,
      referenceImageUrls: [REF1],
      referenceVideoUrls: [VID],
      durationSeconds: 2,
      resolution: "4K" as SeedanceRequest["resolution"],
    };
    try {
      validateSeedanceRequest(request);
      expect.unreachable("expected throw");
    } catch (err) {
      const codes = (err as SeedanceValidationError).errors.map((e) => e.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          "MUTUALLY_EXCLUSIVE_MODES",
          "PROMPT_TOO_SHORT",
          "DURATION_OUT_OF_RANGE",
          "INVALID_RESOLUTION",
        ]),
      );
    }
  });
});

describe("multimodal-reference requirements", () => {
  it("requires at least one reference in multimodal-reference mode", () => {
    expect(() => validateSeedanceRequest({ mode: "multimodal-reference", prompt: PROMPT })).toThrow(
      /MODE_FIELD_REQUIRED|at least one reference/,
    );
  });

  it("accepts video/audio-only multimodal-reference requests", () => {
    expect(() =>
      validateSeedanceRequest({ mode: "multimodal-reference", prompt: PROMPT, referenceVideoUrls: [VID] }),
    ).not.toThrow();
    expect(() =>
      validateSeedanceRequest({ mode: "multimodal-reference", prompt: PROMPT, referenceAudioUrls: [AUD] }),
    ).not.toThrow();
  });

  it("enforces documented reference maxima (9 images / 3 videos / 3 audios)", () => {
    expect(SEEDANCE_MAX_REFERENCE_IMAGES).toBe(9);
    const tooManyImages = Array.from({ length: 10 }, (_, i) => `https://x.example/${i}.png`);
    expect(() =>
      validateSeedanceRequest({
        mode: "multimodal-reference",
        prompt: PROMPT,
        referenceImageUrls: tooManyImages,
      }),
    ).toThrow(/TOO_MANY_REFERENCES/);

    const tooManyVideos = [VID, VID, VID, VID];
    expect(() =>
      validateSeedanceRequest({
        mode: "multimodal-reference",
        prompt: PROMPT,
        referenceVideoUrls: tooManyVideos,
      }),
    ).toThrow(/TOO_MANY_REFERENCES/);
  });
});

describe("scalar field validation", () => {
  it("rejects empty/short prompts and prompts over the documented ceiling", () => {
    expect(() => validateSeedanceRequest(baseRequest("text-to-video"))).not.toThrow();
    expect(() => validateSeedanceRequest({ mode: "text-to-video", prompt: "" })).toThrow(/PROMPT_TOO_SHORT/);
    expect(() =>
      validateSeedanceRequest({ mode: "text-to-video", prompt: "x".repeat(20001) }),
    ).toThrow(/PROMPT_TOO_LONG/);
  });

  it("rejects non-integer and out-of-range durations", () => {
    for (const bad of [3, 16, 5.5, NaN]) {
      expect(() => validateSeedanceRequest({ ...baseRequest("text-to-video"), durationSeconds: bad })).toThrow(
        /DURATION_OUT_OF_RANGE/,
      );
    }
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), durationSeconds: 15 }),
    ).not.toThrow();
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), durationSeconds: 4 }),
    ).not.toThrow();
  });

  it("rejects unknown aspect ratios and resolutions", () => {
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), aspectRatio: "2:1" as never }),
    ).toThrow(/INVALID_ASPECT_RATIO/);
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), aspectRatio: "9:16" }),
    ).not.toThrow();
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), resolution: "1080p" as never }),
    ).toThrow(/INVALID_RESOLUTION/);
  });

  it("rejects non-URL frame/reference values", () => {
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("first-frame"), firstFrameUrl: "not a url" }),
    ).toThrow(/INVALID_REFERENCE_URL/);
    expect(() => validateSeedanceRequest({ ...baseRequest("first-frame"), firstFrameUrl: ASSET })).not.toThrow();
    expect(() =>
      validateSeedanceRequest({ mode: "multimodal-reference", prompt: PROMPT, referenceImageUrls: ["ftp://x"] }),
    ).toThrow(/INVALID_REFERENCE_URL/);
  });

  it("isReferenceUrl accepts http(s) and asset schemes only", () => {
    expect(isReferenceUrl("https://a.png")).toBe(true);
    expect(isReferenceUrl("http://a.png")).toBe(true);
    expect(isReferenceUrl("asset://id")).toBe(true);
    expect(isReferenceUrl("asset://")).toBe(false);
    expect(isReferenceUrl("")).toBe(false);
    expect(isReferenceUrl(42)).toBe(false);
    expect(isReferenceUrl(null)).toBe(false);
  });

  it("isReferenceUrl rejects scheme-only and authority-less URLs", () => {
    // scheme-only garbage must never reach the provider as a usable ref.
    expect(isReferenceUrl("http://")).toBe(false);
    expect(isReferenceUrl("https://")).toBe(false);
    expect(isReferenceUrl("asset:///x")).toBe(false);
    expect(isReferenceUrl("asset://?query")).toBe(false);
    expect(isReferenceUrl("https:///missing-host")).toBe(false);
    expect(isReferenceUrl("ftp://a.png")).toBe(false);
  });

  it("validates callBackUrl: http(s) only, emitted at createTask level", () => {
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), callBackUrl: "https://hooks.example.com/done" }),
    ).not.toThrow();
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), callBackUrl: "asset://abc" }),
    ).toThrow(/INVALID_CALLBACK_URL/);
    expect(() =>
      validateSeedanceRequest({ ...baseRequest("text-to-video"), callBackUrl: "https://" }),
    ).toThrow(/INVALID_CALLBACK_URL/);

    // Emitted on the createTask body (KIE-002 KieCreateTaskRequest shape), not the input.
    const body = buildSeedanceTaskRequest({
      ...baseRequest("first-frame"),
      callBackUrl: "https://hooks.example.com/done",
    });
    expect(body.model).toBe(SEEDANCE_2_MINI_MODEL);
    expect(body.callBackUrl).toBe("https://hooks.example.com/done");
    expect("callBackUrl" in body.input).toBe(false);
    expect(body.input["first_frame_url"]).toBe(IMG);
  });

  it("isCallbackUrl accepts http(s) webhooks only", () => {
    expect(isCallbackUrl("https://hooks.example.com/done")).toBe(true);
    expect(isCallbackUrl("http://hooks.example.com/done")).toBe(true);
    expect(isCallbackUrl("asset://abc")).toBe(false);
    expect(isCallbackUrl("https://")).toBe(false);
    expect(isCallbackUrl("")).toBe(false);
    expect(isCallbackUrl(42)).toBe(false);
  });
});

describe("buildSeedanceInput", () => {
  it("emits only mode-permitted fields for each mode", () => {
    const t2v = buildSeedanceInput(baseRequest("text-to-video"));
    expect(t2v).toEqual({ prompt: PROMPT, aspect_ratio: "16:9", resolution: "720p", duration: 5 });

    const first = buildSeedanceInput(baseRequest("first-frame"));
    expect(first["first_frame_url"]).toBe(IMG);
    expect("last_frame_url" in first).toBe(false);
    expect("reference_image_urls" in first).toBe(false);

    const both = buildSeedanceInput(baseRequest("first-last-frame"));
    expect(both["first_frame_url"]).toBe(IMG);
    expect(both["last_frame_url"]).toBe(IMG2);

    const refs = buildSeedanceInput(baseRequest("multimodal-reference"));
    expect(refs["reference_image_urls"]).toEqual([REF1]);
    expect("first_frame_url" in refs).toBe(false);
  });

  it("passes through optional toggles and explicit overrides", () => {
    const input = buildSeedanceInput({
      ...baseRequest("text-to-video"),
      aspectRatio: "9:16",
      resolution: "480p",
      durationSeconds: 12,
      webSearch: true,
      generateAudio: false,
      nsfwChecker: true,
    });
    expect(input["aspect_ratio"]).toBe("9:16");
    expect(input["resolution"]).toBe("480p");
    expect(input["duration"]).toBe(12);
    expect(input["web_search"]).toBe(true);
    expect(input["generate_audio"]).toBe(false);
    expect(input["nsfw_checker"]).toBe(true);
  });

  it("re-validates before building — rejects an invalid request", () => {
    expect(() =>
      buildSeedanceInput({ ...baseRequest("first-frame"), referenceImageUrls: [REF1] }),
    ).toThrow(SeedanceValidationError);
  });

  it("uses the verified model slug constant", () => {
    expect(SEEDANCE_2_MINI_MODEL).toBe("bytedance/seedance-2-mini");
  });
});

describe("inferSeedanceMode (router diagnostics)", () => {
  it("infers the mode from fields, t2v for empty, null for conflicts", () => {
    expect(inferSeedanceMode(baseRequest("text-to-video"))).toBe("text-to-video");
    expect(inferSeedanceMode(baseRequest("first-frame"))).toBe("first-frame");
    expect(inferSeedanceMode(baseRequest("first-last-frame"))).toBe("first-last-frame");
    expect(inferSeedanceMode(baseRequest("multimodal-reference"))).toBe("multimodal-reference");
    expect(inferSeedanceMode({ ...baseRequest("first-frame"), referenceImageUrls: [REF1] })).toBeNull();
  });

  it("returns null for the illegal last-frame-only payload (no silent remap)", () => {
    expect(
      inferSeedanceMode({ mode: "first-frame", prompt: PROMPT, lastFrameUrl: IMG2 }),
    ).toBeNull();
  });
});