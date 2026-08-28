/**
 * Shot review execution through the decided route (spec §20, task QC-005).
 *
 * Ties the two branches together:
 *  - "video-direct"      → hand the clip itself to a video-capable reviewer;
 *  - "extracted-frames"  → FFmpeg extracts representative frames, the frames
 *    go to an image-vision reviewer;
 *  - "unavailable"       → no automated review; caller maps to human REVIEW.
 *
 * Reviewers are injected ports (the engine never imports a specific provider
 * adapter). The video reviewer receives the clip path; the image reviewer
 * receives the verified extracted-frame files. Both return the caller's own
 * `TRaw` payload verbatim — QC-001's schema owns result structure; this
 * module owns only routing and evidence plumbing.
 */

import {
  DEFAULT_FFPROBE_PATH,
  defaultProbeFacts,
  extractRepresentativeFrames,
  type DumpFrameFn,
  type ProbeFactsFn,
} from "./frames.js";
import { isAutomatedRoute, selectQcRoute } from "./decide.js";
import type {
  QcClipFacts,
  QcExtractedFrame,
  QcRouteDecision,
  QcVisionModelProfile,
} from "./types.js";

/** A reviewer that sees the video file itself. */
export interface VideoReviewPort<TRaw> {
  (input: { videoPath: string; modelId: string; facts: QcClipFacts }): Promise<TRaw>;
}

/** A reviewer that sees extracted frame files (image-vision QC). */
export interface FrameReviewPort<TRaw> {
  (input: {
    videoPath: string;
    modelId: string;
    facts: QcClipFacts;
    frames: QcExtractedFrame[];
  }): Promise<TRaw>;
}

/** Frame-extraction settings for the fallback branch. */
export interface ReviewFrameSettings {
  /** Directory the extracted PNGs are written to (created if missing). */
  outputDir: string;
  /** Representative frame count. Default 4. */
  count?: number;
  /** File-name stem. Default "qc-frame". */
  stem?: string;
  /** Overwrite existing PNGs. Default false (fails instead of clobbering). */
  overwrite?: boolean;
  /** ffprobe binary (used only when `facts` is not provided). Default "ffprobe". */
  ffprobePath?: string;
  /** ffmpeg binary. Default "ffmpeg". */
  ffmpegPath?: string;
}

/** Options for runShotReview(). */
export interface RunShotReviewOptions<TRaw> {
  /** Generated clip under review. */
  videoPath: string;
  /** Capability profile of the configured vision model. */
  profile: QcVisionModelProfile;
  /** Reviewer for the video-direct branch. */
  videoReviewer: VideoReviewPort<TRaw>;
  /** Reviewer for the extracted-frames branch. */
  frameReviewer: FrameReviewPort<TRaw>;
  /** Frame-extraction settings for the fallback branch. */
  frames?: ReviewFrameSettings;
  /** Skip probing: provide clip facts directly (used by both branches). */
  facts?: QcClipFacts;
  /** Force the extraction route even for video-capable models. */
  forceVideoExtraction?: boolean;
}

/** Injectable extraction ports (tests pass fakes; defaults use real FFmpeg). */
export interface RunShotReviewPorts {
  probeFacts?: ProbeFactsFn;
  dumpFrame?: DumpFrameFn;
}

/** Result of one routed shot review. */
export interface ShotReviewOutcome<TRaw> {
  /** The route the router picked. */
  decision: QcRouteDecision;
  /** Reviewer payload; null when the route was "unavailable". */
  review: TRaw | null;
  /** Extracted frames; empty on the video-direct and unavailable routes. */
  frames: QcExtractedFrame[];
  /** Clip facts (provided or probed); null when never needed. */
  facts: QcClipFacts | null;
}

/** Resolve clip facts from provided values or the probe port. */
async function resolveFacts(
  videoPath: string,
  provided: QcClipFacts | undefined,
  probeFacts: ProbeFactsFn | undefined,
): Promise<QcClipFacts> {
  if (provided) return provided;
  if (probeFacts) return probeFacts(videoPath, DEFAULT_FFPROBE_PATH);
  return defaultProbeFacts(videoPath, DEFAULT_FFPROBE_PATH);
}

/**
 * Run one shot's review through the capability-decided route.
 * Returns `review: null` with an "unavailable" decision when the profile
 * cannot review media — the caller maps that to the human REVIEW state.
 */
export async function runShotReview<TRaw>(
  options: RunShotReviewOptions<TRaw>,
  ports: RunShotReviewPorts = {},
): Promise<ShotReviewOutcome<TRaw>> {
  const decision = selectQcRoute(options.profile, {
    forceVideoExtraction: options.forceVideoExtraction,
  });
  if (!isAutomatedRoute(decision)) {
    return { decision, review: null, frames: [], facts: null };
  }

  if (decision.route === "video-direct") {
    const facts = await resolveFacts(options.videoPath, options.facts, ports.probeFacts);
    const review = await options.videoReviewer({
      videoPath: options.videoPath,
      modelId: decision.modelId,
      facts,
    });
    return { decision, review, frames: [], facts };
  }

  const extraction = await extractRepresentativeFrames(
    options.videoPath,
    {
      outputDir: options.frames?.outputDir ?? "./qc-frames",
      count: options.frames?.count,
      stem: options.frames?.stem,
      overwrite: options.frames?.overwrite,
      ffprobePath: options.frames?.ffprobePath,
      ffmpegPath: options.frames?.ffmpegPath,
      facts: options.facts,
    },
    ports,
  );
  const review = await options.frameReviewer({
    videoPath: options.videoPath,
    modelId: decision.modelId,
    facts: extraction.facts,
    frames: extraction.frames,
  });
  return { decision, review, frames: extraction.frames, facts: extraction.facts };
}
