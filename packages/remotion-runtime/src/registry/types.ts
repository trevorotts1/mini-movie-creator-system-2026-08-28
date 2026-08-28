/**
 * Episodic composition registry contracts (spec §21 — episodic timeline).
 *
 * The plan shape mirrors the durable DB rows produced by the schema tasks
 * (CORE-004 `episodes`, CORE-006 `scenes` + `shots`): a planner materializes
 * the episode plan from SQLite and the registry resolves it into Remotion
 * composition configs. The registry itself stays driver-neutral — it consumes
 * plain plan objects, never a database handle.
 */

/** Series-level render defaults (spec §24: 16:9 default, per-episode override). */
export interface SeriesPlan {
  readonly id: string;
  readonly title?: string;
  /** Optional composition-id prefix so several series can share one bundle. */
  readonly compositionIdPrefix?: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

/** One planned shot (CORE-006 `shots` row subset the registry needs). */
export interface ShotPlan {
  readonly shotId: string;
  /** Human-facing shot number (spec §19 pattern `…_SH07_…`), 1-based. */
  readonly sequenceIndex: number;
  /** Planned duration in seconds (DB `target_duration`). */
  readonly targetDurationSeconds: number;
}

/** One planned scene (CORE-006 `scenes` row subset). */
export interface ScenePlan {
  readonly sceneId: string;
  /** Human-facing scene number (spec §19 pattern `S01E03_SC04_…`), 1-based. */
  readonly sequenceIndex: number;
  readonly shots: readonly ShotPlan[];
}

/** One planned episode (CORE-004 `episodes` row subset + its scenes). */
export interface EpisodePlan {
  readonly id: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  /** Optional per-episode overrides; null/undefined inherits series values. */
  readonly fpsOverride?: number | null;
  readonly widthOverride?: number | null;
  readonly heightOverride?: number | null;
  readonly scenes: readonly ScenePlan[];
}

/** The full DB-derived plan for one series — the registry's only input. */
export interface EpisodicPlan {
  readonly series: SeriesPlan;
  readonly episodes: readonly EpisodePlan[];
}

/** Frame offset of a scene/shot inside the episode composition. `sequenceFrom`
 * is the absolute first frame of the entity inside the episode composition —
 * named to match the upstream frame-QA conversion (`local_f = global_s * fps −
 * sequence_from`, remotion/scripts/frames.mjs) that VID-003 preserves. */
export interface ShotCompositionConfig {
  readonly shotId: string;
  readonly sequenceIndex: number;
  /** Absolute first frame of this shot inside the episode composition. */
  readonly sequenceFrom: number;
  readonly durationInFrames: number;
  readonly targetDurationSeconds: number;
}

export interface SceneCompositionConfig {
  readonly sceneId: string;
  readonly sequenceIndex: number;
  readonly sequenceFrom: number;
  readonly durationInFrames: number;
  readonly shots: readonly ShotCompositionConfig[];
}

/** One Remotion `<Composition>` per episode (spec §21: episode is the render unit). */
export interface EpisodeCompositionConfig {
  /** Unique Remotion composition id: `[prefix]SxxEyy`. */
  readonly compositionId: string;
  readonly episodeCode: string;
  readonly seriesId: string;
  readonly episodeId: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationInFrames: number;
  readonly scenes: readonly SceneCompositionConfig[];
}

/** Series metadata + every resolved episode composition. */
export interface EpisodeCompositionRegistry {
  readonly series: {
    readonly id: string;
    readonly title?: string;
    readonly compositionIdPrefix: string;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
  };
  readonly compositions: readonly EpisodeCompositionConfig[];
  /** `SxxEyy` / `[prefix]SxxEyy` → composition, for O(1) lookups. */
  readonly byEpisodeCode: ReadonlyMap<string, EpisodeCompositionConfig>;
  readonly byCompositionId: ReadonlyMap<string, EpisodeCompositionConfig>;
}