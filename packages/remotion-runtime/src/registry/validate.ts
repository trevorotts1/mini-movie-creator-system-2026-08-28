import type { EpisodicPlan, EpisodePlan, ScenePlan, SeriesPlan, ShotPlan } from "./types.js";

/**
 * Plan validation — fail loudly at registry build time, never at render time.
 * The registry is generated from a DB plan (spec §21); a planner bug (gap,
 * overlap, duplicate scene number) must surface as a typed error naming the
 * exact entity, not as a silently wrong timeline.
 */

export class RegistryPlanError extends Error {
  constructor(message: string) {
    super(`[episodic-registry] ${message}`);
    this.name = "RegistryPlanError";
  }
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RegistryPlanError(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RegistryPlanError(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RegistryPlanError(`${label} must be a positive finite number, got ${String(value)}`);
  }
  return value;
}

function requireDimension(value: unknown, label: string): number {
  const n = requirePositiveNumber(value, label);
  if (!Number.isInteger(n)) {
    throw new RegistryPlanError(`${label} must be an integer number of pixels, got ${String(value)}`);
  }
  return n;
}

function validateShot(shot: ShotPlan, episodeCode: string, sceneId: string): void {
  requireNonEmptyString(shot.shotId, `shot.shotId (${episodeCode} / ${sceneId})`);
  requirePositiveInt(shot.sequenceIndex, `shot.sequenceIndex (${shot.shotId})`);
  requirePositiveNumber(
    shot.targetDurationSeconds,
    `shot.targetDurationSeconds (${shot.shotId})`,
  );
}

function validateScene(scene: ScenePlan, episodeCode: string): void {
  requireNonEmptyString(scene.sceneId, `scene.sceneId (${episodeCode})`);
  requirePositiveInt(scene.sequenceIndex, `scene.sequenceIndex (${scene.sceneId})`);
  if (!Array.isArray(scene.shots)) {
    throw new RegistryPlanError(`scene.shots must be an array (${scene.sceneId})`);
  }
  if (scene.shots.length === 0) {
    throw new RegistryPlanError(`scene has no shots (${scene.sceneId})`);
  }
  for (const shot of scene.shots) {
    validateShot(shot, episodeCode, scene.sceneId);
  }
}

function validateEpisode(episode: EpisodePlan): string {
  requireNonEmptyString(episode.id, "episode.id");
  const season = requirePositiveInt(episode.seasonNumber, `episode.seasonNumber (${episode.id})`);
  const number = requirePositiveInt(episode.episodeNumber, `episode.episodeNumber (${episode.id})`);
  const code = formatEpisodeCode(season, number);
  if (!Array.isArray(episode.scenes)) {
    throw new RegistryPlanError(`episode.scenes must be an array (${episode.id})`);
  }
  if (episode.scenes.length === 0) {
    throw new RegistryPlanError(`episode has no scenes (${episode.id} / ${code})`);
  }
  for (const scene of episode.scenes) {
    validateScene(scene, code);
  }
  for (const key of ["fpsOverride", "widthOverride", "heightOverride"] as const) {
    const value = episode[key];
    if (value !== undefined && value !== null) {
      if (key === "fpsOverride") {
        requirePositiveNumber(value, `episode.${key} (${episode.id})`);
      } else {
        requireDimension(value, `episode.${key} (${episode.id})`);
      }
    }
  }
  return code;
}

export function validateSeries(series: SeriesPlan): void {
  requireNonEmptyString(series.id, "series.id");
  if (series.compositionIdPrefix !== undefined) {
    const prefix = series.compositionIdPrefix;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) {
      throw new RegistryPlanError(
        `series.compositionIdPrefix must be alphanumeric starting with a letter, got ${JSON.stringify(prefix)}`,
      );
    }
  }
  requirePositiveNumber(series.fps, "series.fps");
  requireDimension(series.width, "series.width");
  requireDimension(series.height, "series.height");
}

/** Mirrors CORE-004's `formatEpisodeCode`: `S01E03`. Kept local so the
 * registry package has no database dependency (spec §25 layering). */
export function formatEpisodeCode(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

/**
 * Validates the whole plan for cross-entity consistency: duplicate episode
 * codes, duplicate scene/shot ids, and unsorted scene/shot sequences. Returns
 * the episodes in a stable, human-ordered form (season → episode).
 */
export function validatePlan(plan: EpisodicPlan): EpisodePlan[] {
  validateSeries(plan.series);
  if (!Array.isArray(plan.episodes)) {
    throw new RegistryPlanError("plan.episodes must be an array");
  }
  if (plan.episodes.length === 0) {
    throw new RegistryPlanError("plan has no episodes");
  }

  const seenCodes = new Set<string>();
  const seenEpisodeIds = new Set<string>();
  const sorted = [...plan.episodes].sort((a, b) =>
    a.seasonNumber !== b.seasonNumber
      ? a.seasonNumber - b.seasonNumber
      : a.episodeNumber - b.episodeNumber,
  );
  for (const episode of sorted) {
    if (seenEpisodeIds.has(episode.id)) {
      throw new RegistryPlanError(`duplicate episode id "${episode.id}" in plan`);
    }
    seenEpisodeIds.add(episode.id);
    const code = validateEpisode(episode);
    if (seenCodes.has(code)) {
      throw new RegistryPlanError(`duplicate episode code "${code}" in plan`);
    }
    seenCodes.add(code);

    const seenSceneIds = new Set<string>();
    const seenSceneIndexes = new Set<number>();
    // shot ids are global primary keys (spec §12); uniqueness is enforced
    // across the whole episode, not per scene.
    const seenShotIds = new Set<string>();
    let previousSceneIndex = 0;
    for (const scene of episode.scenes) {
      if (seenSceneIds.has(scene.sceneId)) {
        throw new RegistryPlanError(`duplicate scene id "${scene.sceneId}" (${code})`);
      }
      seenSceneIds.add(scene.sceneId);
      if (seenSceneIndexes.has(scene.sequenceIndex)) {
        throw new RegistryPlanError(`duplicate scene sequenceIndex ${scene.sequenceIndex} (${code})`);
      }
      seenSceneIndexes.add(scene.sequenceIndex);
      if (scene.sequenceIndex < previousSceneIndex) {
        throw new RegistryPlanError(
          `scene sequenceIndex ${scene.sequenceIndex} out of order after ${previousSceneIndex} (${code})`,
        );
      }
      previousSceneIndex = scene.sequenceIndex;

      const seenShotIndexes = new Set<number>();
      let previousShotIndex = 0;
      for (const shot of scene.shots) {
        if (seenShotIds.has(shot.shotId)) {
          throw new RegistryPlanError(`duplicate shot id "${shot.shotId}" (${code} / ${scene.sceneId})`);
        }
        seenShotIds.add(shot.shotId);
        if (seenShotIndexes.has(shot.sequenceIndex)) {
          throw new RegistryPlanError(`duplicate shot sequenceIndex ${shot.sequenceIndex} (${shot.shotId})`);
        }
        seenShotIndexes.add(shot.sequenceIndex);
        if (shot.sequenceIndex < previousShotIndex) {
          throw new RegistryPlanError(
            `shot sequenceIndex ${shot.sequenceIndex} out of order after ${previousShotIndex} (${shot.shotId})`,
          );
        }
        previousShotIndex = shot.sequenceIndex;
      }
    }
  }
  return sorted;
}
