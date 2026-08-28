/// <reference types="node" />

/**
 * Frame extraction for image-vision QC (spec §20 fallback path).
 *
 * When the selected vision model cannot ingest video directly, FFmpeg extracts
 * representative frames from the generated clip and the frames are QC'd as
 * images. Reuses the upstream `remotion/scripts/frames.mjs` discipline:
 *  - frames are addressed by integer frame number, 4-digit zero-padded
 *    (`<stem>-f<NNNN>.png`);
 *  - timestamps convert to frames via `local_f = global_s * fps - sequence_from`
 *    (sequence_from = 0 for a standalone generated clip);
 *  - every dumped PNG is READ (verified: exists, non-empty, PNG magic bytes)
 *    before the extraction result is reported.
 */

/** Configuration for choosing which frames to extract. Exactly one mode. */
export type FramePlanConfig =
  | { mode: "count"; count: number }
  | { mode: "interval"; intervalSeconds: number }
  | { mode: "timestamps"; timestamps: number[] };

/** One planned frame: the seek timestamp and its frames.mjs-style frame number. */
export type PlannedFrame = {
  /** 0-based position in the plan. */
  index: number;
  /** Exact seek timestamp in seconds (frame_number / fps). */
  timestampSeconds: number;
  /** Integer frame number: round(timestamp * fps), the upstream local_f conversion. */
  frameNumber: number;
  /** Output file name, `<stem>-f<NNNN>.png` (frames.mjs naming). */
  fileName: string;
};

/** Resolved, validated plan for an extraction run. */
export type FramePlan = {
  /** Video duration the plan was computed against, in seconds. */
  durationSeconds: number;
  /** Frames per second the frame numbers were computed with. */
  fps: number;
  /** Output scale (frames.mjs `--scale=`). 1 = native resolution. */
  scale: number;
  frames: PlannedFrame[];
};

/** Probed (or provided) media facts needed to plan extraction. */
export type ClipFacts = {
  durationSeconds: number;
  fps: number;
  width?: number;
  height?: number;
  codec?: string;
  /** Where the facts came from: ffprobe, or provided directly by the caller. */
  source: "probe" | "provided";
};

/** One successfully extracted frame. */
export type ExtractedFrame = PlannedFrame & {
  /** Absolute path of the written PNG. */
  filePath: string;
  /** File size in bytes (never 0 — every PNG is verified). */
  bytes: number;
};

/** Result of a full extraction run. */
export type FrameExtractionResult = {
  /** Absolute path of the source clip. */
  videoPath: string;
  /** Absolute output directory. */
  outputDir: string;
  /** Media facts used for planning. */
  facts: ClipFacts;
  /** The plan that was executed. */
  plan: FramePlan;
  frames: ExtractedFrame[];
};

/** Options for extractFrames(). */
export type ExtractFramesOptions = {
  /** Directory the PNGs are written to (created if missing). */
  outputDir: string;
  /** Which frames to pick. Default: 4 evenly-spaced representative frames. */
  plan?: FramePlanConfig;
  /** Output scale, frames.mjs `--scale=`. Default 1 (QC needs native detail). */
  scale?: number;
  /** Overwrite existing PNGs. Default false (fails instead of clobbering). */
  overwrite?: boolean;
  /** Skip ffprobe: provide facts directly (e.g. from the asset manifest). */
  facts?: ClipFacts;
  /** ffprobe binary. Default "ffprobe" (resolved from PATH). */
  ffprobePath?: string;
  /** ffmpeg binary. Default "ffmpeg" (resolved from PATH). */
  ffmpegPath?: string;
};