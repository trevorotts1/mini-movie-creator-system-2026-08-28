/**
 * Wan 3.0 typed input + request types (live schema, verified 2026-08-28
 * against https://docs.kie.ai/market/wan/3-0-video.md — field names exact).
 */
import type { WanModelId } from "./capability.js";

/** Output resolution enum (verified). */
export type WanResolution = "480P" | "720P" | "1080P";

/** Output aspect-ratio enum (verified). */
export type WanAspectRatio = "adaptive" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

/** Which generation mode a request uses — mutually exclusive groups. */
export type WanMode =
  | "text_to_video"
  | "first_frame"
  | "first_last_frame"
  | "multimodal_reference"
  | "file_to_video"
  | "link_to_video";

/**
 * Structured, provider-shaped input for Wan 3.0. Validation (validate.ts)
 * turns this into the exact wire payload; callers never hand-write JSON.
 */
export interface WanVideoInput {
  /** Text prompt. Required for text-to-video; recommended with media. ≤20,000 chars. */
  prompt: string;
  /** First-frame image URL. Up to 1. Exclusive with all reference_*_urls. */
  firstFrameUrl?: string;
  /** Last-frame image URL. Up to 1. Exclusive with reference_*_urls. */
  lastFrameUrl?: string;
  /** Reference images (all-purpose reference mode). ≤10. Map to Image1..ImageN. */
  referenceImageUrls?: string[];
  /** Reference videos. ≤5; each 1–15s; total ≤15s; input+output duration ≤30s. */
  referenceVideoUrls?: string[];
  /** Reference audio. ≤5; each 1–15s; total ≤15s. */
  referenceAudioUrls?: string[];
  /** File-to-video source. ≤1. Exclusive with referenceLinkUrls and frames. */
  referenceFileUrls?: string[];
  /** Link-to-video source. ≤1 public page. Exclusive with referenceFileUrls and frames. */
  referenceLinkUrls?: string[];
  /** Output resolution. Default 1080P. */
  resolution?: WanResolution;
  /** Output aspect ratio. Default "adaptive". */
  aspectRatio?: WanAspectRatio;
  /**
   * Output duration seconds. Default 5. Range [2,30] without video input;
   * with reference videos: input duration + duration ≤ 30. `-1` = model decides.
   */
  duration?: number;
  /** Include an audio track. Default true. */
  audio?: boolean;
  /** Reproducibility seed [0, 2147483647]. */
  seed?: number;
}

/** The exact createTask wire body for Wan 3.0 (snake_case input fields). */
export interface WanCreateTaskBody {
  model: WanModelId;
  callBackUrl?: string;
  input: {
    prompt?: string;
    first_frame_url?: string;
    last_frame_url?: string;
    reference_image_urls?: string[];
    reference_video_urls?: string[];
    reference_audio_urls?: string[];
    reference_file_urls?: string[];
    reference_link_urls?: string[];
    resolution: WanResolution;
    aspect_ratio: WanAspectRatio;
    duration: number;
    audio: boolean;
    seed?: number;
  };
}

/** Options for the Wan adapter's submit call. */
export interface WanSubmitOptions {
  /** Optional completion callback URL (Kie POSTs the final envelope here). */
  callBackUrl?: string;
}