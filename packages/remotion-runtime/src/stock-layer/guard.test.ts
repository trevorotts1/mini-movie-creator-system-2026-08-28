import { describe, expect, it } from "vitest";

import {
  assertLicenseSafe,
  assertStockAllowed,
  createLicenseSafePlaceholder,
  createPexelsAdapter,
  createPixabayAdapter,
  createStockAdapter,
  evaluateStockGuard,
  isLicenseSafe,
  placeStockShots,
  STOCK_ADAPTER_FACTORIES,
  STOCK_ALLOWED_PURPOSES,
  StockLicenseError,
  StockPolicyViolationError,
  toStockGuardInput,
} from "./index.js";
import type {
  StockClip,
  StockPlacementCandidate,
} from "./index.js";

const CLIP: StockClip = {
  id: "clip-1",
  providerId: "pexels",
  url: "https://example.com/city-timelapse.mp4",
  durationSeconds: 5,
  width: 1920,
  height: 1080,
  attribution: "Example Photographer / Pexels",
  acquisition: "adapter-search",
  license: {
    kind: "pexels-license",
    attribution: "Example Photographer / Pexels",
    licenseUrl: "https://www.pexels.com/license/",
    sourceUrl: "https://example.com/city-timelapse",
    verifiedAt: "2026-08-28T00:00:00Z",
  },
};

function unlicensedClip(overrides: Partial<StockClip> = {}): StockClip {
  return { ...CLIP, id: "clip-unlicensed", license: { kind: "unknown" }, ...overrides };
}

function candidate(overrides: Partial<StockPlacementCandidate> = {}): StockPlacementCandidate {
  return {
    shotId: "shot-1",
    visualSource: "stock_broll",
    purpose: "establishing",
    characterIds: [],
    ...overrides,
  };
}

describe("STOCK_ALLOWED_PURPOSES (spec §22)", () => {
  it("allows only generic purposes", () => {
    expect(STOCK_ALLOWED_PURPOSES).toEqual(["establishing", "broll"]);
  });
});

describe("evaluateStockGuard", () => {
  it("allows a generic establishing shot with no characters", () => {
    const result = evaluateStockGuard(
      toStockGuardInput(candidate()),
      ["hero-main"],
    );
    expect(result).toEqual({ allowed: true });
  });

  it("rejects stock for a recurring main character (spec §22)", () => {
    const result = evaluateStockGuard(
      toStockGuardInput(candidate({ characterIds: ["hero-main"] })),
      ["hero-main"],
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("recurring_main_character");
    expect(result.offendingCharacterIds).toEqual(["hero-main"]);
  });

  it("rejects stock when ANY character in the shot is recurring", () => {
    const result = evaluateStockGuard(
      toStockGuardInput(
        candidate({ characterIds: ["stranger", "hero-main", "barista"] }),
      ),
      ["hero-main"],
    );
    expect(result.allowed).toBe(false);
    expect(result.offendingCharacterIds).toEqual(["hero-main"]);
  });

  it("rejects non-generic purposes even with no characters", () => {
    const purposes = ["character_action", "dialogue", "graphics_overlay"] as const;
    for (const purpose of purposes) {
      const result = evaluateStockGuard(toStockGuardInput(candidate({ purpose })), []);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("purpose_not_generic");
    }
  });

  it("never reports characters when the purpose is rejected first", () => {
    const result = evaluateStockGuard(
      toStockGuardInput(candidate({ purpose: "dialogue", characterIds: ["x"] })),
      ["x"],
    );
    expect(result.reason).toBe("purpose_not_generic");
    expect(result.offendingCharacterIds).toBeUndefined();
  });
});

describe("assertStockAllowed", () => {
  it("throws StockPolicyViolationError for a recurring main character", () => {
    let caught: unknown;
    try {
      assertStockAllowed(
        toStockGuardInput(candidate({ characterIds: ["hero-main"] })),
        ["hero-main"],
        "shot-1",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StockPolicyViolationError);
    const err = caught as StockPolicyViolationError;
    expect(err.reason).toBe("recurring_main_character");
    expect(err.shotId).toBe("shot-1");
    expect(err.message).toContain("never substitute for recurring main characters");
  });

  it("throws StockPolicyViolationError for a non-generic purpose", () => {
    expect(() =>
      assertStockAllowed(
        toStockGuardInput(candidate({ purpose: "dialogue" })),
        [],
        "shot-9",
      ),
    ).toThrow(/generic establishing\/B-roll purpose/);
  });

  it("does not throw for an allowed generic shot", () => {
    expect(() =>
      assertStockAllowed(
        toStockGuardInput(candidate({ characterIds: ["one-off-kid"] })),
        ["hero-main"],
        "shot-2",
      ),
    ).not.toThrow();
  });
});

describe("placeStockShots", () => {
  it("places an allowed establishing clip at the requested start", () => {
    const placements = placeStockShots(
      [candidate({ shotId: "s1", startSeconds: 2 })],
      new Map([["s1", CLIP]]),
      ["hero-main"],
    );
    expect(placements).toEqual([
      {
        shotId: "s1",
        clip: CLIP,
        startFrame: 60,
        durationInFrames: 150,
      },
    ]);
  });

  it("applies a custom fps", () => {
    const placements = placeStockShots(
      [candidate({ shotId: "s1", startSeconds: 1 })],
      new Map([["s1", CLIP]]),
      [],
      { fps: 24 },
    );
    expect(placements[0]).toMatchObject({ startFrame: 24, durationInFrames: 120 });
  });

  it("rejects stock as a substitute for a recurring main character", () => {
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1", characterIds: ["hero-main"] })],
        new Map([["s1", CLIP]]),
        ["hero-main"],
      ),
    ).toThrow(StockPolicyViolationError);
  });

  it("skips candidates whose visual source is not stock_broll", () => {
    const placements = placeStockShots(
      [
        candidate({ shotId: "s-gen", characterIds: [] }),
        candidate({ shotId: "s-char", visualSource: "generated_character_video", characterIds: ["hero-main"] }),
        candidate({ shotId: "s-still", visualSource: "ai_still_motion" }),
        candidate({ shotId: "s-gfx", visualSource: "native_graphics" }),
      ],
      new Map([
        ["s-gen", CLIP],
        ["s-char", CLIP],
        ["s-still", CLIP],
        ["s-gfx", CLIP],
      ]),
      ["hero-main"],
    );
    expect(placements.map((p) => p.shotId)).toEqual(["s-gen"]);
  });

  it("rejects non-generic purposes on stock_broll candidates with StockPolicyViolationError", () => {
    expect(() =>
      placeStockShots(
        [
          candidate({ shotId: "s-broll", purpose: "broll" }),
          candidate({ shotId: "s-dlg", purpose: "dialogue", characterIds: [] }),
        ],
        new Map([
          ["s-broll", CLIP],
          ["s-dlg", CLIP],
        ]),
        [],
      ),
    ).toThrow(StockPolicyViolationError);
  });

  it("rejects a non-generic purpose even when the candidate has no resolved clip", () => {
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s-dlg", purpose: "dialogue" })],
        new Map(),
        [],
      ),
    ).toThrow(StockPolicyViolationError);
  });

  it("rejects recurring main characters even when the candidate has no resolved clip", () => {
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1", characterIds: ["hero-main"] })],
        new Map(),
        ["hero-main"],
      ),
    ).toThrow(StockPolicyViolationError);
  });

  it("skips candidates with no resolved clip", () => {
    const placements = placeStockShots(
      [candidate({ shotId: "s-missing" })],
      new Map(),
      [],
    );
    expect(placements).toEqual([]);
  });

  it("throws RangeError for a non-positive fps", () => {
    expect(() =>
      placeStockShots([candidate()], new Map(), [], { fps: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      placeStockShots([candidate()], new Map(), [], { fps: NaN }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for a negative startSeconds", () => {
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1", startSeconds: -1 })],
        new Map([["s1", CLIP]]),
        [],
      ),
    ).toThrow(RangeError);
  });

  it("throws RangeError for a non-positive clip duration", () => {
    const zeroDuration = { ...CLIP, durationSeconds: 0 };
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1" })],
        new Map([["s1", zeroDuration]]),
        [],
      ),
    ).toThrow(RangeError);
  });

  it("throws RangeError when the clip is shorter than one frame", () => {
    const subFrame = { ...CLIP, durationSeconds: 0.01 }; // 0.3 frames at 30 fps
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1" })],
        new Map([["s1", subFrame]]),
        [],
      ),
    ).toThrow(RangeError);
  });
});

describe("license gate (spec §19/§29 provenance)", () => {
  it("accepts a clip with a real license kind", () => {
    expect(isLicenseSafe(CLIP)).toBe(true);
    expect(() => assertLicenseSafe(CLIP, "shot-1")).not.toThrow();
  });

  it("refuses unknown-license clips", () => {
    expect(isLicenseSafe(unlicensedClip())).toBe(false);
    expect(() => assertLicenseSafe(unlicensedClip(), "shot-3")).toThrow(
      StockLicenseError,
    );
  });

  it("refuses clips with no license record at all", () => {
    const noLicense = { ...CLIP, license: undefined } as unknown as StockClip;
    expect(isLicenseSafe(noLicense)).toBe(false);
  });

  it("refuses a missing clip outright", () => {
    expect(isLicenseSafe(undefined)).toBe(false);
  });

  it("carries clipId and shotId on StockLicenseError", () => {
    let caught: unknown;
    try {
      assertLicenseSafe(unlicensedClip({ id: "clip-x" }), "shot-7");
    } catch (error) {
      caught = error;
    }
    const err = caught as StockLicenseError;
    expect(err).toBeInstanceOf(StockLicenseError);
    expect(err.clipId).toBe("clip-x");
    expect(err.shotId).toBe("shot-7");
  });

  it("blocks unlicensed clips from timeline placement", () => {
    expect(() =>
      placeStockShots(
        [candidate({ shotId: "s1" })],
        new Map([["s1", unlicensedClip()]]),
        [],
      ),
    ).toThrow(StockLicenseError);
  });

  it("places licensed clips (gate is transparent when provenance exists)", () => {
    const placements = placeStockShots(
      [candidate({ shotId: "s1" })],
      new Map([["s1", CLIP]]),
      [],
    );
    expect(placements).toHaveLength(1);
    expect(placements[0]!.clip.license.kind).toBe("pexels-license");
  });
});

describe("license-safe placeholder (no binary committed)", () => {
  it("marks provenance as placeholder + unknown", () => {
    const clip = createLicenseSafePlaceholder({
      id: "stock-s3-city",
      providerId: "pexels",
      sourceUrl: "https://www.pexels.com/video/city-night-12345/",
      durationSeconds: 6,
      attribution: "Pexels contributor (to credit after license check)",
    });
    expect(clip.acquisition).toBe("placeholder");
    expect(clip.license.kind).toBe("unknown");
    expect(clip.license.sourceUrl).toBe(
      "https://www.pexels.com/video/city-night-12345/",
    );
    // Nothing has been verified yet — an unverified clip must never carry a
    // verification timestamp (provenance integrity, spec §19/§29).
    expect(clip.license.verifiedAt).toBeUndefined();
    // The placeholder itself must NOT pass the license gate — it stands in
    // for a download that has not happened yet.
    expect(isLicenseSafe(clip)).toBe(false);
  });

  it("records sha256 when a real cleared download replaces it", () => {
    const clip = createLicenseSafePlaceholder({
      id: "stock-s3-city",
      providerId: "pixabay",
      sourceUrl: "https://pixabay.com/videos/ocean-waves-999/",
      durationSeconds: 4,
    });
    const cleared: StockClip = {
      ...clip,
      url: "media/projects/S01E01/stock/s3_city.mp4",
      acquisition: "manual-download",
      license: {
        ...clip.license,
        kind: "pixabay-license",
        licenseUrl: "https://pixabay.com/service/license-summary/",
        sha256: "abc123",
        verifiedAt: "2026-08-28T12:00:00Z",
      },
    };
    expect(isLicenseSafe(cleared)).toBe(true);
    expect(cleared.license.sha256).toBe("abc123");
  });
});

describe("stock adapters (stubbed, spec §22)", () => {
  it("pexels/pixabay adapters exist but refuse searches", async () => {
    const pexels = createStockAdapter("pexels");
    const pixabay = createStockAdapter("pixabay");
    expect(pexels?.providerId).toBe("pexels");
    expect(pixabay?.providerId).toBe("pixabay");
    await expect(pexels!.search("city skyline")).rejects.toThrow(/stub/);
    await expect(pixabay!.search("ocean waves")).rejects.toThrow(/stub/);
  });

  it("local provider id has no remote adapter", () => {
    expect(createStockAdapter("local")).toBeUndefined();
  });
});

describe("adapter factories are exported from the layer entry", () => {
  it("createPexelsAdapter / createPixabayAdapter / STOCK_ADAPTER_FACTORIES exist", async () => {
    const pexels = createPexelsAdapter();
    const pixabay = createPixabayAdapter();
    expect(pexels.providerId).toBe("pexels");
    expect(pixabay.providerId).toBe("pixabay");
    expect(STOCK_ADAPTER_FACTORIES.pexels).toBe(createPexelsAdapter);
    expect(STOCK_ADAPTER_FACTORIES.pixabay).toBe(createPixabayAdapter);
    await expect(pexels.search("x")).rejects.toThrow(/stub/);
  });
});