import { describe, expect, it } from "vitest";

import { creditsContentHeight, creditsScrollAt, CREDITS_ROW, type CreditsTimeline } from "./index.js";
import { DEFAULT_FRAME } from "./compose.js";

const FRAME = DEFAULT_FRAME;

const SPEC: CreditsTimeline = {
  title: "The Long Night",
  rows: [
    { role: "Directed by", names: ["T. Otts"] },
    { role: "Written by", names: ["Story Engine", "Human Producer"] },
    { role: "Cast", names: ["Monica Bennett", "Marcus Cole"] },
  ],
  durationFrames: 300,
  startFrame: 0,
};

describe("creditsContentHeight", () => {
  it("scales with row count", () => {
    const one = creditsContentHeight([{ role: "r", names: ["n"] }], FRAME);
    const three = creditsContentHeight(SPEC.rows, FRAME);
    expect(three).toBeGreaterThan(one);
  });
  it("includes title block and bottom pad", () => {
    const empty = creditsContentHeight([], FRAME);
    expect(empty).toBe(Math.round((CREDITS_ROW.titleBlock + CREDITS_ROW.bottomPad) * (FRAME.width / 1080)));
  });
  it("scales with canvas width", () => {
    const half = creditsContentHeight(SPEC.rows, { ...FRAME, width: 540 });
    expect(half).toBe(Math.round(creditsContentHeight(SPEC.rows, FRAME) / 2));
  });
});

describe("creditsScrollAt", () => {
  it("starts fully below the viewport", () => {
    const l = creditsScrollAt(0, SPEC, FRAME);
    expect(l.scrollY).toBe(FRAME.height);
    expect(l.progress).toBe(0);
    expect(l.finished).toBe(false);
  });
  it("scrolls upward over time", () => {
    const early = creditsScrollAt(100, SPEC, FRAME);
    const late = creditsScrollAt(250, SPEC, FRAME);
    expect(late.scrollY).toBeLessThan(early.scrollY);
    expect(late.progress).toBeGreaterThan(early.progress);
  });
  it("ends fully scrolled with progress 1", () => {
    const l = creditsScrollAt(300, SPEC, FRAME);
    expect(l.progress).toBe(1);
    expect(l.finished).toBe(true);
    expect(l.scrollY).toBe(FRAME.height - (creditsContentHeight(SPEC.rows, FRAME) + FRAME.height));
    expect(l.scrollY).toBe(-creditsContentHeight(SPEC.rows, FRAME));
  });
  it("clamps before start and after end", () => {
    expect(creditsScrollAt(-50, SPEC, FRAME).progress).toBe(0);
    expect(creditsScrollAt(-50, SPEC, FRAME).scrollY).toBe(FRAME.height);
    expect(creditsScrollAt(1000, SPEC, FRAME).progress).toBe(1);
    expect(creditsScrollAt(1000, SPEC, FRAME).scrollY).toBe(
      FRAME.height - (creditsContentHeight(SPEC.rows, FRAME) + FRAME.height),
    );
  });
  it("honors startFrame offset", () => {
    const shifted: CreditsTimeline = { ...SPEC, startFrame: 100 };
    expect(creditsScrollAt(50, shifted, FRAME).progress).toBe(0);
    expect(creditsScrollAt(100, shifted, FRAME).progress).toBe(0);
    expect(creditsScrollAt(150, shifted, FRAME).progress).toBeCloseTo(1 / 6, 5);
  });
  it("is deterministic", () => {
    expect(creditsScrollAt(137, SPEC, FRAME)).toEqual(creditsScrollAt(137, SPEC, FRAME));
  });
  it("firstVisible advances as rows scroll past the title block", () => {
    const early = creditsScrollAt(30, SPEC, FRAME);
    const late = creditsScrollAt(280, SPEC, FRAME);
    expect(late.firstVisible).toBeGreaterThanOrEqual(early.firstVisible);
    expect(late.visibleCount).toBeLessThanOrEqual(early.visibleCount);
  });
  it("guards degenerate duration", () => {
    const l = creditsScrollAt(5, { ...SPEC, durationFrames: 0 }, FRAME);
    expect(l.progress).toBe(1); // clamped: dur floor of 1 frame
  });

  it("guards degenerate frame width (no NaN firstVisible)", () => {
    for (const width of [0, Number.NaN]) {
      const l = creditsScrollAt(100, SPEC, { ...FRAME, width });
      expect(Number.isFinite(l.firstVisible), `width=${width}`).toBe(true);
      expect(l.firstVisible).toBeGreaterThanOrEqual(0);
      expect(l.firstVisible).toBeLessThanOrEqual(SPEC.rows.length);
      expect(Number.isFinite(l.scrollY)).toBe(true);
    }
  });
});