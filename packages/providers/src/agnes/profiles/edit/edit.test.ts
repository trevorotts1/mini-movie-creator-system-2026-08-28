/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_IMAGE_EDIT_CAPABILITY,
  AGNES_IMAGE_GENERATIONS_URL,
  AGNES_IMAGE_MODEL,
  AGNES_IMAGE_OUTPUT_CONSTRAINTS,
  assertMaskedEditSupported,
  buildAgnesImageComposeRequest,
  classifyAgnesImageEdit,
  isAgnesImageModeSupported,
  normalizeAgnesImageResponse,
  validateComposeInputCount,
  validateComposeOutputConstraints,
  type AgnesImageComposeInput,
} from "./index.js";

const BASE: AgnesImageComposeInput = {
  prompt: "Combine Mona and the city into one neon poster",
  images: [{ url: "https://cdn.example/character_monica_face_front.png" }],
  size: "2K",
};

describe("AGN-003 capability gate — live API verdict (2026-08-28)", () => {
  it("records multi-image compose as SUPPORTED", () => {
    expect(AGNES_IMAGE_EDIT_CAPABILITY.compose.supported).toBe(true);
    expect(isAgnesImageModeSupported("compose")).toBe(true);
  });

  it("records masked edit as NOT SUPPORTED (no mask param, no /edits endpoint)", () => {
    expect(AGNES_IMAGE_EDIT_CAPABILITY.maskedEdit.supported).toBe(false);
    expect(isAgnesImageModeSupported("masked-edit")).toBe(false);
  });

  it("assertMaskedEditSupported fails with MASKED_EDIT_UNSUPPORTED before any HTTP call", () => {
    const result = assertMaskedEditSupported();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MASKED_EDIT_UNSUPPORTED");
      expect(result.error.message).toContain("does not expose a mask parameter");
    }
  });

  it("classifies a mask-carrying request as unsupported masked edit", () => {
    const result = classifyAgnesImageEdit({
      prompt: "fill the hole",
      images: [{ url: "https://a.png" }],
      mask: { url: "https://m.png" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MASKED_EDIT_UNSUPPORTED");
    }
  });

  it("classifies a bare images request as compose", () => {
    expect(classifyAgnesImageEdit(BASE)).toEqual({ ok: true, value: { mode: "compose" } });
  });

  it("carries the evidence pointer (source URL + verified date)", () => {
    expect(AGNES_IMAGE_EDIT_CAPABILITY.sourceUrl).toMatch(
      /^https:\/\/wiki\.agnes-ai\.com\/en\/docs\/agnes-image-21-flash$/,
    );
    expect(AGNES_IMAGE_EDIT_CAPABILITY.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildAgnesImageComposeRequest — wire shape per doc table", () => {
  it("emits model/prompt/size and extra_body.image[]", () => {
    const result = buildAgnesImageComposeRequest(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe(AGNES_IMAGE_MODEL);
      expect(result.value.prompt).toBe(BASE.prompt);
      expect(result.value.size).toBe("2K");
      expect(result.value.extra_body.image).toEqual([
        "https://cdn.example/character_monica_face_front.png",
      ]);
      expect(result.value.ratio).toBeUndefined();
    }
  });

  it("maps every input image, preserving order", () => {
    const result = buildAgnesImageComposeRequest({
      ...BASE,
      images: [
        { url: "data:image/png;base64,AAAA" },
        { url: "https://cdn.example/background.png" },
        { url: "https://cdn.example/lighting.png" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extra_body.image).toEqual([
        "data:image/png;base64,AAAA",
        "https://cdn.example/background.png",
        "https://cdn.example/lighting.png",
      ]);
    }
  });

  it("propagates ratio when provided", () => {
    const result = buildAgnesImageComposeRequest({ ...BASE, ratio: "16:9" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ratio).toBe("16:9");
    }
  });

  it("rejects an empty image list (doc: array required for compose)", () => {
    const result = buildAgnesImageComposeRequest({ ...BASE, images: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("rejects a missing, empty or whitespace-only prompt (doc: prompt REQUIRED)", () => {
    for (const prompt of ["", "   ", "\n\t"]) {
      const result = buildAgnesImageComposeRequest({ ...BASE, prompt });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_REQUEST");
        expect(result.error.message).toContain("non-empty prompt");
      }
    }
  });

  it("rejects a non-https or non-data image URL before any HTTP call", () => {
    const result = buildAgnesImageComposeRequest({
      ...BASE,
      images: [{ url: "http://insecure.example.com/ref.png" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
      expect(result.error.message).toContain("image[0]");
    }
  });

  it("accepts public https and data: URIs as input images", () => {
    const result = buildAgnesImageComposeRequest({
      ...BASE,
      images: [
        { url: "https://cdn.example/a.png" },
        { url: "data:image/png;base64,AAAA" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("does NOT invent a max image count the doc never states (UNKNOWN policy)", () => {
    expect(validateComposeInputCount(Array.from({ length: 12 }, () => ({}))).ok).toBe(true);
  });

  it("points the compose body at POST /v1/images/generations", () => {
    expect(AGNES_IMAGE_GENERATIONS_URL).toContain("/v1/images/generations");
  });
});

describe("registry records the AGN-003 mode verdict (acceptance: unsupported recorded)", () => {
  it("capability record + doc-stated output constraints are pinned and frozen", () => {
    // Mode verdict (the acceptance: unsupported modes recorded, not assumed).
    expect(AGNES_IMAGE_EDIT_CAPABILITY.compose.supported).toBe(true);
    expect(AGNES_IMAGE_EDIT_CAPABILITY.maskedEdit.supported).toBe(false);
    expect(Object.isFrozen(AGNES_IMAGE_EDIT_CAPABILITY)).toBe(true);
    // Output constraints mirror the doc's parameter table.
    expect([...AGNES_IMAGE_OUTPUT_CONSTRAINTS.sizes]).toEqual([
      "1K",
      "2K",
      "3K",
      "4K",
    ]);
    expect(AGNES_IMAGE_OUTPUT_CONSTRAINTS.defaultRatio).toBe("1:1");
    expect(AGNES_IMAGE_OUTPUT_CONSTRAINTS.editPreservesComposition).toBe(true);
  });
});

describe("validateComposeOutputConstraints — doc-stated tiers/ratios", () => {
  it("accepts every documented size tier", () => {
    for (const size of ["1K", "2K", "3K", "4K"]) {
      expect(validateComposeOutputConstraints(size).ok).toBe(true);
    }
  });

  it("accepts every documented ratio and an omitted ratio", () => {
    for (const ratio of [
      "1:1",
      "3:4",
      "4:3",
      "16:9",
      "9:16",
      "2:3",
      "3:2",
      "21:9",
    ]) {
      expect(validateComposeOutputConstraints("2K", ratio).ok).toBe(true);
    }
    expect(validateComposeOutputConstraints("4K").ok).toBe(true);
  });

  it("rejects an undocumented size before any HTTP call", () => {
    const result = validateComposeOutputConstraints("8K");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
      expect(result.error.message).toContain("8K");
      expect(result.error.message).toContain("1K, 2K, 3K, 4K");
    }
  });

  it("rejects an undocumented ratio before any HTTP call", () => {
    const result = validateComposeOutputConstraints("2K", "5:4");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
      expect(result.error.message).toContain("5:4");
    }
  });

  it("rejects an undocumented size+ratio compose request through the builder", () => {
    const result = buildAgnesImageComposeRequest({
      ...BASE,
      size: "5K" as never,
      ratio: "11:8" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("rejects an invalid mode as unsupported (fail-closed default)", () => {
    expect(isAgnesImageModeSupported("not-a-mode" as never)).toBe(false);
  });
});

describe("normalizeAgnesImageResponse", () => {
  it("extracts url from the default response format", () => {
    const result = normalizeAgnesImageResponse({
      data: [{ url: "https://cdn.example/out_1.png" }],
    });
    expect(result).toEqual({
      ok: true,
      value: { url: "https://cdn.example/out_1.png", b64Json: undefined },
    });
  });

  it("extracts b64_json when the caller asked for base64 output", () => {
    const result = normalizeAgnesImageResponse({
      data: [{ b64_json: "iVBORw0KGgo=" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBeUndefined();
      expect(result.value.b64Json).toBe("iVBORw0KGgo=");
    }
  });

  it("surfaces a provider error payload instead of a silent undefined", () => {
    const result = normalizeAgnesImageResponse({
      error: { message: "ratio must be one of ...", code: "invalid" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HTTP_ERROR");
      expect(result.error.message).toContain("ratio must be one of");
    }
  });

  it("errors when data[] is empty or has neither url nor b64_json", () => {
    expect(normalizeAgnesImageResponse({ data: [] }).ok).toBe(false);
    expect(normalizeAgnesImageResponse({ data: [{}] }).ok).toBe(false);
  });
});
