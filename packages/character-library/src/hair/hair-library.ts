import type { CharacterId, EpisodeRef, HairVersionId } from "./types.js";
import { HairVersionNotFoundError } from "./errors.js";

/**
 * A hair version state for a character — one entry in the character's
 * immutable hair history (spec.md §9 Identity versioning).
 */
export interface HairVersion {
  readonly versionId: HairVersionId;
  readonly characterId: CharacterId;
  /** Human label, e.g. "long-braids". Stable once created. */
  readonly name: string;
  /** Identity-critical description used verbatim in downstream prompts. */
  readonly description: string;
  /** Canonical asset linkage — MMCS asset ID / GHL media file ID. */
  readonly assetId: string | null;
  readonly ghlFileId: string | null;
  readonly sha256: string | null;
  /** First episode where this hair state is canonical. */
  readonly effectiveFrom: EpisodeRef;
  /** Episode from which this version is retired, if retired. */
  retiredAt: EpisodeRef | null;
  /** Approval state of this hair state (spec §9 asset states, hair subset). */
  state: "DRAFT" | "REVIEW" | "APPROVED" | "CANONICAL" | "RETIRED";
  readonly createdAt: string;
}

/** An entry in a character's immutable hair history. */
export interface HairHistoryEntry {
  readonly versionId: HairVersionId;
  readonly name: string;
  readonly effectiveFrom: EpisodeRef;
  readonly retiredAt: EpisodeRef | null;
  readonly state: HairVersion["state"];
}

export interface HairVersionInput {
  readonly name: string;
  readonly description: string;
  readonly effectiveFrom: EpisodeRef;
  readonly assetId?: string | null;
  readonly ghlFileId?: string | null;
  readonly sha256?: string | null;
  readonly createdAt?: string;
}

export interface HairResolution {
  readonly versionId: HairVersionId;
  readonly name: string;
  readonly description: string;
  readonly assetId: string | null;
  readonly ghlFileId: string | null;
  readonly sha256: string | null;
}

export interface HairLibrary {
  /** Adds a new hair version for a character. Existing history is never mutated. */
  addHairVersion(characterId: CharacterId, input: HairVersionInput): HairVersion;
  /**
   * Resolves the hair version canon at an episode's continuity point: the
   * latest version effective at that episode.
   */
  resolveHairAt(characterId: CharacterId, episode: EpisodeRef): HairResolution;
  /** Full history, oldest first. Callers receive a copy — history itself is immutable. */
  getHairHistory(characterId: CharacterId): readonly HairHistoryEntry[];
  /** Retires a version from a given episode (it stays queryable for past episodes). */
  retireHairVersion(characterId: CharacterId, versionId: HairVersionId, retiredAt: EpisodeRef): void;
  /** Promotes a version to CANONICAL (hair state becomes the active appearance). */
  promoteToCanonical(characterId: CharacterId, versionId: HairVersionId): void;
}

export interface HairLibraryOptions {
  readonly now?: () => Date;
}

/**
 * Immutable-history hair library.
 *
 * `addHairVersion` only ever appends. A hair change creates a new appearance
 * version with an effective episode; it never replaces or mutates any prior
 * version, so historical episodes keep resolving to the canon-at-the-time
 * state (spec.md §9: "hairstyle ... changes never overwrite history").
 */
export class InMemoryHairLibrary implements HairLibrary {
  private readonly versions = new Map<CharacterId, HairVersion[]>();
  private readonly clock: () => Date;

  constructor(options: HairLibraryOptions = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  addHairVersion(characterId: CharacterId, input: HairVersionInput): HairVersion {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("hair version name must not be empty");
    }
    const history = this.versions.get(characterId) ?? [];
    if (history.some((v) => v.name === name)) {
      throw new Error(
        `hair version name "${name}" already exists for ${characterId}; a hair change creates a NEW version, never overwrites the existing one`,
      );
    }
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last && compareEpisodes(input.effectiveFrom, last.effectiveFrom) < 0) {
        throw new Error(
          `new hair version effectiveFrom ${formatEpisode(input.effectiveFrom)} must not be before the previous version's effectiveFrom ${formatEpisode(last.effectiveFrom)}`,
        );
      }
    }

    const version: HairVersion = {
      versionId: hairVersionId(characterId, history.length),
      characterId,
      name,
      description: input.description,
      assetId: input.assetId ?? null,
      ghlFileId: input.ghlFileId ?? null,
      sha256: input.sha256 ?? null,
      effectiveFrom: input.effectiveFrom,
      retiredAt: null,
      state: history.length === 0 ? "CANONICAL" : "APPROVED",
      createdAt: input.createdAt ?? this.clock().toISOString(),
    };
    history.push(version);
    this.versions.set(characterId, history);
    return version;
  }

  resolveHairAt(characterId: CharacterId, episode: EpisodeRef): HairResolution {
    const history = this.versions.get(characterId);
    if (!history || history.length === 0) {
      throw new HairVersionNotFoundError(characterId, episode);
    }
    let active: HairVersion | undefined;
    for (const version of history) {
      const retired = version.retiredAt !== null && compareEpisodes(episode, version.retiredAt) >= 0;
      if (!retired && compareEpisodes(episode, version.effectiveFrom) >= 0) {
        active = version;
      }
    }
    if (!active) {
      throw new HairVersionNotFoundError(characterId, episode);
    }
    return {
      versionId: active.versionId,
      name: active.name,
      description: active.description,
      assetId: active.assetId,
      ghlFileId: active.ghlFileId,
      sha256: active.sha256,
    };
  }

  getHairHistory(characterId: CharacterId): readonly HairHistoryEntry[] {
    const history = this.versions.get(characterId) ?? [];
    return history.map((version) => ({
      versionId: version.versionId,
      name: version.name,
      effectiveFrom: version.effectiveFrom,
      retiredAt: version.retiredAt,
      state: version.state,
    }));
  }

  retireHairVersion(characterId: CharacterId, versionId: HairVersionId, retiredAt: EpisodeRef): void {
    const version = this.find(characterId, versionId);
    if (compareEpisodes(retiredAt, version.effectiveFrom) < 0) {
      throw new Error(
        `retirement episode ${formatEpisode(retiredAt)} is before the version became effective ${formatEpisode(version.effectiveFrom)}`,
      );
    }
    // Retirement never deletes or rewrites the version; it stays queryable
    // for every episode before retiredAt.
    version.retiredAt = retiredAt;
    version.state = "RETIRED";
  }

  promoteToCanonical(characterId: CharacterId, versionId: HairVersionId): void {
    const version = this.find(characterId, versionId);
    if (version.state === "RETIRED") {
      throw new Error(`hair version ${versionId} is RETIRED and cannot be promoted`);
    }
    version.state = "CANONICAL";
  }

  private find(characterId: CharacterId, versionId: HairVersionId): HairVersion {
    const history = this.versions.get(characterId);
    const version = history?.find((v) => v.versionId === versionId);
    if (!version) {
      throw new Error(`hair version ${versionId} not found for ${characterId}`);
    }
    return version;
  }
}

function hairVersionId(characterId: CharacterId, sequence: number): HairVersionId {
  const prefix = characterId.startsWith("CHAR_") ? characterId.slice("CHAR_".length) : characterId;
  return `HAIR_${prefix}_V${sequence + 1}`;
}

function compareEpisodes(a: EpisodeRef, b: EpisodeRef): number {
  if (a.season !== b.season) return a.season - b.season;
  return a.episode - b.episode;
}

function formatEpisode(episode: EpisodeRef): string {
  return `S${pad2(episode.season)}E${pad2(episode.episode)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}