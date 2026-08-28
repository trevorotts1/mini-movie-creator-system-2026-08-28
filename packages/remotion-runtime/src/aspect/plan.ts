import {
  AspectPlan,
  AspectRatio,
  AspectSource,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_RESOLUTION_TIER,
  EpisodeAspectConfig,
  RESOLUTION_TIERS,
  ResolutionTier,
  ResolvedAspect,
  SeriesAspectConfig,
} from "./types.js";
import { parseAspectRatio } from "./parse.js";
import { canvasFor, captionZoneFor, safeAreaFor } from "./geometry.js";

/**
 * Resolve one series + its episode overrides into effective, render-ready
 * resolution configs (spec §23: aspect ratio stored at series level with
 * per-episode override; never re-asked every episode).
 *
 * Precedence: builtin 16:9/1080p < series default < episode override.
 * Unknown episode ids are rejected (plan must name every episode it configures).
 */
export function resolveAspectPlan(plan: AspectPlan, episodeIds: string[]): ResolvedAspect[] {
  const series = normalizeSeries(plan.series);
  const overrides = normalizeOverrides(plan.episodes, series);
  const known = new Set(episodeIds);
  if (known.size !== episodeIds.length) {
    throw new Error("duplicate episode ids in episodeIds");
  }
  for (const id of overrides.keys()) {
    if (!known.has(id)) {
      throw new Error(`episode override for unknown episode "${id}"`);
    }
  }
  return episodeIds.map((episodeId) => {
    const eff = overrides.get(episodeId) ?? series;
    const ratio = parseAspectRatio(eff.aspectRatioId);
    const canvas = canvasFor(ratio, eff.resolutionTier);
    const source: AspectSource = overrides.has(episodeId)
      ? "episode-override"
      : plan.series?.aspectRatio !== undefined || plan.series?.resolutionTier !== undefined
        ? "series-default"
        : "builtin-default";
    return {
      episodeId,
      aspectRatio: ratio,
      canvas,
      safeArea: safeAreaFor(canvas),
      captionZone: captionZoneFor(canvas),
      source,
    };
  });
}

/** Series default + per-episode override helpers used by CLI/db layers. */
export function seriesDefaultConfig(
  series?: SeriesAspectConfig,
): { aspectRatioId: string; resolutionTier: ResolutionTier } {
  const s = normalizeSeries(series);
  return { aspectRatioId: s.aspectRatioId, resolutionTier: s.resolutionTier };
}

function normalizeSeries(
  series?: SeriesAspectConfig,
): { aspectRatioId: string; resolutionTier: ResolutionTier } {
  const aspectRatioId = series?.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const resolutionTier = series?.resolutionTier ?? DEFAULT_RESOLUTION_TIER;
  // Validate eagerly so bad series config fails before any episode is rendered —
  // even when the episode list is empty.
  validateConfig(aspectRatioId, resolutionTier);
  return { aspectRatioId, resolutionTier };
}

function validateConfig(aspectRatioId: string, resolutionTier: ResolutionTier): void {
  parseAspectRatio(aspectRatioId);
  if (!(resolutionTier in RESOLUTION_TIERS)) {
    throw new Error(`unknown resolution tier "${resolutionTier}"`);
  }
}

function normalizeOverrides(
  episodes: EpisodeAspectConfig[] | undefined,
  series: { aspectRatioId: string; resolutionTier: ResolutionTier },
): Map<string, { aspectRatioId: string; resolutionTier: ResolutionTier }> {
  const map = new Map<
    string,
    { aspectRatioId: string; resolutionTier: ResolutionTier }
  >();
  for (const ep of episodes ?? []) {
    if (!ep.episodeId) {
      throw new Error("episode override missing episodeId");
    }
    if (map.has(ep.episodeId)) {
      throw new Error(`duplicate episode override for "${ep.episodeId}"`);
    }
    // Missing override fields fall back to the series default (types.ts contract),
    // NOT the builtin defaults — an override that only bumps the tier must keep
    // the series ratio (e.g. series 9:16 + tier-only override stays 9:16).
    const aspectRatioId = ep.aspectRatio ?? series.aspectRatioId;
    const resolutionTier = ep.resolutionTier ?? series.resolutionTier;
    validateConfig(aspectRatioId, resolutionTier);
    map.set(ep.episodeId, { aspectRatioId, resolutionTier });
  }
  return map;
}
