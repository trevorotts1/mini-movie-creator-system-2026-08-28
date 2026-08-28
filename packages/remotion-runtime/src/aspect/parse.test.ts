import { describe, expect, it } from "vitest";
import { AspectPlanError } from "./types.js";
import { parseAspectRatio, formatRatioId } from "./parse.js";

describe("parseAspectRatio", () => {
  it("parses the 16:9 preset", () => {
    const r = parseAspectRatio("16:9");
    expect(r.id).toBe("16:9");
    expect(r.widthUnits).toBe(16);
    expect(r.heightUnits).toBe(9);
    expect(r.ratio).toBeCloseTo(16 / 9, 10);
  });

  it("parses the 9:16 preset", () => {
    const r = parseAspectRatio("9:16");
    expect(r.id).toBe("9:16");
    expect(r.ratio).toBeCloseTo(9 / 16, 10);
  });

  it("parses custom ratios with decimals", () => {
    const r = parseAspectRatio("2.35:1");
    expect(r.id).toBe("2.35:1");
    expect(r.ratio).toBeCloseTo(2.35, 10);
  });

  it("normalizes whitespace and leading zeros", () => {
    const r = parseAspectRatio(" 016 : 009 ");
    expect(r.id).toBe("16:9");
  });

  it("rejects malformed and zero inputs", () => {
    for (const bad of ["", "16x9", "16:", "0:9", "16:0", "abc", "16:9:2", "-1:2", "16 / 9", "1e3:2"]) {
      expect(() => parseAspectRatio(bad), `should reject "${bad}"`).toThrow(AspectPlanError);
    }
  });
});

describe("formatRatioId", () => {
  it("keeps exact integers clean", () => {
    expect(formatRatioId(16, 9)).toBe("16:9");
  });

  it("canonicalizes measured ratios back to preset ids", () => {
    // 1920/1080 measured -> canonical 16:9
    expect(formatRatioId(1920 / 120, 1080 / 120)).toBe("16:9");
  });
});
