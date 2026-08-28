/**
 * Orchestration: archive the canonical character image into GHL and persist
 * the durable link on the character record (MMCS GHL-009, spec §9 + §17).
 *
 * Sequence (spec.md §17 step 3 wording):
 *  1. validate the request;
 *  2. resolve/create `Convert and Flow/Character Library/<Name>/Identity
 *     Masters/` (search before create — folder port, idempotent);
 *  3. archive the image into that folder with a deterministic canonical
 *     filename — the archive port returns file ID + durable URL + SHA-256
 *     and verifies the URL is reachable before reporting ARCHIVED;
 *  4. assemble the spec §9 record and persist it on the character record
 *     via the store port (one write: link + persistedAt).
 *
 * All GHL/I/O sits behind ports; this module is testable with in-memory
 * fakes, matching the cast layer's ports pattern in character-library.
 */

import {
  CanonicalLinkError,
  type CanonicalCharacterImageInput,
  type CanonicalCharacterLink,
  type CharacterArchivePort,
  type CharacterFolderPort,
  type CharacterLinkRecord,
  type CharacterLinkStore,
} from "./types.js";
import {
  buildCanonicalLink,
  canonicalFilename,
  hasDurableLinkage,
  identityMastersPath,
  validateImageInput,
} from "./identity.js";

/** Monotonic asset-ID sequence, per process; IDs are stable given input. */
let assetIdSeq = 0;

/** Mirror of character-library's `generateIdentityAssetId` (CHAR-002). */
export function generateCanonicalAssetId(
  characterId: string,
  seq: number,
): string {
  const key = characterId.replace(/^CHAR_/, "").replace(/[^A-Za-z0-9]/g, "_");
  const padded = String(seq).padStart(3, "0");
  return `IDENT_ASSET_${key}_${padded}`;
}

export interface PersistCanonicalLinkResult {
  /** The full durable link persisted on the character record. */
  link: CanonicalCharacterLink;
  /** ISO-8601 instant the record reports as persisted. */
  persistedAt: string;
  /** GHL folder ID the image was archived into. */
  ghlFolderId: string;
  /** Deterministic canonical filename used for the upload. */
  filename: string;
}

/**
 * Archive + persist one canonical character image. Throws
 * {@link CanonicalLinkError} on invalid input, when the character record does
 * not exist, or when the archive result lacks any durable field — a link with
 * missing GHL file ID / URL / folder ID / SHA-256 is never persisted.
 */
export async function persistCanonicalCharacterLink(
  input: CanonicalCharacterImageInput,
  ports: {
    folders: CharacterFolderPort;
    archive: CharacterArchivePort;
    store: CharacterLinkStore;
  },
  options: { now?: () => string } = {},
): Promise<PersistCanonicalLinkResult> {
  validateImageInput(input);

  const existing = await ports.store.load(input.characterId);
  if (existing === null) {
    throw new CanonicalLinkError(
      `unknown character record: ${input.characterId}`,
    );
  }

  const folderId = await ports.folders.resolveIdentityMastersFolder(
    input.displayName,
  );
  if (typeof folderId !== "string" || folderId.length === 0) {
    throw new CanonicalLinkError(
      "folder port returned an empty Identity Masters folder ID",
    );
  }

  const filename = canonicalFilename(input.characterId, input.identityVersion);
  const archived = await ports.archive.archiveImage({
    sourceUrl: input.sourceUrl,
    filename,
    parentId: folderId,
  });

  assetIdSeq += 1;
  const assetId = generateCanonicalAssetId(input.characterId, assetIdSeq);
  const withFolder: CanonicalCharacterLink = {
    ...buildCanonicalLink(input, archived, assetId),
    ghlFolderId: folderId,
  };
  if (!hasDurableLinkage(withFolder)) {
    throw new CanonicalLinkError(
      "archive result lacks durable linkage (ghlFileId/ghlUrl/ghlFolderId/sha256) — refusing to persist (spec §9)",
    );
  }

  const now = options.now ?? (() => new Date().toISOString());
  const persistedAt = now();
  await ports.store.saveCanonicalLink(input.characterId, withFolder);

  return { link: withFolder, persistedAt, ghlFolderId: folderId, filename };
}

/** Load the durable canonical link for a character (null when absent). */
export async function getCanonicalCharacterLink(
  characterId: string,
  store: CharacterLinkStore,
): Promise<CanonicalCharacterLink | null> {
  const record: CharacterLinkRecord | null = await store.load(characterId);
  return record?.canonicalLink ?? null;
}

/**
 * Downstream consumers (reference plans, provider calls) take the canonical
 * GHL file ID + URL + checksum VERBATIM from this snapshot (spec §9). Throws
 * when the link is absent — callers must not fall back to a provider temp URL.
 */
export function canonicalLinkForDownstream(
  link: CanonicalCharacterLink | null,
): { ghlFileId: string; ghlUrl: string; sha256: string } {
  if (link === null || !hasDurableLinkage(link)) {
    throw new CanonicalLinkError(
      "no durable canonical link on the character record — run persistCanonicalCharacterLink first",
    );
  }
  return { ghlFileId: link.ghlFileId, ghlUrl: link.ghlUrl, sha256: link.sha256 };
}

/** Re-exported for callers that want the folder path without an import loop. */
export { identityMastersPath };
