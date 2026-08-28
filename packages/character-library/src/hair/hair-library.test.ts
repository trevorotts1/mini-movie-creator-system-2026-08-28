import { describe, expect, it } from "vitest";
import {
  HairVersionNotFoundError,
  InMemoryHairLibrary,
} from "./index.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const E01 = { season: 1, episode: 1 };
const E08 = { season: 1, episode: 8 };
const E09 = { season: 1, episode: 9 };

describe("InMemoryHairLibrary", () => {
  it("adds the first hair version and resolves it as CANONICAL", () => {
    const library = new InMemoryHairLibrary();
    const v1 = library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "long dark braids past the shoulders",
      effectiveFrom: E01,
      assetId: "ASSET_monica_hair_v1",
      ghlFileId: "ghl-file-1",
      sha256: "abc123",
    });
    expect(v1.versionId).toBe("HAIR_MONICA_BENNETT_001_V1");
    expect(v1.state).toBe("CANONICAL");
    expect(library.resolveHairAt(MONICA, E08).versionId).toBe("HAIR_MONICA_BENNETT_001_V1");
    expect(library.resolveHairAt(MONICA, E08).ghlFileId).toBe("ghl-file-1");
  });

  it("a hair change appends a new version and never mutates the prior one", () => {
    const library = new InMemoryHairLibrary();
    const v1 = library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "long dark braids past the shoulders",
      effectiveFrom: E01,
    });
    const v2 = library.addHairVersion(MONICA, {
      name: "short-hair",
      description: "short bob cut",
      effectiveFrom: E09,
    });
    expect(v2.versionId).toBe("HAIR_MONICA_BENNETT_001_V2");
    expect(v2.versionId).not.toBe(v1.versionId);
    // v1 record is untouched by the change.
    expect(v1.name).toBe("long-braids");
    expect(v1.description).toBe("long dark braids past the shoulders");
    expect(v1.effectiveFrom).toEqual(E01);
    expect(v1.state).toBe("CANONICAL");
  });

  it("historical episodes keep resolving to the canon-at-the-time version", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "long dark braids past the shoulders",
      effectiveFrom: E01,
      ghlFileId: "ghl-file-braids",
    });
    library.addHairVersion(MONICA, {
      name: "short-hair",
      description: "short bob cut",
      effectiveFrom: E09,
      ghlFileId: "ghl-file-short",
    });
    // S01E01–E08: braids. S01E09+: short hair.
    expect(library.resolveHairAt(MONICA, E08).versionId).toBe("HAIR_MONICA_BENNETT_001_V1");
    expect(library.resolveHairAt(MONICA, E09).versionId).toBe("HAIR_MONICA_BENNETT_001_V2");
    expect(library.resolveHairAt(MONICA, { season: 2, episode: 5 }).versionId).toBe(
      "HAIR_MONICA_BENNETT_001_V2",
    );
  });

  it("resolves the base identity master verbatim in later resolutions", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "long dark braids past the shoulders",
      effectiveFrom: E01,
      assetId: "ASSET_face_front_master",
      ghlFileId: "ghl-1",
      sha256: "deadbeef",
    });
    library.addHairVersion(MONICA, {
      name: "short-hair",
      description: "short bob cut",
      effectiveFrom: E09,
      assetId: "ASSET_face_front_master",
      ghlFileId: "ghl-2",
      sha256: "feedface",
    });
    const resolution = library.resolveHairAt(MONICA, E09);
    expect(resolution.assetId).toBe("ASSET_face_front_master");
    expect(resolution.sha256).toBe("feedface");
  });

  it("rejects a change that would overwrite an existing version name", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "original",
      effectiveFrom: E01,
    });
    expect(() =>
      library.addHairVersion(MONICA, {
        name: "long-braids",
        description: "rewritten description",
        effectiveFrom: E09,
      }),
    ).toThrow(/never overwrites|already exists/i);
    // History intact after the rejected write.
    expect(library.getHairHistory(MONICA)).toHaveLength(1);
    expect(library.resolveHairAt(MONICA, E09).description).toBe("original");
  });

  it("rejects a new version effective before the previous one", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "original",
      effectiveFrom: E08,
    });
    expect(() =>
      library.addHairVersion(MONICA, {
        name: "short-hair",
        description: "short",
        effectiveFrom: E01,
      }),
    ).toThrow(/effectiveFrom/);
  });

  it("getHairHistory returns a copy — mutating it does not change resolution", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "original",
      effectiveFrom: E01,
    });
    const history = library.getHairHistory(MONICA) as unknown as Array<Record<string, unknown>>;
    history.pop();
    history.push({ versionId: "FAKE", name: "hacked", effectiveFrom: E09, retiredAt: null, state: "CANONICAL" });
    expect(library.getHairHistory(MONICA)).toHaveLength(1);
    expect(library.resolveHairAt(MONICA, E09).versionId).toBe("HAIR_MONICA_BENNETT_001_V1");
  });

  it("retire keeps the version queryable for past episodes and hidden at retirement onward", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "braids",
      effectiveFrom: E01,
    });
    library.retireHairVersion(MONICA, "HAIR_MONICA_BENNETT_001_V1", E08);
    expect(library.resolveHairAt(MONICA, E01).versionId).toBe("HAIR_MONICA_BENNETT_001_V1");
    expect(library.getHairHistory(MONICA)[0]?.retiredAt).toEqual(E08);
    expect(() => library.resolveHairAt(MONICA, E09)).toThrow(HairVersionNotFoundError);
  });

  it("unknown character or pre-history episode throws HairVersionNotFoundError", () => {
    const library = new InMemoryHairLibrary();
    expect(() => library.resolveHairAt(MONICA, E01)).toThrow(HairVersionNotFoundError);
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "braids",
      effectiveFrom: E09,
    });
    expect(() => library.resolveHairAt(MONICA, E08)).toThrow(HairVersionNotFoundError);
  });

  it("promoteToCanonical promotes an APPROVED version and refuses RETIRED", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "braids",
      effectiveFrom: E01,
    });
    const v2 = library.addHairVersion(MONICA, {
      name: "short-hair",
      description: "short",
      effectiveFrom: E09,
    });
    expect(v2.state).toBe("APPROVED");
    library.promoteToCanonical(MONICA, v2.versionId);
    expect(library.getHairHistory(MONICA)[1]?.state).toBe("CANONICAL");

    library.retireHairVersion(MONICA, v2.versionId, { season: 2, episode: 1 });
    expect(() => library.promoteToCanonical(MONICA, v2.versionId)).toThrow(/RETIRED/);
  });

  it("empty or whitespace names are rejected", () => {
    const library = new InMemoryHairLibrary();
    expect(() =>
      library.addHairVersion(MONICA, {
        name: "   ",
        description: "x",
        effectiveFrom: E01,
      }),
    ).toThrow(/name must not be empty/);
  });

  it("tracks multiple characters independently", () => {
    const library = new InMemoryHairLibrary();
    library.addHairVersion(MONICA, {
      name: "long-braids",
      description: "braids",
      effectiveFrom: E01,
    });
    const HARRIS = "CHAR_HARRIS_COLE_001";
    library.addHairVersion(HARRIS, {
      name: "buzz-cut",
      description: "buzz cut",
      effectiveFrom: E01,
    });
    expect(library.resolveHairAt(MONICA, E01).name).toBe("long-braids");
    expect(library.resolveHairAt(HARRIS, E01).name).toBe("buzz-cut");
    expect(library.getHairHistory(HARRIS)[0]?.versionId).toBe("HAIR_HARRIS_COLE_001_V1");
  });
});