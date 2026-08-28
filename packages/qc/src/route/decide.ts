/**
 * Route decision from capability profile (spec §14/§20, task QC-005).
 *
 * Selection rules, in priority order:
 *  1. `videoInput: true`   → direct video review ("video-direct").
 *  2. `vision: true`       → FFmpeg frame extraction ("extracted-frames").
 *  3. Neither              → "unavailable" — the model cannot review media;
 *    the caller maps this to the human REVIEW state per spec §20.
 *
 * Undocumented capability reads as `false` (registry policy: "null =
 * undocumented — validators must not enforce a limit"; same discipline here —
 * a missing `vision`/`videoInput` never grants a route). An explicit
 * `forceVideoExtraction` option overrides rule 1 for operators who want
 * frames even when direct video is possible (e.g. cost caps); it can never
 * create a route the profile does not support.
 */

import type { QcRouteDecision, QcVisionModelProfile } from "./types.js";

/** Options that can steer (but never widen) the route decision. */
export interface SelectRouteOptions {
  /**
   * Force the extraction route even when the model could review the video
   * directly. Ignored for profiles without `vision` — it cannot invent
   * capability.
   */
  forceVideoExtraction?: boolean;
}

/**
 * Decide the review route for one shot against one capability profile.
 * Pure function — no I/O, throws only on a missing modelId.
 */
export function selectQcRoute(
  profile: QcVisionModelProfile,
  options: SelectRouteOptions = {},
): QcRouteDecision {
  const { modelId, provider = null, vision = false, videoInput = false } = profile;
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("selectQcRoute: capability profile has no modelId");
  }

  if (videoInput === true && options.forceVideoExtraction !== true) {
    return {
      route: "video-direct",
      modelId,
      provider,
      reason: `capability profile declares videoInput for ${modelId}`,
    };
  }
  if (vision === true) {
    return {
      route: "extracted-frames",
      modelId,
      provider,
      reason:
        options.forceVideoExtraction === true && videoInput === true
          ? `extraction forced for ${modelId} despite videoInput capability`
          : `capability profile declares vision (no direct video input) for ${modelId}`,
    };
  }
  return {
    route: "unavailable",
    modelId,
    provider,
    reason: `capability profile for ${modelId} declares no vision (and no direct video input) — automated review impossible`,
  };
}

/**
 * True when the decision can run an automated review at all. Caller maps
 * false → human REVIEW state (spec §20 "automated routes exhausted").
 */
export function isAutomatedRoute(decision: QcRouteDecision): boolean {
  return decision.route === "video-direct" || decision.route === "extracted-frames";
}
