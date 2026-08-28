/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  classifyShotKeyframes,
  planKeyframes,
  type KeyframeCapabilityProfile,
  type ShotKeyframeInput,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_REED_002";

function grid(
  input: ShotKeyframeInput,
): { profile: KeyframeCapabilityProfile; label: string }[] {
  const profiles: { profile: KeyframeCapabilityProfile; label: string }[] = [];
  for (const firstFrame of [false, true]) {
    for (const lastFrame of [false, true]) {
      for (const firstLastFrame of [false, true]) {
        for (const multimodalReferences of [false, true]) {
          for (const maxImages of [0, 1, 5, null]) {
            profiles.push({
              label: `ff=${firstFrame} lf=${lastFrame} flf=${firstLastFrame} mm=${multimodalReferences} mi=${maxImages}`,
              profile: {
                firstFrame,
                lastFrame,
                firstLastFrame,
                multimodalReferences,
                maxImages: maxImages as number | null,
              },
            });
          }
        }
      }
    }
  }
  return profiles;
}

const shots: ShotKeyframeInput[] = [
  { shotId: "A", sceneId: "S", characters: [MONICA] },
  { shotId: "B", sceneId: "S", characters: [MONICA], needsExactStart: true },
  { shotId: "C", sceneId: "S", characters: [MONICA], needsExactEnd: true },
  {
    shotId: "D",
    sceneId: "S",
    characters: [MONICA],
    needsExactStart: true,
    needsExactEnd: true,
  },
  {
    shotId: "E",
    sceneId: "S",
    characters: [MONICA, MARCUS],
    sceneMasterAvailable: true,
  },
  { shotId: "F", sceneId: "S", characters: [MONICA], complexScene: true },
  {
    shotId: "G",
    sceneId: "S",
    characters: [MONICA, MARCUS],
    sceneMasterAvailable: true,
    needsExactStart: true,
  },
  {
    shotId: "H",
    sceneId: "S",
    characters: [MONICA],
    complexScene: true,
    needsExactStart: true,
    needsExactEnd: true,
  },
];

describe("property grid: strategy invariants hold for every profile", () => {
  it("every decision satisfies the strategy's own preconditions", () => {
    for (const s of shots) {
      for (const { profile, label } of grid(s)) {
        const d = classifyShotKeyframes(s, profile);
        switch (d.strategy) {
          case "start-end":
            expect(
              d.signals.needsStart && d.signals.needsEnd && d.signals.bothFramesSupported,
              `${label} / ${s.shotId}: ${d.strategy} but preconditions false`,
            ).toBe(true);
            break;
          case "one-start":
            expect(
              d.signals.needsStart && d.signals.startSupported,
              `${label} / ${s.shotId}: ${d.strategy} but preconditions false`,
            ).toBe(true);
            break;
          case "scene-master-refs":
            expect(
              d.signals.sceneMasterApplicable,
              `${label} / ${s.shotId}: ${d.strategy} but preconditions false`,
            ).toBe(true);
            break;
          case "multimodal-package":
            expect(
              d.signals.multimodalApplicable,
              `${label} / ${s.shotId}: ${d.strategy} but preconditions false`,
            ).toBe(true);
            break;
          case "zero":
            break;
        }
      }
    }
  });

  it("an unmet requirement always records a downgrade naming the dropped requirement", () => {
    for (const s of shots) {
      for (const { profile, label } of grid(s)) {
        const d = classifyShotKeyframes(s, profile);
        // firstLastFrame (keyframe mode) anchors both frames in one call, so a
        // shot is only missing its start anchor when NEITHER individual nor
        // pair anchoring is available.
        if (d.signals.needsStart && !d.signals.startSupported && !d.signals.bothFramesSupported) {
          expect(
            d.downgraded.some((x) => x.includes("start")),
            `${label} / ${s.shotId}: start unsupported but no start downgrade recorded`,
          ).toBe(true);
        }
        if (d.signals.needsEnd && !d.signals.bothFramesSupported) {
          expect(
            d.downgraded.some((x) => x.includes("end")),
            `${label} / ${s.shotId}: end unsupported but no end downgrade recorded`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("qc regression: silent end-drop in reference branches", () => {
  const profile: KeyframeCapabilityProfile = {
    firstFrame: false,
    lastFrame: false,
    firstLastFrame: false,
    multimodalReferences: true,
    maxImages: 5,
  };

  it("scene-master branch downgrades a dropped exact end explicitly", () => {
    const d = classifyShotKeyframes(
      {
        shotId: "E2",
        sceneId: "S",
        characters: [MONICA, MARCUS],
        sceneMasterAvailable: true,
        needsExactEnd: true,
      },
      profile,
    );
    expect(d.strategy).toBe("scene-master-refs");
    expect(d.downgraded.join(" ")).toContain("start/end dropped");
  });

  it("multimodal branch downgrades a dropped exact end explicitly", () => {
    const d = classifyShotKeyframes(
      {
        shotId: "F2",
        sceneId: "S",
        characters: [MONICA],
        complexScene: true,
        needsExactEnd: true,
      },
      profile,
    );
    expect(d.strategy).toBe("multimodal-package");
    expect(d.downgraded.join(" ")).toContain("start/end dropped");
  });
});

describe("qc regression: prototype-polluting shotIds", () => {
  it("planKeyframes keeps __proto__ and constructor as own keys", () => {
    const plan = planKeyframes(
      [
        { shotId: "__proto__", sceneId: "S" },
        { shotId: "constructor", sceneId: "S" },
        { shotId: "SC03-SH01", sceneId: "S" },
      ],
      {
        firstFrame: true,
        lastFrame: true,
        firstLastFrame: true,
        multimodalReferences: true,
        maxImages: 5,
      },
    );
    expect(Object.keys(plan.byShot).sort()).toEqual([
      "SC03-SH01",
      "__proto__",
      "constructor",
    ]);
    expect(plan.byShot["__proto__"]?.shotId).toBe("__proto__");
    expect(plan.byShot["constructor"]?.shotId).toBe("constructor");
    expect(plan.decisions).toHaveLength(3);
  });
});

describe("qc regression: false downgrade message", () => {
  it("names the missing first-frame anchor, not 'no frame anchoring', when the model anchors last frames", () => {
    const profile: KeyframeCapabilityProfile = {
      firstFrame: false,
      lastFrame: true,
      firstLastFrame: false,
      multimodalReferences: false,
      maxImages: 0,
    };
    const d = classifyShotKeyframes(
      { shotId: "C2", sceneId: "S", needsExactEnd: true },
      profile,
    );
    expect(d.strategy).toBe("zero");
    expect(d.downgraded.join(" ")).toContain("cannot anchor a first frame");
    expect(d.downgraded.join(" ")).not.toContain("has no frame anchoring");
  });
});
