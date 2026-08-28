/**
 * Continuity neighbor check (QC-004) — spec §11 "LOCATIONS, WARDROBE, PROPS":
 * "Scene continuity QC compares neighboring shots against each other and the
 * current Series Bible state."
 *
 * Two comparison axes, both deterministic (no LLM, no media):
 *
 * 1. Neighbor pairs — shots are grouped by scene, ordered by
 *    `sequenceIndex`, and each adjacent pair is compared for location,
 *    time-of-day, wardrobe, hair, prop, and start/end-state continuity.
 * 2. Series Bible state — each shot is checked against the bible snapshot
 *    supplied by the caller: canonical appearance versions resolve by
 *    effective episode (spec §9/§10 immutable history — Monica v1 braids
 *    through E08, v2 short hair from E09), and recurring locations carry
 *    their approved day/night states.
 *
 * Story/text data flowing through here is untrusted and is only ever
 * compared as strings — never executed, never interpolated into code.
 */

/** Severity of a continuity finding. Only `break` flips `ok` to false. */
export const CONTINUITY_SEVERITIES = ["break", "warning"] as const;

export type ContinuitySeverity = (typeof CONTINUITY_SEVERITIES)[number];

/** Finding codes emitted by the continuity check. */
export const CONTINUITY_FINDING_CODES = [
  "location-jump",
  "time-of-day-jump",
  "wardrobe-jump",
  "hair-jump",
  "prop-vanish",
  "state-mismatch",
  "bible-location-state",
  "bible-wardrobe-mismatch",
  "bible-hair-mismatch",
] as const;

export type ContinuityFindingCode = (typeof CONTINUITY_FINDING_CODES)[number];

/** One shot record — the subset of the spec §12 shot specification record the continuity check reads. */
export interface ContinuityShot {
  /** Stable shot business ID. */
  shotId: string;
  /** Owning scene business ID; neighbors are only paired within a scene. */
  sceneId: string;
  /** Order within the scene; neighbors are adjacent after sorting on this. */
  sequenceIndex: number;
  /** Episode code the shot belongs to, e.g. "S01E05" (zero-padded, lexicographically comparable). */
  episode?: string;
  /** Recurring location ID (spec §11 library); null/undefined when unknown. */
  location?: string | null;
  /** Day/night state of the location in this shot ("day", "night", …). */
  timeOfDay?: string | null;
  /** Character business IDs present in the shot. */
  characters?: readonly string[];
  /** Wardrobe state per character ID (spec §11 wardrobe states). */
  wardrobe?: Readonly<Record<string, string>>;
  /** Hair state per character ID (identity/appearance version). */
  hair?: Readonly<Record<string, string>>;
  /** Props present in the shot (spec §11 props library IDs). */
  props?: readonly string[];
  /** State of the scene at the start of the shot (spec §12 `start_state`). */
  startState?: string | null;
  /** State of the scene at the end of the shot (spec §12 `end_state`). */
  endState?: string | null;
}

/** One immutable canon appearance version of a character (spec §9/§10 versioning). */
export interface BibleAppearanceVersion {
  /** Version label, e.g. "v1" / "v2". */
  versionLabel: string;
  /** Hair state carried by this version. */
  hairVersion: string;
  /** Wardrobe state carried by this version. */
  wardrobeVersion: string;
  /** Episode code this version becomes canon from; omit for the original. */
  effectiveEpisode?: string;
  /** Wall-clock instant this version becomes canon from (ISO 8601). */
  effectiveTime?: string;
}

/** A character's canon appearance history in the Series Bible. */
export interface BibleCharacter {
  /** Character business ID. */
  characterId: string;
  /** Ordered appearance versions; index 0 is the original. */
  appearances: readonly BibleAppearanceVersion[];
}

/** A recurring location and its approved day/night states (spec §11). */
export interface BibleLocation {
  /** Location business ID. */
  locationId: string;
  /** Approved time-of-day states, e.g. ["day", "night"]. */
  dayNightStates: readonly string[];
}

/** The current Series Bible state snapshot the check compares shots against (spec §10/§11). */
export interface ContinuityBible {
  /** Canon appearance histories, keyed by character. */
  characters: readonly BibleCharacter[];
  /** Recurring location library. */
  locations: readonly BibleLocation[];
}

/** Input accepted by {@linkcode runContinuityCheck}. */
export interface ContinuityCheckInput {
  /** Shots to check; order in the array does not matter (sorted internally). */
  shots: readonly ContinuityShot[];
  /** Current Series Bible state; optional — without it only neighbor checks run. */
  bible?: ContinuityBible | null;
}

/** A single continuity finding. */
export interface ContinuityFinding {
  /** Machine-readable code from {@linkcode CONTINUITY_FINDING_CODES}. */
  code: ContinuityFindingCode;
  /** Severity; `break` means the shot pair/shot fails continuity QC. */
  severity: ContinuitySeverity;
  /** Human-readable explanation naming the conflicting values. */
  message: string;
  /** Shot IDs involved (pair for neighbor findings, single for bible findings). */
  shotIds: string[];
  /** Scene the finding belongs to; null when not scene-scoped. */
  sceneId: string | null;
}

/** Result of the continuity check. `ok` is true only when no `break` findings exist. */
export interface ContinuityCheckResult {
  /** True when zero `break` findings (warnings do not fail the check). */
  ok: boolean;
  /** All findings, neighbor pairs first, then bible checks, in input order. */
  findings: ContinuityFinding[];
}

/** Error thrown when the shot input itself is malformed (not a continuity break). */
export class ContinuityCheckError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateShots(shots: readonly ContinuityShot[]): void {
  const seen = new Set<string>();
  for (const shot of shots) {
    if (!isNonEmptyString(shot.shotId)) {
      throw new ContinuityCheckError(`shot.shotId must be a non-empty string`);
    }
    if (!isNonEmptyString(shot.sceneId)) {
      throw new ContinuityCheckError(`shot ${shot.shotId}: sceneId must be a non-empty string`);
    }
    if (!Number.isInteger(shot.sequenceIndex)) {
      throw new ContinuityCheckError(`shot ${shot.shotId}: sequenceIndex must be an integer`);
    }
    if (seen.has(shot.shotId)) {
      throw new ContinuityCheckError(`duplicate shotId: ${shot.shotId}`);
    }
    seen.add(shot.shotId);
  }
}

/**
 * Resolve the canon-at-the-time appearance for a character: the last version
 * whose `effectiveEpisode` is at or before the shot's episode (spec §9 —
 * historical episodes reference the canon state at their time). Without a
 * shot episode the canon point is undetermined, so nothing is resolved and
 * no bible finding is emitted for that character.
 */
export function resolveBibleAppearance(
  bible: ContinuityBible,
  characterId: string,
  episode: string | undefined,
): BibleAppearanceVersion | null {
  const character = bible.characters.find((c) => c.characterId === characterId);
  if (!character || character.appearances.length === 0) return null;
  if (episode === undefined) return null;
  let resolved: BibleAppearanceVersion | null = null;
  for (const appearance of character.appearances) {
    const effective = appearance.effectiveEpisode;
    if (effective === undefined || effective <= episode) resolved = appearance;
  }
  return resolved;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function stringDiffers(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return normalized(a) !== normalized(b);
}

function sharedCharacters(
  prev: ContinuityShot,
  next: ContinuityShot,
): string[] {
  const nextSet = new Set(next.characters ?? []);
  return (prev.characters ?? []).filter((id) => nextSet.has(id));
}

function compareNeighbors(
  prev: ContinuityShot,
  next: ContinuityShot,
  findings: ContinuityFinding[],
): void {
  const pair = [prev.shotId, next.shotId];

  if (stringDiffers(prev.location, next.location)) {
    findings.push({
      code: "location-jump",
      severity: "break",
      message: `Neighboring shots change location from "${prev.location}" to "${next.location}"`,
      shotIds: pair,
      sceneId: prev.sceneId,
    });
  }

  if (stringDiffers(prev.timeOfDay, next.timeOfDay)) {
    findings.push({
      code: "time-of-day-jump",
      severity: "break",
      message: `Neighboring shots change time of day from "${prev.timeOfDay}" to "${next.timeOfDay}"`,
      shotIds: pair,
      sceneId: prev.sceneId,
    });
  }

  for (const characterId of sharedCharacters(prev, next)) {
    const prevWardrobe = prev.wardrobe?.[characterId];
    const nextWardrobe = next.wardrobe?.[characterId];
    if (stringDiffers(prevWardrobe, nextWardrobe)) {
      findings.push({
        code: "wardrobe-jump",
        severity: "break",
        message: `Character ${characterId} changes wardrobe from "${prevWardrobe}" to "${nextWardrobe}" between neighboring shots`,
        shotIds: pair,
        sceneId: prev.sceneId,
      });
    }

    const prevHair = prev.hair?.[characterId];
    const nextHair = next.hair?.[characterId];
    if (stringDiffers(prevHair, nextHair)) {
      findings.push({
        code: "hair-jump",
        severity: "break",
        message: `Character ${characterId} changes hair from "${prevHair}" to "${nextHair}" between neighboring shots`,
        shotIds: pair,
        sceneId: prev.sceneId,
      });
    }
  }

  // A prop present in the previous shot must not silently vanish from the
  // next shot. New props appearing are fine; disappearing props are a break.
  if (prev.props !== undefined && next.props !== undefined) {
    const nextProps = new Set(next.props.map(normalized));
    for (const prop of prev.props) {
      if (!nextProps.has(normalized(prop))) {
        findings.push({
          code: "prop-vanish",
          severity: "break",
          message: `Prop "${prop}" present in shot ${prev.shotId} is missing from neighboring shot ${next.shotId}`,
          shotIds: pair,
          sceneId: prev.sceneId,
        });
      }
    }
  }

  // The state the previous shot ends in must match the state the next shot
  // starts in (spec §12 start_state / end_state).
  if (stringDiffers(prev.endState, next.startState)) {
    findings.push({
      code: "state-mismatch",
      severity: "break",
      message: `Shot ${prev.shotId} ends in state "${prev.endState}" but neighboring shot ${next.shotId} starts in state "${next.startState}"`,
      shotIds: pair,
      sceneId: prev.sceneId,
    });
  }
}

function checkShotAgainstBible(
  shot: ContinuityShot,
  bible: ContinuityBible,
  findings: ContinuityFinding[],
): void {
  const shotIds = [shot.shotId];

  const location = shot.location;
  const timeOfDay = shot.timeOfDay;
  if (typeof location === "string" && typeof timeOfDay === "string") {
    const bibleLocation = bible.locations.find((l) => l.locationId === location);
    if (bibleLocation) {
      const states = new Set(bibleLocation.dayNightStates.map(normalized));
      if (!states.has(normalized(timeOfDay))) {
        findings.push({
          code: "bible-location-state",
          severity: "break",
          message: `Shot ${shot.shotId} sets location "${location}" to time of day "${timeOfDay}", which is not an approved state in the Series Bible (approved: ${bibleLocation.dayNightStates.map((s) => `"${s}"`).join(", ")})`,
          shotIds,
          sceneId: shot.sceneId,
        });
      }
    }
  }

  for (const characterId of shot.characters ?? []) {
    const appearance = resolveBibleAppearance(bible, characterId, shot.episode);
    if (!appearance) continue;

    const shotWardrobe = shot.wardrobe?.[characterId];
    if (shotWardrobe !== undefined && normalized(shotWardrobe) !== normalized(appearance.wardrobeVersion)) {
      findings.push({
        code: "bible-wardrobe-mismatch",
        severity: "break",
        message: `Shot ${shot.shotId} wardrobe "${shotWardrobe}" for character ${characterId} contradicts Series Bible canon "${appearance.wardrobeVersion}" (${appearance.versionLabel})`,
        shotIds,
        sceneId: shot.sceneId,
      });
    }

    const shotHair = shot.hair?.[characterId];
    if (shotHair !== undefined && normalized(shotHair) !== normalized(appearance.hairVersion)) {
      findings.push({
        code: "bible-hair-mismatch",
        severity: "break",
        message: `Shot ${shot.shotId} hair "${shotHair}" for character ${characterId} contradicts Series Bible canon "${appearance.hairVersion}" (${appearance.versionLabel})`,
        shotIds,
        sceneId: shot.sceneId,
      });
    }
  }
}

/**
 * Run the continuity neighbor check (spec §11): compare neighboring shots
 * against each other and the current Series Bible state. Shots are grouped
 * by scene and ordered by `sequenceIndex`; input array order is irrelevant.
 */
export function runContinuityCheck(input: ContinuityCheckInput): ContinuityCheckResult {
  validateShots(input.shots);

  const findings: ContinuityFinding[] = [];

  const byScene = new Map<string, ContinuityShot[]>();
  for (const shot of input.shots) {
    const bucket = byScene.get(shot.sceneId);
    if (bucket) bucket.push(shot);
    else byScene.set(shot.sceneId, [shot]);
  }

  for (const sceneShots of byScene.values()) {
    const sorted = [...sceneShots].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (!prev || !next) continue;
      compareNeighbors(prev, next, findings);
    }
  }

  if (input.bible) {
    for (const shot of input.shots) {
      checkShotAgainstBible(shot, input.bible, findings);
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === "break"),
    findings,
  };
}