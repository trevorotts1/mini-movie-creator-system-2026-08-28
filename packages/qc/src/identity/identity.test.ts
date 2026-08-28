/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  IDENTITY_ATTRIBUTE_KEYS,
  IDENTITY_QC_SLOT,
  MockVisionModel,
  VisionResponseError,
  buildIdentityPrompt,
  checkIdentity,
  cleanFrame,
  doctoredFrame,
  imageQcSelection,
  monicaCanonicalAsset,
  monicaReferenceImage,
  parseVisionComparison,
  toExtractedFrame,
} from "./index";

describe("checkIdentity — registry-selected vision model (spec §14)", () => {
  it("sends the canonical identity asset and extracted frame to the imageQc model", async () => {
    const model = new MockVisionModel(imageQcSelection().modelId, [
      { verdict: "match", confidence: 0.97 },
    ]);
    const result = await checkIdentity({
      identityAsset: monicaCanonicalAsset(),
      reference: monicaReferenceImage(),
      frame: cleanFrame(),
      model,
      selection: imageQcSelection(),
    });

    expect(result.verdict).toBe("pass");
    expect(result.failed).toBe(false);
    expect(result.modelId).toBe("deepseek/deepseek-v4-flash-vision-exp");
    expect(result.selection.slot).toBe(IDENTITY_QC_SLOT);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.reference.source).toBe(monicaReferenceImage().source);
    expect(model.calls[0]?.candidate.data).toBe(cleanFrame().image.data);
  });

  it("names the registry-selected model in the result provenance", async () => {
    const model = new MockVisionModel("z-ai/glm-5.3-flash", [
      { verdict: "match", confidence: 0.9 },
    ]);
    const result = await checkIdentity({
      identityAsset: monicaCanonicalAsset(),
      reference: monicaReferenceImage(),
      frame: cleanFrame(),
      model,
      selection: { ...imageQcSelection(), modelId: "z-ai/glm-5.3-flash" },
    });
    expect(result.modelId).toBe("z-ai/glm-5.3-flash");
  });

  it("rejects a selection from any slot other than imageQc", async () => {
    const model = new MockVisionModel(imageQcSelection().modelId, [
      { verdict: "match", confidence: 0.9 },
    ]);
    await expect(
      checkIdentity({
        identityAsset: monicaCanonicalAsset(),
        reference: monicaReferenceImage(),
        frame: cleanFrame(),
        model,
        selection: { ...imageQcSelection(), slot: "videoQc" as never },
      }),
    ).rejects.toThrow(/imageQc/);
  });

  it("rejects an identity asset without durable GHL linkage (spec §9)", async () => {
    const asset = monicaCanonicalAsset();
    const model = new MockVisionModel(imageQcSelection().modelId, [
      { verdict: "match", confidence: 0.9 },
    ]);
    await expect(
      checkIdentity({
        identityAsset: { ...asset, ghlUrl: null },
        reference: monicaReferenceImage(),
        frame: cleanFrame(),
        model,
        selection: imageQcSelection(),
      }),
    ).rejects.toThrow(/ghlUrl/);
  });
});

describe("checkIdentity — doctored fixture mismatch verdict (acceptance)", () => {
  it("fails QC on a doctored frame with a different character", async () => {
    const model = new MockVisionModel(imageQcSelection().modelId, [
      {
        verdict: "mismatch",
        confidence: 0.93,
        rationale: "Frame subject has different facial structure and hair.",
        attributes: [
          { key: "facialStructure", match: false, note: "jawline differs" },
          { key: "hair", match: false, note: "braids absent" },
          { key: "skinTone", match: true, note: null },
        ],
      },
    ]);
    const result = await checkIdentity({
      identityAsset: monicaCanonicalAsset(),
      reference: monicaReferenceImage(),
      frame: doctoredFrame(),
      model,
      selection: imageQcSelection(),
    });

    expect(result.verdict).toBe("fail");
    expect(result.failed).toBe(true);
    expect(result.check).toBe("character-identity");
    expect(result.shotId).toBe("SHOT_S01E03_SC04_SH07");
    expect(result.mismatchedAttributes.sort()).toEqual([
      "facialStructure",
      "hair",
    ]);
    expect(result.reason).toBe("identity mismatch: facialStructure, hair");
    expect(result.identityAssetRef.assetId).toBe("IDENT_ASSET_MONICA_V1_001");
    expect(result.identityAssetRef.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(result.identityAssetRef.ghlUrl).toBe(monicaCanonicalAsset().ghlUrl);
  });

  it("uncertain verdicts fail QC — never a silent pass (spec §20)", async () => {
    const model = new MockVisionModel(imageQcSelection().modelId, [
      {
        verdict: "uncertain",
        confidence: 0.4,
        rationale: "Frame heavily motion-blurred.",
      },
    ]);
    const result = await checkIdentity({
      identityAsset: monicaCanonicalAsset(),
      reference: monicaReferenceImage(),
      frame: cleanFrame(),
      model,
      selection: imageQcSelection(),
    });
    expect(result.verdict).toBe("uncertain");
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("uncertain");
  });

  it("reports per-attribute mismatched keys from model attributes", async () => {
    const model = new MockVisionModel(imageQcSelection().modelId, [
      {
        verdict: "mismatch",
        confidence: 0.8,
        attributes: IDENTITY_ATTRIBUTE_KEYS.map((key) => ({
          key,
          match: false,
          note: null,
        })),
      },
    ]);
    const result = await checkIdentity({
      identityAsset: monicaCanonicalAsset(),
      reference: monicaReferenceImage(),
      frame: doctoredFrame(),
      model,
      selection: imageQcSelection(),
    });
    expect(result.mismatchedAttributes).toHaveLength(IDENTITY_ATTRIBUTE_KEYS.length);
  });
});

describe("buildIdentityPrompt", () => {
  it("embeds the canonical identity linkage and asks for JSON verdicts", () => {
    const asset = monicaCanonicalAsset();
    const frame = cleanFrame();
    const prompt = buildIdentityPrompt(asset, frame);
    expect(prompt).toContain(asset.assetId);
    expect(prompt).toContain(asset.characterId);
    expect(prompt).toContain(asset.identityVersion);
    expect(prompt).toContain(frame.shotId);
    expect(prompt).toContain("facialStructure");
    expect(prompt).toContain('"mismatch"');
    expect(prompt).toContain('"uncertain"');
  });
});

describe("parseVisionComparison — real-adapter string responses", () => {
  it("parses a JSON string response (real adapter shape)", () => {
    const raw = JSON.stringify({
      verdict: "match",
      confidence: 0.9,
      rationale: "same character",
      attributes: [{ key: "hair", match: true, note: null }],
    });
    const comparison = parseVisionComparison(raw);
    expect(comparison.verdict).toBe("match");
    expect(comparison.attributes[0]?.key).toBe("hair");
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const raw =
      'Sure. {"verdict":"mismatch","confidence":0.75,"rationale":"different face","attributes":[]} — done.';
    const comparison = parseVisionComparison(raw);
    expect(comparison.verdict).toBe("mismatch");
  });

  it("extracts the JSON object when surrounding prose contains braces", () => {
    const raw =
      'Result {step one} then {"verdict":"uncertain","confidence":0.3,"rationale":"occluded","attributes":[]}';
    const comparison = parseVisionComparison(raw);
    expect(comparison.verdict).toBe("uncertain");
  });

  it("braces inside JSON string values do not break extraction", () => {
    const raw =
      '{"verdict":"match","confidence":0.9,"rationale":"face is {symmetrical} per {step two}","attributes":[]}';
    const comparison = parseVisionComparison(raw);
    expect(comparison.verdict).toBe("match");
    expect(comparison.rationale).toContain("{step two}");
  });

  it("escaped quotes inside a rationale do not break extraction", () => {
    const raw =
      '{"verdict":"mismatch","confidence":0.6,"rationale":"jaw \\"wider\\" than asset","attributes":[]}';
    const comparison = parseVisionComparison(raw);
    expect(comparison.verdict).toBe("mismatch");
  });

  it("throws VisionResponseError on a non-JSON response", () => {
    expect(() => parseVisionComparison("I could not analyze the image."))
      .toThrow(VisionResponseError);
  });

  it("throws VisionResponseError on an invalid verdict", () => {
    expect(() =>
      parseVisionComparison(
        JSON.stringify({ verdict: "looks-fine", confidence: 0.9 }),
      ),
    ).toThrow(/verdict/);
  });

  it("throws VisionResponseError on out-of-range confidence", () => {
    expect(() =>
      parseVisionComparison(
        JSON.stringify({ verdict: "match", confidence: 7 }),
      ),
    ).toThrow(/confidence/);
  });

  it("throws VisionResponseError on a non-boolean attribute match", () => {
    expect(() =>
      parseVisionComparison(
        JSON.stringify({
          verdict: "match",
          confidence: 0.9,
          attributes: [{ key: "hair", match: "yes" }],
        }),
      ),
    ).toThrow(/match/);
  });
});

describe("toExtractedFrame — extraction seam", () => {
  it("lifts a valid VID-016 extraction into the frame under test", () => {
    const frame = toExtractedFrame({
      shotId: "SHOT_A",
      extraction: {
        source: "file:///tmp/frame.png",
        mimeType: "image/png",
        timestampSeconds: 2,
        dimensions: { width: 1280, height: 720 },
      },
    });
    expect(frame.shotId).toBe("SHOT_A");
    expect(frame.dimensions).toEqual({ width: 1280, height: 720 });
  });

  it("rejects a non-image MIME type", () => {
    expect(() =>
      toExtractedFrame({
        shotId: "SHOT_A",
        extraction: {
          source: "file:///tmp/clip.mp4",
          mimeType: "video/mp4",
          timestampSeconds: 2,
          dimensions: { width: 1280, height: 720 },
        },
      }),
    ).toThrow(/image\//);
  });

  it("rejects a negative timestamp", () => {
    expect(() =>
      toExtractedFrame({
        shotId: "SHOT_A",
        extraction: {
          source: "file:///tmp/frame.png",
          mimeType: "image/png",
          timestampSeconds: -1,
          dimensions: { width: 1280, height: 720 },
        },
      }),
    ).toThrow(/timestamp/);
  });

  it("rejects a degenerate frame dimension", () => {
    expect(() =>
      toExtractedFrame({
        shotId: "SHOT_A",
        extraction: {
          source: "file:///tmp/frame.png",
          mimeType: "image/png",
          timestampSeconds: 2,
          dimensions: { width: 0, height: 720 },
        },
      }),
    ).toThrow(/dimensions/);
  });
});