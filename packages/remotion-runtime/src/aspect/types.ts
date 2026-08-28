/**
 * Aspect-ratio domain types for MMCS episode rendering (spec §23 OUTPUT FORMATS).
 *
 * Master format is asked ONCE at series/project creation, default 16:9 landscape.
 * Stored at series level with per-episode override; never re-asked every episode.
 */

/** Presets the CLI offers at series creation (spec §23: 16:9, 9:16, supported custom). */
export const SUPPORTED_ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "21:9",
  "4:3",
  "3:4",
  "1:1",
  "3:2",
  "2:3",
] as const;

export type SupportedAspectRatio = (typeof SUPPORTED_ASPECT_RATIOS)[number];

/**
 * Any "W:H" string is accepted as a custom ratio (spec §23: supported custom aspect
 * ratio). Preset ids are kept verbatim; custom ids normalize to canonical "W:H".
 */
export type AspectRatioId = SupportedAspectRatio | string;

/** Spec §23: default 16:9 landscape (recommended; YouTube/TV-style). */
export const DEFAULT_ASPECT_RATIO: AspectRatioId = "16:9";

/** Tier = short edge (1080p → 1920x1080 landscape, 1080x1920 vertical). */
export const RESOLUTION_TIERS = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "540p": 540,
  "480p": 480,
  "360p": 360,
} as const;

export type ResolutionTier = keyof typeof RESOLUTION_TIERS;

export const DEFAULT_RESOLUTION_TIER: ResolutionTier = "1080p";

/** Parsed ratio. `id` is the canonical "W:H" string. */
export interface AspectRatio {
  /** e.g. "16:9" */
  id: string;
  /** 16 */
  widthUnits: number;
  /** 9 */
  heightUnits: number;
  /** 16/9 */
  ratio: number;
}

/** Final pixel canvas for a composition. */
export interface Canvas {
  width: number;
  height: number;
  aspectRatioId: string;
}

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Content-safe rect (e.g. 90% of frame, centered) plus pixel insets. */
export interface SafeAreaRect {
  /** Left column of the safe rect, origin top-left of the frame. */
  x: number;
  /** Top row of the safe rect. */
  y: number;
  width: number;
  height: number;
  insets: SafeAreaInsets;
}

/** Series-level master-format config (asked once at creation; spec §23). */
export interface SeriesAspectConfig {
  /** Defaults to 16:9 when omitted. */
  aspectRatio?: AspectRatioId;
  /** Defaults to 1080p when omitted. */
  resolutionTier?: ResolutionTier;
}

/** Per-episode override. Missing fields fall back to the series default. */
export interface EpisodeAspectConfig {
  episodeId: string;
  aspectRatio?: AspectRatioId;
  resolutionTier?: ResolutionTier;
}

/**
 * The full plan: a series default plus optional per-episode overrides.
 * Never re-asked every episode unless the user wants a change (spec §23).
 */
export interface AspectPlan {
  series?: SeriesAspectConfig;
  episodes?: EpisodeAspectConfig[];
}

export type AspectSource =
  | "builtin-default"
  | "series-default"
  | "episode-override";

/** Effective resolution of one episode after default/override resolution. */
export interface ResolvedAspect {
  episodeId: string;
  aspectRatio: AspectRatio;
  canvas: Canvas;
  safeArea: SafeAreaRect;
  /** Bottom-aligned caption zone (dialogue/captions layer). */
  captionZone: SafeAreaRect;
  /** Where the effective ratio came from. */
  source: AspectSource;
}

/** Remotion-friendly composition descriptor generated from a plan. */
export interface CompositionSpec {
  id: string;
  aspectRatioId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  safeArea: SafeAreaRect;
  captionZone: SafeAreaRect;
}

export class AspectPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AspectPlanError";
  }
}
