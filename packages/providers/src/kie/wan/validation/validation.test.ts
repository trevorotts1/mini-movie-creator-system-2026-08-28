/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  WAN_MAX_DURATION_SECONDS,
  WAN_MAX_PROMPT_CHARS,
  WAN_MAX_REFERENCE_AUDIO,
  WAN_MAX_REFERENCE_IMAGES,
  WAN_MAX_REFERENCE_VIDEOS,
  WAN_MIN_DURATION_SECONDS,
  WAN_SUPPORTED_RESOLUTIONS,
  assertWanRequestValid,
  isWanRequestValid,
  validateWanRequest,
  type WanMultimodalRequest,
} from "./index.js";

const URL_A = "https://cdn.example.test/ref-1.png";
const URL_B = "https://cdn.example.test/ref-2.png";

function url(n: number): string {
  return `https://cdn.example.test/ref-${n}.png`;
}

/** Valid baseline request; tests mutate one field at a time. */
function baseRequest(overrides: Partial<WanMultimodalRequest> = {}): WanMultimodalRequest {
  return { prompt: "A calm harbor at dawn", ...overrides };
}

/** Build an array of n distinct reference URLs. */
function refUrls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => url(i + 1));
}

describe("limits constants", () => {
  it("pins the documented Wan 3.0 hard limits", () => {
    expect(WAN_MAX_PROMPT_CHARS).toBe(20_000);
    expect(WAN_MAX_REFERENCE_IMAGES).toBe(10);
    expect(WAN_MAX_REFERENCE_VIDEOS).toBe(5);
    expect(WAN_MAX_REFERENCE_AUDIO).toBe(5);
    expect(WAN_MAX_DURATION_SECONDS).toBe(30);
    expect(WAN_MIN_DURATION_SECONDS).toBe(1);
    expect(WAN_SUPPORTED_RESOLUTIONS).toEqual(["480p", "720p", "1080p"]);
  });
});

describe("prompt validation (reject BEFORE provider call)", () => {
  it("accepts a prompt exactly at the 20,000-char limit", () => {
    const prompt = "x".repeat(WAN_MAX_PROMPT_CHARS);
    const result = validateWanRequest(baseRequest({ prompt }));
    expect(result.ok).toBe(true);
  });

  it("rejects a 20,001-char prompt with PROMPT_TOO_LONG", () => {
    const prompt = "x".repeat(WAN_MAX_PROMPT_CHARS + 1);
    const result = validateWanRequest(baseRequest({ prompt }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("PROMPT_TOO_LONG");
    }
  });

  it("rejects an over-limit prompt even when everything else is valid", () => {
    // 20,001 chars, valid multimodal payload — still must not pass.
    const result = validateWanRequest(
      baseRequest({ prompt: "s".repeat(20_001), referenceImages: [URL_A] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a missing/blank prompt with MISSING_PROMPT", () => {
    for (const prompt of ["", "   ", undefined as unknown as string]) {
      const result = validateWanRequest(baseRequest({ prompt }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("MISSING_PROMPT");
    }
  });

  it("counts prompt characters as UTF-16 code units (emoji-safe length check)", () => {
    // 10,000 emoji = 20,000 UTF-16 units → at the limit, accepted.
    const prompt = "🌊".repeat(10_000);
    expect(validateWanRequest(baseRequest({ prompt })).ok).toBe(true);
    // 10,001 emoji = 20,002 units → over the limit.
    const over = "🌊".repeat(10_001);
    const result = validateWanRequest(baseRequest({ prompt: over }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.code).toBe("PROMPT_TOO_LONG");
  });
});

describe("reference-image validation (reject BEFORE provider call)", () => {
  it("accepts exactly 10 reference images", () => {
    const result = validateWanRequest(baseRequest({ referenceImages: refUrls(10) }));
    expect(result.ok).toBe(true);
  });

  it("rejects 11 reference images with TOO_MANY_REFERENCE_IMAGES", () => {
    const result = validateWanRequest(baseRequest({ referenceImages: refUrls(11) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("TOO_MANY_REFERENCE_IMAGES");
    }
  });

  it("flags invalid (non-URL) reference image entries", () => {
    const result = validateWanRequest(
      baseRequest({ referenceImages: [URL_A, "not-a-url", ""] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const invalid = result.violations.filter((v) => v.code === "INVALID_REFERENCE");
      expect(invalid.map((v) => v.field)).toEqual(["referenceImages[1]", "referenceImages[2]"]);
    }
  });

  it("rejects an over-limit images array even when entries are also invalid", () => {
    const result = validateWanRequest(
      baseRequest({ referenceImages: [...refUrls(10), "junk", ""] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("TOO_MANY_REFERENCE_IMAGES");
      expect(codes).toContain("INVALID_REFERENCE");
    }
  });
});

describe("reference video/audio count validation", () => {
  it("accepts 5 reference videos and 5 reference audio clips", () => {
    const result = validateWanRequest(
      baseRequest({
        referenceVideos: refUrls(5),
        referenceAudio: refUrls(5),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects 6 reference videos with TOO_MANY_REFERENCE_VIDEOS", () => {
    const result = validateWanRequest(baseRequest({ referenceVideos: refUrls(6) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("TOO_MANY_REFERENCE_VIDEOS");
    }
  });

  it("rejects 6 reference audio clips with TOO_MANY_REFERENCE_AUDIO", () => {
    const result = validateWanRequest(baseRequest({ referenceAudio: refUrls(6) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("TOO_MANY_REFERENCE_AUDIO");
    }
  });
});

describe("first/last-frame vs multimodal mode exclusivity", () => {
  it("accepts a pure multimodal request", () => {
    const result = validateWanRequest(
      baseRequest({ referenceImages: [URL_A, URL_B] }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a pure first/last-frame request", () => {
    const result = validateWanRequest(
      baseRequest({ firstFrameUrl: URL_A, lastFrameUrl: URL_B }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a single firstFrameUrl only", () => {
    expect(validateWanRequest(baseRequest({ firstFrameUrl: URL_A })).ok).toBe(true);
  });

  it("accepts a single lastFrameUrl only", () => {
    expect(validateWanRequest(baseRequest({ lastFrameUrl: URL_B })).ok).toBe(true);
  });

  it("rejects multimodal images combined with first frame (MODE_CONFLICT)", () => {
    const result = validateWanRequest(
      baseRequest({ referenceImages: [URL_A], firstFrameUrl: URL_B }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("MODE_CONFLICT");
  });

  it("rejects multimodal videos combined with last frame (MODE_CONFLICT)", () => {
    const result = validateWanRequest(
      baseRequest({ referenceVideos: [URL_A], lastFrameUrl: URL_B }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("MODE_CONFLICT");
  });

  it("rejects multimodal audio combined with first frame (MODE_CONFLICT)", () => {
    const result = validateWanRequest(
      baseRequest({ referenceAudio: [URL_A], firstFrameUrl: URL_B }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.map((v) => v.code)).toContain("MODE_CONFLICT");
  });

  it("rejects empty-string multimodal refs combined with first frame (MODE_CONFLICT via empty entries)", () => {
    // An empty string still counts as an attempted multimodal entry.
    const result = validateWanRequest(
      baseRequest({ referenceImages: [""], firstFrameUrl: URL_A }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("MODE_CONFLICT");
      expect(codes).toContain("INVALID_REFERENCE");
    }
  });

  it("rejects first frame with invalid URL value", () => {
    const result = validateWanRequest(baseRequest({ firstFrameUrl: "ftp://nope" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.field)).toContain("firstFrameUrl");
    }
  });
});

describe("duration and resolution validation", () => {
  it("accepts duration at both bounds", () => {
    expect(validateWanRequest(baseRequest({ durationSeconds: WAN_MIN_DURATION_SECONDS })).ok).toBe(true);
    expect(validateWanRequest(baseRequest({ durationSeconds: WAN_MAX_DURATION_SECONDS })).ok).toBe(true);
  });

  it("rejects duration over 30s and under 1s", () => {
    expect(validateWanRequest(baseRequest({ durationSeconds: 31 })).ok).toBe(false);
    expect(validateWanRequest(baseRequest({ durationSeconds: 0 })).ok).toBe(false);
    expect(validateWanRequest(baseRequest({ durationSeconds: -5 })).ok).toBe(false);
    expect(validateWanRequest(baseRequest({ durationSeconds: NaN })).ok).toBe(false);
  });

  it("accepts each documented resolution and rejects undocumented ones", () => {
    for (const resolution of WAN_SUPPORTED_RESOLUTIONS) {
      expect(validateWanRequest(baseRequest({ resolution })).ok).toBe(true);
    }
    expect(validateWanRequest(baseRequest({ resolution: "2160p" as never })).ok).toBe(false);
    expect(validateWanRequest(baseRequest({ resolution: "4k" as never })).ok).toBe(false);
  });
});

describe("aggregated violations and helpers", () => {
  it("reports ALL violations in one pass, not just the first", () => {
    const result = validateWanRequest(
      baseRequest({
        prompt: "x".repeat(20_001),
        referenceImages: refUrls(12),
        referenceVideos: refUrls(6),
        referenceAudio: refUrls(7),
        firstFrameUrl: URL_A,
        durationSeconds: 99,
        resolution: "2160p" as never,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("PROMPT_TOO_LONG");
      expect(codes).toContain("TOO_MANY_REFERENCE_IMAGES");
      expect(codes).toContain("TOO_MANY_REFERENCE_VIDEOS");
      expect(codes).toContain("TOO_MANY_REFERENCE_AUDIO");
      expect(codes).toContain("MODE_CONFLICT");
      expect(codes).toContain("INVALID_DURATION");
      expect(codes).toContain("INVALID_RESOLUTION");
    }
  });

  it("violation messages never embed prompt content", () => {
    const secret = "TOPSECRET-CONTENT-xyz";
    const result = validateWanRequest(baseRequest({ prompt: secret.repeat(20_000) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const v of result.violations) {
        expect(v.message).not.toContain("TOPSECRET");
      }
    }
  });

  it("isWanRequestValid mirrors result.ok", () => {
    expect(isWanRequestValid({ ok: true, request: baseRequest() })).toBe(true);
    expect(
      isWanRequestValid({
        ok: false,
        violations: [{ code: "MISSING_PROMPT", field: "prompt", message: "m" }],
      }),
    ).toBe(false);
  });

  it("assertWanRequestValid throws BEFORE any provider call for invalid input", () => {
    expect(() => assertWanRequestValid(baseRequest({ prompt: "" }))).toThrow(
      /rejected before provider call/,
    );
    expect(() => assertWanRequestValid(baseRequest({ referenceImages: refUrls(11) }))).toThrow(
      /TOO_MANY_REFERENCE_IMAGES/,
    );
    expect(() => assertWanRequestValid(baseRequest())).not.toThrow();
  });
});

describe("gate-before-call contract shape", () => {
  it("validation is synchronous — usable inline before createTask with no await", () => {
    const started = Date.now();
    const result = validateWanRequest(baseRequest({ prompt: "ok" }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(true);
  });
});

describe("malformed payload handling (never throw, always structured rejection)", () => {
  it("rejects null / undefined / primitives without throwing", () => {
    for (const bad of [null, undefined, 42, "prompt", true]) {
      const result = validateWanRequest(bad as unknown as WanMultimodalRequest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations[0]?.code).toBe("INVALID_REFERENCE");
        expect(result.violations[0]?.field).toBe("request");
      }
    }
  });

  it("rejects array payloads structurally (object without prompt) without throwing", () => {
    const result = validateWanRequest([] as unknown as WanMultimodalRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("MISSING_PROMPT");
    }
  });

  it("rejects non-array reference fields with INVALID_REFERENCE instead of crashing", () => {
    const result = validateWanRequest(
      baseRequest({ referenceImages: "https://cdn.example.test/a.png" as unknown as string[] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.code)).toContain("INVALID_REFERENCE");
      expect(result.violations.map((v) => v.field)).toContain("referenceImages");
    }
  });

  it("rejects non-array referenceVideos/referenceAudio fields", () => {
    for (const field of ["referenceVideos", "referenceAudio"] as const) {
      const result = validateWanRequest(
        baseRequest({ [field]: 7 as unknown as string[] }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations.map((v) => v.field)).toContain(field);
    }
  });

  it("flags present-but-non-string firstFrameUrl/lastFrameUrl instead of silently ignoring", () => {
    const result = validateWanRequest(
      baseRequest({ firstFrameUrl: 123 as unknown as string, lastFrameUrl: true as unknown as string }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.violations.map((v) => v.field);
      expect(fields).toContain("firstFrameUrl");
      expect(fields).toContain("lastFrameUrl");
    }
  });

  it("accepts undefined (absent) frame URLs — optional fields stay optional", () => {
    expect(validateWanRequest(baseRequest({ firstFrameUrl: undefined })).ok).toBe(true);
  });

  it("non-array references present alongside frames still produce MODE_CONFLICT", () => {
    // Array check happens on count; a non-array must not mask a real mode conflict.
    const result = validateWanRequest(
      baseRequest({
        referenceImages: ["https://cdn.example.test/a.png"],
        referenceVideos: 1 as unknown as string[],
        firstFrameUrl: URL_A,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.violations.map((v) => v.code);
      expect(codes).toContain("MODE_CONFLICT");
      expect(codes).toContain("INVALID_REFERENCE");
    }
  });
});