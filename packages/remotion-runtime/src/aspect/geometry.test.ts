import { describe, expect, it } from "vitest";
import { canvasFor, safeAreaFor, captionZoneFor, isValidCanvas } from "./geometry.js";
import { parseAspectRatio } from "./parse.js";

const LANDSCAPE = parseAspectRatio("16:9");
const PORTRAIT = parseAspectRatio("9:16");

describe("canvasFor", () => {
  it("16:9 at 1080p = 1920x1080", () => {
    const c = canvasFor(LANDSCAPE, "1080p");
    expect(c.width).toBe(1920);
    expect(c.height).toBe(1080);
    expect(c.aspectRatioId).toBe("16:9");
  });

  it("9:16 at 1080p = 1080x1920", () => {
    const c = canvasFor(PORTRAIT, "1080p");
    expect(c.width).toBe(1080);
    expect(c.height).toBe(1920);
  });

  it("720p tier = short edge 720", () => {
    const land = canvasFor(LANDSCAPE, "720p");
    const port = canvasFor(PORTRAIT, "720p");
    expect(land).toMatchObject({ width: 1280, height: 720 });
    expect(port).toMatchObject({ width: 720, height: 1280 });
  });

  it("4K tier = 3840x2160 / 2160x3840", () => {
    expect(canvasFor(LANDSCAPE, "2160p")).toMatchObject({ width: 3840, height: 2160 });
    expect(canvasFor(PORTRAIT, "2160p")).toMatchObject({ width: 2160, height: 3840 });
  });

  it("square 1:1 = equal sides", () => {
    const c = canvasFor(parseAspectRatio("1:1"), "1080p");
    expect(c.width).toBe(1080);
    expect(c.height).toBe(1080);
  });

  it("letterboxed 2.35:1 keeps short edge 1080 and stays even", () => {
    const c = canvasFor(parseAspectRatio("2.35:1"), "1080p");
    expect(c.height).toBe(1080);
    expect(c.width % 2).toBe(0);
    expect(c.width).toBeGreaterThan(1920);
  });

  it("rejects unknown tiers", () => {
    expect(() => canvasFor(LANDSCAPE, "bogus" as never)).toThrow(/unknown resolution tier/);
  });

  it("rejects extreme ratios whose long edge would exceed the renderer ceiling", () => {
    // 1:20000 at 1080p -> long edge ~216M px: must throw, not produce a bogus canvas.
    expect(() => canvasFor(parseAspectRatio("1:20000"), "1080p")).toThrow(/invalid long edge/);
  });
});

describe("safeAreaFor", () => {
  it("default 10% inset on 1920x1080", () => {
    const s = safeAreaFor(canvasFor(LANDSCAPE, "1080p"));
    expect(s).toMatchObject({
      x: 192,
      y: 108,
      width: 1920 - 384,
      height: 1080 - 216,
    });
    expect(s.insets).toMatchObject({ top: 108, right: 192, bottom: 108, left: 192 });
  });

  it("covers the whole frame at fraction 0", () => {
    const s = safeAreaFor(canvasFor(LANDSCAPE, "1080p"), { fraction: 0 });
    expect(s).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("rejects fractions outside [0, 0.5)", () => {
    for (const bad of [-0.1, 0.5, 0.9]) {
      expect(() => safeAreaFor(canvasFor(LANDSCAPE, "1080p"), { fraction: bad })).toThrow();
    }
  });

  it("portrait insets are pixel-symmetric around the canvas", () => {
    const canvas = canvasFor(PORTRAIT, "1080p");
    const s = safeAreaFor(canvas);
    expect(s.x + s.width).toBe(canvas.width - s.insets.right);
    expect(s.y + s.height).toBe(canvas.height - s.insets.bottom);
  });
});

describe("captionZoneFor", () => {
  it("bottom 25% of safe area, bottom-adjacent, 16:9", () => {
    const canvas = canvasFor(LANDSCAPE, "1080p");
    const zone = captionZoneFor(canvas);
    expect(zone.height).toBe(Math.round((1080 - 216) * 0.25));
    expect(zone.y + zone.height).toBe(1080 - 108); // flush to safe-area bottom
  });

  it("keeps same fraction for 9:16 so captions clear platform UI", () => {
    const canvas = canvasFor(PORTRAIT, "1080p");
    const zone = captionZoneFor(canvas);
    expect(zone.y + zone.height).toBe(1920 - 192);
    expect(zone.width).toBe(1080 - 2 * 108);
  });

  it("rejects zone fractions outside (0, 1]", () => {
    const canvas = canvasFor(LANDSCAPE, "1080p");
    for (const bad of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => captionZoneFor(canvas, { zone: bad })).toThrow(/caption zone fraction/);
    }
    // zone 1 = full safe-area height, bottom-aligned.
    expect(captionZoneFor(canvas, { zone: 1 }).height).toBe((1080 - 216));
  });
});

describe("isValidCanvas", () => {
  it("accepts rendered canvases", () => {
    expect(isValidCanvas(canvasFor(LANDSCAPE, "1080p"))).toBe(true);
    expect(isValidCanvas(canvasFor(PORTRAIT, "720p"))).toBe(true);
  });

  it("rejects non-integer / oversized / empty canvases", () => {
    expect(isValidCanvas({ width: 0, height: 0, aspectRatioId: "16:9" })).toBe(false);
    expect(isValidCanvas({ width: -1, height: 100, aspectRatioId: "x" })).toBe(false);
    expect(isValidCanvas({ width: 20000, height: 100, aspectRatioId: "x" })).toBe(false);
    expect(isValidCanvas({ width: 1919.5, height: 1080, aspectRatioId: "x" })).toBe(false);
  });
});
