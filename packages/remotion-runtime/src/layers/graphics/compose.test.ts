import { describe, expect, it } from "vitest";

import {
  composeGraphics,
  DEFAULT_FRAME,
  DEFAULT_SAFE_AREA,
  graphicsAtFrame,
  graphicsForShot,
  type GraphicsStack,
} from "./index.js";
import type { GraphicsItemSpec, ShotPlanRef } from "./types.js";

const SHOTS: ShotPlanRef[] = [
  { shotId: "SH01", sceneId: "SC01", sequenceIndex: 0, frameIn: 0, frameOut: 180 },
  { shotId: "SH02", sceneId: "SC01", sequenceIndex: 1, frameIn: 180, frameOut: 360 },
  { shotId: "SH03", sceneId: "SC02", sequenceIndex: 2, frameIn: 360, frameOut: 540 },
];

const ITEMS: GraphicsItemSpec[] = [
  { id: "ep-title", kind: "title", shotId: "SH01", text: ["THE LONG NIGHT"] },
  { id: "ep-kicker", kind: "kicker", shotId: "SH01", text: "Season 1 · Episode 3" },
  { id: "lt-monica", kind: "lowerThird", shotId: "SH02", text: "Monica Bennett", subtext: "Detective, 21st Precinct" },
  { id: "wall-clock", kind: "overlay", shotId: "SH03", panel: { title: "3:12 AM", body: "Hour six of the stakeout." } },
  { id: "credits-lead", kind: "credit", frameFrom: 540, frameTo: 840, text: "Directed by T. Otts" },
  { id: "network-logo", kind: "logo", frameFrom: 0, frameTo: 900 },
];

describe("composeGraphics", () => {
  const stack: GraphicsStack = composeGraphics({ items: ITEMS, shots: SHOTS });

  it("resolves every item without warnings for clean data", () => {
    expect(stack.warnings).toEqual([]);
    expect(stack.items).toHaveLength(ITEMS.length);
  });

  it("sorts the stack by zIndex ascending, then start frame", () => {
    const z = stack.items.map((i) => i.zIndex);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
    for (let i = 1; i < stack.items.length; i += 1) {
      const prev = stack.items[i - 1];
      const cur = stack.items[i];
      expect(prev).toBeDefined();
      expect(cur).toBeDefined();
      if (prev && cur && prev.zIndex === cur.zIndex) {
        expect(cur.range.frameFrom).toBeGreaterThanOrEqual(prev.range.frameFrom);
      }
    }
  });

  it("bounds span the full graphics timeline", () => {
    expect(stack.bounds).toEqual({ from: 0, to: 900 });
  });

  it("warns on unknown shotId bindings", () => {
    const s = composeGraphics({
      items: [{ id: "ghosted", kind: "title", shotId: "NOPE", text: "x" }],
      shots: SHOTS,
    });
    expect(s.warnings.some((w) => w.includes("unknown shotId"))).toBe(true);
  });

  it("warns on same-kind timeline overlaps", () => {
    const s = composeGraphics({
      items: [
        { id: "a", kind: "title", frameFrom: 0, frameTo: 100, text: "A" },
        { id: "b", kind: "title", frameFrom: 50, frameTo: 120, text: "B" },
      ],
      shots: [],
    });
    expect(s.warnings.some((w) => w.startsWith("overlap:"))).toBe(true);
  });

  it("overlap sweep catches transitive overlaps, not only adjacent pairs", () => {
    // a spans 0-1000; b and c fit inside it. Adjacent-pair checks see only
    // (b,c) — no overlap — and miss that a overlaps both.
    const s = composeGraphics({
      items: [
        { id: "a", kind: "title", frameFrom: 0, frameTo: 1000, text: "A" },
        { id: "b", kind: "title", frameFrom: 100, frameTo: 200, text: "B" },
        { id: "c", kind: "title", frameFrom: 300, frameTo: 400, text: "C" },
      ],
      shots: [],
    });
    const overlaps = s.warnings.filter((w) => w.startsWith("overlap:"));
    expect(overlaps.length).toBeGreaterThanOrEqual(2);
    expect(overlaps.some((w) => w.includes("before b") || w.includes("before a"))).toBe(true);
    expect(overlaps.some((w) => w.includes("c starts at"))).toBe(true);
  });

  it("non-overlapping same-kind items stay silent", () => {
    const s = composeGraphics({
      items: [
        { id: "a", kind: "title", frameFrom: 0, frameTo: 100, text: "A" },
        { id: "b", kind: "title", frameFrom: 100, frameTo: 200, text: "B" },
        { id: "c", kind: "title", frameFrom: 400, frameTo: 500, text: "C" },
      ],
      shots: [],
    });
    expect(s.warnings.filter((w) => w.startsWith("overlap:"))).toEqual([]);
  });

  it("NaN frame dimensions collapse to the default canvas (no NaN font scale)", () => {
    const s = composeGraphics({
      items: [{ id: "t", kind: "title", text: "x", frameFrom: 0, frameTo: 10 }],
      shots: [],
      frame: { width: Number.NaN, height: Number.NaN, fps: Number.NaN },
    });
    const it = s.items[0];
    expect(Number.isFinite(it?.fontSizeScaled)).toBe(true);
    expect(it?.fontSizeScaled).toBeGreaterThan(0);
  });

  it("guards non-positive frame sizes with the default canvas", () => {
    const s = composeGraphics({
      items: [{ id: "t", kind: "title", text: "x", frameFrom: 0, frameTo: 10 }],
      shots: [],
      frame: { width: 0, height: -5, fps: 0 },
    });
    // font scale fell back to the default width (no NaN / 0 division)
    const it = s.items[0];
    expect(Number.isFinite(it?.fontSizeScaled)).toBe(true);
    expect(it?.fontSizeScaled).toBeGreaterThan(0);
  });

  it("empty plan composes to an empty stack", () => {
    expect(composeGraphics({ items: [], shots: [] })).toEqual({
      items: [],
      bounds: { from: 0, to: 0 },
      warnings: [],
    });
  });

  it("exposes the default canvas + safe area constants", () => {
    expect(DEFAULT_FRAME).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(DEFAULT_SAFE_AREA).toEqual({ top: 150, right: 160, bottom: 500, left: 60 });
  });
});

describe("graphicsForShot", () => {
  const stack = composeGraphics({ items: ITEMS, shots: SHOTS });

  it("returns shot-bound items for their shot", () => {
    const sh01 = SHOTS[0];
    expect(sh01).toBeDefined();
    const forSH01 = graphicsForShot(stack, sh01 as ShotPlanRef);
    expect(forSH01.map((i) => i.spec.id)).toContain("ep-title");
    expect(forSH01.map((i) => i.spec.id)).toContain("ep-kicker");
    expect(forSH01.map((i) => i.spec.id)).not.toContain("lt-monica");
  });

  it("includes absolute items overlapping the shot window", () => {
    const sh03 = SHOTS[2];
    expect(sh03).toBeDefined();
    const forSH03 = graphicsForShot(stack, sh03 as ShotPlanRef);
    const ids = forSH03.map((i) => i.spec.id);
    expect(ids).toContain("wall-clock");
    // credits-lead starts exactly at SH03's end frame — half-open range excludes it
    expect(ids).not.toContain("credits-lead");
    expect(ids).toContain("network-logo");
  });

  it("absolute item touching only the boundary after the shot is excluded (half-open)", () => {
    const late: GraphicsItemSpec = { id: "late", kind: "overlay", frameFrom: 540, frameTo: 600, panel: {} };
    const s = composeGraphics({ items: [late], shots: SHOTS });
    const sh01 = SHOTS[0];
    const sh02 = SHOTS[1];
    const sh03 = SHOTS[2];
    expect(sh01).toBeDefined();
    expect(sh02).toBeDefined();
    expect(sh03).toBeDefined();
    expect(graphicsForShot(s, sh02 as ShotPlanRef).map((i) => i.spec.id)).not.toContain("late");
    expect(graphicsForShot(s, sh03 as ShotPlanRef).map((i) => i.spec.id)).not.toContain("late");
    // it does ride an absolute-frame window starting at its own frameFrom
    expect(graphicsAtFrame(s, 540).map((i) => i.spec.id)).toContain("late");
  });

  it("shot-bound items do not leak into other shots", () => {
    const s = composeGraphics({ items: ITEMS, shots: SHOTS });
    const sh01 = SHOTS[0];
    const sh03 = SHOTS[2];
    expect(sh01).toBeDefined();
    expect(sh03).toBeDefined();
    expect(graphicsForShot(s, sh03 as ShotPlanRef).map((i) => i.spec.id)).not.toContain("ep-title");
    expect(graphicsForShot(s, sh03 as ShotPlanRef).map((i) => i.spec.id)).not.toContain("lt-monica");
  });
});

describe("graphicsAtFrame", () => {
  const stack = composeGraphics({ items: ITEMS, shots: SHOTS });

  it("returns only items visible at the frame, ordered bottom-to-top", () => {
    const at200 = graphicsAtFrame(stack, 200);
    const ids = at200.map((i) => i.spec.id);
    expect(ids).toContain("lt-monica");
    expect(ids).toContain("network-logo");
    expect(ids).not.toContain("ep-title");
    const z = at200.map((i) => i.zIndex);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
  });

  it("excludes items at their end frame (half-open ranges)", () => {
    const at900 = graphicsAtFrame(stack, 900);
    expect(at900.map((i) => i.spec.id)).not.toContain("network-logo");
  });

  it("credits appear only inside their window", () => {
    expect(graphicsAtFrame(stack, 500).map((i) => i.spec.id)).not.toContain("credits-lead");
    expect(graphicsAtFrame(stack, 600).map((i) => i.spec.id)).toContain("credits-lead");
  });
});