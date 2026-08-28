/// <reference types="node" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import {
  AppearanceVersionRepository,
  ASSET_APPROVAL_STATES,
  CHARACTER_STATES,
  CharacterRepository,
  CharacterRepositoryError,
  IdentityAssetRepository,
  IdentityVersionRepository,
} from "./index.js";

// History tables are append-only with ON DELETE RESTRICT parents, so test
// isolation means a fresh database per case — never DELETE-based cleanup.
let dir: string;
let caseCounter = 0;
let db: SqliteDatabase;
let characters: CharacterRepository;
let identityVersions: IdentityVersionRepository;
let identityAssets: IdentityAssetRepository;
let appearances: AppearanceVersionRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-chars-"));
});

beforeEach(() => {
  caseCounter += 1;
  db = connectSqlite({ path: join(dir, `case-${caseCounter}.db`) });
  migrate(db, MIGRATIONS);
  characters = new CharacterRepository(db);
  identityVersions = new IdentityVersionRepository(db);
  identityAssets = new IdentityAssetRepository(db);
  appearances = new AppearanceVersionRepository(db);
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MONICA = "CHAR_MONICA_BENNETT_001";

describe("character schema (CORE-005)", () => {
  it("creates characters keyed by permanent stable business ID", () => {
    const created = characters.create({
      characterId: MONICA,
      displayName: "Monica Bennett",
    });
    expect(created.characterId).toBe(MONICA);
    expect(created.state).toBe("DRAFT");
    expect(created.voiceProfileId).toBeNull();

    const fetched = characters.findById(MONICA);
    expect(fetched?.displayName).toBe("Monica Bennett");
  });

  it("rejects duplicate character IDs", () => {
    characters.create({ characterId: MONICA, displayName: "Monica Bennett" });
    expect(() =>
      characters.create({ characterId: MONICA, displayName: "Monica Again" }),
    ).toThrow();
  });

  it("updates mutable display name and state but never the ID key", () => {
    characters.create({ characterId: MONICA, displayName: "Monica Bennett" });
    const locked = characters.update(MONICA, { displayName: "Monica B.", state: "LOCKED" });
    expect(locked?.displayName).toBe("Monica B.");
    expect(locked?.state).toBe("LOCKED");
    expect(locked?.characterId).toBe(MONICA);
  });

  it("enforces the character state CHECK constraint", () => {
    characters.create({ characterId: MONICA, displayName: "Monica" });
    expect(() => characters.update(MONICA, { state: "WAT" as never })).toThrow();
    expect(CHARACTER_STATES).toContain("LOCKED");
    expect(CHARACTER_STATES).toContain("CANONICAL");
  });

  it("lists characters ordered by ID", () => {
    characters.create({ characterId: "CHAR_AAA_AAA_002", displayName: "Second" });
    characters.create({ characterId: "CHAR_AAA_AAA_001", displayName: "First" });
    expect(characters.list().map((c) => c.characterId)).toEqual([
      "CHAR_AAA_AAA_001",
      "CHAR_AAA_AAA_002",
    ]);
  });

  it("refuses to delete a character that still owns identity history", () => {
    characters.create({ characterId: MONICA, displayName: "Monica" });
    const version = identityVersions.create({ characterId: MONICA, versionLabel: "v1" });
    expect(version.id).toBeGreaterThan(0);
    expect(() => characters.delete(MONICA)).toThrow(/FOREIGN KEY/);
    // And a character with no history deletes fine.
    characters.create({ characterId: "CHAR_EMPTY_ONE_001", displayName: "Empty" });
    expect(characters.delete("CHAR_EMPTY_ONE_001")).toBe(true);
  });
});

describe("identity versions — immutable history (spec §9)", () => {
  beforeEach(() => {
    characters.create({ characterId: MONICA, displayName: "Monica Bennett" });
  });

  it("creates an append-only ordered history", () => {
    const v1 = identityVersions.create({ characterId: MONICA, versionLabel: "v1", description: "long braids" });
    const v2 = identityVersions.create({ characterId: MONICA, versionLabel: "v2", description: "short hair" });
    expect(v1.versionLabel).toBe("v1");
    expect(v2.versionLabel).toBe("v2");

    const history = identityVersions.listHistory(MONICA);
    expect(history.map((h) => h.versionLabel)).toEqual(["v1", "v2"]);
    expect(history[0]?.description).toBe("long braids");
  });

  it("refuses duplicate version labels per character", () => {
    identityVersions.create({ characterId: MONICA, versionLabel: "v1" });
    expect(() => identityVersions.create({ characterId: MONICA, versionLabel: "v1" })).toThrow();
  });

  it("REFUSES UPDATE on identity history — database-enforced immutability", () => {
    identityVersions.create({ characterId: MONICA, versionLabel: "v1", description: "original" });
    expect(() =>
      db.exec("UPDATE character_identity_versions SET description = 'tampered'"),
    ).toThrow(/append-only|immutable/i);
  });

  it("REFUSES DELETE on identity history — database-enforced immutability", () => {
    identityVersions.create({ characterId: MONICA, versionLabel: "v1" });
    expect(() => db.exec("DELETE FROM character_identity_versions")).toThrow(
      /append-only|immutable/i,
    );
    // History survived the refused delete.
    expect(identityVersions.listHistory(MONICA)).toHaveLength(1);
  });
});

describe("canonical identity assets — GHL linkage columns (spec §9)", () => {
  let versionId: number;

  beforeEach(() => {
    characters.create({ characterId: MONICA, displayName: "Monica Bennett" });
    versionId = identityVersions.create({ characterId: MONICA, versionLabel: "v1" }).id;
  });

  function assetInput() {
    return {
      assetId: "IDENT_ASSET_MONICA_FACE_001",
      identityVersionId: versionId,
      characterId: MONICA,
      width: 1024,
      height: 1024,
      provider: "agnes",
      model: "agnes-image-2.5",
      prompt: "face-front-master",
    };
  }

  it("persists the full canonical record incl. ghl file/folder ID + sha256", () => {
    const asset = identityAssets.create({
      ...assetInput(),
      ghlFileId: "GHL_FILE_123",
      ghlFolderId: "GHL_FOLDER_456",
      ghlUrl: "https://files.gohighlevel.com/monica-face.png",
      sha256: "a".repeat(64),
      approvalState: "CANONICAL",
      canonical: true,
    });
    expect(asset.ghlFileId).toBe("GHL_FILE_123");
    expect(asset.ghlFolderId).toBe("GHL_FOLDER_456");
    expect(asset.ghlUrl).toContain("gohighlevel");
    expect(asset.sha256).toBe("a".repeat(64));
    expect(asset.canonical).toBe(true);

    // Columns actually exist on the table (schema-level proof, not mapper luck).
    const columns = db
      .all("PRAGMA table_info(character_identity_assets)")
      .map((r) => String(r["name"]));
    for (const column of ["ghl_file_id", "ghl_folder_id", "ghl_url", "sha256"]) {
      expect(columns).toContain(column);
    }
  });

  it("finds the one canonical master and rejects a second", () => {
    identityAssets.create({ ...assetInput(), canonical: true, approvalState: "CANONICAL" });
    expect(identityAssets.findCanonical(MONICA)?.assetId).toBe("IDENT_ASSET_MONICA_FACE_001");
    expect(() =>
      identityAssets.create({
        ...assetInput(),
        assetId: "IDENT_ASSET_MONICA_FACE_002",
        canonical: true,
        approvalState: "CANONICAL",
      }),
    ).toThrow();
  });

  it("rejects a malformed sha256 via the CHECK constraint", () => {
    expect(() =>
      identityAssets.create({ ...assetInput(), sha256: "NOT-A-HASH" }),
    ).toThrow();
    expect(() =>
      identityAssets.create({ ...assetInput(), sha256: "Z".repeat(64) }),
    ).toThrow();
  });

  it("updates archival linkage and walks the approval lifecycle", () => {
    const asset = identityAssets.create(assetInput());
    expect(asset.approvalState).toBe("DRAFT");

    const reviewed = identityAssets.update(asset.assetId, { approvalState: "REVIEW" });
    expect(reviewed?.approvalState).toBe("REVIEW");

    const archived = identityAssets.update(asset.assetId, {
      ghlFileId: "GHL_FILE_9",
      ghlFolderId: "GHL_FOLDER_9",
      ghlUrl: "https://files.gohighlevel.com/m.png",
      sha256: "b".repeat(64),
      approvalState: "APPROVED",
    });
    expect(archived?.ghlFileId).toBe("GHL_FILE_9");
    expect(archived?.approvalState).toBe("APPROVED");

    const canonical = identityAssets.update(asset.assetId, {
      approvalState: "CANONICAL",
      canonical: true,
    });
    expect(canonical?.canonical).toBe(true);

    // ASSET_APPROVAL_STATES covers spec §9 incl. REJECTED.
    for (const state of ASSET_APPROVAL_STATES) {
      expect(typeof state).toBe("string");
    }
    expect(ASSET_APPROVAL_STATES).toContain("RETIRED");
    expect(ASSET_APPROVAL_STATES).toContain("REJECTED");
  });

  it("rejects an invalid approval state", () => {
    expect(() =>
      identityAssets.create({ ...assetInput(), approvalState: "BANANA" as never }),
    ).toThrow(/invalid asset approval state/);
  });
});

describe("appearance versions — effective episode + immutable history (spec §9)", () => {
  let baseIdentityVersionId: number;

  beforeEach(() => {
    characters.create({ characterId: MONICA, displayName: "Monica Bennett" });
    baseIdentityVersionId = identityVersions.create({
      characterId: MONICA,
      versionLabel: "v1",
      description: "identity master v1",
    }).id;
  });

  it("creates the original appearance version and appends changes", () => {
    const v1 = appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
      state: "APPROVED",
    });
    expect(v1.effectiveEpisode).toBe("S01E01");

    const v2 = appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E09",
      changeNote: "cut braids",
    });

    const history = appearances.listForCharacter(MONICA);
    expect(history.map((h) => h.versionLabel)).toEqual(["v1", "v2"]);
    expect(history[1]?.baseIdentityVersionId).toBe(baseIdentityVersionId);
    expect(v2.state).toBe("DRAFT");
  });

  it("requires an effective episode and/or effective time", () => {
    expect(() =>
      appearances.create({
        characterId: MONICA,
        versionLabel: "v1",
        hairVersion: "long-braids-v1",
        wardrobeVersion: "business-blue-v1",
        baseIdentityVersionId,
      }),
    ).toThrow(/effective episode/i);
  });

  it("rejects an invalid appearance state with a typed error (SQL CHECK never hit)", () => {
    expect(() =>
      appearances.create({
        characterId: MONICA,
        versionLabel: "v1",
        hairVersion: "long-braids-v1",
        wardrobeVersion: "business-blue-v1",
        baseIdentityVersionId,
        effectiveEpisode: "S01E01",
        state: "BANANA" as never,
      }),
    ).toThrow(/invalid appearance state/);
  });

  it("resolves canon-at-the-time: v1 for E01–E08, v2 from E09", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
      state: "APPROVED",
    });
    appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v2",
      baseIdentityVersionId,
      effectiveEpisode: "S01E09",
      state: "APPROVED",
    });

    expect(appearances.resolveForEpisode(MONICA, "S01E01")?.hairVersion).toBe("long-braids-v1");
    expect(appearances.resolveForEpisode(MONICA, "S01E08")?.hairVersion).toBe("long-braids-v1");
    expect(appearances.resolveForEpisode(MONICA, "S01E09")?.hairVersion).toBe("short-hair-v2");
    expect(appearances.resolveForEpisode(MONICA, "S02E01")?.hairVersion).toBe("short-hair-v2");
  });

  it("episode resolution is numeric, not lexicographic (S02E03 < S10E01)", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S02E03",
      state: "APPROVED",
    });
    appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v2",
      baseIdentityVersionId,
      effectiveEpisode: "S10E01",
      state: "APPROVED",
    });

    // String compare: "S02E03" >= "S10E01" is TRUE — numeric keeps v1 canon.
    expect(appearances.resolveForEpisode(MONICA, "S02E04")?.hairVersion).toBe("long-braids-v1");
    expect(appearances.resolveForEpisode(MONICA, "S10E01")?.hairVersion).toBe("short-hair-v2");
    expect(appearances.resolveForEpisode(MONICA, "S10E02")?.hairVersion).toBe("short-hair-v2");
  });

  it("two-digit episodes do not outrank single-digit ones (S01E08 stays v1)", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
      state: "APPROVED",
    });
    appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v2",
      baseIdentityVersionId,
      effectiveEpisode: "S01E10",
      state: "APPROVED",
    });

    // String compare: "S01E08" >= "S01E10" is TRUE — numeric keeps v1 canon.
    expect(appearances.resolveForEpisode(MONICA, "S01E08")?.hairVersion).toBe("long-braids-v1");
    expect(appearances.resolveForEpisode(MONICA, "S01E10")?.hairVersion).toBe("short-hair-v2");
  });

  it("rejects malformed episode labels in resolution", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
    });
    expect(() => appearances.resolveForEpisode(MONICA, "episode-three")).toThrow(
      /must match S<season>E<episode>/,
    );
  });

  it("time-only appearance versions never resolve for episode-only queries", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
      state: "APPROVED",
    });
    appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v2",
      baseIdentityVersionId,
      effectiveTime: "2026-01-15T00:00:00.000Z",
      state: "APPROVED",
    });

    expect(appearances.resolveForEpisode(MONICA, "S01E02")?.hairVersion).toBe("long-braids-v1");
    expect(appearances.resolveForEpisode(MONICA, "S03E01")?.hairVersion).toBe("long-braids-v1");
  });

  it("base identity master id never changes across appearance versions", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
    });
    appearances.create({
      characterId: MONICA,
      versionLabel: "v2",
      hairVersion: "short-hair-v2",
      wardrobeVersion: "business-blue-v2",
      baseIdentityVersionId,
      effectiveEpisode: "S01E09",
    });
    for (const version of appearances.listForCharacter(MONICA)) {
      expect(version.baseIdentityVersionId).toBe(baseIdentityVersionId);
    }
  });

  it("REFUSES UPDATE and DELETE on appearance history — database-enforced", () => {
    appearances.create({
      characterId: MONICA,
      versionLabel: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
      baseIdentityVersionId,
      effectiveEpisode: "S01E01",
    });
    expect(() =>
      db.exec("UPDATE character_appearance_versions SET hair_version = 'hacked'"),
    ).toThrow(/append-only|immutable/i);
    expect(() => db.exec("DELETE FROM character_appearance_versions")).toThrow(
      /append-only|immutable/i,
    );
    expect(appearances.listForCharacter(MONICA)).toHaveLength(1);
  });
});

describe("repositories surface the base contract", () => {
  it("exposes stable repository names for registry wiring", () => {
    expect(characters.name).toBe("characters");
    expect(identityVersions.name).toBe("character-identity-versions");
    expect(identityAssets.name).toBe("character-identity-assets");
    expect(appearances.name).toBe("character-appearance-versions");
  });

  it("throws typed errors on invalid repository inputs", () => {
    expect(() => identityVersions.create({ characterId: MONICA, versionLabel: "" })).toThrow(
      CharacterRepositoryError,
    );
  });
});