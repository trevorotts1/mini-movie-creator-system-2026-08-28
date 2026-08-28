/**
 * Pure helpers for canonical character links (GHL-009) — no I/O.
 *
 * Filename + validation + record normalization, split out so the orchestration
 * in `persist.ts` stays a thin sequence of port calls and everything here is
 * unit-testable without mocks.
 */

import {
  CanonicalLinkError,
  type CanonicalCharacterImageInput,
  type CanonicalCharacterLink,
  type CanonicalLinkState,
} from "./types.js";

/** SHA-256 is persisted as lowercase hex, 64 chars (spec §9 checksum). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Character ID shape: permanent business ID, `CHAR_<SLUG>_<NNN>`. */
const CHARACTER_ID_PATTERN = /^CHAR_[A-Z0-9_]+_\d{3,}$/;

/** Reject blank/dangerous strings early, with a field name in the message. */
function requireNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CanonicalLinkError(`${field} must be a non-blank string`);
  }
  return value;
}

/** True when the value looks like a permanent character business ID. */
export function isCharacterBusinessId(value: string): boolean {
  return CHARACTER_ID_PATTERN.test(value);
}

/** True when the value is 64-char (case-insensitive) hex. */
export function isSha256Hex(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/** Normalize a checksum to the persisted form (lowercase hex); throw if malformed. */
export function normalizeSha256(value: string): string {
  requireNonBlank(value, "sha256");
  const lowered = value.toLowerCase();
  if (!SHA256_HEX.test(lowered)) {
    throw new CanonicalLinkError(`sha256 must be 64 hex chars, got: ${value}`);
  }
  return lowered;
}

/**
 * Slug for the `Character Library/<Name>/` folder level: the display name is
 * trimmed and internal whitespace collapsed to single spaces; every other
 * character is preserved verbatim (GHL folder names are free text). Empty or
 * whitespace-only names throw — a character folder cannot be named.
 */
export function characterFolderName(displayName: string): string {
  if (typeof displayName !== "string") {
    throw new CanonicalLinkError("displayName must be a string");
  }
  const name = displayName.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new CanonicalLinkError("displayName must be non-blank");
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new CanonicalLinkError(
      `displayName is not usable as a folder name: ${JSON.stringify(displayName)}`,
    );
  }
  return name;
}

/** GHL folder path for one character's identity masters. */
export function identityMastersPath(displayName: string): readonly string[] {
  return ["Convert and Flow", "Character Library", characterFolderName(displayName), "Identity Masters"];
}

/**
 * Deterministic canonical filename for a character's identity master image:
 * `<characterId>_identity-<version>_master.<ext>`. Flat, traversal-free,
 * stable across regeneration-with-same-inputs.
 */
export function canonicalFilename(
  characterId: string,
  identityVersion: string,
  extension = "png",
): string {
  requireNonBlank(characterId, "characterId");
  requireNonBlank(identityVersion, "identityVersion");
  if (!/^[A-Za-z0-9._-]+$/.test(identityVersion)) {
    throw new CanonicalLinkError(
      `identityVersion must be filename-safe (A-Z a-z 0-9 . _ -), got: ${identityVersion}`,
    );
  }
  const ext = extension.toLowerCase().replace(/^\./, "");
  // Image-master extensions only (png, jpg, jpeg, webp, avif, gif).
  if (!/^[a-z0-9]{3,4}$/.test(ext)) {
    throw new CanonicalLinkError(`image extension looks unsafe: ${extension}`);
  }
  const charKey = characterId.replace(/[^A-Za-z0-9]/g, "_");
  return `${charKey}_identity-${identityVersion}_master.${ext}`;
}

/** States the record may be persisted under. */
export function isCanonicalLinkState(value: unknown): value is CanonicalLinkState {
  return value === "APPROVED" || value === "CANONICAL";
}

/**
 * Validate one persistence request. Prompt and other story/text fields are
 * untrusted data: length-checked only, stored verbatim, never interpreted.
 */
export function validateImageInput(
  input: CanonicalCharacterImageInput,
): CanonicalCharacterImageInput {
  requireNonBlank(input.characterId, "characterId");
  if (!isCharacterBusinessId(input.characterId)) {
    throw new CanonicalLinkError(
      `characterId must be a permanent business ID (CHAR_<NAME>_<NNN>), got: ${input.characterId}`,
    );
  }
  characterFolderName(input.displayName); // throws when unusable
  requireNonBlank(input.identityVersion, "identityVersion");
  requireNonBlank(input.sourceUrl, "sourceUrl");
  requireNonBlank(input.provider, "provider");
  requireNonBlank(input.model, "model");
  requireNonBlank(input.sourceJobId, "sourceJobId");
  if (typeof input.prompt !== "string") {
    throw new CanonicalLinkError("prompt must be a string");
  }
  if (!Number.isInteger(input.width) || input.width <= 0) {
    throw new CanonicalLinkError(`width must be a positive integer, got: ${String(input.width)}`);
  }
  if (!Number.isInteger(input.height) || input.height <= 0) {
    throw new CanonicalLinkError(`height must be a positive integer, got: ${String(input.height)}`);
  }
  if (
    input.approvalState !== undefined &&
    !isCanonicalLinkState(input.approvalState)
  ) {
    throw new CanonicalLinkError(
      `approvalState must be APPROVED or CANONICAL at link time, got: ${String(input.approvalState)}`,
    );
  }
  return input;
}

/**
 * Assemble the durable link record from the archive result. SHA-256 is
 * normalized to lowercase hex; approval state and canonical flag are kept
 * consistent (spec §9: canonical only in state CANONICAL).
 */
export function buildCanonicalLink(
  input: CanonicalCharacterImageInput,
  archived: { ghlFileId: string; ghlUrl: string; sha256: string },
  assetId: string,
): CanonicalCharacterLink {
  requireNonBlank(archived.ghlFileId, "ghlFileId");
  requireNonBlank(archived.ghlUrl, "ghlUrl");
  const sha256 = normalizeSha256(archived.sha256);
  const approvalState: CanonicalLinkState = input.approvalState ?? "APPROVED";
  return {
    assetId,
    characterId: input.characterId,
    identityVersion: input.identityVersion,
    ghlFileId: archived.ghlFileId,
    ghlFolderId: "",
    ghlUrl: archived.ghlUrl,
    sha256,
    width: input.width,
    height: input.height,
    provider: input.provider,
    model: input.model,
    sourceJobId: input.sourceJobId,
    prompt: input.prompt,
    approvalState,
    canonical: approvalState === "CANONICAL",
  };
}

/** True when a record carries every spec §9 durable field (non-empty). */
export function hasDurableLinkage(
  link: Pick<
    CanonicalCharacterLink,
    "ghlFileId" | "ghlFolderId" | "ghlUrl" | "sha256"
  > | null,
): boolean {
  if (link === null) return false;
  return (
    link.ghlFileId.length > 0 &&
    link.ghlFolderId.length > 0 &&
    link.ghlUrl.length > 0 &&
    link.sha256.length === 64
  );
}
