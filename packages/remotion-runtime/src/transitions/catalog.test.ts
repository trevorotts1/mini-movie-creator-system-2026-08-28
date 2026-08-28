import { describe, expect, it } from "vitest";
import {
  TRANSITION_CATALOG,
  TRANSITION_KINDS,
  WIPE_DIRECTIONS,
  defaultDurationFramesFor,
  isTransitionKind,
  isWipeDirection,
} from "./catalog";

describe("transition catalog", () => {
  it("exposes the minimum required kinds: cut, crossfade, wipe", () => {
    expect(TRANSITION_KINDS).toEqual(["cut", "crossfade", "wipe"]);
    expect(TRANSITION_CATALOG.cut).toBeDefined();
    expect(TRANSITION_CATALOG.crossfade).toBeDefined();
    expect(TRANSITION_CATALOG.wipe).toBeDefined();
  });

  it("documents every kind with a description and a non-negative default", () => {
    for (const kind of TRANSITION_KINDS) {
      const def = TRANSITION_CATALOG[kind];
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.defaultDurationFrames).toBeGreaterThanOrEqual(0);
    }
  });

  it("treats cut as zero-overlap regardless of catalog default", () => {
    expect(defaultDurationFramesFor("cut")).toBe(0);
    expect(TRANSITION_CATALOG.cut.defaultDurationFrames).toBe(0);
  });

  it("isTransitionKind accepts only catalog kinds", () => {
    expect(isTransitionKind("cut")).toBe(true);
    expect(isTransitionKind("crossfade")).toBe(true);
    expect(isTransitionKind("wipe")).toBe(true);
    expect(isTransitionKind("zoom")).toBe(false);
    expect(isTransitionKind("")).toBe(false);
  });

  it("lists four wipe directions and recognizes them", () => {
    expect(WIPE_DIRECTIONS).toEqual([
      "left-to-right",
      "right-to-left",
      "top-to-bottom",
      "bottom-to-top",
    ]);
    for (const direction of WIPE_DIRECTIONS) {
      expect(isWipeDirection(direction)).toBe(true);
    }
    expect(isWipeDirection("diagonal")).toBe(false);
  });
});
