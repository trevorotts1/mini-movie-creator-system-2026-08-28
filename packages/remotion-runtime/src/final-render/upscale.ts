// Upscale / quality-tier rules (VID-014) — spec §21:
//   "A 720p generated source upscaled to 1080p is never represented as
//    native 1080p quality."
//
// The render timeline may be 1080p (or any master resolution) while some
// shots' provider sources are lower (e.g. 720p Agnes/Kie output). The OUTPUT
// metadata must tell the truth: upscaled shots carry an `upscaled` flag and
// a tier that names the upscaling — `native-1080p` is reserved for output
// whose sources were genuinely native 1080p+ (or a scale=1 native render).

import type {
  PlannedShot,
  QualityTier,
  RenderMode,
  Resolution,
  ShotQualityRecord,
} from "./contract.js";

/** Reference master resolution: 1080p landscape (spec §23 default 16:9). */
export const RESOLUTION_1080P: Resolution = { width: 1920, height: 1080 };
export const RESOLUTION_720P: Resolution = { width: 1280, height: 720 };

/** True when a >= b on BOTH dimensions (allow 1px codec rounding slack). */
function atLeast(a: Resolution, b: Resolution): boolean {
  return a.width >= b.width - 1 && a.height >= b.height - 1;
}

/** True when the source is at least 1080p in both dimensions. */
export function isNative1080(source: Resolution): boolean {
  return atLeast(source, RESOLUTION_1080P);
}

/** True when the source is at least 720p but below 1080p. */
export function is720Class(source: Resolution): boolean {
  return atLeast(source, RESOLUTION_720P) && !isNative1080(source);
}

/** True when below 720p. */
export function isBelow720(source: Resolution): boolean {
  return !atLeast(source, RESOLUTION_720P);
}

/**
 * The tier for ONE rendered shot. `renderedAt` is the timeline (or native
 * scale=1) resolution the shot was rendered at; `source` is the provider
 * output resolution.
 *
 * Invariants the tests enforce:
 * - upscaled (rendered > source) with a 720-class source → `upscaled-720p`,
 *   NEVER `native-1080p` even when renderedAt is exactly 1920x1080;
 * - upscaled below 720 → `upscaled-lower`;
 * - upscaled from a source ≥1080p (bigger master than native) →
 *   `upscaled-higher` — honest: the source was native-grade but the output
 *   was enlarged beyond it, so neither `native-1080p` nor `upscaled-720p`
 *   is truthful;
 * - not upscaled and source is 1080p+ → `native-1080p`;
 * - not upscaled and source is 720-class → `native-720p`.
 */
export function tierFor(
  source: Resolution,
  renderedAt: Resolution,
): QualityTier {
  const upscaled = renderedAt.width > source.width || renderedAt.height > source.height;
  if (upscaled) {
    if (isBelow720(source)) return "upscaled-lower";
    if (is720Class(source)) return "upscaled-720p";
    // Upscaled from a source ≥1080p (e.g. rendered larger than native for a
    // bigger master). Still not native at the output resolution.
    return "upscaled-higher";
  }
  if (isNative1080(source)) return "native-1080p";
  if (is720Class(source)) return "native-720p";
  return "native-custom";
}

/**
 * Master resolution for the episode format (spec §23). 16:9 → 1920x1080,
 * 9:16 → 1080x1920, custom → the declared custom resolution.
 */
export function masterResolutionFor(
  format: "16:9" | "9:16" | "custom",
  custom?: Resolution,
): Resolution {
  if (format === "16:9") return RESOLUTION_1080P;
  if (format === "9:16") return { width: 1080, height: 1920 };
  if (!custom) {
    throw new Error(
      "custom format requires a custom resolution (spec §23 supported custom aspect ratio)",
    );
  }
  return custom;
}

/** Effective render resolution for a mode (timeline master vs scale=1 native). */
export function renderResolutionFor(
  mode: RenderMode,
  format: "16:9" | "9:16" | "custom",
  custom?: Resolution,
): Resolution {
  if (mode === "native") {
    // scale=1: the composition's own resolution passes through untouched.
    // Callers pass the composition's declared resolution as `custom` when the
    // composition is non-master; without one the master resolution is used.
    return custom ?? masterResolutionFor(format);
  }
  return masterResolutionFor(format, custom);
}

/**
 * Compute per-shot quality records for the whole composition — the metadata
 * written beside the final render and consumed by the production report and
 * VID-015's probe.
 *
 * Native mode (scale=1): every shot renders at its OWN source resolution —
 * nothing is upscaled, tiers are the honest native ones.
 */
export function computeShotQuality(
  shots: readonly PlannedShot[],
  renderedAt: Resolution,
  mode: RenderMode = "timeline",
): ShotQualityRecord[] {
  return shots.map((shot) => {
    const target = mode === "native" ? shot.source : renderedAt;
    return {
      shotId: shot.shotId,
      source: shot.source,
      renderedAt: target,
      upscaled: target.width > shot.source.width || target.height > shot.source.height,
      qualityTier: tierFor(shot.source, target),
    };
  });
}

/**
 * Episode-level quality tier. Honest rule:
 * - all shots native (not upscaled) and all ≥1080p → `native-1080p`;
 * - all native, all 720-class → `native-720p`;
 * - any upscale present → the source mix decides:
 *     - any upscaled shot below 720 → `upscaled-lower`;
 *     - any upscaled shot from a ≥1080p source → `upscaled-higher`;
 *     - every upscaled shot is 720-class → `upscaled-720p`;
 *     - sources genuinely mixed (some native-1080, some 720) → `mixed-source`.
 */
export function episodeTier(
  records: readonly ShotQualityRecord[],
): QualityTier {
  if (records.length === 0) return "native-custom";
  const upscaled = records.filter((r) => r.upscaled);
  if (upscaled.length === 0) {
    const all1080 = records.every((r) => isNative1080(r.source));
    const all720 = records.every((r) => is720Class(r.source));
    if (all1080) return "native-1080p";
    if (all720) return "native-720p";
    return "mixed-source";
  }
  const has1080Native = records.some((r) => !r.upscaled && isNative1080(r.source));
  const below720Upscale = upscaled.some((r) => isBelow720(r.source));
  const higherUpscale = upscaled.some((r) => isNative1080(r.source));
  if (has1080Native) return "mixed-source";
  if (below720Upscale) return "upscaled-lower";
  if (higherUpscale) return "upscaled-higher";
  return "upscaled-720p";
}