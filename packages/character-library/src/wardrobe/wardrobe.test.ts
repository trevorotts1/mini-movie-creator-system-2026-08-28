import { describe, expect, it } from "vitest";

import {
  compareEpisodePoints,
  createWardrobeHistory,
  isApprovedState,
  listWardrobeVersions,
  recordWardrobeChange,
  resolveActiveWardrobe,
  resolveWardrobeAtPoint,
  type WardrobeHistory,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";

function businessBlue(): WardrobeHistory {
  return createWardrobeHistory({
    characterId: MONICA,
    versionId: "business-blue-v1",
    label: "business blue suit",
    effectiveFrom: { season: 1, episode: 1 },
    description: "navy blue business suit with white blouse",
  });
}

describe("compareEpisodePoints", () => {
  it("orders season-major, then episode", () => {
    expect(compareEpisodePoints({ season: 1, episode: 8 }, { season: 1, episode: 9 })).toBeLessThan(0);
    expect(compareEpisodePoints({ season: 1, episode: 9 }, { season: 2, episode: 1 })).toBeLessThan(0);
    expect(compareEpisodePoints({ season: 1, episode: 5 }, { season: 1, episode: 5 })).toBe(0);
  });
});

describe("isApprovedState", () => {
  it("approves only APPROVED and CANONICAL", () => {
    expect(isApprovedState("APPROVED")).toBe(true);
    expect(isApprovedState("CANONICAL")).toBe(true);
    expect(isApprovedState("DRAFT")).toBe(false);
    expect(isApprovedState("REVIEW")).toBe(false);
    expect(isApprovedState("RETIRED")).toBe(false);
    expect(isApprovedState("REJECTED")).toBe(false);
  });
});

describe("createWardrobeHistory", () => {
  it("creates an open-ended initial version", () => {
    const history = businessBlue();
    expect(history.characterId).toBe(MONICA);
    expect(history.versions).toHaveLength(1);
    const version = history.versions[0]!;
    expect(version.versionId).toBe("business-blue-v1");
    expect(version.effectiveUntil).toBeNull();
    expect(version.state).toBe("CANONICAL");
  });

  it("rejects empty ids", () => {
    expect(() =>
      createWardrobeHistory({
        characterId: "",
        versionId: "x-v1",
        label: "x",
        effectiveFrom: { season: 1, episode: 1 },
        description: "x",
      }),
    ).toThrow(/characterId/);
    expect(() =>
      createWardrobeHistory({
        characterId: MONICA,
        versionId: "",
        label: "x",
        effectiveFrom: { season: 1, episode: 1 },
        description: "x",
      }),
    ).toThrow(/versionId/);
  });
});

describe("recordWardrobeChange", () => {
  it("appends a new version and closes the superseded one without deleting history", () => {
    const changed = recordWardrobeChange(
      businessBlue(),
      { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
      { label: "casual denim", description: "denim jacket over grey tee" },
    );
    expect(changed.versions).toHaveLength(2);

    const oldVersion = changed.versions.find((v) => v.versionId === "business-blue-v1")!;
    expect(oldVersion.effectiveUntil).toEqual({ season: 1, episode: 9 });
    expect(oldVersion.description).toBe("navy blue business suit with white blouse");

    const newVersion = changed.versions.find((v) => v.versionId === "casual-denim-v1")!;
    expect(newVersion.effectiveFrom).toEqual({ season: 1, episode: 9 });
    expect(newVersion.effectiveUntil).toBeNull();
  });

  it("supports multiple sequential changes", () => {
    const step1 = recordWardrobeChange(
      businessBlue(),
      { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
      { label: "casual denim", description: "denim jacket over grey tee" },
    );
    const step2 = recordWardrobeChange(
      step1,
      { characterId: MONICA, versionId: "winter-coat-v1", supersedes: "casual-denim-v1", effectiveFrom: { season: 2, episode: 3 } },
      { label: "winter coat", description: "long charcoal wool coat" },
    );
    expect(listWardrobeVersions(step2)).toHaveLength(3);
    const first = step2.versions.find((v) => v.versionId === "business-blue-v1")!;
    const second = step2.versions.find((v) => v.versionId === "casual-denim-v1")!;
    expect(first.effectiveUntil).toEqual({ season: 1, episode: 9 });
    expect(second.effectiveUntil).toEqual({ season: 2, episode: 3 });
  });

  it("rejects a change that does not supersede the currently active version", () => {
    expect(() =>
      recordWardrobeChange(
        businessBlue(),
        { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "some-other-v9", effectiveFrom: { season: 1, episode: 9 } },
        { label: "casual denim", description: "x" },
      ),
    ).toThrow(/supersedes/);
  });

  it("rejects a change before the current version's effectiveFrom", () => {
    expect(() =>
      recordWardrobeChange(
        businessBlue(),
        { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 1 } },
        { label: "casual denim", description: "x" },
      ),
    ).toThrow(/effectiveFrom/);
  });

  it("rejects duplicate version ids and cross-character histories", () => {
    expect(() =>
      recordWardrobeChange(
        businessBlue(),
        { characterId: MONICA, versionId: "business-blue-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
        { label: "x", description: "x" },
      ),
    ).toThrow(/already exists/);
    expect(() =>
      recordWardrobeChange(
        businessBlue(),
        { characterId: "CHAR_OTHER_001", versionId: "x-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
        { label: "x", description: "x" },
      ),
    ).toThrow(/history of/);
  });
});

describe("resolveActiveWardrobe", () => {
  it("resolves the initial version before any change", () => {
    const active = resolveActiveWardrobe(businessBlue(), { season: 1, episode: 5 });
    expect(active?.versionId).toBe("business-blue-v1");
  });

  it("switches to the new version at its effective point", () => {
    const changed = recordWardrobeChange(
      businessBlue(),
      { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
      { label: "casual denim", description: "denim jacket over grey tee" },
    );
    expect(resolveActiveWardrobe(changed, { season: 1, episode: 8 })?.versionId).toBe("business-blue-v1");
    expect(resolveActiveWardrobe(changed, { season: 1, episode: 9 })?.versionId).toBe("casual-denim-v1");
    expect(resolveActiveWardrobe(changed, { season: 2, episode: 1 })?.versionId).toBe("casual-denim-v1");
  });

  it("returns null before every approved version and for non-approved states", () => {
    expect(resolveActiveWardrobe(businessBlue(), { season: 1, episode: 1 })).not.toBeNull();
    expect(
      resolveActiveWardrobe(businessBlue(), { season: 0, episode: 1 }),
    ).toBeNull();

    const draft = createWardrobeHistory({
      characterId: MONICA,
      versionId: "gala-dress-draft",
      label: "gala dress",
      effectiveFrom: { season: 1, episode: 1 },
      description: "red gala dress",
      state: "DRAFT",
    });
    expect(resolveActiveWardrobe(draft, { season: 1, episode: 5 })).toBeNull();
  });

  it("never resolves a retired version", () => {
    const changed = recordWardrobeChange(
      businessBlue(),
      { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
      { label: "casual denim", description: "denim jacket over grey tee" },
    );
    const old = changed.versions.find((v) => v.versionId === "business-blue-v1")!;
    expect(old.effectiveUntil).not.toBeNull();
    expect(resolveActiveWardrobe(changed, { season: 1, episode: 8 })?.versionId).toBe("business-blue-v1");
  });
});

describe("resolveWardrobeAtPoint (historical canon-at-the-time)", () => {
  it("keeps historical episodes on the version that was canon at their time", () => {
    const changed = recordWardrobeChange(
      businessBlue(),
      { characterId: MONICA, versionId: "casual-denim-v1", supersedes: "business-blue-v1", effectiveFrom: { season: 1, episode: 9 } },
      { label: "casual denim", description: "denim jacket over grey tee" },
    );
    // Re-rendering S01E03 long after the change must still get business-blue-v1.
    expect(resolveWardrobeAtPoint(changed, { season: 1, episode: 3 })?.versionId).toBe("business-blue-v1");
    expect(resolveWardrobeAtPoint(changed, { season: 1, episode: 10 })?.versionId).toBe("casual-denim-v1");
  });
});