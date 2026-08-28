/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  assertNotProviderInput,
  approveSceneMasterSpec,
  classifySceneMasterNeed,
  createInternalStoryboardImage,
  createSceneMasterSpec,
  filterProviderEligibleImages,
  isProviderEligibleImage,
  NON_PROVIDER_INPUT_MARKER,
  planSceneMasters,
  SceneMasterError,
  type SceneMasterSpec,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_REED_002";

/** Monica/Marcus two-hander office scene (spec §7 example shape). */
function twoCharacterScene() {
  return {
    sceneId: "SC03",
    characters: [MONICA, MARCUS],
    speakingCharacters: [MONICA, MARCUS],
    shots: [
      { shotId: "SC03-SH01", characters: [MONICA], shotType: "establishing" },
      { shotId: "SC03-SH04", characters: [MONICA, MARCUS], shotType: "two-shot" },
    ],
    importance: "high" as const,
  };
}

function monicaMarcusSpec(): SceneMasterSpec {
  return createSceneMasterSpec({
    sceneId: "SC03",
    episodeCode: "S01E01",
    identities: [
      {
        characterId: MONICA,
        identityVersion: "v1",
        hairVersion: "long-braids-v1",
        wardrobeVersion: "business-blue-v1",
        displayName: "Monica Bennett",
      },
      {
        characterId: MARCUS,
        identityVersion: "v1",
        wardrobeVersion: "casual-charcoal-v1",
      },
    ],
    room: {
      locationId: "LOC_NEWSROOM_001",
      roomName: "open-plan newsroom",
      timeOfDay: "day",
      environmentNotes: "desks, monitors, glass meeting room in background",
    },
    lighting: { scheme: "cool overhead fluorescents with warm desk practicals" },
    props: [
      { propId: "PROP_LAPTOP_001", name: "laptop", placement: "center desk", handledByCharacterId: MONICA },
      { name: "coffee mug", placement: "Marcus's desk" },
    ],
    positions: [
      { characterId: MONICA, position: "center-left", facing: "toward-right", notes: "seated" },
      { characterId: MARCUS, position: "center-right", facing: "toward-left", notes: "standing" },
    ],
  });
}

describe("classifySceneMasterNeed", () => {
  it("flags an important multi-character scene for a Scene Master Image", () => {
    const need = classifySceneMasterNeed(twoCharacterScene());
    expect(need.requiresSceneMaster).toBe(true);
    expect(need.signals.multiCharacter).toBe(true);
    expect(need.signals.dialogueBetweenCharacters).toBe(true);
    expect(need.signals.hasMultiCharacterShot).toBe(true);
    expect(need.signals.characterCount).toBe(2);
    expect(need.reason).toContain("importance score");
  });

  it("does not flag a single-character scene", () => {
    const need = classifySceneMasterNeed({
      sceneId: "SC05",
      characters: [MONICA],
      speakingCharacters: [MONICA],
      shots: [{ shotId: "SC05-SH01", characters: [MONICA], shotType: "close-up" }],
      importance: "high",
    });
    expect(need.requiresSceneMaster).toBe(false);
    expect(need.signals.multiCharacter).toBe(false);
  });

  it("does not flag a multi-character scene below the importance threshold", () => {
    const need = classifySceneMasterNeed({
      sceneId: "SC07",
      characters: [MONICA, MARCUS],
      importance: "normal",
    });
    expect(need.requiresSceneMaster).toBe(false);
    expect(need.signals.multiCharacter).toBe(true);
    // normal(1) + no dialogue bonus + no multi-character shots = 1 < 2
    expect(need.signals.importanceScore).toBe(1);
  });

  it("flags a normal-importance scene when two characters speak and share a two-shot", () => {
    const need = classifySceneMasterNeed({
      sceneId: "SC08",
      characters: [MONICA, MARCUS],
      speakingCharacters: [MONICA, MARCUS],
      shots: [{ shotId: "SC08-SH02", characters: [MONICA, MARCUS] }],
      importance: "normal",
    });
    // normal(1) + dialogue(2) + two-shot(1) = 4 >= 2
    expect(need.requiresSceneMaster).toBe(true);
    expect(need.signals.importanceScore).toBe(4);
  });

  it("counts shot-level multi-character framing without dialogue", () => {
    const need = classifySceneMasterNeed({
      sceneId: "SC09",
      characters: [MONICA, MARCUS],
      shots: [{ shotId: "SC09-SH01", characters: [MONICA, MARCUS] }],
      importance: "hero",
    });
    expect(need.requiresSceneMaster).toBe(true);
    expect(need.signals.dialogueBetweenCharacters).toBe(false);
  });

  it("throws on an empty sceneId", () => {
    expect(() =>
      classifySceneMasterNeed({ sceneId: "", characters: [MONICA, MARCUS], importance: "high" }),
    ).toThrow(SceneMasterError);
  });

  it("rejects a missing or non-array characters list with SceneMasterError, not a TypeError", () => {
    expect(() =>
      classifySceneMasterNeed({
        sceneId: "SC03",
        characters: undefined as unknown as string[],
        importance: "high",
      }),
    ).toThrow(/scene.characters must be an array/);
    expect(() =>
      classifySceneMasterNeed({
        sceneId: "SC03",
        characters: "Monica,Marcus" as unknown as string[],
        importance: "high",
      }),
    ).toThrow(/scene.characters must be an array/);
  });

  it("rejects an unknown importance level instead of producing a NaN score", () => {
    expect(() =>
      classifySceneMasterNeed({
        sceneId: "SC03",
        characters: [MONICA, MARCUS],
        importance: "critical" as unknown as "high",
      }),
    ).toThrow(/unknown importance/);
    // NaN score would silently fall below the threshold and drop the flag.
    const need = classifySceneMasterNeed(twoCharacterScene());
    expect(Number.isFinite(need.signals.importanceScore)).toBe(true);
  });
});

describe("createSceneMasterSpec", () => {
  it("carries identities, wardrobe, room, lighting, props, and positions", () => {
    const spec = monicaMarcusSpec();
    expect(spec.sceneId).toBe("SC03");
    expect(spec.identities).toHaveLength(2);
    expect(spec.identities[0]).toMatchObject({
      characterId: MONICA,
      identityVersion: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
    });
    expect(spec.identities[1]?.wardrobeVersion).toBe("casual-charcoal-v1");
    expect(spec.room.roomName).toBe("open-plan newsroom");
    expect(spec.room.locationId).toBe("LOC_NEWSROOM_001");
    expect(spec.lighting.scheme).toContain("fluorescents");
    expect(spec.props).toHaveLength(2);
    expect(spec.props[0]?.handledByCharacterId).toBe(MONICA);
    expect(spec.positions).toHaveLength(2);
    expect(spec.positions[1]).toMatchObject({
      characterId: MARCUS,
      position: "center-right",
    });
  });

  it("starts DRAFT and NOT provider-reference-eligible", () => {
    const spec = monicaMarcusSpec();
    expect(spec.approvalState).toBe("DRAFT");
    expect(spec.providerReferenceEligible).toBe(false);
  });

  it("rejects an empty identities list", () => {
    expect(() =>
      createSceneMasterSpec({
        sceneId: "SC03",
        identities: [],
        room: { roomName: "newsroom" },
        lighting: { scheme: "daylight" },
        props: [],
        positions: [],
      }),
    ).toThrow(SceneMasterError);
  });

  it("rejects an identity without a wardrobe version", () => {
    expect(() =>
      createSceneMasterSpec({
        sceneId: "SC03",
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "" }],
        room: { roomName: "newsroom" },
        lighting: { scheme: "daylight" },
        props: [],
        positions: [
          { characterId: MONICA, position: "center" },
        ],
      }),
    ).toThrow(/wardrobeVersion/);
  });

  it("rejects a prop with an empty name", () => {
    expect(() =>
      createSceneMasterSpec({
        sceneId: "SC03",
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        room: { roomName: "newsroom" },
        lighting: { scheme: "daylight" },
        props: [{ name: "" }],
        positions: [{ characterId: MONICA, position: "center" }],
      }),
    ).toThrow(/prop.name/);
  });

  it("rejects missing array fields with SceneMasterError, not a TypeError", () => {
    const base = {
      sceneId: "SC03",
      room: { roomName: "newsroom" },
      lighting: { scheme: "daylight" },
    };
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        positions: [{ characterId: MONICA, position: "center" }],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/props must be an array/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        props: [],
        positions: [{ characterId: MONICA, position: "center" }],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/identities must be an array/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        props: [],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/positions must be an array/);
  });

  it("rejects non-string required fields with SceneMasterError, not a TypeError", () => {
    expect(() =>
      createSceneMasterSpec({
        sceneId: "SC03",
        identities: [
          { characterId: 123 as unknown as string, identityVersion: "v1", wardrobeVersion: "w1" },
        ],
        room: { roomName: "newsroom" },
        lighting: { scheme: "daylight" },
        props: [],
        positions: [{ characterId: MONICA, position: "center" }],
      }),
    ).toThrow(/characterId must be a non-empty string/);
    expect(() =>
      createSceneMasterSpec({
        sceneId: "SC03",
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        room: { roomName: "newsroom" },
        lighting: { scheme: "" },
        props: [],
        positions: [{ characterId: MONICA, position: "center" }],
      }),
    ).toThrow(/lighting.scheme must be a non-empty string/);
  });

  it("rejects non-object array entries with SceneMasterError, not a TypeError", () => {
    const base = {
      sceneId: "SC03",
      room: { roomName: "newsroom" },
      lighting: { scheme: "daylight" },
    };
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [null as unknown as { characterId: string }],
        props: [],
        positions: [{ characterId: MONICA, position: "center" }],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/identities entry must be an object/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        props: [42 as unknown as { name: string }],
        positions: [{ characterId: MONICA, position: "center" }],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/prop must be an object/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        props: [],
        positions: [null as unknown as { characterId: string }],
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/position must be an object/);
  });

  it("rejects missing or non-object room/lighting with SceneMasterError, not a TypeError", () => {
    const base = {
      sceneId: "SC03",
      identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
      props: [],
      positions: [{ characterId: MONICA, position: "center" }],
    };
    expect(() =>
      createSceneMasterSpec({
        ...base,
        lighting: { scheme: "daylight" },
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/room must be an object/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        lighting: null as unknown as { scheme: string },
        room: { roomName: "newsroom" },
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/lighting must be an object/);
    expect(() =>
      createSceneMasterSpec({
        ...base,
        room: ["newsroom"] as unknown as { roomName: string },
        lighting: { scheme: "daylight" },
      } as unknown as Parameters<typeof createSceneMasterSpec>[0]),
    ).toThrow(/room must be an object/);
  });

  it("rejects duplicate identities and duplicate positions", () => {
    const base = {
      sceneId: "SC03",
      room: { roomName: "newsroom" },
      lighting: { scheme: "daylight" },
      props: [],
    };
    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [
          { characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" },
          { characterId: MONICA, identityVersion: "v2", wardrobeVersion: "w2" },
        ],
        positions: [{ characterId: MONICA, position: "center" }],
      }),
    ).toThrow(/duplicate identity/);

    expect(() =>
      createSceneMasterSpec({
        ...base,
        identities: [{ characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" }],
        positions: [
          { characterId: MONICA, position: "center" },
          { characterId: MONICA, position: "stage-left" },
        ],
      }),
    ).toThrow(/duplicate position/);
  });

  it("requires exactly one position per identity and rejects unknown-character positions", () => {
    const base = {
      sceneId: "SC03",
      identities: [
        { characterId: MONICA, identityVersion: "v1", wardrobeVersion: "w1" },
        { characterId: MARCUS, identityVersion: "v1", wardrobeVersion: "w2" },
      ],
      room: { roomName: "newsroom" },
      lighting: { scheme: "daylight" },
      props: [],
    };
    expect(() =>
      createSceneMasterSpec({
        ...base,
        positions: [{ characterId: MONICA, position: "center" }],
      }),
    ).toThrow(/missing position for character/);

    expect(() =>
      createSceneMasterSpec({
        ...base,
        positions: [
          { characterId: MONICA, position: "center" },
          { characterId: "CHAR_UNKNOWN_999", position: "stage-right" },
        ],
      }),
    ).toThrow(/unknown character/);
  });

  it("approves atomically: APPROVED state flips provider eligibility", () => {
    const spec = approveSceneMasterSpec(monicaMarcusSpec());
    expect(spec.approvalState).toBe("APPROVED");
    expect(spec.providerReferenceEligible).toBe(true);
    // Original DRAFT spec is untouched (spec is treated immutably).
    const draft = monicaMarcusSpec();
    expect(draft.approvalState).toBe("DRAFT");
  });
});

describe("internal storyboard images are never provider input", () => {
  it("stamps created images with NON_PROVIDER_INPUT and providerInput=false", () => {
    const image = createInternalStoryboardImage({
      assetId: "ASSET_S01E01_SC03_SB01",
      sceneId: "SC03",
      role: "storyboard",
      note: "wide establishing frame",
    });
    expect(image.providerInput).toBe(false);
    expect(image.usageMarker).toBe(NON_PROVIDER_INPUT_MARKER);
  });

  it("isProviderEligibleImage is false for internal images even if a field claims otherwise", () => {
    const tampered = {
      providerInput: true,
      usageMarker: NON_PROVIDER_INPUT_MARKER,
    };
    expect(isProviderEligibleImage(tampered)).toBe(false);
    expect(isProviderEligibleImage({ providerInput: false, usageMarker: "SOMETHING_ELSE" })).toBe(false);
    expect(isProviderEligibleImage({ providerInput: true, usageMarker: "PROVIDER_INPUT" })).toBe(true);
  });

  it("assertNotProviderInput throws when an internal image is about to reach a provider", () => {
    const image = createInternalStoryboardImage({
      assetId: "ASSET_S01E01_SC03_SM",
      sceneId: "SC03",
      role: "scene-master",
    });
    expect(() => assertNotProviderInput(image)).not.toThrow();
    expect(() =>
      assertNotProviderInput({
        assetId: "ASSET_X",
        providerInput: true,
        usageMarker: "PROVIDER_INPUT",
      }),
    ).toThrow(/provider-eligible and must never be treated as an internal planning image/);
  });

  it("filterProviderEligibleImages drops every internal storyboard", () => {
    const master = createInternalStoryboardImage({
      assetId: "ASSET_SC03_SM",
      sceneId: "SC03",
      role: "scene-master",
    });
    const frameA = createInternalStoryboardImage({
      assetId: "ASSET_SC03_SB01",
      sceneId: "SC03",
      role: "storyboard",
    });
    const frameB = createInternalStoryboardImage({
      assetId: "ASSET_SC03_SB02",
      sceneId: "SC03",
      role: "storyboard",
    });
    // A hypothetical genuinely provider-scoped reference rides alongside.
    const providerRef = {
      assetId: "ASSET_MONICA_IDENTITY_MASTER_V1",
      sceneId: "SC03",
      role: "keyframe" as const,
      providerInput: true as const,
      usageMarker: "PROVIDER_INPUT" as const,
    };
    const eligible = filterProviderEligibleImages([master, frameA, providerRef, frameB]);
    expect(eligible.map((image) => image.assetId)).toEqual([
      "ASSET_MONICA_IDENTITY_MASTER_V1",
    ]);
    // Internal planning list itself may hold more images than the provider gets.
    expect([master, frameA, frameB, providerRef]).toHaveLength(4);
    expect(filterProviderEligibleImages([master, frameA, frameB])).toHaveLength(0);
  });
});

describe("planSceneMasters", () => {
  const appearance = (characterId: string) =>
    characterId === MONICA
      ? { identityVersion: "v1", hairVersion: "long-braids-v1", wardrobeVersion: "business-blue-v1" }
      : { identityVersion: "v1", wardrobeVersion: "casual-charcoal-v1" };

  it("builds a DRAFT spec from canon-resolved appearances for flagged scenes", () => {
    const plans = planSceneMasters(
      [twoCharacterScene()],
      { roomName: "newsroom" },
      { scheme: "fluorescents" },
      [{ name: "laptop" }],
      [
        { characterId: MONICA, position: "center-left" },
        { characterId: MARCUS, position: "center-right" },
      ],
      { resolveAppearance: appearance },
    );
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan?.requiresSceneMaster).toBe(true);
    expect(plan?.spec?.identities[0]).toMatchObject({
      characterId: MONICA,
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
    });
    expect(plan?.spec?.approvalState).toBe("DRAFT");
    expect(plan?.spec?.providerReferenceEligible).toBe(false);
  });

  it("passes through unflagged scenes without a spec", () => {
    const plans = planSceneMasters(
      [
        {
          sceneId: "SC01",
          characters: [MONICA],
          shots: [{ shotId: "SC01-SH01", characters: [MONICA] }],
        },
      ],
      { roomName: "newsroom" },
      { scheme: "fluorescents" },
      [],
      [],
      { resolveAppearance: appearance },
    );
    expect(plans[0]).toMatchObject({ sceneId: "SC01", requiresSceneMaster: false });
    expect(plans[0]?.spec).toBeUndefined();
  });

  it("errors on a missing appearance resolution instead of guessing canon", () => {
    expect(() =>
      planSceneMasters(
        [twoCharacterScene()],
        { roomName: "newsroom" },
        { scheme: "fluorescents" },
        [],
        [],
        { resolveAppearance: () => undefined },
      ),
    ).toThrow(/no appearance resolution for character/);
  });

  it("dedupes repeated characters in a flagged scene into one identity per character", () => {
    const duplicated = { ...twoCharacterScene(), characters: [MONICA, MARCUS, MONICA] };
    const plans = planSceneMasters(
      [duplicated],
      { roomName: "newsroom" },
      { scheme: "fluorescents" },
      [],
      [
        { characterId: MONICA, position: "center-left" },
        { characterId: MARCUS, position: "center-right" },
      ],
      { resolveAppearance: appearance },
    );
    expect(plans[0]?.requiresSceneMaster).toBe(true);
    expect(plans[0]?.spec?.identities).toHaveLength(2);
    expect(plans[0]?.spec?.identities.map((identity) => identity.characterId)).toEqual([
      MONICA,
      MARCUS,
    ]);
  });
});