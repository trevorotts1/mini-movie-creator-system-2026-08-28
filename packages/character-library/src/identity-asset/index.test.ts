import { describe, expect, it } from "vitest";

import {
  ASSET_APPROVAL_STATES,
  ASSET_STATE_TRANSITIONS,
  IDENTITY_ASSET_FIELDS,
  clearLocalCache,
  createIdentityAsset,
  generateIdentityAssetId,
  markCanonical,
  registerLocalCache,
  resolveAssetMedia,
  transitionAssetState,
  type IdentityAsset,
} from "./index";

/**
 * Every field of the spec §9 canonical identity asset record must exist on the
 * asset record. This test is the schema gate for CHAR-002.
 */
const SPEC_9_REQUIRED_FIELDS = [
  "assetId", // MMCS asset ID
  "characterId", // character ID
  "identityVersion", // identity version
  "ghlFileId", // GHL media file ID
  "ghlFolderId", // GHL folder ID
  "ghlUrl", // durable GHL URL
  "sha256", // SHA-256
  "localCachePath", // local cache path if present
  "width", // image dimensions
  "height", // image dimensions
  "provider", // generation provider
  "model", // generation model
  "sourceJobId", // source task/job ID
  "prompt", // prompt
  "approvalState", // approval state
  "canonical", // canonical flag
] as const;

const FULL_INPUT = {
  characterId: "CHAR_MONICA_BENNETT_001",
  identityVersion: "v1",
  ghlFileId: "ghl-file-123",
  ghlFolderId: "ghl-folder-456",
  ghlUrl: "https://files.monica.example/identity-v1.png",
  sha256: "A".repeat(64),
  localCachePath: "media/projects/demo/identity-v1.png",
  width: 1024,
  height: 1536,
  provider: "kie",
  model: "seedance-2.0-mini",
  sourceJobId: "job_gen_0001",
  prompt: "front-facing identity master, neutral expression, studio light",
  approvalState: "CANONICAL",
  canonical: true,
} as const;

function fullAsset(): IdentityAsset {
  return createIdentityAsset({ ...FULL_INPUT });
}

describe("spec §9 canonical identity asset record — schema", () => {
  it("declares exactly the spec §9 fields", () => {
    expect([...IDENTITY_ASSET_FIELDS].sort()).toEqual(
      [...SPEC_9_REQUIRED_FIELDS].sort(),
    );
  });

  it("asset record carries every spec §9 field with values", () => {
    const asset = fullAsset();
    for (const field of IDENTITY_ASSET_FIELDS) {
      const value = asset[field];
      expect(value, `field ${field} must be defined`).toBeDefined();
      if (field !== "localCachePath") {
        expect(value, `field ${field} must be non-null`).not.toBeNull();
      }
    }
  });

  it("carries the §9 example shape's linkage verbatim", () => {
    const asset = fullAsset();
    expect(asset.assetId).toMatch(/^IDENT_ASSET_/);
    expect(asset.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(asset.identityVersion).toBe("v1");
    expect(asset.ghlFileId).toBe("ghl-file-123");
    expect(asset.ghlFolderId).toBe("ghl-folder-456");
    expect(asset.ghlUrl).toBe("https://files.monica.example/identity-v1.png");
    expect(asset.sha256).toBe("a".repeat(64));
  });

  it("records generation metadata (provider/model/job/prompt/dimensions)", () => {
    const asset = fullAsset();
    expect(asset.provider).toBe("kie");
    expect(asset.model).toBe("seedance-2.0-mini");
    expect(asset.sourceJobId).toBe("job_gen_0001");
    expect(asset.prompt).toContain("identity master");
    expect(asset.width).toBe(1024);
    expect(asset.height).toBe(1536);
  });

  it("records approval state and canonical flag", () => {
    const asset = fullAsset();
    expect(asset.approvalState).toBe("CANONICAL");
    expect(asset.canonical).toBe(true);
  });

  it("defaults to DRAFT + non-canonical with explicit nulls (no missing keys)", () => {
    const asset = createIdentityAsset({
      characterId: "CHAR_MONICA_BENNETT_001",
      identityVersion: "v1",
      width: 512,
      height: 512,
      provider: "gemini",
      model: "gemini-image",
      prompt: "draft candidate",
    });
    expect(asset.approvalState).toBe("DRAFT");
    expect(asset.canonical).toBe(false);
    expect(asset.ghlFileId).toBeNull();
    expect(asset.ghlFolderId).toBeNull();
    expect(asset.ghlUrl).toBeNull();
    expect(asset.sha256).toBeNull();
    expect(asset.localCachePath).toBeNull();
    expect(asset.sourceJobId).toBeNull();
    expect(Object.keys(asset).sort()).toEqual(
      [...IDENTITY_ASSET_FIELDS].sort(),
    );
  });

  it("rejects canonical without durable GHL linkage (spec: archived before LOCK)", () => {
    expect(() =>
      createIdentityAsset({
        ...FULL_INPUT,
        ghlFileId: undefined,
      }),
    ).toThrow(/ghlFileId/);
  });

  it("rejects canonical flag outside CANONICAL state", () => {
    expect(() =>
      createIdentityAsset({ ...FULL_INPUT, approvalState: "APPROVED" }),
    ).toThrow(/CANONICAL/);
  });

  it("rejects non-positive dimensions and empty required strings", () => {
    expect(() =>
      createIdentityAsset({ ...FULL_INPUT, width: 0 }),
    ).toThrow(/width/);
    expect(() =>
      createIdentityAsset({ ...FULL_INPUT, height: -1 }),
    ).toThrow(/height/);
    expect(() =>
      createIdentityAsset({ ...FULL_INPUT, prompt: "  " }),
    ).toThrow(/prompt/);
  });
});

describe("approval state lifecycle (spec §9 asset states)", () => {
  it("walks DRAFT → REVIEW → APPROVED → CANONICAL", () => {
    let asset = createIdentityAsset({ ...FULL_INPUT, approvalState: "DRAFT", canonical: false });
    for (const next of ["REVIEW", "APPROVED", "CANONICAL"] as const) {
      asset = transitionAssetState(asset, next);
    }
    expect(asset.approvalState).toBe("CANONICAL");
    expect(asset.canonical).toBe(true);
  });

  it("markCanonical flips APPROVED → CANONICAL", () => {
    const approved = createIdentityAsset({
      ...FULL_INPUT,
      approvalState: "APPROVED",
      canonical: false,
    });
    const asset = markCanonical(approved);
    expect(asset.approvalState).toBe("CANONICAL");
    expect(asset.canonical).toBe(true);
  });

  it("forbids illegal edges (APPROVED → REVIEW, APPROVED → RETIRED)", () => {
    const approved = createIdentityAsset({
      ...FULL_INPUT,
      approvalState: "APPROVED",
      canonical: false,
    });
    expect(() => transitionAssetState(approved, "REVIEW")).toThrow(
      /illegal approval transition/,
    );
    expect(() => transitionAssetState(approved, "RETIRED")).toThrow(
      /illegal approval transition/,
    );
    expect(ASSET_STATE_TRANSITIONS.REJECTED).toEqual([]);
  });

  it("declares all six asset states", () => {
    expect([...ASSET_APPROVAL_STATES]).toEqual([
      "DRAFT",
      "REVIEW",
      "APPROVED",
      "CANONICAL",
      "RETIRED",
      "REJECTED",
    ]);
  });
});

describe("asset ID generation", () => {
  it("generates stable IDENT_ASSET IDs keyed to the character", () => {
    expect(generateIdentityAssetId("CHAR_MONICA_BENNETT_001", 1)).toBe(
      "IDENT_ASSET_MONICA_BENNETT_001_001",
    );
    expect(generateIdentityAssetId("CHAR_JAY_DIAZ_002", 12)).toBe(
      "IDENT_ASSET_JAY_DIAZ_002_012",
    );
  });

  it("1000 generated IDs are unique", () => {
    const ids = new Set(
      Array.from({ length: 1000 }, (_, i) =>
        generateIdentityAssetId("CHAR_MONICA_BENNETT_001", i + 1),
      ),
    );
    expect(ids.size).toBe(1000);
  });
});

describe("local cache handling (spec §9: cache path optional, GHL durable)", () => {
  it("clearing the local cache keeps GHL linkage intact", () => {
    const asset = fullAsset();
    const cleared = clearLocalCache(asset);
    expect(cleared.localCachePath).toBeNull();
    expect(cleared.ghlFileId).toBe(asset.ghlFileId);
    expect(cleared.ghlUrl).toBe(asset.ghlUrl);
    expect(cleared.sha256).toBe(asset.sha256);
  });

  it("resolveAssetMedia prefers a matching cache and falls back to GHL", () => {
    const asset = fullAsset();
    const hit = resolveAssetMedia(asset, {
      path: asset.localCachePath ?? "",
      sha256: asset.sha256 ?? "",
    });
    expect(hit.source).toBe("local-cache");
    const miss = resolveAssetMedia(clearLocalCache(asset), null);
    expect(miss.source).toBe("ghl");
    expect(miss.ghlUrl).toBe(asset.ghlUrl);
    expect(miss.ghlFileId).toBe(asset.ghlFileId);
  });

  it("registerLocalCache validates hash format and rejects bad input", () => {
    expect(
      registerLocalCache({
        path: "media/projects/demo/x.png",
        sha256: "AB".repeat(32),
        sizeBytes: 10,
        dimensions: { width: 8, height: 8 },
      }).sha256,
    ).toBe("ab".repeat(32));
    expect(() =>
      registerLocalCache({
        path: "x.png",
        sha256: "nothex",
        sizeBytes: 1,
        dimensions: { width: 1, height: 1 },
      }),
    ).toThrow(/sha256/);
  });
});