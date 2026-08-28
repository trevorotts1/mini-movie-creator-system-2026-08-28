/**
 * Wardrobe / hair / prop checks (QC-003) — spec §9, §11, §12, §20.
 *
 * Verifies the ACTIVE appearance version (canon-at-the-time hair/wardrobe,
 * resolved from the Character Library appearance history at the episode's
 * continuity point) against the shot specification's requirements, and flags
 * wrong-wardrobe / missing-prop / forbidden-prop fixtures observed in the
 * generated media.
 *
 * Two gates, one check:
 *  1. Planning gate — the shot spec pins hair/wardrobe versions; those must
 *     match the active appearance version resolved for the shot's episode
 *     (spec §9: "resolve active identity/hair/wardrobe versions for the
 *     episode's continuity point"). A stale spec (e.g. braids required in
 *     E10 after the E09 haircut) is flagged before anything is generated.
 *  2. Observation gate — what the vision QC observed in the generated media
 *     (hair/wardrobe/props) must satisfy the shot spec's requirements
 *     (spec §20: "wardrobe; accessories; ... props").
 *
 * The appearance-history input is a structural mirror of the
 * `@mmcs/character-library` AppearanceHistory shape so this module stays
 * self-contained (no cross-package coupling; structural typing joins them at
 * integration).
 */

/** Lifecycle state carried by an appearance version (spec §9 asset states). */
export type AppearanceState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

/** One immutable appearance snapshot (structural mirror of CHAR-006). */
export interface AppearanceVersionRecord {
  versionLabel: string;
  hairVersion: string;
  wardrobeVersion: string;
  baseIdentityMasterId: string;
  state?: AppearanceState;
  effectiveEpisode?: string;
  effectiveTime?: string;
  changeNote?: string;
}

/** A character's ordered, append-only appearance history (structural mirror). */
export interface AppearanceHistoryInput {
  characterId: string;
  baseIdentityMasterId: string;
  versions: AppearanceVersionRecord[];
}

/** Hair/wardrobe/prop requirements taken from the shot spec record (§12). */
export interface ShotAppearanceRequirements {
  /** Required hair version, when the shot pins one. */
  hairVersion?: string;
  /** Required wardrobe version, when the shot pins one. */
  wardrobeVersion?: string;
  /** Props that must be present in the shot. */
  requiredProps?: string[];
  /** Props that must NOT appear in the shot (continuity exclusions). */
  forbiddenProps?: string[];
}

/** What the vision QC observed in the generated media for one character. */
export interface AppearanceObservation {
  /** Hair version detected in the generated media. */
  hairVersion?: string;
  /** Wardrobe version detected in the generated media. */
  wardrobeVersion?: string;
  /** Props detected in the generated media. */
  props?: string[];
}

/** One character's slice of a shot appearance QC. */
export interface ShotAppearanceCheckInput {
  shotId: string;
  characterId: string;
  /** Episode code the shot belongs to, e.g. "S01E10" (drives canon resolution). */
  episode?: string;
  /** Point in time for time-gated appearance versions (ISO 8601). */
  time?: string;
  /** The character's appearance history (resolved canon-at-the-time). */
  appearanceHistory: AppearanceHistoryInput;
  /** Requirements from the shot spec record. */
  requirements: ShotAppearanceRequirements;
  /** Optional observation from the generated media; omits the observation gate. */
  observation?: AppearanceObservation;
}

/** Failure kinds emitted by the wardrobe check. */
export type WardrobeFailureKind =
  | "HAIR_MISMATCH"
  | "WARDROBE_MISMATCH"
  | "MISSING_PROP"
  | "FORBIDDEN_PROP";

/** A single concrete defect found by the wardrobe check. */
export interface WardrobeFailure {
  kind: WardrobeFailureKind;
  /** Human-readable explanation naming expected vs actual. */
  message: string;
  /** The required/expected value from the shot spec. */
  expected: string;
  /** The observed/active value, or null when nothing was observed. */
  actual: string | null;
}

/** Per-character result of the wardrobe check. */
export interface WardrobeCheckResult {
  shotId: string;
  characterId: string;
  /** The active appearance version resolved for this continuity point. */
  activeVersionLabel: string | null;
  activeHairVersion: string | null;
  activeWardrobeVersion: string | null;
  /** "PASS" when no failures, "FAIL" otherwise. */
  status: "PASS" | "FAIL";
  failures: WardrobeFailure[];
}

/** Error thrown on invalid wardrobe-check inputs. */
export class WardrobeCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WardrobeCheckError";
  }
}

function effectiveEpisodeNumber(effectiveEpisode: string): number {
  const match = /^S(\d+)E(\d+)$/.exec(effectiveEpisode);
  if (!match) {
    throw new WardrobeCheckError(
      `episode must match S<season>E<episode>, got "${effectiveEpisode}"`,
    );
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  return season * 10000 + episode;
}

/**
 * Resolve the ACTIVE appearance version (canon-at-the-time) for one episode
 * and optional point in time — the newest version whose effective point is at
 * or before the query. Episodes before the first effective point resolve to
 * the index-0 version. A query with neither episode nor time means "now" and
 * resolves the latest created version. Mirrors the Character Library's
 * resolution so planning-time and QC-time resolution agree.
 */
export function resolveActiveAppearance(
  history: AppearanceHistoryInput,
  query: { episode?: string; time?: string },
): AppearanceVersionRecord {
  const first = history.versions[0];
  if (!first) {
    throw new WardrobeCheckError(
      `character ${history.characterId} has no appearance versions`,
    );
  }
  if (query.episode === undefined && query.time === undefined) {
    return history.versions[history.versions.length - 1] ?? first;
  }
  let resolved = first;
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
 * Check one character's appearance for one shot: the shot spec's hair/wardrobe
 * requirements must match the ACTIVE appearance version at the shot's
 * continuity point, and (when an observation is provided) the generated media
 * must satisfy the hair/wardrobe/prop requirements. Returns one result per
 * call; all requirement dimensions are checked, failures accumulate.
 */
export function checkAppearance(
  input: ShotAppearanceCheckInput,
): WardrobeCheckResult {
  if (input.shotId.length === 0) {
    throw new WardrobeCheckError("shotId must be non-empty");
  }
  if (input.characterId.length === 0) {
    throw new WardrobeCheckError("characterId must be non-empty");
  }
  const failures: WardrobeFailure[] = [];

  let active: AppearanceVersionRecord | null = null;
  if (input.appearanceHistory.versions.length > 0) {
    active = resolveActiveAppearance(input.appearanceHistory, {
      episode: input.episode,
      time: input.time,
    });
  }

  // Planning gate: shot-spec pins must agree with the active appearance.
  if (active && input.requirements.hairVersion !== undefined) {
    if (input.requirements.hairVersion !== active.hairVersion) {
      failures.push({
        kind: "HAIR_MISMATCH",
        message:
          `shot ${input.shotId} requires hair "${input.requirements.hairVersion}" ` +
          `but the active appearance version for ${input.characterId}` +
          `${input.episode ? ` at ${input.episode}` : ""} is ` +
          `"${active.hairVersion}" (${active.versionLabel})`,
        expected: input.requirements.hairVersion,
        actual: active.hairVersion,
      });
    }
  }
  if (active && input.requirements.wardrobeVersion !== undefined) {
    if (input.requirements.wardrobeVersion !== active.wardrobeVersion) {
      failures.push({
        kind: "WARDROBE_MISMATCH",
        message:
          `shot ${input.shotId} requires wardrobe ` +
          `"${input.requirements.wardrobeVersion}" but the active appearance ` +
          `version for ${input.characterId}` +
          `${input.episode ? ` at ${input.episode}` : ""} is ` +
          `"${active.wardrobeVersion}" (${active.versionLabel})`,
        expected: input.requirements.wardrobeVersion,
        actual: active.wardrobeVersion,
      });
    }
  }

  // Observation gate: generated media must satisfy the shot requirements.
  const observation = input.observation;
  if (observation) {
    if (
      input.requirements.hairVersion !== undefined &&
      observation.hairVersion !== undefined &&
      observation.hairVersion !== input.requirements.hairVersion
    ) {
      failures.push({
        kind: "HAIR_MISMATCH",
        message:
          `shot ${input.shotId} requires hair "${input.requirements.hairVersion}" ` +
          `but generated media shows "${observation.hairVersion}"`,
        expected: input.requirements.hairVersion,
        actual: observation.hairVersion,
      });
    }
    if (
      input.requirements.wardrobeVersion !== undefined &&
      observation.wardrobeVersion !== undefined &&
      observation.wardrobeVersion !== input.requirements.wardrobeVersion
    ) {
      failures.push({
        kind: "WARDROBE_MISMATCH",
        message:
          `shot ${input.shotId} requires wardrobe ` +
          `"${input.requirements.wardrobeVersion}" but generated media shows ` +
          `"${observation.wardrobeVersion}"`,
        expected: input.requirements.wardrobeVersion,
        actual: observation.wardrobeVersion,
      });
    }
    {
      const observedProps = observation.props ?? [];
      for (const required of input.requirements.requiredProps ?? []) {
        if (!observedProps.includes(required)) {
          failures.push({
            kind: "MISSING_PROP",
            message:
              `shot ${input.shotId} requires prop "${required}" but it was not ` +
              `observed in the generated media`,
            expected: required,
            actual: null,
          });
        }
      }
      for (const forbidden of input.requirements.forbiddenProps ?? []) {
        if (observedProps.includes(forbidden)) {
          failures.push({
            kind: "FORBIDDEN_PROP",
            message:
              `shot ${input.shotId} forbids prop "${forbidden}" but it was ` +
              `observed in the generated media`,
            expected: `absent: ${forbidden}`,
            actual: forbidden,
          });
        }
      }
    }
  }

  return {
    shotId: input.shotId,
    characterId: input.characterId,
    activeVersionLabel: active?.versionLabel ?? null,
    activeHairVersion: active?.hairVersion ?? null,
    activeWardrobeVersion: active?.wardrobeVersion ?? null,
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };
}

/** One character's appearance slice inside a multi-character shot. */
export interface ShotCharacterAppearance {
  characterId: string;
  appearanceHistory: AppearanceHistoryInput;
  requirements: ShotAppearanceRequirements;
  observation?: AppearanceObservation;
}

/** Whole-shot input: every character checked against the same shot spec. */
export interface ShotAppearanceInput {
  shotId: string;
  episode?: string;
  time?: string;
  characters: ShotCharacterAppearance[];
}

/**
 * Check every character in a shot. One result per character; never throws on
 * a failing check (failures are data), only on invalid input.
 */
export function checkShot(
  input: ShotAppearanceInput,
): WardrobeCheckResult[] {
  if (input.shotId.length === 0) {
    throw new WardrobeCheckError("shotId must be non-empty");
  }
  return input.characters.map((character) =>
    checkAppearance({
      shotId: input.shotId,
      characterId: character.characterId,
      episode: input.episode,
      time: input.time,
      appearanceHistory: character.appearanceHistory,
      requirements: character.requirements,
      observation: character.observation,
    }),
  );
}

/** Roll-up status for the shot record's `qc_status` field (§12). */
export function overallStatus(results: readonly WardrobeCheckResult[]): "PASS" | "FAIL" {
  return results.some((result) => result.status === "FAIL") ? "FAIL" : "PASS";
}