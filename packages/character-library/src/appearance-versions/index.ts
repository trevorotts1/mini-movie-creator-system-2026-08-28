/**
 * Appearance versioning for the Character Library (spec §9 "Identity versioning
 * (immutable history)").
 *
 * A hair/wardrobe change creates a NEW appearance version with an effective
 * episode and/or effective time. It must never mutate or replace the base
 * identity master, and historical episodes always resolve the
 * canon-at-the-time version (Monica v1 braids for E01–E08, v2 short from E09).
 */

import type { AssetState } from "./asset-states.js";

/** Identifies where an appearance change takes effect in the timeline. */
export interface EffectivePoint {
  /** Episode code this version becomes canon from, e.g. "S01E09". */
  effectiveEpisode?: string;
  /** Wall-clock instant this version becomes canon from (ISO 8601). */
  effectiveTime?: string;
}

/** One immutable appearance snapshot of a character at some point in canon. */
export interface AppearanceVersion extends EffectivePoint {
  /** Stable version label, e.g. "v1" or "v2". Unique per character. */
  versionLabel: string;
  /** Hair state carried by this version (e.g. "long-braids-v1"). */
  hairVersion: string;
  /** Wardrobe state carried by this version (e.g. "business-blue-v1"). */
  wardrobeVersion: string;
  /** Durable linkage to the base identity master this version derives from. */
  baseIdentityMasterId: string;
  /** Asset lifecycle state of this appearance version itself. */
  state: AssetState;
  /** Optional note describing the change (e.g. "cut braids, short hair"). */
  changeNote?: string;
}

/** A character's ordered, append-only appearance history. */
export interface AppearanceHistory {
  /** Character these versions belong to (stable business ID). */
  characterId: string;
  /** Immutable base identity master; never replaced by appearance changes. */
  baseIdentityMasterId: string;
  /** Ordered by first-became-canon; index 0 is the original appearance. */
  versions: AppearanceVersion[];
}

/** Options for {@link createAppearanceHistory}. */
export interface CreateAppearanceHistoryOptions {
  /** Hair state of the original appearance version. */
  initialHairVersion: string;
  /** Wardrobe state of the original appearance version. */
  initialWardrobeVersion: string;
  /** Effective point of the original version; defaults to no constraint. */
  initialEffective?: EffectivePoint;
  /** Initial lifecycle state; defaults to "DRAFT". */
  initialState?: AssetState;
}

/** Error thrown on invalid appearance-version operations. */
export class AppearanceVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppearanceVersionError";
  }
}

const VERSION_LABEL_PATTERN = /^v\d+$/;

/**
 * Create an append-only appearance history whose index-0 version is the
 * original appearance. The base identity master is recorded once and can
 * never be swapped by later appearance changes.
 */
export function createAppearanceHistory(
  characterId: string,
  baseIdentityMasterId: string,
  options: CreateAppearanceHistoryOptions,
): AppearanceHistory {
  if (characterId.length === 0) {
    throw new AppearanceVersionError("characterId must be non-empty");
  }
  if (baseIdentityMasterId.length === 0) {
    throw new AppearanceVersionError("baseIdentityMasterId must be non-empty");
  }
  const version: AppearanceVersion = {
    versionLabel: "v1",
    hairVersion: options.initialHairVersion,
    wardrobeVersion: options.initialWardrobeVersion,
    baseIdentityMasterId,
    state: options.initialState ?? "DRAFT",
    ...(options.initialEffective ?? {}),
  };
  return { characterId, baseIdentityMasterId, versions: [version] };
}

/**
 * Create a new appearance version for a hair and/or wardrobe change.
 * Appends only; the previous versions and the base identity master stay
 * untouched. Version labels are auto-assigned as v2, v3, … and must never
 * collide.
 */
export function addAppearanceVersion(
  history: AppearanceHistory,
  change: {
    hairVersion?: string;
    wardrobeVersion?: string;
    effectiveEpisode?: string;
    effectiveTime?: string;
    state?: AssetState;
    changeNote?: string;
  },
): AppearanceVersion {
  const previous = latestAppearanceVersion(history);
  const hairVersion = change.hairVersion ?? previous.hairVersion;
  const wardrobeVersion = change.wardrobeVersion ?? previous.wardrobeVersion;
  if (hairVersion === previous.hairVersion && wardrobeVersion === previous.wardrobeVersion) {
    throw new AppearanceVersionError(
      "appearance version must change hairVersion and/or wardrobeVersion",
    );
  }
  if (
    change.effectiveEpisode === undefined &&
    change.effectiveTime === undefined
  ) {
    throw new AppearanceVersionError(
      "appearance version requires an effective episode and/or effective time",
    );
  }
  const nextNumber = history.versions.length + 1;
  const versionLabel = `v${nextNumber}`;
  if (
    history.versions.some((v) => v.versionLabel === versionLabel) ||
    !VERSION_LABEL_PATTERN.test(versionLabel)
  ) {
    throw new AppearanceVersionError(`version label collision: ${versionLabel}`);
  }
  const version: AppearanceVersion = {
    versionLabel,
    hairVersion,
    wardrobeVersion,
    baseIdentityMasterId: history.baseIdentityMasterId,
    state: change.state ?? "DRAFT",
    changeNote: change.changeNote,
    ...(change.effectiveEpisode !== undefined
      ? { effectiveEpisode: change.effectiveEpisode }
      : {}),
    ...(change.effectiveTime !== undefined ? { effectiveTime: change.effectiveTime } : {}),
  };
  history.versions.push(version);
  return version;
}

/** The most recently created appearance version, or undefined when empty. */
export function latestAppearanceVersion(
  history: AppearanceHistory,
): AppearanceVersion {
  const last = history.versions.at(-1);
  if (!last) {
    throw new AppearanceVersionError(
      `character ${history.characterId} has no appearance versions`,
    );
  }
  return last;
}

function effectiveEpisodeNumber(effectiveEpisode: string): number {
  const match = /^S(\d+)E(\d+)$/.exec(effectiveEpisode);
  if (!match) {
    throw new AppearanceVersionError(
      `effectiveEpisode must match S<season>E<episode>, got "${effectiveEpisode}"`,
    );
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  return season * 10000 + episode;
}

/**
 * Resolve the canon-at-the-time appearance version for one episode and
 * optional point in time: the newest version whose effective point is at or
 * before the query. Versions created with only an effectiveTime apply from
 * that instant regardless of episode; versions with only an effectiveEpisode
 * apply from that episode onward; versions with both require both to have
 * passed. Episodes before the first version's effective episode resolve to
 * the index-0 version (the original appearance is canon from the start).
 * A query with neither episode nor time means "now" and resolves the latest
 * created version.
 */
export function resolveAppearanceVersion(
  history: AppearanceHistory,
  query: { episode?: string; time?: string },
): AppearanceVersion {
  let resolved = history.versions[0];
  if (!resolved) {
    throw new AppearanceVersionError(
      `character ${history.characterId} has no appearance versions`,
    );
  }
  if (query.episode === undefined && query.time === undefined) {
    return latestAppearanceVersion(history);
  }
  for (const version of history.versions.slice(1)) {
    if (version.effectiveEpisode !== undefined) {
      if (query.episode === undefined) continue;
      if (
        effectiveEpisodeNumber(query.episode) <
        effectiveEpisodeNumber(version.effectiveEpisode)
      ) {
        continue;
      }
    }
    if (version.effectiveTime !== undefined) {
      if (query.time === undefined) continue;
      if (query.time < version.effectiveTime) continue;
    }
    resolved = version;
  }
  return resolved;
}

/**
 * The version an episode should have canonically referenced at its air time:
 * resolution restricted to effective-episode ordering (ignores later time-only
 * changes). Kept explicit so historical re-renders stay deterministic.
 */
export function resolveAppearanceVersionForEpisode(
  history: AppearanceHistory,
  episode: string,
): AppearanceVersion {
  return resolveAppearanceVersion(history, { episode });
}