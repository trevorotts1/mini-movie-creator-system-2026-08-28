/**
 * Wan 3.0 request builder + pricing (verified 2026-08-28).
 *
 * buildCreateTaskBody: validated structured input → exact wire body
 * (snake_case input fields per docs.kie.ai/market/wan/3-0-video.md).
 * estimateWanCost: verified per-resolution credit/USD-per-second pricing;
 * with reference videos the provider bills input video duration too.
 */
import { getWanProfile, WAN_3_0_MODEL, type WanModelId } from "./capability.js";
import type { WanCreateTaskBody, WanVideoInput } from "./types.js";

/**
 * Build the createTask body. Does NOT validate — call validateWanInput first
 * (kept separate so tests and the budget manager can compose steps). Omits
 * undefined optionals; fills verified defaults for resolution/aspect/duration/audio.
 */
export function buildCreateTaskBody(
  input: WanVideoInput,
  model: WanModelId = WAN_3_0_MODEL,
  callBackUrl?: string,
): WanCreateTaskBody {
  const profile = getWanProfile(model);
  const wireInput: WanCreateTaskBody["input"] = {
    resolution: input.resolution ?? profile.output.defaultResolution,
    aspect_ratio: input.aspectRatio ?? profile.output.defaultAspectRatio,
    duration: input.duration ?? profile.output.defaultDurationSeconds,
    audio: input.audio ?? true,
  };
  if (input.prompt !== undefined && input.prompt !== "") wireInput.prompt = input.prompt;
  if (input.firstFrameUrl) wireInput.first_frame_url = input.firstFrameUrl;
  if (input.lastFrameUrl) wireInput.last_frame_url = input.lastFrameUrl;
  if (hasAny(input.referenceImageUrls)) wireInput.reference_image_urls = input.referenceImageUrls;
  if (hasAny(input.referenceVideoUrls)) wireInput.reference_video_urls = input.referenceVideoUrls;
  if (hasAny(input.referenceAudioUrls)) wireInput.reference_audio_urls = input.referenceAudioUrls;
  if (hasAny(input.referenceFileUrls)) wireInput.reference_file_urls = input.referenceFileUrls;
  if (hasAny(input.referenceLinkUrls)) wireInput.reference_link_urls = input.referenceLinkUrls;
  if (input.seed !== undefined) wireInput.seed = input.seed;

  return {
    model,
    ...(callBackUrl !== undefined ? { callBackUrl } : {}),
    input: wireInput,
  };
}

function hasAny(list: string[] | undefined): boolean {
  return Array.isArray(list) && list.length > 0;
}

/** Verified cost estimate. Null when duration is model-chosen (-1). */
export interface WanCostEstimate {
  /** Billed seconds (output [+ reference-video input seconds]). */
  billedSeconds: number;
  resolution: "480P" | "720P" | "1080P";
  credits: number;
  usd: number;
  model: WanModelId;
}

/**
 * Estimate spend for a request. Uses the verified per-second rates; with
 * reference videos, billed seconds = input video seconds + output seconds
 * (provider billing rule). Null when duration is -1 (model decides).
 */
export function estimateWanCost(
  input: WanVideoInput,
  model: WanModelId = WAN_3_0_MODEL,
  referenceVideoSeconds = 0,
): WanCostEstimate | null {
  const profile = getWanProfile(model);
  const duration = input.duration ?? profile.output.defaultDurationSeconds;
  if (duration === -1) return null;
  const resolution = input.resolution ?? profile.output.defaultResolution;
  const billedSeconds = duration + referenceVideoSeconds;
  const creditsPerSecond = profile.pricing.creditsPerSecondByResolution[resolution];
  const usdPerSecond = profile.pricing.usdPerSecondByResolution[resolution];
  return {
    billedSeconds,
    resolution,
    credits: round4(creditsPerSecond * billedSeconds),
    usd: round4(profile.pricing.usdPerSecondByResolution[resolution] * billedSeconds),
    model,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}