import { describe, expect, it } from "vitest";

import {
  GRAPHICS_COLORS,
  GRAPHICS_FONTS,
  GRAPHICS_GRADIENT,
  GRAPHICS_RADIUS,
  GRAPHICS_SHADOW,
  GRAPHICS_TIMING_DEFAULTS,
  KIND_DEFAULTS,
} from "./index.js";

const ALL_KINDS = [
  "title",
  "kicker",
  "subtitle",
  "lowerThird",
  "overlay",
  "credit",
  "logo",
  "progressBar",
] as const;

describe("brand tokens", () => {
  it("palette hexes match brand.md exactly", () => {
    expect(GRAPHICS_COLORS.accent).toBe("#6366F1");
    expect(GRAPHICS_COLORS.accent2).toBe("#9b7cc4");
    expect(GRAPHICS_COLORS.signal).toBe("#4db8a8");
    expect(GRAPHICS_COLORS.warn).toBe("#f5d76e");
    expect(GRAPHICS_COLORS.danger).toBe("#e8879f");
    expect(GRAPHICS_COLORS.ink).toBe("#1a1a2e");
    expect(GRAPHICS_COLORS.paper).toBe("#fffef7");
  });

  it("signature gradient is indigo -> violet -> teal", () => {
    expect(GRAPHICS_GRADIENT).toBe(
      "linear-gradient(120deg, #6366F1, #9b7cc4, #4db8a8)",
    );
  });

  it("radii follow brand shape rules", () => {
    expect(GRAPHICS_RADIUS.card).toBe(14);
    expect(GRAPHICS_RADIUS.panel).toBe(14);
    expect(GRAPHICS_RADIUS.pill).toBe(999);
  });

  it("shadows are soft, never hard-offset", () => {
    expect(GRAPHICS_SHADOW.soft).not.toMatch(/4px 4px/);
    expect(GRAPHICS_SHADOW.card).toMatch(/rgba\(26,26,46/);
  });

  it("timing defaults match brand motion language (30fps)", () => {
    expect(GRAPHICS_TIMING_DEFAULTS.inDur).toBe(7);
    expect(GRAPHICS_TIMING_DEFAULTS.outDur).toBeLessThan(GRAPHICS_TIMING_DEFAULTS.inDur);
    expect(GRAPHICS_TIMING_DEFAULTS.stagger).toBeGreaterThanOrEqual(3);
  });

  it("fonts are the 3-font brand system", () => {
    expect(GRAPHICS_FONTS.display).toBe("Space Grotesk");
    expect(GRAPHICS_FONTS.body).toBe("Inter");
    expect(GRAPHICS_FONTS.mono).toBe("JetBrains Mono");
  });
});

describe("KIND_DEFAULTS", () => {
  it("covers every graphics kind", () => {
    for (const k of ALL_KINDS) {
      expect(KIND_DEFAULTS[k], `missing default for kind ${k}`).toBeDefined();
    }
    expect(Object.keys(KIND_DEFAULTS)).toHaveLength(ALL_KINDS.length);
  });

  it("every default has a non-empty label and finite numbers", () => {
    for (const [k, d] of Object.entries(KIND_DEFAULTS)) {
      expect(d.label.length, k).toBeGreaterThan(0);
      expect(Number.isFinite(d.zIndex), k).toBe(true);
      expect(Number.isFinite(d.fontSize), k).toBe(true);
      expect(d.color.length, k).toBeGreaterThan(0);
      expect(d.anchor.length, k).toBeGreaterThan(0);
    }
  });

  it("z-order is a strict total order: kicker < subtitle < title < progressBar < lowerThird < overlay < credit < logo", () => {
    const z = (k: (typeof ALL_KINDS)[number]) => KIND_DEFAULTS[k].zIndex;
    expect(z("kicker")).toBeLessThan(z("subtitle"));
    expect(z("subtitle")).toBeLessThan(z("title"));
    expect(z("title")).toBeLessThan(z("progressBar"));
    expect(z("progressBar")).toBeLessThan(z("lowerThird"));
    expect(z("lowerThird")).toBeLessThan(z("overlay"));
    expect(z("overlay")).toBeLessThan(z("credit"));
    expect(z("credit")).toBeLessThan(z("logo"));
  });
});