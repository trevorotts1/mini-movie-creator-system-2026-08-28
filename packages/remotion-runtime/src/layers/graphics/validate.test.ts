import { describe, expect, it } from "vitest";

import { graphicsPlanIsValid, validateGraphicsPlan, type GraphicsIssue } from "./index.js";
import type { GraphicsItemSpec, ShotPlanRef } from "./types.js";

const SHOTS: ShotPlanRef[] = [
  { shotId: "SH01", frameIn: 0, frameOut: 180 },
  { shotId: "SH02", frameIn: 180, frameOut: 360 },
];

const CLEAN: GraphicsItemSpec[] = [
  { id: "t", kind: "title", shotId: "SH01", text: ["THE LONG NIGHT"] },
  { id: "k", kind: "kicker", shotId: "SH01", text: "S01E03" },
  { id: "lt", kind: "lowerThird", shotId: "SH02", text: "Monica Bennett", subtext: "Detective" },
  { id: "ov", kind: "overlay", frameFrom: 0, frameTo: 120, panel: { title: "3:12 AM" } },
  { id: "cr", kind: "credit", frameFrom: 360, frameTo: 660 },
];

describe("validateGraphicsPlan", () => {
  it("clean plan produces no errors", () => {
    const issues = validateGraphicsPlan(CLEAN, SHOTS);
    expect(issues.filter((i: GraphicsIssue) => i.severity === "error")).toEqual([]);
  });

  it("missing id is an error", () => {
    const issues = validateGraphicsPlan([{ id: "", kind: "title", text: "x" }], SHOTS);
    expect(issues.some((i) => i.code === "empty-id" && i.severity === "error")).toBe(true);
  });

  it("duplicate ids are errors", () => {
    const issues = validateGraphicsPlan(
      [
        { id: "dup", kind: "title", text: "a" },
        { id: "dup", kind: "title", text: "b" },
      ],
      SHOTS,
    );
    expect(issues.filter((i) => i.code === "duplicate-id")).toHaveLength(1);
    expect(issues.find((i) => i.code === "duplicate-id")?.severity).toBe("error");
  });

  it("unknown kind is an error", () => {
    const issues = validateGraphicsPlan(
      [{ id: "x", kind: "hologram" as unknown as GraphicsItemSpec["kind"], text: "x" }],
      SHOTS,
    );
    expect(issues.some((i) => i.code === "unknown-kind" && i.severity === "error")).toBe(true);
  });

  it("absolute frameTo <= frameFrom is an error", () => {
    const issues = validateGraphicsPlan([{ id: "x", kind: "overlay", frameFrom: 100, frameTo: 100 }], SHOTS);
    expect(issues.some((i) => i.code === "bad-frame-range")).toBe(true);
  });

  it("binding an unknown shot is an error", () => {
    const issues = validateGraphicsPlan([{ id: "x", kind: "title", shotId: "GHOST", text: "x" }], SHOTS);
    expect(issues.some((i) => i.code === "unknown-shot" && i.severity === "error")).toBe(true);
  });

  it("text-bearing kind without text is a warning, not an error", () => {
    const issues = validateGraphicsPlan([{ id: "x", kind: "title", shotId: "SH01" }], SHOTS);
    const w = issues.find((i) => i.code === "empty-text");
    expect(w?.severity).toBe("warning");
  });

  it("credits may omit text (rows come from the credits block)", () => {
    const issues = validateGraphicsPlan([{ id: "cr", kind: "credit", frameFrom: 0, frameTo: 30 }], SHOTS);
    expect(issues.some((i) => i.code === "empty-text")).toBe(false);
  });

  it("same-kind timeline overlap is a warning", () => {
    const issues = validateGraphicsPlan(
      [
        { id: "a", kind: "title", frameFrom: 0, frameTo: 100, text: "A" },
        { id: "b", kind: "title", frameFrom: 50, frameTo: 120, text: "B" },
      ],
      SHOTS,
    );
    expect(issues.some((i) => i.code === "overlap" && i.severity === "warning")).toBe(true);
  });

  it("different kinds may overlap freely (title over overlay)", () => {
    const issues = validateGraphicsPlan(
      [
        { id: "a", kind: "title", frameFrom: 0, frameTo: 100, text: "A" },
        { id: "b", kind: "logo", frameFrom: 50, frameTo: 120 },
      ],
      SHOTS,
    );
    expect(issues.some((i) => i.code === "overlap")).toBe(false);
  });
});

describe("graphicsPlanIsValid", () => {
  it("true for clean plans", () => {
    expect(graphicsPlanIsValid(CLEAN, SHOTS)).toBe(true);
  });
  it("false when any error exists (warnings alone keep it valid)", () => {
    expect(graphicsPlanIsValid([{ id: "x", kind: "title", shotId: "GHOST" }], SHOTS)).toBe(false);
    expect(graphicsPlanIsValid([{ id: "x", kind: "title", shotId: "SH01" }], SHOTS)).toBe(true);
  });
});