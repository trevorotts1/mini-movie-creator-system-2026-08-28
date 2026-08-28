/**
 * Wardrobe versioning for the Character Library (spec §9 + §11).
 *
 * Wardrobe states are versioned per character with an immutable history: a
 * wardrobe change never overwrites a prior version, it appends a new version
 * with an effective continuity point. Resolving the active wardrobe for an
 * episode continuity point returns the canon-at-the-time version — the newest
 * version whose effective point is <= the queried point.
 */

/** Ordered episode point on a series timeline. */
export interface EpisodePoint {
  readonly season: number;
  readonly episode: number;
}

/** Asset lifecycle states (spec §9 "Asset states"). */
export type WardrobeAssetState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

/** Reference package categories a wardrobe version contributes (spec §9). */
export type WardrobeReferenceCategory =
  | "full-body-master"
  | "face-front-master"
  | "face-3q-master"
  | "face-profile-master"
  | "detail"
  | "provider-pack";

/** One versioned wardrobe state for a character (immutable once recorded). */
export interface WardrobeVersion {
  /** Stable version id, unique per character (e.g. "business-blue-v1"). */
  readonly versionId: string;
  /** Owning character stable business ID (e.g. "CHAR_MONICA_BENNETT_001"). */
  readonly characterId: string;
  /** Human label for the state (e.g. "business blue suit"). */
  readonly label: string;
  /** Continuity point from which this state is canon. */
  readonly effectiveFrom: EpisodePoint;
  /**
   * Continuity point after which this state stops being canon. `null` means
   * still current; superseded versions get this stamped when replaced.
   */
  readonly effectiveUntil: EpisodePoint | null;
  /** Lifecycle state of the wardrobe version itself. */
  readonly state: WardrobeAssetState;
  /** Durable reference assets backing this state, keyed by category. */
  readonly references: ReadonlyArray<WardrobeReference>;
  /** Canonical wardrobe description used verbatim in prompts. */
  readonly description: string;
}

/** A durable reference asset for a wardrobe state. */
export interface WardrobeReference {
  readonly category: WardrobeReferenceCategory;
  /** MMCS asset ID. */
  readonly assetId: string;
  /** Durable provider URL (used verbatim downstream). */
  readonly url: string;
  /** SHA-256 of the asset. */
  readonly sha256: string;
  readonly state: WardrobeAssetState;
}

/** An episode continuity point where the active wardrobe changes. */
export interface WardrobeChange {
  readonly characterId: string;
  /** Version being introduced at this point. */
  readonly versionId: string;
  /** Version it replaces (must be the currently active one, if any). */
  readonly supersedes: string | null;
  readonly effectiveFrom: EpisodePoint;
}

/** Read-only wardrobe history for one character. */
export interface WardrobeHistory {
  readonly characterId: string;
  readonly versions: ReadonlyArray<WordrobeVersionLike>;
}

/** Structural alias kept internal-friendly for version records in a history. */
export type WordrobeVersionLike = WardrobeVersion;

/** Compares two episode points (season-major, then episode). */
export function compareEpisodePoints(
  a: EpisodePoint,
  b: EpisodePoint,
): number {
  if (a.season !== b.season) return a.season - b.season;
  return a.episode - b.episode;
}

/** True when `point` is at or after `effective`. */
export function isAtOrAfter(point: EpisodePoint, effective: EpisodePoint): boolean {
  return compareEpisodePoints(point, effective) >= 0;
}

function versionWindowContains(
  version: WardrobeVersion,
  point: EpisodePoint,
): boolean {
  if (!isAtOrAfter(point, version.effectiveFrom)) return false;
  if (version.effectiveUntil === null) return true;
  return compareEpisodePoints(point, version.effectiveUntil) < 0;
}

/** Validates the shared structural invariants of a wardrobe version. */
function assertVersionShape(version: WardrobeVersion): void {
  if (version.characterId.length === 0) {
    throw new Error("wardrobe version requires a characterId");
  }
  if (version.versionId.length === 0) {
    throw new Error("wardrobe version requires a versionId");
  }
  if (version.effectiveUntil !== null) {
    if (compareEpisodePoints(version.effectiveUntil, version.effectiveFrom) <= 0) {
      throw new Error(
        `wardrobe version ${version.versionId}: effectiveUntil must be after effectiveFrom`,
      );
    }
  }
}

/** Creates the initial wardrobe version for a character. */
export function createWardrobeHistory(input: {
  characterId: string;
  versionId: string;
  label: string;
  effectiveFrom: EpisodePoint;
  description: string;
  references?: ReadonlyArray<WardrobeReference>;
  state?: WardrobeAssetState;
}): WardrobeHistory {
  const version: WardrobeVersion = {
    versionId: input.versionId,
    characterId: input.characterId,
    label: input.label,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: null,
    state: input.state ?? "CANONICAL",
    references: input.references ?? [],
    description: input.description,
  };
  assertVersionShape(version);
  return { characterId: input.characterId, versions: [version] };
}

/**
 * Records a wardrobe change: appends a new version effective from a continuity
 * point and closes the superseded version. The prior version is never mutated
 * into the new state — history stays immutable; the old version only gets its
 * `effectiveUntil` stamped so historical episodes still resolve it.
 */
export function recordWardrobeChange(
  history: WardrobeHistory,
  change: WardrobeChange,
  input: {
    label: string;
    description: string;
    references?: ReadonlyArray<WardrobeReference>;
    state?: WardrobeAssetState;
  },
): WardrobeHistory {
  if (history.characterId !== change.characterId) {
    throw new Error(
      `wardrobe change for ${change.characterId} applied to history of ${history.characterId}`,
    );
  }
  const versions = [...history.versions];
  if (versions.length === 0) {
    throw new Error(
      `cannot record wardrobe change for ${change.characterId}: history is empty`,
    );
  }
  if (versions.some((v) => v.versionId === change.versionId)) {
    throw new Error(
      `wardrobe version ${change.versionId} already exists for ${change.characterId}`,
    );
  }
  const current = resolveActiveWardrobe(history, change.effectiveFrom);
  if (current === null || current.versionId !== change.supersedes) {
    const actual = current === null ? "none" : current.versionId;
    throw new Error(
      `wardrobe change ${change.versionId} supersedes ${change.supersedes ?? "nothing"} but active at ${change.effectiveFrom.season}E${change.effectiveFrom.episode} is ${actual}`,
    );
  }
  if (compareEpisodePoints(change.effectiveFrom, current.effectiveFrom) <= 0) {
    throw new Error(
      `wardrobe change ${change.versionId}: effectiveFrom must be after the superseded version's start`,
    );
  }

  const next: WardrobeVersion = {
    versionId: change.versionId,
    characterId: change.characterId,
    label: input.label,
    effectiveFrom: change.effectiveFrom,
    effectiveUntil: null,
    state: input.state ?? "CANONICAL",
    references: input.references ?? [],
    description: input.description,
  };
  assertVersionShape(next);

  const closed: WardrobeVersion = {
    ...current,
    effectiveUntil: change.effectiveFrom,
  };
  const closedIndex = versions.findIndex((v) => v.versionId === current.versionId);
  versions[closedIndex] = closed;
  versions.push(next);
  versions.sort(
    (a, b) => compareEpisodePoints(a.effectiveFrom, b.effectiveFrom) || a.versionId.localeCompare(b.versionId),
  );
  return { characterId: history.characterId, versions };
}

/**
 * Resolves the active wardrobe for an episode continuity point: the newest
 * version effective at or before the point whose window still contains it.
 * Non-approved states (DRAFT/REVIEW/REJECTED/RETIRED) never resolve as active.
 * Returns `null` when the point predates every approved version.
 */
export function resolveActiveWardrobe(
  history: WardrobeHistory,
  point: EpisodePoint,
): WardrobeVersion | null {
  const candidates = history.versions.filter(
    (v) => isApprovedState(v.state) && versionWindowContains(v, point),
  );
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (compareEpisodePoints(candidate.effectiveFrom, best.effectiveFrom) > 0) {
      best = candidate;
    }
  }
  return best;
}

/** True for states eligible to auto-resolve as active (spec §9). */
export function isApprovedState(state: WardrobeAssetState): boolean {
  return state === "APPROVED" || state === "CANONICAL";
}

/** Lists all versions for a character, oldest effective first. */
export function listWardrobeVersions(history: WardrobeHistory): ReadonlyArray<WardrobeVersion> {
  return history.versions;
}

/**
 * Resolves the canon-at-the-time wardrobe for a historical episode. Historical
 * episodes must keep referencing the version that was canon when they aired,
 * even after newer versions exist — this is the same resolution rule as
 * `resolveActiveWardrobe` but named for the historical-read use case.
 */
export function resolveWardrobeAtPoint(
  history: WardrobeHistory,
  point: EpisodePoint,
): WardrobeVersion | null {
  return resolveActiveWardrobe(history, point);
}