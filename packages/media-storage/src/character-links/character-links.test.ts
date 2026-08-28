import { describe, expect, it } from "vitest";
import {
  CanonicalLinkError,
  canonicalFilename,
  canonicalLinkForDownstream,
  characterFolderName,
  generateCanonicalAssetId,
  getCanonicalCharacterLink,
  hasDurableLinkage,
  identityMastersPath,
  isCharacterBusinessId,
  isSha256Hex,
  memoryArchivePort,
  memoryFolderPort,
  memoryLinkStore,
  normalizeSha256,
  persistCanonicalCharacterLink,
  validateImageInput,
} from "./index.js";

const SHA = "b6c1e2f3a4b5c6d7e8f9012345678901234567890abcdef1234567890abcdef12".slice(0, 64);

function baseInput() {
  return {
    characterId: "CHAR_MONICA_BENNETT_001",
    displayName: "Monica Bennett",
    identityVersion: "v1",
    sourceUrl: "https://cdn.example.com/tmp/monica-v1.png",
    width: 1024,
    height: 1536,
    provider: "kie",
    model: "seedance-2.0-mini",
    prompt: "front-facing identity master, neutral expression",
    sourceJobId: "job_123",
  };
}

function wired(input = baseInput()) {
  const folders = memoryFolderPort(new Map());
  const archive = memoryArchivePort({ sha256: SHA });
  const store = memoryLinkStore();
  store.records.set("CHAR_MONICA_BENNETT_001", {
    characterId: "CHAR_MONICA_BENNETT_001",
    canonicalLink: null,
    canonicalLinkPersistedAt: null,
    linkHistory: [],
  });
  return { folders, archive, store, input };
}

describe("character-links identity helpers", () => {
  it("builds the spec §9 folder path with the display name", () => {
    expect(identityMastersPath("Monica Bennett")).toEqual([
      "Convert and Flow",
      "Character Library",
      "Monica Bennett",
      "Identity Masters",
    ]);
  });

  it("collapses whitespace in folder names but rejects unusable ones", () => {
    expect(characterFolderName("  Monica   Bennett ")).toBe("Monica Bennett");
    expect(() => characterFolderName("   ")).toThrow(CanonicalLinkError);
    expect(() => characterFolderName("../etc")).toThrow(CanonicalLinkError);
    expect(() => characterFolderName("a/b")).toThrow(CanonicalLinkError);
  });

  it("derives a deterministic canonical filename", () => {
    const name = canonicalFilename("CHAR_MONICA_BENNETT_001", "v1");
    expect(name).toBe("CHAR_MONICA_BENNETT_001_identity-v1_master.png");
    expect(canonicalFilename("CHAR_MONICA_BENNETT_001", "v1")).toBe(name);
    expect(canonicalFilename("CHAR_X_001", "v2", "jpg")).toBe(
      "CHAR_X_001_identity-v2_master.jpg",
    );
  });

  it("rejects unsafe identity versions and extensions", () => {
    expect(() => canonicalFilename("CHAR_X_001", "../evil")).toThrow(CanonicalLinkError);
    expect(() => canonicalFilename("CHAR_X_001", "v1", "sh")).toThrow(CanonicalLinkError);
  });

  it("validates the §9 business ID shape and checksum format", () => {
    expect(isCharacterBusinessId("CHAR_MONICA_BENNETT_001")).toBe(true);
    expect(isCharacterBusinessId("monica bennett")).toBe(false);
    expect(isCharacterBusinessId("CHAR_MONICA_1")).toBe(false);
    expect(isSha256Hex(SHA)).toBe(true);
    expect(normalizeSha256(SHA.toUpperCase())).toBe(SHA);
    expect(() => normalizeSha256("nothex")).toThrow(CanonicalLinkError);
  });

  it("validates persistence input fields", () => {
    expect(validateImageInput(baseInput()).prompt).toBe(baseInput().prompt);
    expect(() => validateImageInput({ ...baseInput(), characterId: "monica" })).toThrow(
      CanonicalLinkError,
    );
    expect(() => validateImageInput({ ...baseInput(), width: 0 })).toThrow(CanonicalLinkError);
    expect(() => validateImageInput({ ...baseInput(), height: 1.5 })).toThrow(CanonicalLinkError);
    expect(() => validateImageInput({ ...baseInput(), provider: "" })).toThrow(
      CanonicalLinkError,
    );
    expect(() =>
      validateImageInput({ ...baseInput(), approvalState: "DRAFT" as never }),
    ).toThrow(CanonicalLinkError);
  });

  it("detects durable linkage presence", () => {
    expect(
      hasDurableLinkage({
        ghlFileId: "f",
        ghlFolderId: "p",
        ghlUrl: "https://x",
        sha256: SHA,
      }),
    ).toBe(true);
    expect(
      hasDurableLinkage({ ghlFileId: "f", ghlFolderId: "", ghlUrl: "https://x", sha256: SHA }),
    ).toBe(false);
    expect(hasDurableLinkage(null)).toBe(false);
  });
});

describe("persistCanonicalCharacterLink", () => {
  it("archives into Character Library/<Name>/Identity Masters and persists the §9 record", async () => {
    const w = wired();
    const result = await persistCanonicalCharacterLink(w.input, {
      folders: w.folders,
      archive: w.archive,
      store: w.store,
    });

    expect(result.ghlFolderId).toMatch(/^FOLDER_\d{3}$/);
    expect(result.filename).toBe("CHAR_MONICA_BENNETT_001_identity-v1_master.png");

    const link = await getCanonicalCharacterLink("CHAR_MONICA_BENNETT_001", w.store);
    expect(link).not.toBeNull();
    expect(link?.ghlFileId).toContain("CHAR_MONICA_BENNETT_001");
    expect(link?.ghlFolderId).toBe(result.ghlFolderId);
    expect(link?.ghlUrl).toMatch(/^https:\/\/services\.leadconnectorhq\.com\//);
    expect(link?.sha256).toBe(SHA);
    expect(link?.assetId).toMatch(/^IDENT_ASSET_MONICA_BENNETT_001_\d{3}$/);
    // Spec §9 generation metadata persisted on the character record:
    expect(link?.provider).toBe("kie");
    expect(link?.model).toBe("seedance-2.0-mini");
    expect(link?.sourceJobId).toBe("job_123");
    expect(link?.prompt).toBe("front-facing identity master, neutral expression");
    expect(link?.width).toBe(1024);
    expect(link?.height).toBe(1536);
    expect(link?.identityVersion).toBe("v1");
    expect(link?.approvalState).toBe("APPROVED");
    expect(link?.canonical).toBe(false);
  });

  it("stamps persistedAt on the record at write time", async () => {
    let tick = 0;
    const stamps = ["2026-08-28T12:00:00.000Z", "2026-08-28T12:00:01.000Z"];
    const now = () => stamps[tick++] ?? "2026-08-28T12:00:02.000Z";
    const folders = memoryFolderPort(new Map());
    const archive = memoryArchivePort({ sha256: SHA });
    const store = memoryLinkStore(undefined, { now });
    store.records.set("CHAR_MONICA_BENNETT_001", {
      characterId: "CHAR_MONICA_BENNETT_001",
      canonicalLink: null,
      canonicalLinkPersistedAt: null,
      linkHistory: [],
    });
    await persistCanonicalCharacterLink(baseInput(), {
      folders,
      archive,
      store,
    });
    const record = await store.load("CHAR_MONICA_BENNETT_001");
    expect(record?.canonicalLinkPersistedAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("CANONICAL state sets the canonical flag; APPROVED does not", async () => {
    const w = wired();
    await persistCanonicalCharacterLink(
      { ...w.input, approvalState: "CANONICAL" },
      { folders: w.folders, archive: w.archive, store: w.store },
    );
    const link = await getCanonicalCharacterLink("CHAR_MONICA_BENNETT_001", w.store);
    expect(link?.canonical).toBe(true);
    expect(link?.approvalState).toBe("CANONICAL");
  });

  it("replaces the active link but keeps immutable history", async () => {
    const w = wired();
    await persistCanonicalCharacterLink(w.input, {
      folders: w.folders,
      archive: w.archive,
      store: w.store,
    });
    await persistCanonicalCharacterLink(
      { ...w.input, identityVersion: "v2" },
      { folders: w.folders, archive: w.archive, store: w.store },
    );
    const record = (await w.store.load("CHAR_MONICA_BENNETT_001")) as
      | import("./memory.js").MemoryCharacterRecord
      | null;
    expect(record?.canonicalLink?.identityVersion).toBe("v2");
    expect(record?.linkHistory).toHaveLength(2);
    expect(record?.linkHistory[0]?.identityVersion).toBe("v1");
  });

  it("separate characters get separate Identity Masters folders", async () => {
    const map = new Map();
    const folders = memoryFolderPort(map);
    const store = memoryLinkStore();
    store.records.set("CHAR_MONICA_BENNETT_001", {
      characterId: "CHAR_MONICA_BENNETT_001",
      canonicalLink: null,
      canonicalLinkPersistedAt: null,
      linkHistory: [],
    });
    store.records.set("CHAR_HARRIS_COLE_002", {
      characterId: "CHAR_HARRIS_COLE_002",
      canonicalLink: null,
      canonicalLinkPersistedAt: null,
      linkHistory: [],
    });
    const inputA = baseInput();
    const inputB = {
      ...baseInput(),
      characterId: "CHAR_HARRIS_COLE_002",
      displayName: "Harris Cole",
    };
    const a = await persistCanonicalCharacterLink(inputA, { folders, archive: memoryArchivePort({ sha256: SHA }), store });
    const b = await persistCanonicalCharacterLink(inputB, { folders, archive: memoryArchivePort({ sha256: SHA }), store });
    expect(a.ghlFolderId).not.toBe(b.ghlFolderId);
    expect([...map.keys()].some((k) => k.endsWith("/Monica Bennett/Identity Masters"))).toBe(true);
    expect([...map.keys()].some((k) => k.endsWith("/Harris Cole/Identity Masters"))).toBe(true);
  });

  it("refuses to persist when the character record does not exist", async () => {
    const w = wired();
    await expect(
      persistCanonicalCharacterLink(
        { ...w.input, characterId: "CHAR_GHOST_009" },
        { folders: w.folders, archive: w.archive, store: w.store },
      ),
    ).rejects.toThrow(CanonicalLinkError);
  });

  it("refuses to persist when archival returns no SHA-256", async () => {
    const w = wired();
    const brokenArchive = {
      async archiveImage() {
        return { ghlFileId: "f1", ghlUrl: "https://x/y", sha256: "" };
      },
    };
    await expect(
      persistCanonicalCharacterLink(w.input, {
        folders: w.folders,
        archive: brokenArchive,
        store: w.store,
      }),
    ).rejects.toThrow(CanonicalLinkError);
    const record = await w.store.load("CHAR_MONICA_BENNETT_001");
    expect(record?.canonicalLink).toBeNull();
  });

  it("refuses to persist when the folder port returns an empty ID", async () => {
    const w = wired();
    const brokenFolders = {
      async resolveIdentityMastersFolder() {
        return "";
      },
    };
    await expect(
      persistCanonicalCharacterLink(w.input, {
        folders: brokenFolders,
        archive: w.archive,
        store: w.store,
      }),
    ).rejects.toThrow(CanonicalLinkError);
  });
});

describe("downstream snapshot", () => {
  it("hands back file ID + URL + checksum verbatim", async () => {
    const w = wired();
    const result = await persistCanonicalCharacterLink(w.input, {
      folders: w.folders,
      archive: w.archive,
      store: w.store,
    });
    const snapshot = canonicalLinkForDownstream(result.link);
    expect(snapshot).toEqual({
      ghlFileId: result.link.ghlFileId,
      ghlUrl: result.link.ghlUrl,
      sha256: SHA,
    });
    expect(() => canonicalLinkForDownstream(null)).toThrow(CanonicalLinkError);
  });
});

describe("memory adapters", () => {
  it("resolves the same path to the same folder ID (idempotent)", async () => {
    const map = new Map();
    const folders = memoryFolderPort(map);
    const first = await folders.resolveIdentityMastersFolder("Monica Bennett");
    const second = await folders.resolveIdentityMastersFolder("Monica Bennett");
    expect(first).toBe(second);
    expect(map.size).toBe(4); // Convert and Flow / Character Library / <Name> / Identity Masters
  });

  it("archive port yields a durable URL and stable file ID", async () => {
    const archive = memoryArchivePort({ sha256: SHA });
    const a = await archive.archiveImage({
      sourceUrl: "https://cdn.example.com/x.png",
      filename: "CHAR_X_001_identity-v1_master.png",
      parentId: "FOLDER_004",
    });
    const b = await archive.archiveImage({
      sourceUrl: "https://cdn.example.com/x.png",
      filename: "CHAR_X_001_identity-v1_master.png",
      parentId: "FOLDER_004",
    });
    expect(a).toEqual(b);
    expect(a.ghlUrl.startsWith("https://")).toBe(true);
  });
});

describe("asset ID generation", () => {
  it("mirrors the character-library IDENT_ASSET format", () => {
    expect(generateCanonicalAssetId("CHAR_MONICA_BENNETT_001", 7)).toBe(
      "IDENT_ASSET_MONICA_BENNETT_001_007",
    );
    expect(generateCanonicalAssetId("CHAR_MONICA_BENNETT_001", 123)).toBe(
      "IDENT_ASSET_MONICA_BENNETT_001_123",
    );
  });
});
