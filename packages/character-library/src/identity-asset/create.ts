import {
  ASSET_STATE_TRANSITIONS,
  type AssetApprovalState,
  type IdentityAsset,
  type IdentityAssetInput,
} from "./types.js";

/**
 * Create a canonical identity asset record (spec §9).
 *
 * Every field of the spec's canonical record is always present on the result —
 * optional inputs are normalized to explicit `null` rather than missing keys.
 * Throws on missing required linkage and on invariants the spec states:
 * `canonical: true` requires approval state `CANONICAL`, and a canonical asset
 * must carry its durable GHL file ID, URL and SHA-256.
 */
let assetIdSeq = 0;

export function createIdentityAsset(input: IdentityAssetInput): IdentityAsset {
  const assetId =
    input.assetId ??
    generateIdentityAssetId(input.characterId, ++assetIdSeq);
  assertNonEmpty(assetId, "assetId");
  assertNonEmpty(input.characterId, "characterId");
  assertNonEmpty(input.identityVersion, "identityVersion");
  assertNonEmpty(input.provider, "provider");
  assertNonEmpty(input.model, "model");
  assertNonEmpty(input.prompt, "prompt");

  if (!Number.isInteger(input.width) || input.width <= 0) {
    throw new Error(`invalid width: ${String(input.width)}`);
  }
  if (!Number.isInteger(input.height) || input.height <= 0) {
    throw new Error(`invalid height: ${String(input.height)}`);
  }

  const approvalState: AssetApprovalState = input.approvalState ?? "DRAFT";
  const canonical = input.canonical ?? false;

  if (canonical && approvalState !== "CANONICAL") {
    throw new Error(
      `canonical asset must have approvalState "CANONICAL", got "${approvalState}"`,
    );
  }
  if (
    canonical &&
    (!input.ghlFileId || !input.ghlUrl || !input.sha256)
  ) {
    throw new Error(
      "canonical asset requires ghlFileId, ghlUrl and sha256 (spec §9: used verbatim downstream)",
    );
  }

  return {
    assetId,
    characterId: input.characterId,
    identityVersion: input.identityVersion,
    ghlFileId: input.ghlFileId ?? null,
    ghlFolderId: input.ghlFolderId ?? null,
    ghlUrl: input.ghlUrl ?? null,
    sha256: input.sha256 ? input.sha256.toLowerCase() : null,
    localCachePath: input.localCachePath ?? null,
    width: input.width,
    height: input.height,
    provider: input.provider,
    model: input.model,
    sourceJobId: input.sourceJobId ?? null,
    prompt: input.prompt,
    approvalState,
    canonical,
  };
}

/** Generate a stable MMCS asset business ID (`IDENT_ASSET_<CHARKEY>_<NNN>` style). */
export function generateIdentityAssetId(characterId: string, seq: number): string {
  const key = characterId.replace(/^CHAR_/, "").replace(/[^A-Za-z0-9]/g, "_");
  const padded = String(seq).padStart(3, "0");
  return `IDENT_ASSET_${key}_${padded}`;
}

/** Transition an asset's approval state; throws on an edge the spec forbids. */
export function transitionAssetState(
  asset: IdentityAsset,
  to: AssetApprovalState,
): IdentityAsset {
  const allowed = ASSET_STATE_TRANSITIONS[asset.approvalState];
  if (!allowed.includes(to)) {
    throw new Error(
      `illegal approval transition ${asset.approvalState} → ${to}`,
    );
  }
  if (to === "CANONICAL" && (!asset.ghlFileId || !asset.ghlUrl || !asset.sha256)) {
    throw new Error(
      "cannot reach CANONICAL without ghlFileId, ghlUrl and sha256 (spec §9 archival before LOCK)",
    );
  }
  return { ...asset, approvalState: to, canonical: to === "CANONICAL" };
}

/** Mark an APPROVED asset canonical (character LOCK approval). Same edge as spec. */
export function markCanonical(asset: IdentityAsset): IdentityAsset {
  return transitionAssetState(asset, "CANONICAL");
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}