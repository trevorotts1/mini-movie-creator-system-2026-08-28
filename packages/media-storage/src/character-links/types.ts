/**
 * Character canonical link persistence (MMCS task GHL-009) — spec §9
 * "Canonical identity asset record (durable media linkage, not prose)".
 *
 * When a character's canonical image is generated, this module archives it
 * into `Character Library/<Name>/Identity Masters/` in GHL and persists the
 * full durable record — GHL file ID + URL + folder ID + SHA-256 + generation
 * metadata — on the character record. Downstream reference plans and provider
 * calls consume the canonical GHL file ID + URL + checksum VERBATIM (spec §9).
 *
 * Field parity with `@mmcs/character-library` identity-asset (CHAR-002) is
 * intentional: the character-library package defines the record shape; this
 * package fills the GHL linkage and persists it on the character record via
 * the port below. media-storage never imports character-library — the
 * architecture keeps feature packages decoupled from adapter packages.
 */

/** Character folder subtree names, exactly as spec.md §folder-tree defines. */
export const CHARACTER_LIBRARY_ROOT = "Convert and Flow" as const;
export const CHARACTER_LIBRARY_FOLDER = "Character Library" as const;
export const IDENTITY_MASTERS_FOLDER = "Identity Masters" as const;

/** Media category of canonical character images — always images. */
export const CHARACTER_IMAGE_CATEGORY = "image" as const;

/** MIME types a canonical character identity image may carry. */
export const CHARACTER_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Approval states a canonical link may be persisted under (spec §9). */
export type CanonicalLinkState = "APPROVED" | "CANONICAL";

/**
 * Everything needed to archive one canonical character image and persist the
 * link. Generation metadata is required — spec §9 stores it on the record,
 * and the source job ID prevents expensive regeneration duplicates.
 */
export interface CanonicalCharacterImageInput {
  /** Permanent character business ID, `CHAR_<NAME>_<NNN>` style. */
  characterId: string;
  /** Display name — names the `Character Library/<Name>/` folder. */
  displayName: string;
  /** Identity version the image belongs to (e.g. `v1`); immutable history. */
  identityVersion: string;
  /** Provider temp URL or local URL of the generated image. HTTPS required. */
  sourceUrl: string;
  /** Image width in pixels (must be a positive integer). */
  width: number;
  /** Image height in pixels (must be a positive integer). */
  height: number;
  /** Generation provider (e.g. `kie`, `fal`, `gemini`). */
  provider: string;
  /** Generation model as called (e.g. `seedance-2.0-mini`). */
  model: string;
  /** Prompt that produced the image (untrusted text: stored verbatim only). */
  prompt: string;
  /** Source provider generation task/job ID for provenance. */
  sourceJobId: string;
  /** Asset lifecycle state at persistence time. Defaults to `APPROVED`. */
  approvalState?: CanonicalLinkState;
  /** Optional explicit asset ID; generated if omitted. */
  assetId?: string;
  /** Optional local cache path if present; canonical linkage survives removal. */
  localCachePath?: string | null;
  /** Optional image extension override (e.g. 'png', 'jpg', 'webp'). */
  extension?: string;
}

/** The durable link persisted on the character record (spec §9 fields). */
export interface CanonicalCharacterLink {
  /** MMCS asset ID (`IDENT_ASSET_<CHARKEY>_<NNN>` style). */
  assetId: string;
  /** Owning character's permanent business ID. */
  characterId: string;
  /** Identity version this asset belongs to. */
  identityVersion: string;
  /** GHL media file ID of the archived image. */
  ghlFileId: string;
  /** GHL folder ID of `Character Library/<Name>/Identity Masters/`. */
  ghlFolderId: string;
  /** Durable GHL URL — used verbatim downstream. */
  ghlUrl: string;
  /** SHA-256 of the archived bytes (lowercase hex). */
  sha256: string;
  /** Optional local cache path if present on disk; null otherwise. */
  localCachePath?: string | null;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Generation provider. */
  provider: string;
  /** Generation model. */
  model: string;
  /** Source provider generation task/job ID. */
  sourceJobId: string;
  /** The prompt that produced the asset. */
  prompt: string;
  /** Asset lifecycle state (APPROVED or CANONICAL at link time). */
  approvalState: CanonicalLinkState;
  /** Canonical flag — true only in state CANONICAL (character LOCKED). */
  canonical: boolean;
}

/**
 * The character record this module persists the canonical link onto. Kept
 * structurally minimal (the cast layer's GlobalCharacterRecord satisfies it)
 * so media-storage stays decoupled from character-library types.
 */
export interface CharacterLinkRecord {
  readonly characterId: string;
  /** Durable canonical link, or null before the first archival. */
  canonicalLink: CanonicalCharacterLink | null;
  /** ISO-8601 instant the current link was persisted, or null. */
  canonicalLinkPersistedAt: string | null;
}

/** Port: resolve (search-before-create) the GHL folders the link needs. */
export interface CharacterFolderPort {
  /**
   * Resolve `Character Library/<Name>/Identity Masters/` by exact names,
   * creating any missing segment, and return the innermost folder ID.
   */
  resolveIdentityMastersFolder(displayName: string): Promise<string>;
}

/** Port: upload the image into a GHL folder and return durable linkage. */
export interface CharacterArchivePort {
  /**
   * Archive the image bytes/URL into `parentId`, returning the GHL file ID,
   * durable URL and SHA-256 (lowercase hex) after the URL is verified
   * reachable (spec §17 step 3: ARCHIVED only after verification).
   */
  archiveImage(input: {
    sourceUrl: string;
    /** Deterministic canonical filename for the upload. */
    filename: string;
    parentId: string;
  }): Promise<{ ghlFileId: string; ghlUrl: string; sha256: string }>;
}

/** Port: persist the canonical link on the character record. */
export interface CharacterLinkStore {
  /** Persist the link (create or replace the character's canonical link). */
  saveCanonicalLink(characterId: string, link: CanonicalCharacterLink): Promise<void>;
  /** Load the character record, or null when unknown. */
  load(characterId: string): Promise<CharacterLinkRecord | null>;
}

/** Error thrown when the persisted link would violate a spec §9 invariant. */
export class CanonicalLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLinkError";
  }
}
