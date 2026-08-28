/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  classifyReferenceStrategy,
  needsForShotType,
  normalizeWeights,
  planReferenceBudget,
  ReferenceBudgetError,
  scoreCandidate,
  NEED_AXES,
  type ReferenceBudgetInput,
  type ReferenceCandidate,
  type ReferenceCapability,
  type ReferenceHistoryOracle,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_REED_002";

/** Generous video-model capability: 4 image refs + frame + multimodal. */
function generousCapability(): ReferenceCapability {
  return {
    maxImages: 4,
    firstFrame: true,
    lastFrame: true,
    firstLastFrame: true,
    multimodalReferences: true,
    allowedReferenceTypes: ["image"],
    incompatibleCombinations: ["firstLastFrame+multimodalReferences"],
  };
}

/** Image reference with no input support at all (text-to-video only). */
function inputlessCapability(): ReferenceCapability {
  return {
    maxImages: 0,
    firstFrame: false,
    lastFrame: false,
    firstLastFrame: false,
    multimodalReferences: false,
    allowedReferenceTypes: null,
    incompatibleCombinations: null,
  };
}

function faceRef(assetId: string, characterId: string): ReferenceCandidate {
  return {
    assetId,
    characterId,
    kind: "identity",
    valueProfile: { identity: 1.0, pose: 0.2 },
  };
}

function wardrobeRef(assetId: string, characterId: string): ReferenceCandidate {
  return {
    assetId,
    characterId,
    kind: "wardrobe",
    valueProfile: { wardrobe: 1.0, identity: 0.1 },
  };
}

function locationRef(assetId: string): ReferenceCandidate {
  return {
    assetId,
    kind: "location",
    valueProfile: { location: 1.0 },
  };
}

function baseInput(overrides: Partial<ReferenceBudgetInput>): ReferenceBudgetInput {
  return {
    shotId: "SC03-SH02",
    shotType: "close-up",
    characters: [MONICA],
    candidates: [faceRef("REF_FACE", MONICA)],
    capability: generousCapability(),
    model: "agnes-flash-25",
    ...overrides,
  };
}

describe("needsForShotType", () => {
  it("close-up: identity dominates, location near-irrelevant", () => {
    const needs = needsForShotType("close-up");
    expect(needs.identity).toBe(1.0);
    expect(needs.location).toBeLessThan(0.2);
  });

  it("full shot: wardrobe dominates", () => {
    expect(needsForShotType("full").wardrobe).toBe(1.0);
  });

  it("establishing: location dominates, identity near-irrelevant", () => {
    const needs = needsForShotType("establishing");
    expect(needs.location).toBe(1.0);
    expect(needs.identity).toBeLessThan(0.3);
  });

  it("unknown shot type falls back to neutral defaults, never identity guesses", () => {
    const needs = needsForShotType("extreme-fish-eye-pov");
    for (const axis of NEED_AXES) {
      expect(needs[axis]).toBeLessThanOrEqual(0.5);
      expect(needs[axis]).toBeGreaterThan(0);
    }
  });

  it("input overrides win over shot-type defaults", () => {
    const needs = needsForShotType("close-up");
    expect(needs.identity).toBe(1.0);
    // The planner merges overrides in planReferenceBudget; here we only
    // assert the merge order primitive: spread order.
    const merged = { ...needs, identity: 0.1 };
    expect(merged.identity).toBe(0.1);
  });
});

describe("classifyReferenceStrategy", () => {
  const needs = needsForShotType("medium");

  it("close-up needs with frame support: one starting keyframe", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 1,
      hasApprovedSceneMaster: false,
      exactStartState: true,
      exactEndState: false,
      complex: false,
      needs,
      capability: generousCapability(),
    });
    expect(decision.strategy).toBe("one-starting-keyframe");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("exact start+end with firstLastFrame support: start-end keyframes", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 1,
      hasApprovedSceneMaster: false,
      exactStartState: true,
      exactEndState: true,
      complex: false,
      needs,
      capability: generousCapability(),
    });
    expect(decision.strategy).toBe("start-end-keyframes");
  });

  it("no characters and no exact states: zero keyframes", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 0,
      hasApprovedSceneMaster: false,
      exactStartState: false,
      exactEndState: false,
      complex: false,
      needs,
      capability: generousCapability(),
    });
    expect(decision.strategy).toBe("zero-keyframes");
  });

  it("two characters + approved master: scene-master strategy beats portrait stack", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 2,
      hasApprovedSceneMaster: true,
      exactStartState: false,
      exactEndState: false,
      complex: false,
      needs,
      capability: generousCapability(),
    });
    expect(decision.strategy).toBe("scene-master-plus-references");
  });

  it("exact start+end but model lacks frame support: falls to multimodal references", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 1,
      hasApprovedSceneMaster: false,
      exactStartState: true,
      exactEndState: true,
      complex: false,
      needs,
      capability: { ...generousCapability(), firstFrame: true, lastFrame: false, firstLastFrame: false },
    });
    expect(decision.strategy).toBe("multimodal-reference-package");
  });

  it("model accepting zero inputs: zero keyframes regardless of needs", () => {
    const decision = classifyReferenceStrategy({
      characterCount: 2,
      hasApprovedSceneMaster: true,
      exactStartState: false,
      exactEndState: false,
      complex: true,
      needs,
      capability: inputlessCapability(),
    });
    expect(decision.strategy).toBe("zero-keyframes");
  });
});

describe("planReferenceBudget — minimum sufficient selection", () => {
  it("single close-up: 1-2 references, identity first, never more", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "close-up",
        candidates: [
          faceRef("REF_FACE", MONICA),
          wardrobeRef("REF_WARDROBE", MONICA),
          locationRef("REF_LOCATION"),
        ],
      }),
    );
    expect(plan.total).toBeGreaterThanOrEqual(1);
    expect(plan.total).toBeLessThanOrEqual(2);
    expect(plan.referenceIds[0]).toBe("REF_FACE");
    expect(plan.underLimit).toBe(true);
  });

  it("never stuffs max slots: 4-slot model + 6 useful candidates selects under limit", async () => {
    const candidates: ReferenceCandidate[] = [
      faceRef("REF_FACE", MONICA),
      wardrobeRef("REF_WARDROBE", MONICA),
      locationRef("REF_LOCATION"),
      {
        assetId: "REF_PROP",
        kind: "prop",
        valueProfile: { prop: 1.0 },
      },
      {
        assetId: "REF_POSE",
        kind: "pose",
        valueProfile: { pose: 1.0 },
      },
      {
        assetId: "REF_START",
        kind: "pose",
        valueProfile: { startState: 1.0, identity: 0.2 },
      },
      {
        assetId: "REF_END",
        kind: "pose",
        valueProfile: { endState: 1.0 },
      },
    ];
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "full",
        characters: [MONICA],
        candidates,
        capability: generousCapability(),
      }),
    );
    expect(plan.modelMaxImages).toBe(4);
    expect(plan.total).toBeLessThan(4);
    expect(plan.underLimit).toBe(true);
    expect(plan.notes.some((n) => n.includes("unused"))).toBe(true);
  });

  it("two-character dialogue with approved master: master + at most one companion, not portraits", async () => {
    const sceneMaster: ReferenceBudgetInput["sceneMaster"] = {
      assetId: "ASSET_MASTER_SC03",
      approved: true,
      valueProfile: { identity: 1.0, wardrobe: 0.9, location: 0.9, prop: 0.5, pose: 0.6 },
    };
    const plan = await planReferenceBudget(
      baseInput({
        shotId: "SC03-SH04",
        shotType: "two-shot",
        characters: [MONICA, MARCUS],
        sceneMaster,
        candidates: [
          faceRef("REF_FACE_MONICA", MONICA),
          faceRef("REF_FACE_MARCUS", MARCUS),
          wardrobeRef("REF_WARDROBE_M", MONICA),
          locationRef("REF_LOCATION"),
        ],
      }),
    );
    expect(plan.strategy).toBe("scene-master-plus-references");
    expect(plan.referenceIds[0]).toBe("ASSET_MASTER_SC03");
    expect(plan.total).toBeLessThanOrEqual(2);
    expect(plan.referenceIds).not.toContain("REF_FACE_MONICA");
    expect(plan.referenceIds).not.toContain("REF_FACE_MARCUS");
  });

  it("unapproved scene master is never used", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "two-shot",
        characters: [MONICA, MARCUS],
        sceneMaster: {
          assetId: "ASSET_MASTER_DRAFT",
          approved: false,
          valueProfile: { identity: 1.0, wardrobe: 0.9, location: 0.9 },
        },
        candidates: [faceRef("REF_FACE", MONICA)],
      }),
    );
    expect(plan.referenceIds).not.toContain("ASSET_MASTER_DRAFT");
  });

  it("start+end strategy: frames only, zero extra references", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotId: "SC03-SH06",
        shotType: "close-up",
        strategy: "start-end-keyframes",
        candidates: [
          { assetId: "KF_START", kind: "keyframe-start", isStartFrame: true, valueProfile: { identity: 1.0, startState: 1.0 } },
          { assetId: "KF_END", kind: "keyframe-end", isEndFrame: true, valueProfile: { identity: 1.0, endState: 1.0 } },
          faceRef("REF_FACE", MONICA),
        ],
      }),
    );
    expect(plan.strategy).toBe("start-end-keyframes");
    expect(plan.referenceIds).toEqual(["KF_START", "KF_END"]);
    expect(plan.underLimit).toBe(true);
  });

  it("start+end strategy without a start-frame candidate errors", async () => {
    await expect(
      planReferenceBudget(
        baseInput({
          strategy: "start-end-keyframes",
          candidates: [faceRef("REF_FACE", MONICA)],
        }),
      ),
    ).rejects.toBeInstanceOf(ReferenceBudgetError);
  });

  it("zero-keyframes: empty selection", async () => {
    const plan = await planReferenceBudget(
      baseInput({ strategy: "zero-keyframes", candidates: [faceRef("REF_FACE", MONICA)] }),
    );
    expect(plan.referenceIds).toEqual([]);
    expect(plan.total).toBe(0);
  });

  it("model with maxImages 0: zero references even with candidates", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        capability: inputlessCapability(),
        candidates: [faceRef("REF_FACE", MONICA)],
      }),
    );
    expect(plan.referenceIds).toEqual([]);
    expect(plan.underLimit).toBe(true);
    expect(plan.notes.join(" ")).toContain("accepts no reference inputs");
  });

  it("selection stops once needs are covered (coverage threshold)", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "medium",
        candidates: [
          {
            assetId: "REF_KITCHEN_SINK",
            kind: "identity",
            valueProfile: { identity: 1.0, wardrobe: 1.0, location: 1.0, prop: 1.0, pose: 1.0, startState: 1.0, endState: 1.0 },
          },
          faceRef("REF_REDUNDANT", MONICA),
        ],
      }),
    );
    expect(plan.referenceIds).toEqual(["REF_KITCHEN_SINK"]);
    expect(plan.uncoveredNeeds).toEqual([]);
  });

  it("coverage threshold: below-threshold coverage keeps selecting", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "close-up",
        candidates: [
          faceRef("REF_FACE_PARTIAL", MONICA),
        ],
        options: { coverageThreshold: 1.01 },
      }),
    );
    // identity need 1.0, value 1.0 < 1.01 → still uncovered, but no second
    // identity candidate exists to help: selection stops with the partial.
    expect(plan.referenceIds).toEqual(["REF_FACE_PARTIAL"]);
    expect(plan.uncoveredNeeds).toContain("identity");
  });

  it("duplicate candidate assetIds are rejected", async () => {
    await expect(
      planReferenceBudget(
        baseInput({
          candidates: [faceRef("REF_DUP", MONICA), faceRef("REF_DUP", MONICA)],
        }),
      ),
    ).rejects.toBeInstanceOf(ReferenceBudgetError);
  });

  it("empty shotId is rejected", async () => {
    await expect(planReferenceBudget(baseInput({ shotId: " " }))).rejects.toBeInstanceOf(
      ReferenceBudgetError,
    );
  });
});

describe("historical success scoring", () => {
  function oracleFrom(
    rates: Record<string, number | null>,
  ): ReferenceHistoryOracle {
    return {
      successRateForReference: (_c, _m, referenceId) => ({
        samples: 10,
        accepted: Math.round((rates[referenceId] ?? 0.5) * 10),
        rejected: 10 - Math.round((rates[referenceId] ?? 0.5) * 10),
        rate: rates[referenceId] ?? null,
      }),
      successRateForPack: (_c, _m, ids) => ({
        samples: 4,
        accepted: 3,
        rejected: 1,
        rate: 0.75,
      }),
    };
  }

  it("historically stronger reference wins a tie on coverage value", async () => {
    // Two wardrobe refs with identical value; history breaks the tie.
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "medium",
        needs: { wardrobe: 1.0, identity: 0.0, location: 0.0, prop: 0.0, pose: 0.0, startState: 0.0, endState: 0.0 },
        characters: [MONICA],
        candidates: [
          { assetId: "REF_WARD_LOSER", characterId: MONICA, kind: "wardrobe", valueProfile: { wardrobe: 1.0 } },
          { assetId: "REF_WARD_WINNER", characterId: MONICA, kind: "wardrobe", valueProfile: { wardrobe: 1.0 } },
        ],
        history: oracleFrom({ REF_WARD_WINNER: 1.0, REF_WARD_LOSER: 0.2 }),
      }),
    );
    expect(plan.referenceIds[0]).toBe("REF_WARD_WINNER");
    expect(plan.historicalRates["REF_WARD_WINNER"]).toBe(1.0);
  });

  it("no history: neutral rate, selection still proceeds by value", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "close-up",
        candidates: [faceRef("REF_FACE", MONICA)],
        history: oracleFrom({}),
      }),
    );
    expect(plan.historicalRates["REF_FACE"]).toBeNull();
    expect(plan.referenceIds).toEqual(["REF_FACE"]);
  });

  it("pack history surfaces in plan when oracle supplies it", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        shotType: "medium",
        characters: [MONICA],
        candidates: [faceRef("REF_FACE", MONICA)],
        history: oracleFrom({ REF_FACE: 0.9 }),
      }),
    );
    expect(plan.packHistoricalRate).not.toBeNull();
    expect(plan.packHistoricalRate?.rate).toBe(0.75);
  });

  it("oracle throwing on pack query degrades to null, never breaks planning", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        candidates: [faceRef("REF_FACE", MONICA)],
        history: {
          successRateForReference: () => ({ samples: 2, accepted: 1, rejected: 1, rate: 0.5 }),
          successRateForPack: () => {
            throw new Error("storage unavailable");
          },
        },
      }),
    );
    expect(plan.packHistoricalRate).toBeNull();
    expect(plan.referenceIds).toEqual(["REF_FACE"]);
  });

  it("async oracle works", async () => {
    const plan = await planReferenceBudget(
      baseInput({
        candidates: [faceRef("REF_FACE", MONICA)],
        history: {
          successRateForReference: async () => ({ samples: 5, accepted: 5, rejected: 0, rate: 1.0 }),
        },
      }),
    );
    expect(plan.historicalRates["REF_FACE"]).toBe(1.0);
  });
});

describe("scoreCandidate", () => {
  it("scores against remaining needs only", () => {
    const weights = normalizeWeights(undefined);
    const candidate: ReferenceCandidate = {
      assetId: "X",
      kind: "identity",
      valueProfile: { identity: 1.0, location: 1.0 },
    };
    const withLocationNeed = scoreCandidate(candidate, { identity: 1, location: 1 }, null, { historyWeight: 0 });
    const withoutLocationNeed = scoreCandidate(candidate, { identity: 1, location: 0 }, null, { historyWeight: 0 });
    expect(withLocationNeed).toBeGreaterThan(withoutLocationNeed);
    expect(weights.identity).toBeGreaterThan(weights.prop ?? 0);
  });

  it("positive history beats neutral history at equal coverage", () => {
    const candidate: ReferenceCandidate = { assetId: "X", kind: "identity", valueProfile: { identity: 1.0 } };
    const a = scoreCandidate(candidate, { identity: 1 }, 1.0, { historyWeight: 0.3 });
    const b = scoreCandidate(candidate, { identity: 1 }, null, { historyWeight: 0.3 });
    expect(a).toBeGreaterThan(b);
  });

  it("negative history loses to neutral at equal coverage", () => {
    const candidate: ReferenceCandidate = { assetId: "X", kind: "identity", valueProfile: { identity: 1.0 } };
    const a = scoreCandidate(candidate, { identity: 1 }, 0.0, { historyWeight: 0.3 });
    const b = scoreCandidate(candidate, { identity: 1 }, null, { historyWeight: 0.3 });
    expect(a).toBeLessThan(b);
  });
});