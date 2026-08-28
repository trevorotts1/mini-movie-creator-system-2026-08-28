/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  EXCLUSIVE_MODE_KEYS,
  FRAME_VS_REFERENCES_CONFLICTS,
  ExclusiveModeValidationError,
  activeModes,
  assertExclusiveModes,
  isFrameMode,
  isReferenceMode,
  parseIncompatibleCombination,
  validateExclusiveModes,
  type ExclusiveModeCapability,
} from "./index.js";

const PROMPT_FILLED = {
  // Mode exclusivity is this validator's only concern; frame/reference
  // fields below are the signal. No prompt field needed.
} as const;

function capability(
  incompatibleCombinations: string[],
): ExclusiveModeCapability {
  return { references: { incompatibleCombinations } };
}

const NO_RULES = capability([]);

const IMG = "https://assets.example.com/refs/character-master.png";
const IMG2 = "https://assets.example.com/refs/wardrobe.png";
const VID = "https://assets.example.com/refs/cam-move.mp4";
const AUD = "https://assets.example.com/refs/voice-tone.wav";
const FRAME_A = "https://assets.example.com/frames/first.png";
const FRAME_B = "https://assets.example.com/frames/last.png";

describe("activeModes", () => {
  it("activates nothing for an empty request", () => {
    expect(activeModes(PROMPT_FILLED).size).toBe(0);
  });

  it("treats blank strings and empty arrays as absent", () => {
    const active = activeModes({
      firstFrameUrl: "   ",
      lastFrameUrl: "",
      referenceImageUrls: [],
      referenceVideoUrls: [],
      referenceAudioUrls: [],
    });
    expect(active.size).toBe(0);
  });

  it("activates firstFrame, lastFrame, and firstLastFrame together when both frames present", () => {
    const active = activeModes({ firstFrameUrl: FRAME_A, lastFrameUrl: FRAME_B });
    expect([...active].sort()).toEqual(
      ["firstFrame", "firstLastFrame", "lastFrame"].sort(),
    );
  });

  it("activates only lastFrame for a lone last frame", () => {
    const active = activeModes({ lastFrameUrl: FRAME_B });
    expect([...active]).toEqual(["lastFrame"]);
  });

  it("activates multimodalReferences for reference images", () => {
    expect([...activeModes({ referenceImageUrls: [IMG] })]).toEqual([
      "multimodalReferences",
    ]);
  });

  it("activates referenceVideos and referenceAudio separately", () => {
    expect([...activeModes({ referenceVideoUrls: [VID] })]).toEqual([
      "referenceVideos",
    ]);
    expect([...activeModes({ referenceAudioUrls: [AUD] })]).toEqual([
      "referenceAudio",
    ]);
  });
});

describe("mode classification helpers", () => {
  it("classifies frame vs reference keys", () => {
    expect(isFrameMode("firstFrame")).toBe(true);
    expect(isFrameMode("lastFrame")).toBe(true);
    expect(isFrameMode("firstLastFrame")).toBe(true);
    expect(isFrameMode("multimodalReferences")).toBe(false);
    expect(isReferenceMode("multimodalReferences")).toBe(true);
    expect(isReferenceMode("referenceVideos")).toBe(true);
    expect(isReferenceMode("referenceAudio")).toBe(true);
  });
});

describe("hard rule: first/last frame vs multimodal references (Wan)", () => {
  it("rejects first frame + reference images", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      firstFrameUrl: FRAME_A,
      referenceImageUrls: [IMG],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("rejects first+last frames + reference images (Wan 3.0 first/last vs multimodal constraint)", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      firstFrameUrl: FRAME_A,
      lastFrameUrl: FRAME_B,
      referenceImageUrls: [IMG, IMG2],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("rejects last frame + reference images", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      lastFrameUrl: FRAME_B,
      referenceImageUrls: [IMG],
    });
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("rejects frames + reference videos", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      firstFrameUrl: FRAME_A,
      referenceVideoUrls: [VID],
    });
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("rejects frames + reference audio", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      lastFrameUrl: FRAME_B,
      referenceAudioUrls: [AUD],
    });
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("reports the hard rule even when the profile declares no combinations", () => {
    // The frame-vs-references conflict is provider-documented fact, not a
    // per-profile preference — an empty incompatibleCombinations list must
    // not open the door to it.
    const issues = validateExclusiveModes(capability([]), {
      firstFrameUrl: FRAME_A,
      referenceImageUrls: [IMG],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
  });

  it("allows first/last frames alone and references alone", () => {
    expect(validateExclusiveModes(NO_RULES, { firstFrameUrl: FRAME_A })).toEqual([]);
    expect(
      validateExclusiveModes(NO_RULES, {
        firstFrameUrl: FRAME_A,
        lastFrameUrl: FRAME_B,
      }),
    ).toEqual([]);
    expect(validateExclusiveModes(NO_RULES, { referenceImageUrls: [IMG, IMG2] })).toEqual([]);
    expect(
      validateExclusiveModes(NO_RULES, {
        referenceImageUrls: [IMG],
        referenceVideoUrls: [VID],
        referenceAudioUrls: [AUD],
      }),
    ).toEqual([]);
  });

  it("emits exactly one hard-rule issue even when every conflict pair is present", () => {
    const issues = validateExclusiveModes(NO_RULES, {
      firstFrameUrl: FRAME_A,
      lastFrameUrl: FRAME_B,
      referenceImageUrls: [IMG],
      referenceVideoUrls: [VID],
      referenceAudioUrls: [AUD],
    });
    expect(issues).toHaveLength(1);
  });
});

describe("generic incompatibleCombinations validation", () => {
  it("passes when declared combination is not active", () => {
    const issues = validateExclusiveModes(
      capability(["referenceVideos+referenceAudio"]),
      { referenceImageUrls: [IMG] },
    );
    expect(issues).toEqual([]);
  });

  it("rejects when two modes of a declared combination are active", () => {
    const issues = validateExclusiveModes(
      capability(["referenceVideos+referenceAudio"]),
      { referenceVideoUrls: [VID], referenceAudioUrls: [AUD] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
    expect(issues[0]?.message).toContain("referenceVideos + referenceAudio");
  });

  it("rejects three-way declared combinations", () => {
    const issues = validateExclusiveModes(
      capability(["multimodalReferences+referenceVideos+referenceAudio"]),
      {
        referenceImageUrls: [IMG],
        referenceVideoUrls: [VID],
        referenceAudioUrls: [AUD],
      },
    );
    expect(issues).toHaveLength(1);
  });

  it("checks every declared entry independently", () => {
    const issues = validateExclusiveModes(
      capability(["firstFrame+lastFrame", "referenceVideos+referenceAudio"]),
      { firstFrameUrl: FRAME_A, lastFrameUrl: FRAME_B },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("firstFrame + lastFrame");
  });

  it("is order-independent within an entry", () => {
    const a = validateExclusiveModes(
      capability(["referenceVideos+referenceAudio"]),
      { referenceVideoUrls: [VID], referenceAudioUrls: [AUD] },
    );
    const b = validateExclusiveModes(
      capability(["referenceAudio+referenceVideos"]),
      { referenceVideoUrls: [VID], referenceAudioUrls: [AUD] },
    );
    expect(a.map((i) => i.code)).toEqual(b.map((i) => i.code));
  });

  it("does not fire for a single active mode even if named in a combination", () => {
    const issues = validateExclusiveModes(
      capability(["firstFrame+multimodalReferences"]),
      { firstFrameUrl: FRAME_A },
    );
    expect(issues).toEqual([]);
  });

  it("treats a repeated single-mode entry as malformed (needs two distinct modes)", () => {
    const issues = validateExclusiveModes(capability(["firstFrame+firstFrame"]), {
      firstFrameUrl: FRAME_A,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("INVALID_INCOMPATIBLE_COMBINATION");
  });
});

describe("capability-data defects (incompatibleCombinations hygiene)", () => {
  it("rejects entries with unknown mode tokens", () => {
    const issues = validateExclusiveModes(capability(["firstFrame+bogusMode"]), {
      referenceImageUrls: [IMG],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("INVALID_INCOMPATIBLE_COMBINATION");
    expect(issues[0]?.field).toBe("incompatibleCombinations");
  });

  it("rejects entries naming fewer than two distinct modes", () => {
    for (const entry of ["firstFrame", "", "+", "  +  "]) {
      const issues = validateExclusiveModes(capability([entry]), {});
      expect(issues).toHaveLength(1);
      expect(issues[0]?.code).toBe("INVALID_INCOMPATIBLE_COMBINATION");
    }
  });

  it("reports data defects and exclusivity violations together", () => {
    const issues = validateExclusiveModes(
      capability(["firstFrame+nope", "referenceVideos+referenceAudio"]),
      { referenceVideoUrls: [VID], referenceAudioUrls: [AUD] },
    );
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code).sort()).toEqual([
      "INVALID_INCOMPATIBLE_COMBINATION",
      "MUTUALLY_EXCLUSIVE_MODES",
    ]);
  });
});

describe("parseIncompatibleCombination", () => {
  it("parses valid entries preserving distinct mode order", () => {
    expect(parseIncompatibleCombination("firstFrame+lastFrame")).toEqual([
      "firstFrame",
      "lastFrame",
    ]);
    expect(
      parseIncompatibleCombination(" multimodalReferences + referenceVideos "),
    ).toEqual(["multimodalReferences", "referenceVideos"]);
  });

  it("returns null for malformed entries", () => {
    expect(parseIncompatibleCombination("nope+nope")).toBeNull();
    expect(parseIncompatibleCombination("firstFrame")).toBeNull();
    expect(parseIncompatibleCombination("")).toBeNull();
  });
});

describe("assertExclusiveModes", () => {
  it("returns silently on a clean request", () => {
    expect(() =>
      assertExclusiveModes(NO_RULES, { firstFrameUrl: FRAME_A }),
    ).not.toThrow();
  });

  it("throws ExclusiveModeValidationError naming the conflicting modes", () => {
    try {
      assertExclusiveModes(NO_RULES, {
        firstFrameUrl: FRAME_A,
        referenceImageUrls: [IMG],
      });
      expect.unreachable("assertExclusiveModes should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ExclusiveModeValidationError);
      if (error instanceof ExclusiveModeValidationError) {
        expect(error.issues).toHaveLength(1);
        expect(error.issues[0]?.code).toBe("MUTUALLY_EXCLUSIVE_MODES");
        expect(error.message).toContain("MUTUALLY_EXCLUSIVE_MODES");
      }
    }
  });
});

describe("constant integrity", () => {
  it("hard-rule conflict table only pairs a frame mode with a reference mode", () => {
    for (const [frame, reference] of FRAME_VS_REFERENCES_CONFLICTS) {
      expect(isFrameMode(frame)).toBe(true);
      expect(isReferenceMode(reference)).toBe(true);
    }
  });

  it("canonical key list matches the union of all classifications", () => {
    expect(EXCLUSIVE_MODE_KEYS).toHaveLength(6);
    expect(new Set(EXCLUSIVE_MODE_KEYS.map((k) => (isFrameMode(k) ? "f" : "r")))).toEqual(
      new Set(["f", "r"]),
    );
  });
});