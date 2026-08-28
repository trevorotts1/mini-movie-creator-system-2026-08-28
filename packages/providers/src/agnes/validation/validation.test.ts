/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_VIDEO_2_5_FLASH_VALIDATION_PROFILE,
  AGNES_VIDEO_2_5_VALIDATION_PROFILE,
  AgnesRequestValidationError,
  buildAgnesVideoPayload,
  effectiveMode,
  fieldsToMode,
  getAgnesValidationProfile,
  validateAgnesRequest,
  assertAgnesRequest,
  type AgnesVideoRequestShape,
} from "./index.js";

const FLASH = AGNES_VIDEO_2_5_FLASH_VALIDATION_PROFILE;
const REGULAR = AGNES_VIDEO_2_5_VALIDATION_PROFILE;

const KEYFRAME: AgnesVideoRequestShape = {
  prompt: "the locked character turns toward the window",
  firstFrameUrl: "https://ghl.example/first.png",
};

const REFERENCE: AgnesVideoRequestShape = {
  prompt: "the locked character walks past the cafe",
  referenceImageUrls: [
    "https://ghl.example/identity.png",
    "https://ghl.example/wardrobe.png",
  ],
};

describe("profiles", () => {
  it("resolves both seeded Agnes video profiles", () => {
    expect(getAgnesValidationProfile("agnes-video-2.5-flash")).toBe(FLASH);
    expect(getAgnesValidationProfile("agnes-video-2.5")).toBe(REGULAR);
    expect(getAgnesValidationProfile("agnes-video-v2.0")).toBeUndefined();
  });

  it("encodes the provider facts", () => {
    // Flash: size fixed 720P, images max 5, videos never supported.
    expect(FLASH.output.resolutions).toEqual(["720P"]);
    expect(FLASH.references.maxImages).toBe(5);
    expect(FLASH.references.referenceVideoSupported).toBe(false);
    // Regular: 720P/960P/2K, reference videos supported.
    expect(REGULAR.output.resolutions).toEqual(["720P", "960P", "2K"]);
    expect(REGULAR.references.referenceVideoSupported).toBe(true);
    // Agnes prompt hard max is undocumented on both → UNKNOWN (null).
    expect(FLASH.prompt.hardMaxCharacters).toBeNull();
    expect(REGULAR.prompt.hardMaxCharacters).toBeNull();
    // Regular reference counts are undocumented → UNKNOWN (null), never guessed.
    expect(REGULAR.references.maxImages).toBeNull();
    expect(REGULAR.references.maxVideos).toBeNull();
    expect(REGULAR.references.maxAudio).toBeNull();
    expect(FLASH.references.maxAudio).toBeNull();
  });
});

describe("mode inference", () => {
  it("classifies keyframe / reference / text shapes", () => {
    expect(fieldsToMode(KEYFRAME)).toBe("keyframe");
    expect(fieldsToMode(REFERENCE)).toBe("reference");
    expect(fieldsToMode({ prompt: "x" })).toBe("text");
    expect(effectiveMode({ prompt: "x", lastFrameUrl: "https://a/b.png" })).toBe(
      "keyframe",
    );
  });

  it("returns null when frame and reference fields conflict", () => {
    const shape: AgnesVideoRequestShape = {
      prompt: "x",
      firstFrameUrl: "https://a/first.png",
      referenceImageUrls: ["https://a/identity.png"],
    };
    expect(fieldsToMode(shape)).toBeNull();
  });

  it("treats empty strings and empty arrays as absent", () => {
    expect(
      fieldsToMode({ prompt: "x", firstFrameUrl: "  ", referenceImageUrls: [] }),
    ).toBe("text");
  });
});

describe("first-frame request shape (keyframe mode)", () => {
  it("accepts a first-frame-only keyframe request", () => {
    const result = validateAgnesRequest(FLASH, {
      ...KEYFRAME,
      seconds: 5,
      size: "720P",
      aspectRatio: "16:9",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
    expect(result.issues).toEqual([]);
  });

  it("accepts first+last and a lone last frame", () => {
    expect(
      validateAgnesRequest(FLASH, {
        ...KEYFRAME,
        lastFrameUrl: "https://ghl.example/last.png",
      }).ok,
    ).toBe(true);
    expect(
      validateAgnesRequest(FLASH, {
        prompt: "x",
        lastFrameUrl: "https://ghl.example/last.png",
      }).ok,
    ).toBe(true); // Agnes accepts a lone last frame in keyframe mode
  });

  it("rejects keyframe with reference media (invalid combination)", () => {
    const result = validateAgnesRequest(FLASH, {
      ...KEYFRAME,
      referenceImageUrls: ["https://ghl.example/identity.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain(
      "MODE_FIELDS_CONFLICT",
    );
  });

  it("rejects keyframe mode with no frame field", () => {
    const result = validateAgnesRequest(FLASH, { prompt: "x", mode: "keyframe" });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "KEYFRAME_REQUIRES_FRAME",
    );
  });

  it("rejects keyframe with explicit reference arrays present", () => {
    const result = validateAgnesRequest(FLASH, {
      prompt: "x",
      mode: "keyframe",
      firstFrameUrl: "https://a/first.png",
      referenceAudioUrls: ["https://a/voice.wav"],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "KEYFRAME_DISALLOWS_REFERENCE_MEDIA",
    );
  });
});

describe("last-frame request shape (keyframe mode)", () => {
  it("maps a lone last frame onto last_frame only", () => {
    const result = validateAgnesRequest(REGULAR, {
      prompt: "x",
      lastFrameUrl: "https://ghl.example/last.png",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("keyframe");
expect(result.issues).toEqual([]);
  });
});

describe("reference-image request shape (reference mode)", () => {
  it("accepts reference images and reports the mode", () => {
    const result = validateAgnesRequest(REGULAR, REFERENCE);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("reference");
  });

  it("rejects reference mode with frame fields (invalid combination)", () => {
    const result = validateAgnesRequest(REGULAR, {
      ...REFERENCE,
      mode: "reference",
      firstFrameUrl: "https://ghl.example/first.png",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "REFERENCE_DISALLOWS_FRAME_FIELDS",
    );
  });

  it("rejects reference mode with no media", () => {
    const result = validateAgnesRequest(REGULAR, { prompt: "x", mode: "reference" });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "REFERENCE_REQUIRES_MEDIA",
    );
  });

  it("enforces the Flash 5-image cap pre-flight", () => {
    const six = Array.from(
      { length: 6 },
      (_, i) => `https://ghl.example/ref-${i}.png`,
    );
    const result = validateAgnesRequest(FLASH, { prompt: "x", referenceImageUrls: six });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      field: "referenceImageUrls",
      code: "TOO_MANY_REFERENCE_IMAGES",
    });
    expect(result.issues[0]!.message).toContain("images length must not exceed 5");
  });

  it("accepts exactly 5 images on Flash", () => {
    const five = Array.from(
      { length: 5 },
      (_, i) => `https://ghl.example/ref-${i}.png`,
    );
    expect(
      validateAgnesRequest(FLASH, { prompt: "x", referenceImageUrls: five }).ok,
    ).toBe(true);
  });

  it("does NOT enforce a reference-image count on regular (UNKNOWN never enforced)", () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `https://ghl.example/ref-${i}.png`,
    );
    const result = validateAgnesRequest(REGULAR, { prompt: "x", referenceImageUrls: many });
    expect(result.ok).toBe(true); // no documented cap → no invented cap
  });
});

describe("reference-video support split", () => {
  const videos = [{ url: "https://ghl.example/ref.mp4", startSeconds: 2, requireAudio: true }];

  it("rejects videos on Flash pre-flight", () => {
    const result = validateAgnesRequest(FLASH, { prompt: "x", referenceVideos: videos });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      field: "referenceVideos",
      code: "REFERENCE_VIDEOS_NOT_SUPPORTED",
    });
    expect(result.issues[0]!.message).toContain("videos is not supported");
  });

  it("accepts videos on regular with url/startSeconds/requireAudio", () => {
    const result = validateAgnesRequest(REGULAR, {
      prompt: "x",
      referenceVideos: videos,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("reference");
  });

  it("rejects malformed video entries", () => {
    const result = validateAgnesRequest(REGULAR, {
      prompt: "x",
      referenceVideos: [{ url: "" }, { url: "https://ok.mp4", startSeconds: Number.NaN }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([
      "INVALID_REFERENCE_VIDEO_ENTRY",
      "INVALID_REFERENCE_VIDEO_ENTRY",
    ]);
  });
});

describe("text mode", () => {
  it("accepts a bare text request", () => {
    const result = validateAgnesRequest(FLASH, { prompt: "a door opens" });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("text");
  });

  it("rejects any media field in text mode", () => {
    const mediaCases: AgnesVideoRequestShape[] = [
      { firstFrameUrl: "https://a/first.png" },
      { lastFrameUrl: "https://a/last.png" },
      { referenceImageUrls: ["https://a/i.png"] },
      { referenceAudioUrls: ["https://a/a.wav"] },
      { referenceVideos: [{ url: "https://a/v.mp4" }] },
    ];
    for (const media of mediaCases) {
      const result = validateAgnesRequest(FLASH, { prompt: "x", mode: "text", ...media });
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain("TEXT_MODE_MEDIA_FIELDS");
    }
  });
});

describe("explicit mode agreement", () => {
  it("accepts an explicit mode that matches the fields", () => {
    expect(validateAgnesRequest(FLASH, { ...KEYFRAME, mode: "keyframe" }).ok).toBe(
      true,
    );
    expect(validateAgnesRequest(FLASH, { ...REFERENCE, mode: "reference" }).ok).toBe(
      true,
    );
  });

  it("rejects an explicit mode that disagrees with the fields", () => {
    const result = validateAgnesRequest(FLASH, { ...KEYFRAME, mode: "reference" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      field: "mode",
      code: "MODE_FIELDS_CONFLICT",
    });
  });

  it("rejects an unknown explicit mode", () => {
    const result = validateAgnesRequest(FLASH, {
      prompt: "x",
      mode: "hybrid" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("UNKNOWN_MODE");
  });
});

describe("prompt and profile validation", () => {
  it("requires a non-empty prompt in every mode", () => {
    for (const prompt of [undefined, "", "   "]) {
      const result = validateAgnesRequest(FLASH, { prompt, mode: "text" } as AgnesVideoRequestShape);
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain("MISSING_PROMPT");
    }
  });

  it("does NOT invent an Agnes prompt limit (UNKNOWN preserved)", () => {
    // 100,000 chars: Agnes' ceiling is undocumented, so no length issue may fire.
    const longPrompt = "x".repeat(100_000);
    const result = validateAgnesRequest(FLASH, {
      prompt: longPrompt,
      firstFrameUrl: "https://a/first.png",
    });
    expect(result.ok).toBe(true);
  });

  it("flags a malformed profile hard max instead of silently skipping it", () => {
    const badProfile = {
      ...FLASH,
      prompt: { hardMaxCharacters: -1 as unknown as number | null },
    };
    const result = validateAgnesRequest(badProfile, { prompt: "x", mode: "text" });
    expect(result.issues.map((i) => i.code)).toContain("INVALID_PROFILE_LIMIT");
  });

  it("enforces a VERIFIED prompt max when a profile supplies one", () => {
    const hypothetical = {
      ...FLASH,
      prompt: { hardMaxCharacters: 100 },
    };
    const result = validateAgnesRequest(hypothetical, {
      prompt: "x".repeat(101),
      mode: "text",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("PROMPT_TOO_LONG");
  });
});

describe("seconds and size", () => {
  it("accepts the 4-12 range as number and string", () => {
    expect(validateAgnesRequest(FLASH, { prompt: "x", seconds: 4 }).ok).toBe(true);
    expect(validateAgnesRequest(FLASH, { prompt: "x", seconds: "12" }).ok).toBe(true);
    expect(validateAgnesRequest(FLASH, { prompt: "x", seconds: 8 }).ok).toBe(true);
  });

  it("rejects out-of-range durations pre-flight", () => {
    for (const seconds of [3, 13, "2", "99"]) {
      const result = validateAgnesRequest(FLASH, { prompt: "x", seconds });
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain("INVALID_SECONDS");
    }
  });

  it("rejects non-numeric seconds", () => {
    const result = validateAgnesRequest(FLASH, { prompt: "x", seconds: "eight" });
    expect(result.ok).toBe(false);
  });

  it("rejects sizes outside the verified list (Flash fixed 720P)", () => {
    expect(
      validateAgnesRequest(FLASH, { prompt: "x", size: "960P" }).issues.map(
        (i) => i.code,
      ),
    ).toContain("INVALID_SIZE");
    expect(validateAgnesRequest(FLASH, { prompt: "x", size: "720P" }).ok).toBe(true);
    expect(validateAgnesRequest(REGULAR, { prompt: "x", size: "2K" }).ok).toBe(true);
    expect(
      validateAgnesRequest(REGULAR, { prompt: "x", size: "4K" }).issues.map(
        (i) => i.code,
      ),
    ).toContain("INVALID_SIZE");
  });
});

describe("assertAgnesRequest", () => {
  it("returns the resolved mode on success", () => {
    expect(assertAgnesRequest(FLASH, KEYFRAME)).toBe("keyframe");
    expect(assertAgnesRequest(REGULAR, REFERENCE)).toBe("reference");
  });

  it("throws AgnesRequestValidationError listing every issue on failure", () => {
    const shape: AgnesVideoRequestShape = {
      prompt: "",
      firstFrameUrl: "https://a/first.png",
      referenceImageUrls: ["https://a/i.png"],
      referenceVideos: [{ url: "https://a/v.mp4" }],
    };
    expect(() => assertAgnesRequest(FLASH, shape)).toThrowError(
      AgnesRequestValidationError,
    );
    try {
      assertAgnesRequest(FLASH, shape);
      expect.unreachable();
    } catch (error) {
      const err = error as AgnesRequestValidationError;
      expect(err.name).toBe("AgnesRequestValidationError");
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues.map((i) => i.code)).toContain("MODE_FIELDS_CONFLICT");
    }
  });
});

describe("buildAgnesVideoPayload", () => {
  it("maps first-frame requests to first_frame", () => {
    const payload = buildAgnesVideoPayload("agnes-video-2.5-flash", {
      ...KEYFRAME,
      mode: "keyframe",
      seconds: 5,
      size: "720P",
      aspectRatio: "9:16",
    });
    expect(payload).toEqual({
      model: "agnes-video-2.5-flash",
      mode: "keyframe",
      prompt: KEYFRAME.prompt,
      first_frame: "https://ghl.example/first.png",
      seconds: "5",
      size: "720P",
      aspect_ratio: "9:16",
    });
     });

  it("maps first+last to both frame fields", () => {
    const payload = buildAgnesVideoPayload("agnes-video-2.5", {
      prompt: "x",
      mode: "keyframe",
      firstFrameUrl: "https://a/first.png",
      lastFrameUrl: "https://a/last.png",
    });
    expect(payload.first_frame).toBe("https://a/first.png");
    expect(payload.last_frame).toBe("https://a/last.png");
  });

  it("maps reference images to images[] and reference videos to videos[] objects", () => {
    const payload = buildAgnesVideoPayload("agnes-video-2.5", {
      prompt: "x",
      mode: "reference",
      referenceImageUrls: ["https://a/i.png"],
      referenceAudioUrls: ["https://a/a.wav"],
      referenceVideos: [{ url: "https://a/v.mp4", startSeconds: 3, requireAudio: true }],
    });
    expect(payload.images).toEqual(["https://a/i.png"]);
    expect(payload.audios).toEqual(["https://a/a.wav"]);
    expect(payload.videos).toEqual([
      { url: "https://a/v.mp4", start_seconds: 3, require_audio: true },
    ]);
  });

  it("omits absent media fields (provider rejects disallowed fields per mode)", () => {
    const textPayload = buildAgnesVideoPayload("agnes-video-2.5-flash", {
      prompt: "x",
      mode: "text",
    });
    expect(textPayload.first_frame).toBeUndefined();
    expect(textPayload.last_frame).toBeUndefined();
    expect(textPayload.images).toBeUndefined();
    expect(textPayload.audios).toBeUndefined();
    expect(textPayload.videos).toBeUndefined();
  });

  it("normalizes numeric seconds to the provider string", () => {
    expect(
      buildAgnesVideoPayload("agnes-video-2.5", {
        prompt: "x",
        mode: "text",
        seconds: 6,
      }).seconds,
    ).toBe("6");
    expect(
      buildAgnesVideoPayload("agnes-video-2.5", {
        prompt: "x",
        mode: "text",
        seconds: "12",
      }).seconds,
    ).toBe("12");
  });
});

describe("malformed input hardening (QC regressions)", () => {
  it("returns issues instead of throwing on non-array reference fields", () => {
    const cases: Array<{ bad: AgnesVideoRequestShape; code: string }> = [
      { bad: { referenceImageUrls: "abc" as never }, code: "INVALID_REFERENCE_ENTRY" },
      { bad: { referenceAudioUrls: "abc" as never }, code: "INVALID_REFERENCE_ENTRY" },
      { bad: { referenceVideos: "abc" as never }, code: "INVALID_REFERENCE_VIDEO_ENTRY" },
    ];
    for (const { bad, code } of cases) {
      const result = validateAgnesRequest(REGULAR, {
        prompt: "x",
        ...bad,
      } as AgnesVideoRequestShape);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.map((i) => i.code)).toContain(code);
    }
  });

  it("returns issues instead of throwing on non-array videos on Flash", () => {
    const result = validateAgnesRequest(FLASH, {
      prompt: "x",
      referenceVideos: "abc" as never,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("flags non-string frame fields instead of silently dropping them", () => {
    const result = validateAgnesRequest(FLASH, {
      prompt: "x",
      firstFrameUrl: 123 as never,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("INVALID_FRAME_ENTRY");
  });

  it("rejects NaN and non-integer number seconds instead of emitting NaN/4.5", () => {
    for (const seconds of [Number.NaN, 4.5, Number.POSITIVE_INFINITY]) {
      const result = validateAgnesRequest(FLASH, {
        prompt: "x",
        seconds: seconds as never,
      });
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain("INVALID_SECONDS");
    }
  });

  it("validates requireAudio as a boolean on regular (videos supported)", () => {
    const result = validateAgnesRequest(REGULAR, {
      prompt: "x",
      referenceVideos: [
        { url: "https://a/v.mp4", requireAudio: "yes" as never },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "INVALID_REFERENCE_VIDEO_ENTRY",
    );
  });

  it("buildAgnesVideoPayload never emits empty or garbage optional fields", () => {
    const payload = buildAgnesVideoPayload("agnes-video-2.5", {
      prompt: "x",
      mode: "text",
      seconds: "" as never,
      aspectRatio: "  ",
      size: "",
    });
    expect(payload.seconds).toBeUndefined();
    expect(payload.aspect_ratio).toBeUndefined();
    expect(payload.size).toBeUndefined();
  });
});

describe("round-trip with the CAP-002 registry seeds", () => {
  it("accepts every mode the registry seed declares supported", () => {
    // The registry (CAP-002) declares Flash/regular firstFrame/lastFrame/
    // firstLastFrame/multimodalReferences all true — the validator must agree.
    for (const profile of [FLASH, REGULAR]) {
      expect(profile.references.firstFrame).toBe(true);
      expect(profile.references.lastFrame).toBe(true);
      expect(profile.references.firstLastFrame).toBe(true);
      expect(profile.references.multimodalReferences).toBe(true);
    }
  });

  it("keeps the Flash videos-unsupported fact consistent with the registry notes", () => {
    // CAP-002 seed: "non-empty videos always rejected (HTTP 400)" for Flash.
    const result = validateAgnesRequest(FLASH, {
      prompt: "x",
      mode: "reference",
      referenceImageUrls: ["https://a/i.png"],
      referenceVideos: [{ url: "https://a/v.mp4" }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(
      "REFERENCE_VIDEOS_NOT_SUPPORTED",
    );
  });
});