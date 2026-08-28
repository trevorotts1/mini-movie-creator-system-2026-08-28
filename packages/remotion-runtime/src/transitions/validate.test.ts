import { describe, expect, it } from "vitest";
import { validateTransitionPlan } from "./validate";
import type { TransitionPlan } from "./types";

const validPlan: TransitionPlan = {
  fps: 30,
  shots: [
    { id: "s1", durationInFrames: 90 },
    { id: "s2", durationInFrames: 60, transition: { kind: "crossfade", durationFrames: 12 } },
    { id: "s3", durationInFrames: 60, transition: { kind: "wipe", direction: "left-to-right" } },
  ],
};

describe("validateTransitionPlan", () => {
  it("accepts a valid plan", () => {
    const result = validateTransitionPlan(validPlan);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects non-positive or non-finite fps", () => {
    expect(validateTransitionPlan({ ...validPlan, fps: 0 }).valid).toBe(false);
    expect(validateTransitionPlan({ ...validPlan, fps: -30 }).valid).toBe(false);
    expect(validateTransitionPlan({ ...validPlan, fps: Number.NaN }).valid).toBe(false);
  });

  it("rejects non-positive or non-integer shot durations", () => {
    const plan: TransitionPlan = { fps: 30, shots: [{ id: "s1", durationInFrames: 0 }] };
    const result = validateTransitionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("durationInFrames");
  });

  it("rejects unknown transition kinds", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        { id: "s1", durationInFrames: 60 },
        { id: "s2", durationInFrames: 60, transition: { kind: "dissolve-slow" as never } },
      ],
    };
    const result = validateTransitionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("unknown transition kind");
  });

  it("requires a known direction on wipe transitions", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        { id: "s1", durationInFrames: 60 },
        { id: "s2", durationInFrames: 60, transition: { kind: "wipe" } },
      ],
    };
    const result = validateTransitionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("wipe transition requires a known direction");
  });

  it("rejects non-positive or non-integer declared durations and only reports the bad shot", () => {
    const plan: TransitionPlan = {
      fps: 30,
      shots: [
        { id: "s1", durationInFrames: 60 },
        { id: "s2", durationInFrames: 60, transition: { kind: "crossfade", durationFrames: -3 } },
        { id: "s3", durationInFrames: 60, transition: { kind: "crossfade", durationFrames: 7.5 } },
      ],
    };
    const result = validateTransitionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.join("\n")).toContain("s2");
    expect(result.issues.join("\n")).toContain("s3");
  });

  it("collects multiple independent issues in one pass", () => {
    const plan: TransitionPlan = {
      fps: -1,
      shots: [
        { id: "s1", durationInFrames: 0 },
        { id: "s2", durationInFrames: 60, transition: { kind: "glitch" as never, durationFrames: 0 } },
      ],
    };
    const result = validateTransitionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
