import type {
  EpisodeCompositionConfig,
  EpisodeCompositionRegistry,
  EpisodicPlan,
  EpisodePlan,
  SceneCompositionConfig,
  ShotCompositionConfig,
  SeriesPlan,
} from "./types.js";
import { formatEpisodeCode, RegistryPlanError, validatePlan } from "./validate.js";

/**
 * Episodic composition registry builder (spec §21 — episodic timeline).
 *
 * Takes the DB-derived `EpisodicPlan` and resolves one Remotion composition
 * per episode: `series/episode/scene/shot → composition`, with cumulative
 * frame offsets laid out so scene/shot components can be placed by
 * `sequenceFrom` + `durationInFrames` (VID-003's timeline mapping preserves
 * the upstream `local_f = global_s * fps − sequence_from` convention on top
 * of these offsets).
 */

/** Frame length of a shot, rounded like the upstream registry does
 * (`durationInFrames = round(seconds * fps)`, remotion/src/Root.tsx). */
export function shotDurationInFrames(targetDurationSeconds: number, fps: number): number {
  return Math.max(1, Math.round(targetDurationSeconds * fps));
}

function resolveDimensions(series: SeriesPlan, episode: EpisodePlan): {
  fps: number;
  width: number;
  height: number;
} {
  return {
    fps: episode.fpsOverride ?? series.fps,
    width: episode.widthOverride ?? series.width,
    height: episode.heightOverride ?? series.height,
  };
}

export function resolveEpisodeComposition(
  series: SeriesPlan,
  episode: EpisodePlan,
  compositionIdPrefix: string,
): EpisodeCompositionConfig {
  const code = formatEpisodeCode(episode.seasonNumber, episode.episodeNumber);
  const { fps, width, height } = resolveDimensions(series, episode);

  let cursor = 0;
  const scenes: SceneCompositionConfig[] = episode.scenes.map((scene) => {
    const sequenceFrom = cursor;
    let sceneFrames = 0;
    const shots: ShotCompositionConfig[] = scene.shots.map((shot) => {
      const durationInFrames = shotDurationInFrames(shot.targetDurationSeconds, fps);
      // Shots anchor absolutely inside the episode: each shot's sequenceFrom
      // is its own first frame, so `local_f = global_s * fps − sequenceFrom`
      // holds per shot without any scene-relative re-derivation (VID-003).
      const shotConfig: ShotCompositionConfig = {
        shotId: shot.shotId,
        sequenceIndex: shot.sequenceIndex,
        sequenceFrom: sequenceFrom + sceneFrames,
        durationInFrames,
        targetDurationSeconds: shot.targetDurationSeconds,
      };
      sceneFrames += durationInFrames;
      return shotConfig;
    });
    cursor += sceneFrames;
    return {
      sceneId: scene.sceneId,
      sequenceIndex: scene.sequenceIndex,
      sequenceFrom,
      durationInFrames: sceneFrames,
      shots,
    };
  });

  return {
    compositionId: `${compositionIdPrefix}${code}`,
    episodeCode: code,
    seriesId: series.id,
    episodeId: episode.id,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    fps,
    width,
    height,
    durationInFrames: cursor,
    scenes,
  };
}

/**
 * Builds the full series registry: one composition per episode, plus maps for
 * episode-code and composition-id lookup. Throws `RegistryPlanError` on any
 * plan inconsistency (see `validatePlan`).
 */
export function buildEpisodeCompositionRegistry(plan: EpisodicPlan): EpisodeCompositionRegistry {
  const episodes = validatePlan(plan);
  const series = plan.series;
  const prefix = series.compositionIdPrefix ?? "";

  const seenCompositionIds = new Set<string>();
  const compositions: EpisodeCompositionConfig[] = [];
  for (const episode of episodes) {
    const composition = resolveEpisodeComposition(series, episode, prefix);
    if (seenCompositionIds.has(composition.compositionId)) {
      throw new RegistryPlanError(`duplicate composition id "${composition.compositionId}"`);
    }
    seenCompositionIds.add(composition.compositionId);
    compositions.push(composition);
  }

  const byEpisodeCode = new Map<string, EpisodeCompositionConfig>();
  const byCompositionId = new Map<string, EpisodeCompositionConfig>();
  for (const composition of compositions) {
    byEpisodeCode.set(composition.episodeCode, composition);
    byEpisodeCode.set(composition.compositionId, composition);
    byCompositionId.set(composition.compositionId, composition);
  }

  return {
    series: {
      id: series.id,
      title: series.title,
      compositionIdPrefix: prefix,
      fps: series.fps,
      width: series.width,
      height: series.height,
    },
    compositions,
    byEpisodeCode,
    byCompositionId,
  };
}

/** Convenience lookup: episode code (`S01E03`) or full composition id (`ShowS01E03`). */
export function getCompositionForEpisode(
  registry: EpisodeCompositionRegistry,
  episodeCodeOrCompositionId: string,
): EpisodeCompositionConfig | undefined {
  return registry.byEpisodeCode.get(episodeCodeOrCompositionId) ?? registry.byCompositionId.get(episodeCodeOrCompositionId);
}