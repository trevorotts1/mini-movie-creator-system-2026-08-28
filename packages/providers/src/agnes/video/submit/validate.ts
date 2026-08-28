/**
 * AGN-004 — pre-request validation chain (spec §5 order, binding):
 *
 *   1. resolve capability profile      (from CAP-002 seeded registry)
 *   2. count prompt characters exactly (recorded; hard max only when the
 *      registry states one — Agnes stays UNKNOWN/null, never enforced,
 *      never invented)
 *   3. validate reference counts       (against the profile; null max = no
 *      documented limit → not enforced, recorded as UNKNOWN)
 *   4. validate mutually exclusive modes (CAP-005 validator + Agnes mode rules)
 *   5. validate duration/resolution    (against the profile)
 *   6. estimate spend                  (per-second pricing; budget gate runs
 *      in the submitter, spec §4)
 *
 * The chain is pure: no I/O, no fetch. `submitAgnesVideo` runs it before
 * anything durable happens; any issue aborts the job before the first store
 * write, so an invalid request can never become a provider charge.
 */

import {
  assertExclusiveModes,
  type ExclusiveModeValidationError,
} from "@mmcs/capability-registry/validators/index.js";
import type { MediaModelCapabilitySeed } from "@mmcs/capability-registry/data/index.js";
import { AGNES_VIDEO_2_5, AGNES_VIDEO_2_5_FLASH } from "@mmcs/capability-registry/data/agnes.js";

import type { AgnesVideoSubmitInput } from "./request.js";
import { classifyMode } from "./request.js";

/** One pre-request validation defect. */
export interface AgnesVideoValidationIssue {
  /** Dotted path to the offending field (e.g. "prompt", "mode"). */
  field: string;
  /** Machine-readable rule id (stable for tests/routing). */
  code: AgnesVideoValidationIssueCode;
  /** Human-readable explanation; safe to log. */
  message: string;
}

/** Stable issue codes (stable for downstream tests/routing). */
export type AgnesVideoValidationIssueCode =
  | "PROMPT_REQUIRED"
  | "PROMPT_EXCEEDS_HARD_MAX"
  | "MODE_EXCLUSIVITY"
  | "LAST_FRAME_REQUIRES_FIRST"
  | "MODE_UNVERIFIED_FOR_MODEL"
  | "MODE_NOT_SUPPORTED"
  | "FRAME_NOT_SUPPORTED"
  | "REFERENCE_IMAGES_EXCEED_MAX"
  | "REFERENCE_VIDEOS_NOT_SUPPORTED"
  | "REFERENCE_VIDEOS_EXCEED_MAX"
  | "REFERENCE_AUDIOS_EXCEED_MAX"
  | "SECONDS_INVALID"
  | "SECONDS_OUT_OF_RANGE"
  | "SIZE_NOT_SUPPORTED"
  | "ASPECT_RATIO_NOT_SUPPORTED"
  | "N_NOT_SUPPORTED"
  | "BUDGET_RESERVATION_DECLINED";

/** Which chain stage produced an issue — mirrors the spec §5 chain order. */
export type AgnesVideoValidationStage =
  | "characters"
  | "references"
  | "modes"
  | "duration"
  | "resolution";

/** Result of running the pre-request chain. */
export interface AgnesVideoValidationResult {
  ok: boolean;
  /** Effective mode after classification/explicit override. */
  mode: "text" | "keyframe" | "reference";
  /** Exact prompt length (recorded even when valid, spec §19). */
  promptCharacterCount: number;
  /** Per-stage issues in chain order. */
  issues: AgnesVideoValidationIssue[];
}

/** Thrown by the submitter when the pre-request chain fails. */
export class AgnesVideoValidationError extends Error {
  readonly issues: readonly AgnesVideoValidationIssue[];

  constructor(issues: readonly AgnesVideoValidationIssue[]) {
    super(
      `Agnes video submit failed pre-request validation (${issues.length} issue(s)): ${issues
        .map((issue) => `[${issue.code}] ${issue.field}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "AgnesVideoValidationError";
    this.issues = issues;
  }
}

const AGNES_VIDEO_DOC_URL =
  "https://wiki.agnes-ai.com/en/docs/agnes-video-25";

/**
 * Agnes Video 2.5 documented mode rules (both variants, verified 2026-08-28):
 *   - mode=keyframe excludes images/audios/videos
 *   - mode=reference excludes first_frame/last_frame (Flash also videos)
 * CAP-005's hard frame-vs-references rule already covers the cross-mode
 * conflict; these stage-2 rules make the explicit `mode` field binding.
 */
const MODE_INPUT_CONFLICTS: Readonly<
  Record<
    "text" | "keyframe" | "reference",
    readonly ("firstFrameUrl" | "lastFrameUrl" | "referenceImageUrls" | "referenceVideos" | "referenceAudioUrls")[]
  >
> = Object.freeze({
  text: [
    "firstFrameUrl",
    "lastFrameUrl",
    "referenceImageUrls",
    "referenceVideos",
    "referenceAudioUrls",
  ],
  keyframe: ["referenceImageUrls", "referenceVideos", "referenceAudioUrls"],
  reference: ["firstFrameUrl", "lastFrameUrl"],
});

/** True when the model's profile documents frame (first/last) support. */
function supportsFrames(capability: MediaModelCapabilitySeed): boolean {
  return capability.references.firstFrame || capability.references.lastFrame;
}

/**
 * Run the full pre-request validation chain (spec §5 order). Pure — the
 * submitter calls this before creating any durable record.
 */
export function validateAgnesVideoSubmit(
  input: AgnesVideoSubmitInput,
  capability: MediaModelCapabilitySeed,
): AgnesVideoValidationResult {
  const issues: AgnesVideoValidationIssue[] = [];

  // Stage 1+2: prompt present + exact character count (spec §5: count
  // exactly, compare against hard max ONLY when the registry states one).
  const promptCharacterCount = input.prompt.length;
  if (promptCharacterCount === 0) {
    issues.push({
      field: "prompt",
      code: "PROMPT_REQUIRED",
      message: "prompt is required",
    });
  }
  // Agnes hardMaxCharacters is null (UNKNOWN) — this branch must not fire
  // for Agnes; a test pins that a huge prompt stays VALID for Agnes.
  const hardMax = capability.prompt.hardMaxCharacters;
  if (hardMax !== null && promptCharacterCount > hardMax) {
    issues.push({
      field: "prompt",
      code: "PROMPT_EXCEEDS_HARD_MAX",
      message: `prompt is ${promptCharacterCount} characters; documented hard max is ${hardMax}`,
    });
  }

  // Stage 3: reference counts (null max = undocumented → not enforced).
  const maxImages = capability.references.maxImages;
  if (
    maxImages !== null &&
    input.referenceImageUrls !== undefined &&
    input.referenceImageUrls.length > maxImages
  ) {
    issues.push({
      field: "images",
      code: "REFERENCE_IMAGES_EXCEED_MAX",
      message: `${input.referenceImageUrls.length} reference images exceeds the documented max of ${maxImages}`,
    });
  }
  const referenceVideoCount = input.referenceVideos?.length ?? 0;
  if (videosUnsupported(capability) && referenceVideoCount > 0) {
    issues.push({
      field: "videos",
      code: "REFERENCE_VIDEOS_NOT_SUPPORTED",
      message:
        "this model does not accept reference videos (Agnes Flash: HTTP 400 videos is not supported)",
    });
  } else {
    const maxVideos = capability.references.maxVideos;
    if (maxVideos !== null && referenceVideoCount > maxVideos) {
      issues.push({
        field: "videos",
        code: "REFERENCE_VIDEOS_EXCEED_MAX",
        message: `${referenceVideoCount} reference videos exceeds the documented max of ${maxVideos}`,
      });
    }
  }
  const maxAudio = capability.references.maxAudio;
  if (
    maxAudio !== null &&
    input.referenceAudioUrls !== undefined &&
    input.referenceAudioUrls.length > maxAudio
  ) {
    issues.push({
      field: "audios",
      code: "REFERENCE_AUDIOS_EXCEED_MAX",
      message: `${input.referenceAudioUrls.length} reference audios exceeds the documented max of ${maxAudio}`,
    });
  }

  // Stage 4: mode selection + exclusivity.
  const mode = input.mode ?? classifyMode(input);
  if (!supportsFrames(capability) && (input.firstFrameUrl !== undefined || input.lastFrameUrl !== undefined)) {
    issues.push({
      field: "first_frame",
      code: "FRAME_NOT_SUPPORTED",
      message: "this model does not document first/last-frame support",
    });
  }
  for (const field of MODE_INPUT_CONFLICTS[mode]) {
    const present =
      (field === "firstFrameUrl" && input.firstFrameUrl !== undefined) ||
      (field === "lastFrameUrl" && input.lastFrameUrl !== undefined) ||
      (field === "referenceImageUrls" && (input.referenceImageUrls?.length ?? 0) > 0) ||
      (field === "referenceVideos" && (input.referenceVideos?.length ?? 0) > 0) ||
      (field === "referenceAudioUrls" && (input.referenceAudioUrls?.length ?? 0) > 0);
    if (present) {
      issues.push({
        field: "mode",
        code: "MODE_EXCLUSIVITY",
        message: `mode=${mode} excludes ${field} (Agnes: keyframe excludes images/audios/videos; reference excludes first_frame/last_frame)`,
      });
    }
  }
  if (input.lastFrameUrl !== undefined && input.firstFrameUrl === undefined) {
    issues.push({
      field: "last_frame",
      code: "LAST_FRAME_REQUIRES_FIRST",
      message: "last_frame requires first_frame (keyframe mode)",
    });
  }
  // CAP-005 generic hard rule (frame inputs vs reference inputs) — same
  // validator the router and KIE adapters use.
  if (issues.every((issue) => issue.code !== "MODE_EXCLUSIVITY")) {
    try {
      assertExclusiveModes(capability, {
        firstFrameUrl: input.firstFrameUrl,
        lastFrameUrl: input.lastFrameUrl,
        referenceImageUrls: input.referenceImageUrls,
        referenceVideoUrls: input.referenceVideos?.map((video) => video.url),
        referenceAudioUrls: input.referenceAudioUrls,
      });
    } catch (error) {
      const exclusivityError = error as ExclusiveModeValidationError;
      if (exclusivityError.issues !== undefined) {
        for (const issue of exclusivityError.issues) {
          if (issue.code === "MUTUALLY_EXCLUSIVE_MODES") {
            issues.push({
              field: "mode",
              code: "MODE_EXCLUSIVITY",
              message: issue.message,
            });
          }
        }
      } else {
        throw error;
      }
    }
  }

  // Stage 5a: duration (seconds string "4"–"12" per the verified docs).
  const minSeconds = capability.output.minDurationSeconds;
  const maxSeconds = capability.output.maxDurationSeconds;
  if (input.seconds !== undefined) {
    if (!/^\d+$/.test(input.seconds)) {
      issues.push({
        field: "seconds",
        code: "SECONDS_INVALID",
        message: `seconds must be a decimal string like "5" (Agnes schema), got "${input.seconds}"`,
      });
    } else {
      const seconds = Number(input.seconds);
      if (
        (minSeconds !== null && seconds < minSeconds) ||
        (maxSeconds !== null && seconds > maxSeconds)
      ) {
        issues.push({
          field: "seconds",
          code: "SECONDS_OUT_OF_RANGE",
          message: `seconds ${seconds} outside documented range ${minSeconds ?? "?"}-${maxSeconds ?? "?"} (source: ${AGNES_VIDEO_DOC_URL})`,
        });
      }
    }
  }

  // Stage 5b: resolution + aspect ratio enums from the profile.
  if (
    input.size !== undefined &&
    !capability.output.resolutions.includes(input.size)
  ) {
    issues.push({
      field: "size",
      code: "SIZE_NOT_SUPPORTED",
      message: `size ${input.size} not in documented resolutions ${capability.output.resolutions.join(", ")} (Flash accepts only 720P)`,
    });
  }
  if (
    input.aspectRatio !== undefined &&
    !capability.output.aspectRatios.includes(input.aspectRatio)
  ) {
    issues.push({
      field: "aspect_ratio",
      code: "ASPECT_RATIO_NOT_SUPPORTED",
      message: `aspect ratio ${input.aspectRatio} not in documented set ${capability.output.aspectRatios.join(", ")}`,
    });
  }
  if (input.n !== undefined && input.n !== 1) {
    issues.push({
      field: "n",
      code: "N_NOT_SUPPORTED",
      message: "Agnes Video 2.5 generates n=1 only",
    });
  }

  return {
    ok: issues.length === 0,
    mode,
    promptCharacterCount,
    issues,
  };
}

/**
 * True when the profile declares reference-video input unsupported.
 * Agnes Flash: any non-empty videos array → HTTP 400.
 */
function videosUnsupported(capability: MediaModelCapabilitySeed): boolean {
  return capability.references.incompatibleCombinations.some((entry) =>
    entry.includes("videos always rejected") || entry.includes("videos is not supported"),
  );
}

/**
 * Estimate paid spend for one job (spec §4: derive cost BEFORE spending;
 * CAP-002 pricing: output seconds × per-second rate; input-video seconds and
 * excess images billed too). Currently $0 under the Agnes promo but computed
 * from list prices so the estimate never silently assumes free.
 */
export function estimateSpendUsd(
  input: AgnesVideoSubmitInput,
  capability: MediaModelCapabilitySeed,
): number {
  const seconds = Number(input.seconds ?? "5");
  const rate = capability.pricing.amount ?? 0;
  const outputCost = seconds * rate;
  const inputVideoSeconds = (input.referenceVideos ?? []).length * seconds;
  const inputVideoCost = inputVideoSeconds * rate;
  const freeImages = imageFreeAllowance(capability);
  const excessImages = Math.max(
    0,
    (input.referenceImageUrls?.length ?? 0) - freeImages,
  );
  const excessImageRate = capability.pricingDetail?.["excess-input-image"] ?? 0;
  const excessImageCost = excessImages * excessImageRate;
  return round6(outputCost + inputVideoCost + excessImageCost);
}

function imageFreeAllowance(capability: MediaModelCapabilitySeed): number {
  const value = capability.pricingDetail?.["free-image-allowance"];
  // Agnes Video 2.5 (both variants) bills input images from the 6th
  // (pricing page: "first 5 input images free"); the Flash seed omits the
  // allowance key, so default to the documented 5 rather than 0.
  return typeof value === "number" ? value : 5;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Resolve the seeded capability profile for a model id (stage 1). */
export function agnesVideoCapability(
  model: "agnes-video-2.5-flash" | "agnes-video-2.5",
): MediaModelCapabilitySeed {
  return model === "agnes-video-2.5" ? AGNES_VIDEO_2_5 : AGNES_VIDEO_2_5_FLASH;
}