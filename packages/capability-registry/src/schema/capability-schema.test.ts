import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_LEVELS,
  CAPABILITY_KINDS,
  capabilityRegistrySchema,
  confidenceSchema,
  capabilityKindSchema,
  mediaModelCapabilitySchema,
  parseMediaModelCapability,
  safeParseMediaModelCapability,
  unknownConstraintsCapability,
  unknownModesCapability,
  unknownOutputCapability,
  unknownPricingCapability,
  unknownPromptCapability,
  unknownReferencesCapability,
  type MediaModelCapability,
} from "./index.js";

const ISO = "2026-08-28T12:00:00.000Z";

function validVideoProfile(overrides: Partial<MediaModelCapability> = {}): MediaModelCapability {
  return {
    provider: "kie",
    modelId: "seedance-1.5-pro",
    modelFamily: null,
    modelType: null,
    kind: "video",
    lastVerifiedAt: ISO,
    sourceUrls: ["https://docs.example.com/seedance"],
    confidence: "VERIFIED",
    prompt: unknownPromptCapability(),
    references: unknownReferencesCapability(),
    modes: unknownModesCapability(),
    output: unknownOutputCapability(),
    constraints: unknownConstraintsCapability(),
    pricing: unknownPricingCapability(),
    ...overrides,
  };
}

describe("confidence enum", () => {
  it("exposes exactly VERIFIED/PROVISIONAL/UNKNOWN", () => {
    expect([...CONFIDENCE_LEVELS]).toEqual(["VERIFIED", "PROVISIONAL", "UNKNOWN"]);
  });

  it("rejects values outside the enum", () => {
    expect(confidenceSchema.safeParse("GUESSED").success).toBe(false);
    expect(confidenceSchema.safeParse("verified").success).toBe(false);
  });
});

describe("registry kinds", () => {
  it("has separate kinds for reasoning/vision/image/video/voice/storage", () => {
    expect([...CAPABILITY_KINDS]).toEqual([
      "reasoning",
      "vision",
      "image",
      "video",
      "voice",
      "storage",
    ]);
  });

  it("accepts every kind on a profile", () => {
    for (const kind of CAPABILITY_KINDS) {
      expect(capabilityKindSchema.parse(kind)).toBe(kind);
    }
  });

  it("rejects an unknown kind", () => {
    expect(capabilityKindSchema.safeParse("audio").success).toBe(false);
  });
});

describe("mediaModelCapabilitySchema", () => {
  it("accepts a complete VERIFIED video profile", () => {
    const parsed = mediaModelCapabilitySchema.parse(validVideoProfile());
    expect(parsed.provider).toBe("kie");
    expect(parsed.kind).toBe("video");
    expect(parsed.confidence).toBe("VERIFIED");
  });

  it("keeps UNKNOWN confidence valid (never guessed)", () => {
    const parsed = mediaModelCapabilitySchema.parse(
      validVideoProfile({ confidence: "UNKNOWN" }),
    );
    expect(parsed.confidence).toBe("UNKNOWN");
  });

  it("requires all spec fields: provider, modelId, kind, lastVerifiedAt, sourceUrls, confidence", () => {
    const { provider, ...noProvider } = validVideoProfile();
    const { modelId, ...noModelId } = validVideoProfile();
    const { lastVerifiedAt, ...noVerified } = validVideoProfile();
    const { sourceUrls, ...noSources } = validVideoProfile();
    const { confidence, ...noConfidence } = validVideoProfile();
    expect(mediaModelCapabilitySchema.safeParse(noProvider).success).toBe(false);
    expect(mediaModelCapabilitySchema.safeParse(noModelId).success).toBe(false);
    expect(mediaModelCapabilitySchema.safeParse(noVerified).success).toBe(false);
    expect(mediaModelCapabilitySchema.safeParse(noSources).success).toBe(false);
    expect(mediaModelCapabilitySchema.safeParse(noConfidence).success).toBe(false);
  });

  it("rejects a non-ISO lastVerifiedAt", () => {
    const bad = validVideoProfile({ lastVerifiedAt: "August 28 2026" });
    expect(mediaModelCapabilitySchema.safeParse(bad).success).toBe(false);
  });

  it("keeps sourceUrls provenance (non-empty URL strings)", () => {
    const bad = validVideoProfile({ sourceUrls: ["not a url"] });
    expect(mediaModelCapabilitySchema.safeParse(bad).success).toBe(false);
  });

  it("validates prompt block with nullable unknowns", () => {
    const parsed = mediaModelCapabilitySchema.parse(
      validVideoProfile({
        prompt: { hardMaxCharacters: null, recommendedMaxCharacters: null, negativePromptSupported: null },
      }),
    );
    expect(parsed.prompt.hardMaxCharacters).toBeNull();
    const bad = validVideoProfile({
      prompt: { hardMaxCharacters: -1, recommendedMaxCharacters: null, negativePromptSupported: true },
    });
    expect(mediaModelCapabilitySchema.safeParse(bad).success).toBe(false);
  });

  it("validates references block including incompatibleCombinations", () => {
    const refs = {
      ...unknownReferencesCapability(),
      maxImages: 3,
      firstFrame: true,
      lastFrame: true,
      firstLastFrame: true,
      incompatibleCombinations: ["firstFrame+lastFrame", "imageReference+videoReference"],
    };
    const parsed = mediaModelCapabilitySchema.parse(validVideoProfile({ references: refs }));
    expect(parsed.references.incompatibleCombinations).toEqual([
      "firstFrame+lastFrame",
      "imageReference+videoReference",
    ]);
  });

  it("allows incompatibleCombinations null = UNKNOWN (never an empty guess)", () => {
    const parsed = mediaModelCapabilitySchema.parse(validVideoProfile());
    expect(parsed.references.incompatibleCombinations).toBeNull();
  });

  it("validates modes block", () => {
    const parsed = mediaModelCapabilitySchema.parse(
      validVideoProfile({
        modes: {
          textToImage: null,
          imageToImage: null,
          textToVideo: true,
          imageToVideo: true,
          firstFrameToVideo: true,
          firstLastFrameToVideo: true,
          multimodalReferenceToVideo: false,
          referenceVideoSupported: null,
        },
      }),
    );
    expect(parsed.modes.textToVideo).toBe(true);
    expect(parsed.modes.multimodalReferenceToVideo).toBe(false);
  });

  it("validates output block: durations, resolutions, aspectRatios", () => {
    const parsed = mediaModelCapabilitySchema.parse(
      validVideoProfile({
        output: {
          minDurationSeconds: 3,
          maxDurationSeconds: 12,
          durationsSeconds: [5, 10],
          resolutions: ["1080x1920", "720x1280"],
          aspectRatios: ["9:16"],
          audioGenerationSupported: true,
        },
      }),
    );
    expect(parsed.output.maxDurationSeconds).toBe(12);
    const bad = validVideoProfile({
      output: { ...unknownOutputCapability(), maxDurationSeconds: 0 },
    });
    expect(mediaModelCapabilitySchema.safeParse(bad).success).toBe(false);
  });

  it("validates pricing block with currency and null unit/amount allowed", () => {
    const parsed = mediaModelCapabilitySchema.parse(
      validVideoProfile({
        pricing: { unit: "per_video_second", amount: 0.04, currency: "USD", quota: null, overage: null },
      }),
    );
    expect(parsed.pricing.amount).toBe(0.04);
    expect(parsed.pricing.currency).toBe("USD");
    const bad = validVideoProfile({
      pricing: { unit: null, amount: null, currency: "DOLLAR", quota: null, overage: null },
    });
    expect(mediaModelCapabilitySchema.safeParse(bad).success).toBe(false);
  });
});

describe("registry snapshot", () => {
  it("groups entries per kind in a versioned registry", () => {
    const registry = capabilityRegistrySchema.parse({
      version: 1,
      kind: "video",
      updatedAt: ISO,
      entries: [validVideoProfile()],
    });
    expect(registry.kind).toBe("video");
    expect(registry.entries).toHaveLength(1);
  });

  it("rejects a registry with invalid version/kind/entries", () => {
    expect(
      capabilityRegistrySchema.safeParse({
        version: 0,
        kind: "video",
        updatedAt: ISO,
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      capabilityRegistrySchema.safeParse({
        version: 1,
        kind: "podcast",
        updatedAt: ISO,
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      capabilityRegistrySchema.safeParse({
        version: 1,
        kind: "video",
        updatedAt: ISO,
        entries: [{ provider: "x" }],
      }).success,
    ).toBe(false);
  });
});

describe("unknown constructors", () => {
  it("produce all-null numeric/boolean-unknown blocks so nothing is invented", () => {
    expect(unknownPromptCapability()).toEqual({
      hardMaxCharacters: null,
      recommendedMaxCharacters: null,
      negativePromptSupported: null,
    });
    expect(unknownReferencesCapability().maxImages).toBeNull();
    expect(unknownReferencesCapability().incompatibleCombinations).toBeNull();
    expect(unknownModesCapability().textToVideo).toBeNull();
    expect(unknownOutputCapability().resolutions).toBeNull();
    expect(unknownConstraintsCapability().mutuallyExclusiveInputs).toBeNull();
    expect(unknownPricingCapability().amount).toBeNull();
  });

  it("round-trip through the schema", () => {
    const profile = validVideoProfile();
    expect(parseMediaModelCapability(profile)).toEqual(profile);
  });
});

describe("parse helpers", () => {
  it("parseMediaModelCapability throws on invalid input", () => {
    expect(() => parseMediaModelCapability({ provider: "x" })).toThrow();
  });

  it("safeParseMediaModelCapability returns null on invalid input", () => {
    expect(safeParseMediaModelCapability({ provider: "x" })).toBeNull();
    expect(safeParseMediaModelCapability(validVideoProfile())).not.toBeNull();
  });
});