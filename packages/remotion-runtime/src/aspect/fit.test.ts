import { describe, expect, it } from "vitest";
import { Canvas } from "./types.js";
import { fitSourceToCanvas, sourceMatchesCanvas } from "./fit.js";

const LANDSCAPE: Canvas = { width: 1920, height: 1080, aspectRatioId: "16:9" };
const PORTRAIT: Canvas = { width: 1080, height: 1920, aspectRatioId: "9:16" };

describe("fitSourceToCanvas — letterbox (default)", () => {
  it("matching-ratio source fills the canvas exactly, no bars", () => {
    const t = fitSourceToCanvas({ width: 1920, height: 1080 }, LANDSCAPE);
    expect(t.mode).toBe("letterbox");
    expect(t).toMatchObject({ scale: 1, x: 0, y: 0, width: 1920, height: 1080, hasBars: false });
    expect(t.padding).toMatchObject({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("letterboxes a wider source (2.35:1 on 16:9): bars top+bottom, full width", () => {
    const t = fitSourceToCanvas({ width: 1920, height: 817 }, LANDSCAPE);
    expect(t.hasBars).toBe(true);
    expect(t.width).toBe(1920);
    expect(t.height).toBeLessThan(1080);
    expect(t.y).toBe(Math.round((1080 - t.height) / 2));
    expect(t.x).toBe(0);
    expect(t.padding.top).toBe(t.y);
    expect(t.padding.bottom).toBe(1080 - (t.y + t.height));
    expect(t.padding.left).toBe(0);
    expect(t.padding.right).toBe(0);
  });

  it("pillarboxes a narrower source (4:3 on 16:9): bars left+right, full height", () => {
    const t = fitSourceToCanvas({ width: 1440, height: 1080 }, LANDSCAPE);
    expect(t.hasBars).toBe(true);
    expect(t.height).toBe(1080);
    expect(t.width).toBeLessThan(1920);
    expect(t.x).toBe(Math.round((1920 - t.width) / 2));
    expect(t.padding.top).toBe(0);
    expect(t.padding.bottom).toBe(0);
  });

  it("orientation mismatch: landscape source letterboxes inside 9:16 canvas", () => {
    const t = fitSourceToCanvas({ width: 1920, height: 1080 }, PORTRAIT);
    expect(t.hasBars).toBe(true);
    expect(t.width).toBe(1080);
    expect(t.height).toBe(608);
    expect(t.y).toBe(Math.round((1920 - 608) / 2));
    expect(t.padding.left).toBe(0);
    expect(t.padding.right).toBe(0);
    expect(t.padding.top + t.height + t.padding.bottom).toBe(1920);
  });

  it("scales down oversized sources without cropping (letterbox never upscales past fit)", () => {
    const t = fitSourceToCanvas({ width: 3840, height: 2160 }, LANDSCAPE);
    expect(t.width).toBe(1920);
    expect(t.height).toBe(1080);
    expect(t.scale).toBeCloseTo(0.5, 10);
  });
});

describe("fitSourceToCanvas — crop (cover)", () => {
  it("center-crops a wider source onto 16:9: fills height, overflow horizontal", () => {
    const t = fitSourceToCanvas({ width: 1920, height: 817 }, LANDSCAPE, "crop");
    expect(t.mode).toBe("crop");
    expect(t.height).toBe(1080);
    expect(t.width).toBe(2538); // 1920 * (1080/817) — crops the horizontal overflow
    expect(t.y).toBe(0);
    expect(t.x).toBeLessThanOrEqual(0);
    expect(t.hasBars).toBe(false);
  });

  it("center-crops a taller source: fills width, overflow vertical", () => {
    const t = fitSourceToCanvas({ width: 1440, height: 1080 }, LANDSCAPE, "crop");
    expect(t.width).toBe(1920);
    expect(t.height).toBe(1440); // 1080 * (1920/1440) — crops the vertical overflow
    expect(t.x).toBe(0);
    expect(t.y).toBeLessThanOrEqual(0);
    expect(t.hasBars).toBe(false);
  });

  it("orientation mismatch crop: portrait canvas fully covered by landscape source", () => {
    const t = fitSourceToCanvas({ width: 1920, height: 1080 }, PORTRAIT, "crop");
    expect(t.width).toBe(3413); // 1920 * (1920/1080) — crops the horizontal overflow
    expect(t.height).toBe(1920);
    expect(t.y).toBe(0);
    expect(t.x).toBeLessThanOrEqual(0);
  });

  it("crop + letterbox share the same center point so a mode switch never shifts the subject", () => {
    const lb = fitSourceToCanvas({ width: 1440, height: 1080 }, LANDSCAPE);
    const cr = fitSourceToCanvas({ width: 1440, height: 1080 }, LANDSCAPE, "crop");
    expect(cr.x + cr.width / 2).toBe(lb.x + lb.width / 2); // horizontal center 960
    expect(cr.y + cr.height / 2).toBe(lb.y + lb.height / 2); // vertical center 540
  });
});

describe("fitSourceToCanvas — validation", () => {
  it("rejects zero/negative/NaN source dims", () => {
    for (const bad of [
      { width: 0, height: 100 },
      { width: 100, height: -1 },
      { width: Number.NaN, height: 100 },
    ]) {
      expect(() => fitSourceToCanvas(bad, LANDSCAPE)).toThrow();
    }
  });

  it("rejects unknown modes", () => {
    expect(() => fitSourceToCanvas({ width: 100, height: 100 }, LANDSCAPE, "stretch" as never)).toThrow(
      /invalid fit mode/,
    );
  });
});

describe("sourceMatchesCanvas", () => {
  it("true for exact and near matches, false for mismatches", () => {
    expect(sourceMatchesCanvas({ width: 1920, height: 1080 }, LANDSCAPE)).toBe(true);
    expect(sourceMatchesCanvas({ width: 1280, height: 720 }, LANDSCAPE)).toBe(true);
    expect(sourceMatchesCanvas({ width: 1440, height: 1080 }, LANDSCAPE)).toBe(false);
    expect(sourceMatchesCanvas({ width: 1080, height: 1920 }, PORTRAIT)).toBe(true);
  });

  it("tolerance boundary: sub-1% drift passes at default, fails at tighter tolerance", () => {
    // 1938x1080 is ~0.94% off 16:9 — inside the default 1% tolerance.
    expect(sourceMatchesCanvas({ width: 1938, height: 1080 }, LANDSCAPE)).toBe(true);
    expect(sourceMatchesCanvas({ width: 1938, height: 1080 }, LANDSCAPE, 0.005)).toBe(false);
  });

  it("rejects invalid source dims", () => {
    expect(sourceMatchesCanvas({ width: 0, height: 0 }, LANDSCAPE)).toBe(false);
  });
});
