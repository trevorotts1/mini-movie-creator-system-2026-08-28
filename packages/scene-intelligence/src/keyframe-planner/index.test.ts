/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  classifyShotKeyframes,
  isKeyframeStrategy,
  KEYFRAME_STRATEGIES,
  KeyframePlannerError,
  planKeyframes,
  type KeyframeCapabilityProfile,
  type ShotKeyframeInput,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_REED_002";

/* Real-shaped profiles (values match CAP-002 capability data: Agnes Video 2.5
 * Flash has full frame anchoring + multimodal references, maxImages 5; the
 * no-capability profile mirrors unknownReferencesCapability() defaults with
 * maxImages 0). */
const AGNES_LIKE: KeyframeCapabilityProfile = {
  firstFrame: true,
  lastFrame: true,
  firstLastFrame: true,
  multimodalReferences: true,
  maxImages: 5,
};

const TEXT_ONLY: KeyframeCapabilityProfile = {
  firstFrame: false,
  lastFrame: false,
  firstLastFrame: false,
  multimodalReferences: false,
  maxImages: 0,
};

const FIRST_FRAME_ONLY: KeyframeCapabilityProfile = {
  firstFrame: true,
  lastFrame: false,
  firstLastFrame: false,
  multimodalReferences: false,
  maxImages: 1,
};

const SCENE_MASTER_ONLY: KeyframeCapabilityProfile = {
  firstFrame: false,
  lastFrame: false,
  firstLastFrame: false,
  multimodalReferences: false,
  maxImages: 5,
};

function shot(overrides: Partial<ShotKeyframeInput> = {}): ShotKeyframeInput {
  return {
    shotId: "SC03-SH04",
    sceneId: "SC03",
    characters: [MONICA],
    shotType: "close-up",
    ...overrides,
  };
}

describe("keyframe strategies (spec §8 mutual exclusivity)", () => {
  it("exposes exactly the five spec strategies", () => {
    expect([...KEYFRAME_STRATEGIES]).toEqual([
      "zero",
      "one-start",
      "start-end",
      "scene-master-refs",
      "multimodal-package",
    ]);
  });

  it("classifies a plain single-character shot as zero keyframes", () => {
    const d = classifyShotKeyframes(shot(), AGNES_LIKE);
    expect(d.strategy).toBe("zero");
    expect(d.keyframeCount).toBe(0);
    expect(d.signals.multiCharacter).toBe(false);
    expect(d.reason).toContain("text-to-video acceptable");
  });

  it("classifies an exact-start shot as one-start on a first-frame model", () => {
    const d = classifyShotKeyframes(shot({ needsExactStart: true }), AGNES_LIKE);
    expect(d.strategy).toBe("one-start");
    expect(d.keyframeCount).toBe(1);
  });

  it("classifies an exact-end-only request as start-end when the model anchors both frames (precise transition)", () => {
    const d = classifyShotKeyframes(shot({ needsExactEnd: true }), AGNES_LIKE);
    expect(d.strategy).toBe("start-end");
    expect(d.keyframeCount).toBe(2);
    expect(d.signals.needsStart).toBe(true);
    expect(d.signals.needsEnd).toBe(true);
  });

  it("downgrades an exact-end-only request to one-start when last-frame anchoring is unsupported", () => {
    const d = classifyShotKeyframes(shot({ needsExactEnd: true }), FIRST_FRAME_ONLY);
    expect(d.strategy).toBe("one-start");
    expect(d.keyframeCount).toBe(1);
    expect(d.downgraded.join(" ")).toContain("no last-frame anchoring");
  });

  it("classifies exact start+end as start-end when both frames are anchored", () => {
    const d = classifyShotKeyframes(shot({ needsExactStart: true, needsExactEnd: true }), AGNES_LIKE);
    expect(d.strategy).toBe("start-end");
    expect(d.keyframeCount).toBe(2);
  });

  it("classifies a multi-character shot with an approved scene master as scene-master-refs", () => {
    const d = classifyShotKeyframes(
      shot({
        characters: [MONICA, MARCUS],
        sceneMasterAvailable: true,
        shotType: "two-shot",
      }),
      SCENE_MASTER_ONLY,
    );
    expect(d.strategy).toBe("scene-master-refs");
    expect(d.keyframeCount).toBe(0);
    expect(d.reason).toContain("scene master");
  });

  it("classifies a complex scene as multimodal-package only when the model supports it", () => {
    const complex = { complexScene: true, characters: [MONICA] };
    expect(classifyShotKeyframes(shot(complex), AGNES_LIKE).strategy).toBe(
      "multimodal-package",
    );
    expect(classifyShotKeyframes(shot(complex), TEXT_ONLY).strategy).toBe("zero");
  });
});

describe("mutual exclusivity across the decision surface", () => {
  const cases: { label: string; input: ShotKeyframeInput; profile: KeyframeCapabilityProfile }[] = [
    {
      label: "plain shot / agnes-like",
      input: shot(),
      profile: AGNES_LIKE,
    },
    {
      label: "exact start / agnes-like",
      input: shot({ needsExactStart: true }),
      profile: AGNES_LIKE,
    },
    {
      label: "exact both / agnes-like",
      input: shot({ needsExactStart: true, needsExactEnd: true }),
      profile: AGNES_LIKE,
    },
    {
      label: "two-character scene master / scene-master-only",
      input: shot({ characters: [MONICA, MARCUS], sceneMasterAvailable: true }),
      profile: SCENE_MASTER_ONLY,
    },
    {
      label: "complex scene / agnes-like",
      input: shot({ complexScene: true }),
      profile: AGNES_LIKE,
    },
    {
      label: "complex scene / text-only",
      input: shot({ complexScene: true }),
      profile: TEXT_ONLY,
    },
  ];

  it("yields exactly one strategy per shot in every case", () => {
    for (const { label, input, profile } of cases) {
      const d = classifyShotKeyframes(input, profile);
      expect(KEYFRAME_STRATEGIES, label).toContain(d.strategy);
    }
  });

  it("keyframeCount agrees with the strategy across all five strategies", () => {
    const counts: Record<string, number> = {};
    for (const { input, profile } of cases) {
      const d = classifyShotKeyframes(input, profile);
      counts[d.strategy] = d.keyframeCount;
    }
    expect(counts["zero"]).toBe(0);
    expect(counts["one-start"]).toBe(1);
    expect(counts["start-end"]).toBe(2);
    expect(counts["scene-master-refs"]).toBe(0);
    expect(counts["multimodal-package"]).toBe(0);
  });
});

describe("classification changes when the capability profile changes", () => {
  it("same transition shot: start-end on anchoring model, zero on text-only", () => {
    const transition = shot({ needsExactStart: true, needsExactEnd: true });
    const onAgnes = classifyShotKeyframes(transition, AGNES_LIKE);
    const onTextOnly = classifyShotKeyframes(transition, TEXT_ONLY);

    expect(onAgnes.strategy).toBe("start-end");
    expect(onTextOnly.strategy).toBe("zero");
    expect(onAgnes.keyframeCount).not.toBe(onTextOnly.keyframeCount);
  });

  it("same multi-character shot: scene-master-refs with scene-master profile, zero with image-0 profile", () => {
    const twoShot = shot({
      characters: [MONICA, MARCUS],
      sceneMasterAvailable: true,
    });
    expect(classifyShotKeyframes(twoShot, SCENE_MASTER_ONLY).strategy).toBe(
      "scene-master-refs",
    );
    expect(classifyShotKeyframes(twoShot, TEXT_ONLY).strategy).toBe("zero");
  });

  it("same complex shot: multimodal-package with multimodal support, zero without", () => {
    const complex = shot({ complexScene: true });
    expect(classifyShotKeyframes(complex, AGNES_LIKE).strategy).toBe(
      "multimodal-package",
    );
    expect(classifyShotKeyframes(complex, FIRST_FRAME_ONLY).strategy).toBe("zero");
  });

  it("first+last separately supported implies both-frame anchoring", () => {
    const separate = { ...AGNES_LIKE, firstLastFrame: false };
    const d = classifyShotKeyframes(
      shot({ needsExactStart: true, needsExactEnd: true }),
      separate,
    );
    expect(d.strategy).toBe("start-end");
  });

  it("downgrades exact end to one-start when the model lacks last-frame anchoring", () => {
    const d = classifyShotKeyframes(
      shot({ needsExactStart: true, needsExactEnd: true }),
      FIRST_FRAME_ONLY,
    );
    expect(d.strategy).toBe("one-start");
    expect(d.downgraded.join(" ")).toContain("no last-frame anchoring");
  });

  it("downgrades to zero when anchoring is requested on a model with no frame support", () => {
    const d = classifyShotKeyframes(
      shot({ needsExactStart: true, needsExactEnd: true }),
      TEXT_ONLY,
    );
    expect(d.strategy).toBe("zero");
    expect(d.downgraded.length).toBeGreaterThan(0);
  });
});

describe("planning a shot sequence", () => {
  const sequence: ShotKeyframeInput[] = [
    {
      shotId: "SC03-SH01",
      sceneId: "SC03",
      shotType: "establishing",
      complexScene: true,
    },
    {
      shotId: "SC03-SH04",
      sceneId: "SC03",
      characters: [MONICA, MARCUS],
      shotType: "two-shot",
      sceneMasterAvailable: true,
    },
    {
      shotId: "SC03-SH06",
      sceneId: "SC03",
      characters: [MARCUS],
      needsExactStart: true,
      needsExactEnd: true,
    },
  ];

  it("produces one mutually exclusive decision per shot with O(1) lookup", () => {
    const plan = planKeyframes(sequence, AGNES_LIKE, { modelLabel: "agnes-video-2.5-flash" });
    expect(plan.modelLabel).toBe("agnes-video-2.5-flash");
    expect(plan.decisions).toHaveLength(3);
    expect(Object.keys(plan.byShot)).toEqual([
      "SC03-SH01",
      "SC03-SH04",
      "SC03-SH06",
    ]);
    expect(plan.byShot["SC03-SH01"]?.strategy).toBe("multimodal-package");
    expect(plan.byShot["SC03-SH04"]?.strategy).toBe("scene-master-refs");
    expect(plan.byShot["SC03-SH06"]?.strategy).toBe("start-end");
  });

  it("rejects duplicate and empty shotIds", () => {
    expect(() =>
      planKeyframes([shot(), shot()], AGNES_LIKE),
    ).toThrow(KeyframePlannerError);
    expect(() =>
      planKeyframes([{ shotId: "", sceneId: "SC03" }], AGNES_LIKE),
    ).toThrow(KeyframePlannerError);
  });

  it("maxImages 0 blocks scene-master classification; UNKNOWN (null) does not", () => {
    const twoShot = shot({ characters: [MONICA, MARCUS], sceneMasterAvailable: true });

    const zeroSlots = classifyShotKeyframes(twoShot, { ...SCENE_MASTER_ONLY, maxImages: 0 });
    expect(zeroSlots.strategy).toBe("zero");

    const unknownSlots = classifyShotKeyframes(twoShot, { ...SCENE_MASTER_ONLY, maxImages: null });
    expect(unknownSlots.strategy).toBe("scene-master-refs");
  });
});

describe("runtime strategy guard", () => {
  it("isKeyframeStrategy accepts known strategies and rejects foreign values", () => {
    for (const s of KEYFRAME_STRATEGIES) {
      expect(isKeyframeStrategy(s)).toBe(true);
    }
    expect(isKeyframeStrategy("start+end")).toBe(false);
    expect(isKeyframeStrategy(undefined)).toBe(false);
    expect(isKeyframeStrategy(42)).toBe(false);
  });
});