/**
 * Route types for video QC review (spec §14/§20, task QC-005).
 *
 * "Video-capable multimodal models review video directly when possible;
 * otherwise FFmpeg extracts representative frames for image-vision QC."
 * Route selection comes from the model's capability profile — never from
 * guesswork: a profile that declares `videoInput` goes straight to the video,
 * a profile with only `vision` sees FFmpeg-extracted frames, and a profile
 * with neither cannot review media at all (caller maps that to the human
 * REVIEW state per spec §20 "automated routes exhausted").
 *
 * `QcVisionModelProfile` is deliberately structural: any capability-registry
 * reasoning seed (CAP-002's `ReasoningModelCapabilitySeed` — `modelId`,
 * `vision`, `videoInput`) satisfies it and can be passed directly. Route
 * names for the two working branches match QC-001's `QC_ROUTES`
 * ("video-direct" | "extracted-frames"); "unavailable" is the router-level
 * outcome for a profile with no vision at all.
 */

/**
 * The slice of a capability profile the route decision reads. Unknown extra
 * fields are ignored; `vision`/`videoInput` are optional so a loosely-typed
 * profile still routes (missing = false, "undocumented ≠ yes").
 */
export interface QcVisionModelProfile {
  /** Provider slug, e.g. "openrouter". Carried on the decision for reports. */
  provider?: string;
  /** Exact model id the review will run against. Required. */
  modelId: string;
  /** Model accepts image input (image-vision QC route). */
  vision?: boolean;
  /** Model accepts video input directly (direct video review route). */
  videoInput?: boolean;
}

/** Every outcome the router can produce. */
export const QC_REVIEW_ROUTES = [
  "video-direct",
  "extracted-frames",
  "unavailable",
] as const;

export type QcReviewRoute = (typeof QC_REVIEW_ROUTES)[number];

/** Why the router picked (or refused) a route — surfaced on QC results. */
export interface QcRouteDecision {
  route: QcReviewRoute;
  modelId: string;
  /** Provider from the profile, null when the profile did not carry one. */
  provider: string | null;
  reason: string;
}

/** One representative frame extracted for the image-vision QC route. */
export interface QcPlannedFrame {
  /** 0-based position in the extraction plan (after dedupe). */
  index: number;
  /** Seek timestamp in seconds. */
  timestampSeconds: number;
  /** Integer frame number: round(timestamp * fps). */
  frameNumber: number;
  /** Output file name, `<stem>-f<NNNN>.png` (upstream frames.mjs naming). */
  fileName: string;
}

/** One extracted frame, verified on disk. */
export interface QcExtractedFrame extends QcPlannedFrame {
  /** Absolute path of the written PNG. */
  filePath: string;
  /** File size in bytes (never 0 — every PNG is verified before use). */
  bytes: number;
}

/** Media facts needed to plan representative frames. */
export interface QcClipFacts {
  durationSeconds: number;
  fps: number;
}
