/**
 * Episodic composition contracts for the Remotion project (spec §21).
 *
 * Structural mirrors of `@mmcs/remotion-runtime/src/registry/types.ts` —
 * declared locally because the upstream `remotion/` project is a standalone
 * npm workspace (its own node_modules) that does not resolve the monorepo
 * `@mmcs/*` path aliases. The generator (scripts/gen-episodic-registry.mjs)
 * emits this exact shape; a structural drift between the two is caught by
 * the registry test suite in the package (`packages/remotion-runtime`),
 * which is the canonical contract.
 */

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