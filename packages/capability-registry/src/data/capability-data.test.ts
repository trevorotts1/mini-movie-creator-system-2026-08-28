/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  ALL_PROFILES,
  AGNES_IMAGE_2_1_FLASH,
  AGNES_VIDEO_2_5,
  AGNES_VIDEO_2_5_FLASH,
  DATA_VERIFIED_ON,
  DEEPSEEK_V4_FLASH_VISION_EXP,
  FISH_S1,
  FISH_S2_PRO,
  FISH_S2_1_PRO,
  FISH_S2_1_PRO_FREE,
  FISH_VOICE_PROFILES,
  GLM_5_3_FLASH,
  GEMINI_3_7_FLASH,
  KIE_MEDIA_PROFILES,
  KIE_SEEDANCE_2_MINI,
  KIE_WAN_3_0_VIDEO,
  KIE_WAN_3_0_VIDEO_PRIME,
  MEDIA_PROFILES,
  QWEN_3_8_FLASH,
  REASONING_PROFILES,
  VOICE_PROFILES,
  getProfile,
  type CapabilitySeed,
  type MediaModelCapabilitySeed,
  type ReasoningModelCapabilitySeed,
  type VoiceModelCapabilitySeed,
} from "./index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_PATTERN = /^https?:\/\//;

/** Every profile the acceptance criteria require to exist. */
const REQUIRED_MODEL_IDS = [
  "agnes-video-2.5-flash",
  "agnes-video-2.5",
  "agnes-image-2.1-flash",
  "bytedance/seedance-2-mini",
  "wan/3-0-video",
  "wan/3-0-video-prime",
  "s2.1-pro",
  "s2.1-pro-free",
  "s2-pro",
  "s1",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "qwen/qwen3.8-flash",
  "google/gemini-3.7-flash",
] as const;

function isMedia(p: CapabilitySeed): p is MediaModelCapabilitySeed {
  return p.kind === "image" || p.kind === "video";
}
function isVoice(p: CapabilitySeed): p is VoiceModelCapabilitySeed {
  return p.kind === "voice";
}
function isReasoning(p: CapabilitySeed): p is ReasoningModelCapabilitySeed {
  return p.kind === "reasoning";
}

describe("required seed coverage", () => {
  it("seeds every model the acceptance criteria name", () => {
    for (const id of REQUIRED_MODEL_IDS) {
      expect(ALL_PROFILES[id], `missing profile: ${id}`).toBeTruthy();
    }
  });

  it("keeps lookup consistent with the aggregated maps", () => {
    expect(Object.keys(MEDIA_PROFILES).sort()).toEqual(
      [...Object.keys(AGNES_MEDIA_KEYS()).concat(Object.keys(KIE_MEDIA_PROFILES))].sort(),
    );
    expect(getProfile("wan/3-0-video")).toBe(KIE_WAN_3_0_VIDEO);
    expect(getProfile("s2.1-pro")).toBe(FISH_S2_1_PRO);
    expect(getProfile("qwen/qwen3.8-flash")).toBe(QWEN_3_8_FLASH);
    expect(getProfile("not-a-model")).toBeUndefined();
  });

  function AGNES_MEDIA_KEYS(): Record<string, unknown> {
    return {
      "agnes-video-2.5-flash": AGNES_VIDEO_2_5_FLASH,
      "agnes-video-2.5": AGNES_VIDEO_2_5,
      "agnes-image-2.1-flash": AGNES_IMAGE_2_1_FLASH,
    };
  }
});

describe("provenance triple — every value carries source/date/confidence", () => {
  const all = Object.values(ALL_PROFILES);

  it("every profile has an ISO lastVerifiedAt matching the verify date", () => {
    for (const p of all) {
      expect(ISO_DATE.test(p.lastVerifiedAt), p.modelId).toBe(true);
      expect(p.lastVerifiedAt, p.modelId).toBe(DATA_VERIFIED_ON);
    }
  });

  it("every profile has at least one live source URL per profile", () => {
    for (const p of all) {
      expect(p.sourceUrls.length, p.modelId).toBeGreaterThan(0);
      for (const url of p.sourceUrls) {
        expect(URL_PATTERN.test(url), `${p.modelId}: ${url}`).toBe(true);
      }
    }
  });

  it("confidence is one of the three allowed values", () => {
    for (const p of all) {
      expect(["VERIFIED", "PROVISIONAL", "UNKNOWN"]).toContain(p.confidence);
    }
  });

  it("provider-doc-verifiable media profiles are VERIFIED", () => {
    for (const p of Object.values(MEDIA_PROFILES)) {
      expect(p.confidence, p.modelId).toBe("VERIFIED");
    }
  });

  it("voice profiles are VERIFIED from official Fish docs", () => {
    for (const p of Object.values(VOICE_PROFILES)) {
      expect(p.confidence, p.modelId).toBe("VERIFIED");
    }
  });

  it("reasoning profiles are PROVISIONAL (router catalog, not vendor docs)", () => {
    for (const p of Object.values(REASONING_PROFILES)) {
      expect(p.confidence, p.modelId).toBe("PROVISIONAL");
    }
  });
});

describe("UNKNOWN preservation — undocumented values stay null", () => {
  it("Agnes hard prompt ceiling is UNKNOWN on both video profiles", () => {
    expect(AGNES_VIDEO_2_5_FLASH.prompt.hardMaxCharacters).toBeNull();
    expect(AGNES_VIDEO_2_5.prompt.hardMaxCharacters).toBeNull();
    expect(AGNES_VIDEO_2_5_FLASH.prompt.recommendedMaxCharacters).toBeNull();
    expect(AGNES_VIDEO_2_5.prompt.recommendedMaxCharacters).toBeNull();
  });

  it("Agnes UNKNOWN is documented with a why note", () => {
    for (const p of [AGNES_VIDEO_2_5_FLASH, AGNES_VIDEO_2_5]) {
      const note = p.notes.promptHardMax ?? "";
      expect(note.toLowerCase()).toContain("unknown");
      expect(note.length).toBeGreaterThan(20);
    }
  });

  it("Agnes never inherits another model's 20,000 limit", () => {
    // The Kie models document 20000; Agnes must NOT copy it.
    expect(KIE_WAN_3_0_VIDEO.prompt.hardMaxCharacters).toBe(20_000);
    expect(KIE_SEEDANCE_2_MINI.prompt.hardMaxCharacters).toBe(20_000);
    expect(AGNES_VIDEO_2_5.prompt.hardMaxCharacters).not.toBe(20_000);
    expect(AGNES_VIDEO_2_5.prompt.hardMaxCharacters).toBeNull();
  });

  it("Fish character limit is UNKNOWN (not stated in TTSRequest schema)", () => {
    for (const p of Object.values(VOICE_PROFILES)) {
      expect(p.hardMaxCharacters, p.modelId).toBeNull();
    }
  });

  it("regular Agnes 2.5 reference counts stay null where unstated", () => {
    expect(AGNES_VIDEO_2_5.references.maxImages).toBeNull();
    expect(AGNES_VIDEO_2_5.references.maxVideos).toBeNull();
    expect(AGNES_VIDEO_2_5.references.maxAudio).toBeNull();
  });
});

describe("Agnes Video 2.5 Flash — verified Flash-specific limits", () => {
  it("720P is the only supported resolution", () => {
    expect(AGNES_VIDEO_2_5_FLASH.output.resolutions).toEqual(["720P"]);
    expect(AGNES_VIDEO_2_5.output.resolutions).toEqual(["720P", "960P", "2K"]);
  });

  it("reference images max 5; reference video unsupported", () => {
    expect(AGNES_VIDEO_2_5_FLASH.references.maxImages).toBe(5);
    const notes = JSON.stringify(AGNES_VIDEO_2_5_FLASH.notes);
    expect(notes).toContain("videos is not supported");
  });

  it("durations 4-12 seconds on both 2.5 variants", () => {
    expect(AGNES_VIDEO_2_5_FLASH.output.minDurationSeconds).toBe(4);
    expect(AGNES_VIDEO_2_5_FLASH.output.maxDurationSeconds).toBe(12);
    expect(AGNES_VIDEO_2_5.output.minDurationSeconds).toBe(4);
    expect(AGNES_VIDEO_2_5.output.maxDurationSeconds).toBe(12);
  });

  it("first/last-frame keyframe control supported on both", () => {
    expect(AGNES_VIDEO_2_5_FLASH.references.firstFrame).toBe(true);
    expect(AGNES_VIDEO_2_5_FLASH.references.lastFrame).toBe(true);
    expect(AGNES_VIDEO_2_5_FLASH.references.firstLastFrame).toBe(true);
    expect(AGNES_VIDEO_2_5.references.firstLastFrame).toBe(true);
  });
});

describe("Kie profiles — schema-verified values", () => {
  it("Seedance 2.0 Mini: prompt 3-20000, refs 9/3/3, 4-15s, 480p/720p", () => {
    expect(KIE_SEEDANCE_2_MINI.prompt.hardMaxCharacters).toBe(20_000);
    expect(KIE_SEEDANCE_2_MINI.references.maxImages).toBe(9);
    expect(KIE_SEEDANCE_2_MINI.references.maxVideos).toBe(3);
    expect(KIE_SEEDANCE_2_MINI.references.maxAudio).toBe(3);
    expect(KIE_SEEDANCE_2_MINI.output.minDurationSeconds).toBe(4);
    expect(KIE_SEEDANCE_2_MINI.output.maxDurationSeconds).toBe(15);
    expect(KIE_SEEDANCE_2_MINI.output.resolutions).toEqual(["480p", "720p"]);
    expect(KIE_SEEDANCE_2_MINI.output.aspectRatios).toContain("16:9");
    expect(KIE_SEEDANCE_2_MINI.output.aspectRatios).toContain("9:16");
    expect(KIE_SEEDANCE_2_MINI.output.aspectRatios).toContain("adaptive");
  });

  it("Seedance mode exclusivity is recorded", () => {
    expect(KIE_SEEDANCE_2_MINI.references.incompatibleCombinations.join(" ")).toContain(
      "mutually exclusive",
    );
    expect(KIE_SEEDANCE_2_MINI.references.multimodalReferences).toBe(true);
  });

  it("Wan 3.0: prompt 20000, refs 10/5/5, 2-30s, 480P/720P/1080P", () => {
    expect(KIE_WAN_3_0_VIDEO.prompt.hardMaxCharacters).toBe(20_000);
    expect(KIE_WAN_3_0_VIDEO.references.maxImages).toBe(10);
    expect(KIE_WAN_3_0_VIDEO.references.maxVideos).toBe(5);
    expect(KIE_WAN_3_0_VIDEO.references.maxAudio).toBe(5);
    expect(KIE_WAN_3_0_VIDEO.output.minDurationSeconds).toBe(2);
    expect(KIE_WAN_3_0_VIDEO.output.maxDurationSeconds).toBe(30);
    expect(KIE_WAN_3_0_VIDEO.output.resolutions).toEqual(["480P", "720P", "1080P"]);
  });

  it("Wan 3.0 pricing matches the live kie.ai rates", () => {
    expect(KIE_WAN_3_0_VIDEO.pricingDetail?.["480P"]).toBe(0.04);
    expect(KIE_WAN_3_0_VIDEO.pricingDetail?.["720P"]).toBe(0.08);
    expect(KIE_WAN_3_0_VIDEO.pricingDetail?.["1080P"]).toBe(0.16);
    expect(KIE_WAN_3_0_VIDEO_PRIME.pricingDetail?.["1080P"]).toBe(0.252);
  });

  it("Seedance pricing matches the live kie.ai rates", () => {
    expect(KIE_SEEDANCE_2_MINI.pricingDetail?.["720p-with-video-input"]).toBe(0.025);
    expect(KIE_SEEDANCE_2_MINI.pricingDetail?.["720p-no-video-input"]).toBe(0.041);
  });
});

describe("Fish S2.1 family — verified model enum and pricing", () => {
  it("seeds exactly the four models in the API enum", () => {
    expect(Object.keys(VOICE_PROFILES).sort()).toEqual(
      ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free"].sort(),
    );
  });

  it("s2.1 pricing is $15/M UTF-8 bytes, free variant $0", () => {
    expect(FISH_S2_1_PRO.pricing.amount).toBe(15.0);
    expect(FISH_S2_1_PRO.pricing.unit).toBe("usd-per-million-utf8-bytes");
    expect(FISH_S2_1_PRO_FREE.pricing.amount).toBe(0);
    expect(FISH_S2_1_PRO_FREE.freeTier).toBe(true);
    expect(FISH_S2_1_PRO.freeTier).toBe(false);
  });

  it("word timestamps documented via the with-timestamp endpoint", () => {
    expect(FISH_S2_1_PRO.wordTimestamps).toBe(true);
    expect(FISH_S2_1_PRO.sourceUrls.join(" ")).toContain("with-timestamps");
  });

  it("language counts match the docs (83 / 80+ → null / 13)", () => {
    expect(FISH_S2_1_PRO.languages).toBe(83);
    expect(FISH_S2_PRO.languages).toBeNull(); // "80+" is not a count
    expect(FISH_S1.languages).toBe(13);
  });

  it("free-tier dependence is flagged, not assumed", () => {
    expect(FISH_S2_1_PRO_FREE.notes.freeTier).toContain("Do not architect around it staying free");
  });
});

describe("reasoning/vision registry — runbook §28 presets", () => {
  it("all four presets present with OpenRouter slugs", () => {
    expect(GLM_5_3_FLASH.modelId).toBe("z-ai/glm-5.3-flash");
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.modelId).toBe(
      "deepseek/deepseek-v4-flash-vision-exp",
    );
    expect(QWEN_3_8_FLASH.modelId).toBe("qwen/qwen3.8-flash");
    expect(GEMINI_3_7_FLASH.modelId).toBe("google/gemini-3.7-flash");
  });

  it("MAX_REASONING mapping is per-model data, never a shared constant", () => {
    // literal "max" accepted:
    expect(GLM_5_3_FLASH.maxReasoningEffort).toBe("max");
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.maxReasoningEffort).toBe("max");
    // no literal "max" — highest supported effort is "high":
    expect(GEMINI_3_7_FLASH.maxReasoningEffort).toBe("high");
    expect(GEMINI_3_7_FLASH.supportedEfforts).toEqual(["high", "medium", "low"]);
    // no effort ladder published → unmappable here:
    expect(QWEN_3_8_FLASH.supportedEfforts).toBeNull();
    expect(QWEN_3_8_FLASH.maxReasoningEffort).toBeNull();
    expect(QWEN_3_8_FLASH.reasoningEffort).toBe(false);
  });

  it("vision/video input flags decide frame-extraction routing", () => {
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.vision).toBe(true);
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.videoInput).toBe(false);
    expect(GLM_5_3_FLASH.videoInput).toBe(true);
    expect(GEMINI_3_7_FLASH.videoInput).toBe(true);
  });

  it("context and pricing recorded from the router catalog", () => {
    expect(GLM_5_3_FLASH.contextTokens).toBe(1_310_720);
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.contextTokens).toBe(1_048_576);
    expect(QWEN_3_8_FLASH.contextTokens).toBe(1_000_000);
    expect(GEMINI_3_7_FLASH.contextTokens).toBe(1_048_576);
    expect(GEMINI_3_7_FLASH.pricing.usdPerMillionInput).toBeCloseTo(0.375, 6);
    expect(DEEPSEEK_V4_FLASH_VISION_EXP.pricing.usdPerMillionInput).toBeCloseTo(0.22, 6);
  });
});

describe("data hygiene", () => {
  it("model ids are unique across the registry", () => {
    const ids = Object.keys(ALL_PROFILES);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every null numeric field carries an explanatory note", () => {
    for (const p of Object.values(ALL_PROFILES)) {
      if (isMedia(p)) {
        if (p.prompt.hardMaxCharacters === null) {
          expect(p.notes.promptHardMax ?? "", p.modelId).toBeTruthy();
        }
        if (p.references.maxImages === null) {
          expect(JSON.stringify(p.notes).toLowerCase(), p.modelId).toContain("max");
        }
      }
      if (isVoice(p) && p.hardMaxCharacters === null) {
        expect(p.notes.promptHardMax ?? "", p.modelId).toBeTruthy();
      }
    }
  });

  it("pricing blocks always name a currency", () => {
    for (const p of Object.values(ALL_PROFILES)) {
      expect(p.pricing.currency, p.modelId).toBe("USD");
    }
  });
});