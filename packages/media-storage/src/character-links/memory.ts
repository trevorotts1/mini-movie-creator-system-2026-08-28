/**
 * In-memory adapters for the canonical-link ports (GHL-009).
 *
 * Useful for tests, the CLI smoke path, and any caller that wants the full
 * persist sequence without live GHL. The memory store mirrors the semantics
 * the SQLite layer (CORE-005 `character_identity_assets`) will enforce: one
 * canonical link per character record, immutable history retained as a
 * versioned list, and persistedAt stamped on every write.
 */

import type {
  CanonicalCharacterLink,
  CharacterFolderPort,
  CharacterLinkRecord,
  CharacterLinkStore,
} from "./types.js";
import { identityMastersPath } from "./identity.js";

/** Map of folder path (joined with "/") → folder ID. */
export type FolderMap = Map<string, string>;

/**
 * Deterministic in-memory folder resolver. Creates any missing segment of
 * `Convert and Flow/Character Library/<Name>/Identity Masters/` with IDs
 * derived from the path (`FOLDER_<index>`), mirroring search-before-create
 * idempotency: the same path always resolves to the same ID.
 */
export function memoryFolderPort(folders: FolderMap): CharacterFolderPort {
  return {
    async resolveIdentityMastersFolder(displayName: string): Promise<string> {
      const segments = [...identityMastersPath(displayName)];
      let path = "";
      for (const segment of segments) {
        path = path.length === 0 ? segment : `${path}/${segment}`;
        const hit = folders.get(path);
        if (hit !== undefined) continue;
        const created = `FOLDER_${String(folders.size + 1).padStart(3, "0")}`;
        folders.set(path, created);
      }
      const resolved = folders.get(path);
      if (resolved === undefined) {
        throw new Error(`memoryFolderPort failed to resolve: ${path}`);
      }
      return resolved;
    },
  };
}

/**
 * In-memory archive port. Derives a fake-but-stable GHL file ID from the
 * filename, a durable URL from the file ID, and accepts the SHA-256 the
 * caller computed (or derives a deterministic pseudo-checksum in tests).
 * Never performs network I/O.
 */
export function memoryArchivePort(options: {
  sha256?: string;
}): CharacterArchivePortShim {
  return {
    async archiveImage({ filename, parentId }) {
      const ghlFileId = `FILE_${filename.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40)}`;
      return {
        ghlFileId,
        ghlUrl: `https://services.leadconnectorhq.com/storage/${parentId}/${ghlFileId}`,
        sha256:
          options.sha256 ??
          "a".repeat(64),
      };
    },
  };
}

/** The memory archive port type (structural twin of CharacterArchivePort). */
export interface CharacterArchivePortShim {
  archiveImage(input: {
    sourceUrl: string;
    filename: string;
    parentId: string;
  }): Promise<{ ghlFileId: string; ghlUrl: string; sha256: string }>;
}

/** A character record as held by the memory store. */
export interface MemoryCharacterRecord extends CharacterLinkRecord {
  /** Full history of persisted links, newest last (immutable history). */
  linkHistory: CanonicalCharacterLink[];
}

/**
 * In-memory character link store: `characterId → record`. `saveCanonicalLink`
 * replaces the active link and appends to history; loading an unknown
 * character returns null (persist then throws "unknown character record").
 */
export function memoryLinkStore(
  records: Map<string, MemoryCharacterRecord> = new Map(),
  options: { now?: () => string } = {},
): CharacterLinkStore & { records: Map<string, MemoryCharacterRecord> } {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    records,
    async load(characterId: string): Promise<CharacterLinkRecord | null> {
      return records.get(characterId) ?? null;
    },
    async saveCanonicalLink(
      characterId: string,
      link: CanonicalCharacterLink,
    ): Promise<void> {
      const existing = records.get(characterId);
      const record: MemoryCharacterRecord = {
        characterId,
        canonicalLink: link,
        canonicalLinkPersistedAt: now(),
        linkHistory: [...(existing?.linkHistory ?? []), link],
      };
      records.set(characterId, record);
    },
  };
}
