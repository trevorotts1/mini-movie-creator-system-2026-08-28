import { describe, expect, it } from "vitest";

import {
  anchorBlock,
  composeZ,
  DEFAULT_HOLD_FRAMES,
  easeInCubic,
  easeOutCubic,
  envelopeAt,
  exitEnvelope,
  graphicsBounds,
  lineEnvelopes,
  linesOf,
  progress,
  resolveItems,
  resolveKindConfig,
  resolveRange,
  resolveTiming,
  safeNumber,
  scaleToCanvas,
  REFERENCE_WIDTH,
  type ResolvedRange,
} from "./index.js";
import { GRAPHICS_TIMING_DEFAULTS } from "./tokens.js";
import type { FrameSize, GraphicsItemSpec, ShotPlanRef } from "./types.js";

const FRAME: FrameSize = { width: 1080, height: 1920, fps: 30 };
const SHOT: ShotPlanRef = { shotId: "SH01", sceneId: "SC01", sequenceIndex: 0, frameIn: 300, frameOut: 480 };

const TITLE: GraphicsItemSpec = { id: "t1", kind: "title", shotId: "SH01", text: ["HELLO", "WORLD"] };

describe("safeNumber", () => {
  it("passes finite values through", () => {
    expect(safeNumber(5, 1)).toBe(5);
    expect(safeNumber(0, 1)).toBe(0);
    expect(safeNumber(-3, 1)).toBe(-3);
  });
  it("falls back on undefined/null/NaN/Infinity", () => {
    expect(safeNumber(undefined, 7)).toBe(7);
    expect(safeNumber(null as unknown as number, 7)).toBe(7);
    expect(safeNumber(Number.NaN, 7)).toBe(7);
    expect(safeNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });
});

describe("scaleToCanvas", () => {
  it("keeps 1080-authored sizes unchanged on the reference canvas", () => {
    expect(scaleToCanvas(92, { width: 1080 })).toBe(92);
  });
  it("scales proportionally for other widths", () => {
    expect(scaleToCanvas(92, { width: 540 })).toBe(46);
    expect(scaleToCanvas(92, { width: 2160 })).toBe(184);
  });
  it("reference width constant is 1080", () => {
    expect(REFERENCE_WIDTH).toBe(1080);
  });
});

describe("anchorBlock", () => {
  const safe = { top: 150, right: 160, bottom: 500, left: 60 };
  it("top-center sits under the top safe margin, centered", () => {
    const b = anchorBlock("top-center", FRAME, safe);
    expect(b.x).toBe(540);
    expect(b.y).toBe(210);
    expect(b.align).toBe("center");
  });
  it("lower-third clears the bottom safe margin", () => {
    const b = anchorBlock("lower-third", FRAME, safe);
    expect(b.y).toBe(1920 - 500 - 24);
    expect(b.align).toBe("left");
  });
  it("watermark hugs the bottom-right inside the safe area", () => {
    const b = anchorBlock("watermark", FRAME, safe);
    expect(b.x).toBe(1080 - 160 - 16);
    expect(b.y).toBe(1920 - 500 - 16);
  });
  it("badge sits top-right", () => {
    const b = anchorBlock("badge", FRAME, safe);
    expect(b.x).toBe(1080 - 160 - 32);
    expect(b.y).toBe(158);
  });
  it("full covers the canvas origin", () => {
    expect(anchorBlock("full", FRAME, safe)).toEqual({ x: 0, y: 0, align: "left" });
  });
});

describe("resolveRange", () => {
  it("binds to the shot window plus offset", () => {
    const r = resolveRange({ id: "t1", kind: "title", shotId: "SH01" }, SHOT);
    expect(r.frameFrom).toBe(300);
    expect(r.frameTo).toBe(480);
    expect(r.inAt).toBe(300);
    expect(r.outAt).toBe(480 - GRAPHICS_TIMING_DEFAULTS.outDur);
  });
  it("honors offsetIn inside the shot", () => {
    const r = resolveRange({ id: "t1", kind: "title", shotId: "SH01", offsetIn: 30 }, SHOT);
    expect(r.frameFrom).toBe(330);
    expect(r.frameTo).toBe(480);
  });
  it("standalone items use frameFrom/frameTo", () => {
    const r = resolveRange({ id: "t1", kind: "overlay", frameFrom: 10, frameTo: 40 }, undefined);
    expect(r.frameFrom).toBe(10);
    expect(r.frameTo).toBe(40);
    expect(r.outAt).toBe(40 - GRAPHICS_TIMING_DEFAULTS.outDur);
  });
  it("standalone items without bounds hold for the default duration", () => {
    const r = resolveRange({ id: "t1", kind: "overlay" }, undefined);
    expect(r.frameFrom).toBe(0);
    expect(r.frameTo).toBe(DEFAULT_HOLD_FRAMES);
  });
  it("never produces an empty range (frameTo > frameFrom)", () => {
    const r = resolveRange({ id: "t1", kind: "title", shotId: "SH01", offsetIn: 500 }, SHOT);
    expect(r.frameTo).toBeGreaterThan(r.frameFrom);
  });
  it("guards NaN inputs", () => {
    const r = resolveRange(
      { id: "t1", kind: "overlay", frameFrom: Number.NaN, frameTo: Number.NaN },
      undefined,
    );
    expect(r.frameFrom).toBe(0);
    expect(r.frameTo).toBe(DEFAULT_HOLD_FRAMES);
  });
});

describe("resolveTiming", () => {
  it("defaults match brand motion language", () => {
    const t = resolveTiming();
    expect(t).toEqual({ inDur: 7, outDur: 6, stagger: 3, rise: 24, fall: 14 });
  });
  it("honors overrides", () => {
    expect(resolveTiming({ inDur: 12, rise: 40 }).inDur).toBe(12);
    expect(resolveTiming({ rise: 40 }).rise).toBe(40);
  });
  it("guards bad overrides", () => {
    expect(resolveTiming({ inDur: Number.NaN }).inDur).toBe(7);
  });
});

describe("resolveKindConfig / composeZ", () => {
  it("defaults per kind", () => {
    expect(resolveKindConfig({ id: "k", kind: "kicker" }).color).toBe("#f5d76e");
    expect(resolveKindConfig({ id: "k", kind: "title" }).anchor).toBe("top-center");
    expect(resolveKindConfig({ id: "k", kind: "lowerThird" }).anchor).toBe("lower-third");
   });
  it("z-order: overlays above titles; credits and logos on top", () => {
    const z = (s: GraphicsItemSpec) => composeZ(s);
    expect(z({ id: "a", kind: "overlay" })).toBeGreaterThan(z({ id: "b", kind: "title" }));
    expect(z({ id: "c", kind: "credit" })).toBeGreaterThan(z({ id: "d", kind: "overlay" }));
    expect(z({ id: "e", kind: "logo" })).toBeGreaterThan(z({ id: "f", kind: "credit" }));
  });
  it("per-item overrides win", () => {
    expect(resolveKindConfig({ id: "k", kind: "title", accentColor: "#e8879f", zIndex: 99 }).color).toBe("#e8879f");
    expect(resolveKindConfig({ id: "k", kind: "title", zIndex: 99 }).zIndex).toBe(99);
  });
});

describe("envelopeAt", () => {
  const range: ResolvedRange = { frameFrom: 100, frameTo: 160, inAt: 100, outAt: 154 };
  const t = resolveTiming();

  it("hidden before entry", () => {
    const e = envelopeAt(50, range, t);
    expect(e.phase).toBe("hidden");
    expect(e.opacity).toBe(0);
 expect(e.translateY).toBe(t.rise);
  });
  it("rises + fades in over inDur (ease-out, no overshoot)", () => {
    const mid = envelopeAt(103, range, t);
    expect(mid.phase).toBe("entering");
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.translateY).toBeGreaterThan(0);
    const late = envelopeAt(106, range, t); // 6/7 through the ramp
    expect(late.opacity).toBeGreaterThan(mid.opacity);
    expect(late.translateY).toBeLessThan(mid.translateY);
  });
  it("holding is fully composed", () => {
    const e = envelopeAt(120, range, t);
    expect(e).toEqual({ opacity: 1, translateY: 0, phase: "holding" });
  });
  it("exits with fade + fall", () => {
    const mid = envelopeAt(157, range, t); // halfway through exit
    expect(mid.phase).toBe("exiting");
    expect(mid.opacity).toBeLessThan(1);
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.translateY).toBeGreaterThan(0);
    const end = envelopeAt(159, range, t);
    expect(end.opacity).toBeLessThan(mid.opacity);
  });
  it("hidden after the end", () => {
    const e = envelopeAt(200, range, t);
    expect(e.phase).toBe("hidden");
    expect(e.opacity).toBe(0);
  });
  it("entry uses ease-out cubic", () => {
    const p = 0.5;
    expect(easeOutCubic(p)).toBeCloseTo(0.875, 5);
    expect(easeInCubic(p)).toBe(0.125);
  });
  it("exitEnvelope matches envelopeAt on the exit tail", () => {
    for (let f = 154; f < 160; f += 1) {
      expect(envelopeAt(f, range, t)).toEqual(exitEnvelope(f, range, t));
    }
  });
});

describe("progress", () => {
  it("clamps to [0,1]", () => {
    expect(progress(-5, 0, 10)).toBe(0);
    expect(progress(15, 0, 10)).toBe(1);
    expect(progress(5, 0, 10)).toBe(0.5);
  });
  it("returns 1 for degenerate ranges", () => {
    expect(progress(5, 10, 10)).toBe(1);
    expect(progress(5, 10, 2)).toBe(1);
  });
});

describe("linesOf", () => {
  it("wraps single strings", () => {
    expect(linesOf({ id: "x", kind: "title", text: "hi" })).toEqual(["hi"]);
  });
  it("passes arrays through, filtering non-strings", () => {
    expect(linesOf({ id: "x", kind: "title", text: ["a", 3, "b"] as unknown as string[] })).toEqual(["a", "b"]);
  });
  it("empty for missing text", () => {
    expect(linesOf({ id: "x", kind: "title" })).toEqual([]);
  });
});

describe("lineEnvelopes", () => {
  it("staggers lines by the timing stagger", () => {
    const range: ResolvedRange = { frameFrom: 0, frameTo: 100, inAt: 0, outAt: 94 };
    const t = resolveTiming();
    const envs = lineEnvelopes(2, range, t, 3);
    expect(envs).toHaveLength(3);
    const [first, second, third] = envs;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    // line 0 is 2 frames into its ramp; line 1 starts at 3, line 2 at 6 — hidden
    expect(first?.phase).toBe("entering");
    expect(first?.opacity).toBeGreaterThan(0);
    expect(second?.phase).toBe("hidden");
    expect(third?.phase).toBe("hidden");
  });
  it("all lines end together at the item end", () => {
    const range: ResolvedRange = { frameFrom: 0, frameTo: 100, inAt: 0, outAt: 94 };
    const t = resolveTiming();
    const envs = lineEnvelopes(99, range, t, 2);
    expect(envs.every((e) => e.phase === "exiting")).toBe(true);
  });
});

describe("resolveItems", () => {
  it("binds items to shots and scales font sizes", () => {
    const items = resolveItems([TITLE], [SHOT], FRAME);
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it?.shot?.shotId).toBe("SH01");
    expect(it?.range.frameFrom).toBe(300);
    expect(it?.fontSizeScaled).toBe(92);
    expect(it?.lines).toEqual(["HELLO", "WORLD"]);
  });
  it("font size scales with canvas width", () => {
    const it = resolveItems([TITLE], [SHOT], { ...FRAME, width: 540 })[0];
    expect(it?.fontSizeScaled).toBe(46);
  });
  it("unknown shotId resolves standalone without throwing", () => {
    const it = resolveItems([{ id: "x", kind: "title", shotId: "GHOST" }], [SHOT], FRAME)[0];
    expect(it?.shot).toBeUndefined();
    expect(it?.range.frameFrom).toBe(0);
  });
  it("applies per-item kind overrides", () => {
    const it = resolveItems(
      [{ id: "x", kind: "title", accentColor: "#e8879f", zIndex: 77, fontSize: 60 }],
      [],
      FRAME,
    )[0];
    expect(it?.color).toBe("#e8879f");
    expect(it?.zIndex).toBe(77);
    expect(it?.fontSizeScaled).toBe(60);
  });
});

describe("graphicsBounds", () => {
  it("spans all items", () => {
    const items = resolveItems(
      [
        { id: "a", kind: "title", frameFrom: 10, frameTo: 30 },
        { id: "b", kind: "overlay", frameFrom: 25, frameTo: 90 },
      ],
      [],
      FRAME,
    );
    expect(graphicsBounds(items)).toEqual({ from: 10, to: 90 });
  });
  it("zeroes on empty input", () => {
    expect(graphicsBounds([])).toEqual({ from: 0, to: 0 });
  });
});