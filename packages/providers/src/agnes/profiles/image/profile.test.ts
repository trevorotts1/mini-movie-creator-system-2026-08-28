/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_IMAGE_2_1_FLASH_LIMITS,
  AGNES_IMAGE_2_1_FLASH_MODEL,
  AGNES_IMAGE_DEFAULT_TIMEOUT_MS,
  AGNES_IMAGE_FREE_INPUT_IMAGES,
  AGNES_IMAGE_GENERATIONS_URL,
  AGNES_IMAGE_LIST_USD_PER_IMAGE,
  AGNES_IMAGE_RATIOS,
  AGNES_IMAGE_SIZES,
  agnesImageMode,
  buildAgnesImageRequest,
  estimateAgnesImageCost,
  isAgnesImageReferenceUrl,
  validateAgnesImageRequest,
  type AgnesImageInput,
} from "./index.js";

const BASE: AgnesImageInput = { prompt: "locked character face-front master" };

describe("verified per-call limits", () => {
  it("encodes the documented size tiers", () => {
    expect(AGNES_IMAGE_SIZES).toEqual(["1K", "2K", "3K", "4K"]);
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.sizes.status).toBe("VERIFIED");
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.sizes.value).toEqual(AGNES_IMAGE_SIZES);
  });

  it("encodes the documented aspect-ratio list and default", () => {
    expect(AGNES_IMAGE_RATIOS).toEqual([
      "1:1",
      "3:4",
      "4:3",
      "16:9",
      "9:16",
      "2:3",
      "3:2",
      "21:9",
    ]);
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.ratioDefault.value).toBe("1:1");
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.sizeDefault.value).toBe("1K");
  });

  it("keeps the prompt character ceiling UNKNOWN (spec §14)", () => {
    const promptLimit = AGNES_IMAGE_2_1_FLASH_LIMITS.promptHardMaxCharacters;
    expect(promptLimit.status).toBe("UNKNOWN");
    expect(promptLimit.note).toMatch(/2026-08-28/);
  });

  it("keeps reference-image max count UNKNOWN (3-free is pricing, not a cap)", () => {
    const maxImages = AGNES_IMAGE_2_1_FLASH_LIMITS.maxReferenceImages;
    expect(maxImages.status).toBe("UNKNOWN");
    expect(maxImages.note).toMatch(/first-3-free/);
  });

  it("keeps seed, n, and negative prompt UNKNOWN/absent", () => {
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.seed.status).toBe("UNKNOWN");
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.outputImagesPerCall.status).toBe(
      "UNKNOWN",
    );
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.negativePrompt.status).toBe("UNKNOWN");
  });

  it("encodes the 3-free / $0.003-overage input-image billing rule", () => {
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.freeInputImages.value).toBe(3);
    expect(AGNES_IMAGE_FREE_INPUT_IMAGES).toBe(3);
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.listUsdPerExcessInputImage.value).toBe(
      0.003,
    );
  });

  it("encodes the documented list prices per tier", () => {
    expect(AGNES_IMAGE_LIST_USD_PER_IMAGE).toEqual({
      "1K": 0.01,
      "2K": 0.018,
      "3K": 0.021,
      "4K": 0.024,
    });
  });

  it("carries provenance on every VERIFIED limit", () => {
    for (const [key, limit] of Object.entries(
      AGNES_IMAGE_2_1_FLASH_LIMITS,
    )) {
      if (limit.status === "VERIFIED") {
        expect(limit.verifiedOn, key).toBe("2026-08-28");
        expect(limit.source.startsWith("https://wiki.agnes-ai.com/"), key).toBe(
          true,
        );
      } else {
        expect(limit.note.length, key).toBeGreaterThan(0);
      }
    }
  });

  it("targets the documented endpoint and timeout window", () => {
    expect(AGNES_IMAGE_GENERATIONS_URL).toBe(
      "https://apihub.agnes-ai.com/v1/images/generations",
    );
    expect(AGNES_IMAGE_2_1_FLASH_LIMITS.timeoutMsRange.value).toEqual([
      60_000, 360_000,
    ]);
    expect(AGNES_IMAGE_DEFAULT_TIMEOUT_MS).toBe(360_000);
    expect(AGNES_IMAGE_2_1_FLASH_MODEL).toBe("agnes-image-2.1-flash");
  });
});

describe("agnesImageMode", () => {
  it("classifies text-to-image with no images", () => {
    expect(agnesImageMode(undefined)).toBe("text-to-image");
    expect(agnesImageMode([])).toBe("text-to-image");
  });

  it("classifies edit with exactly one image", () => {
    expect(agnesImageMode(["https://a/b.png"])).toBe("edit");
  });

  it("classifies compose with two or more images", () => {
    expect(agnesImageMode(["https://a/b.png", "https://a/c.png"])).toBe(
      "compose",
    );
  });
});

describe("reference-image rules", () => {
  it("accepts public HTTPS and data: URIs only", () => {
    expect(isAgnesImageReferenceUrl("https://storage.example.com/x.png")).toBe(
      true,
    );
    expect(isAgnesImageReferenceUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAgnesImageReferenceUrl("http://storage.example.com/x.png")).toBe(
      false,
    );
    expect(isAgnesImageReferenceUrl("file:///etc/passwd")).toBe(false);
    expect(
      isAgnesImageReferenceUrl(
        "https://login:cookie@private.example.com/x.png",
      ),
    ).toBe(true); // scheme check only; provider fetches and would fail auth
  });
});

describe("validateAgnesImageRequest", () => {
  it("accepts a plain text-to-image request", () => {
    const result = validateAgnesImageRequest(BASE);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("text-to-image");
    expect(result.errors).toEqual([]);
  });

  it("rejects an empty prompt", () => {
    expect(validateAgnesImageRequest({ prompt: "" }).ok).toBe(false);
    expect(
      validateAgnesImageRequest({ prompt: "" }).errors[0]?.field,
    ).toBe("prompt");
  });

  it("rejects unverified size tiers and ratios", () => {
    const result = validateAgnesImageRequest({ ...BASE, size: "8K" as never });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("size");

    const badRatio = validateAgnesImageRequest({
      ...BASE,
      ratio: "4:5" as never,
    });
    expect(badRatio.ok).toBe(false);
    expect(badRatio.errors[0]?.field).toBe("ratio");
  });

  it("rejects non-https/non-data reference URLs", () => {
    const result = validateAgnesImageRequest({
      ...BASE,
      images: ["http://insecure.example.com/ref.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.field).toBe("image[0]");
  });

  it("does NOT enforce any prompt character limit (max UNKNOWN)", () => {
    const huge = "x".repeat(100_000);
    const result = validateAgnesImageRequest({ prompt: huge });
    expect(result.ok).toBe(true);
  });

  it("does NOT enforce a reference-image count limit (max UNKNOWN)", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `https://refs.example.com/r${i}.png`,
    );
    const result = validateAgnesImageRequest({ ...BASE, images: many });
    expect(result.ok).toBe(true);
  });
});

describe("buildAgnesImageRequest", () => {
  it("builds the exact text-to-image wire body", () => {
    const req = buildAgnesImageRequest(BASE);
    expect(req).toEqual({
      model: "agnes-image-2.1-flash",
      prompt: "locked character face-front master",
      size: "1K",
    });
    expect("ratio" in req).toBe(false);
    expect("image" in req).toBe(false);
    expect("extra_body" in req).toBe(false);
  });

  it("defaults size and ratio per docs", () => {
    const req = buildAgnesImageRequest({ ...BASE, ratio: "16:9" });
    expect(req.size).toBe("1K");
    expect(req.ratio).toBe("16:9");
  });

  it("never sends n, seed, or negative_prompt", () => {
    const req = buildAgnesImageRequest({
      ...BASE,
      images: ["https://a/b.png"],
      responseFormat: "b64_json",
    });
    const json = JSON.stringify(req);
    expect(json).not.toContain('"n"');
    expect(json).not.toContain('"seed"');
    expect(json).not.toContain('"negative_prompt"');
  });

  it("nests response_format under extra_body, never top-level (HTTP 400 pitfall)", () => {
    const req = buildAgnesImageRequest({ ...BASE, responseFormat: "b64_json" });
    expect(req.extra_body?.response_format).toBe("b64_json");
    expect("response_format" in req).toBe(false);
  });

  it("sends reference images top-level AND under extra_body", () => {
    const images = ["https://a/b.png", "data:image/png;base64,AAAA"];
    const req = buildAgnesImageRequest({ ...BASE, images });
    expect(req.image).toEqual(images);
    expect(req.extra_body?.image).toEqual(images);
    expect(agnesImageMode(images)).toBe("compose");
  });

  it("omits extra_body when no responseFormat and no images", () => {
    const req = buildAgnesImageRequest({ ...BASE, size: "4K" });
    expect(req.extra_body).toBeUndefined();
    expect(req.size).toBe("4K");
  });
});

describe("estimateAgnesImageCost", () => {
  it("prices one output image at the tier list price", () => {
    const est = estimateAgnesImageCost({ ...BASE, size: "2K" });
    expect(est.listUsdTotal).toBe(0.018);
    expect(est.excessInputImages).toBe(0);
    expect(est.currency).toBe("USD");
  });

  it("charges list-price overage only from the 4th input image", () => {
    const est = estimateAgnesImageCost({
      ...BASE,
      images: [
        "https://a/1.png",
        "https://a/2.png",
        "https://a/3.png",
        "https://a/4.png",
      ],
    });
    expect(est.excessInputImages).toBe(1);
    expect(est.excessInputUsdTotal).toBeCloseTo(0.003, 10);
  });

  it("records UNKNOWN notes instead of guessing unverified values", () => {
    const est = estimateAgnesImageCost({ ...BASE, images: ["https://a/1.png"] });
    expect(est.unknownNotes.join(" ")).toMatch(/UNKNOWN/);
  });
});
