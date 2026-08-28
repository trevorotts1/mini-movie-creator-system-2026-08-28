import {
  AspectPlan,
  CompositionSpec,
  ResolvedAspect,
} from "./types.js";
import { resolveAspectPlan } from "./plan.js";

export interface CompositionPlanOptions {
  /** Local fps for the generated compositions; upstream default is 30. */
  fps?: number;
  /** Duration in seconds (same for both ratios by default). */
  durationInSeconds?: number;
  /** Per-episode duration overrides, only when an episode differs. */
  durationsByEpisode?: Record<string, number>;
}

/**
 * Generate Remotion composition descriptors for every episode from ONE plan
 * (acceptance §32: 16:9 and 9:16 compositions both generate from the same plan).
 * The rendered canvas differs per episode ratio; every spec carries the same
 * fps/duration math so the same registry can register both.
 */
export function compositionsFromPlan(
  plan: AspectPlan,
  episodeIds: string[],
  options: CompositionPlanOptions = {},
): CompositionSpec[] {
  const fps = options.fps ?? 30;
  const durationInSeconds = options.durationInSeconds ?? 60;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`invalid fps ${fps}`);
  }
  if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
    throw new Error(`invalid durationInSeconds ${durationInSeconds}`);
  }
  const resolved: ResolvedAspect[] = resolveAspectPlan(plan, episodeIds);
  return resolved.map((r) => {
    const perEpisode = options.durationsByEpisode?.[r.episodeId] ?? durationInSeconds;
    if (!Number.isFinite(perEpisode) || perEpisode <= 0) {
      throw new Error(`invalid duration for episode "${r.episodeId}": ${perEpisode}`);
    }
    return {
      id: `episode-${r.episodeId}-${r.aspectRatio.id.replace(":", "x")}`,
      aspectRatioId: r.aspectRatio.id,
      width: r.canvas.width,
      height: r.canvas.height,
      fps,
      durationInFrames: Math.max(1, Math.round(perEpisode * fps)),
      safeArea: r.safeArea,
      captionZone: r.captionZone,
    };
  });
}
