/**
 * Wan hero/complex fallback route — executor (QC-010).
 *
 * Wires the pure policy (policy.ts) to submission through an injected
 * client port shaped exactly like the verified Wan 3.0 adapter's
 * `WanClientPort` (KIE-005) — the real adapter satisfies it structurally,
 * tests inject stubs. Every hard limit is re-checked HERE against the wire
 * input as the final pre-submit barrier (spec §5/§6: reject over-limit
 * prompts / over-count references BEFORE the provider call). The route
 * never polls (KIE-002 owns the task state machine) and never retries
 * submission itself (QC-006 owns the retry policy above this tier).
 */
import { evaluateWanPolicy, projectWanSpendUsd, WAN_ROUTE_LIMITS } from "./policy.js";
import type {
  WanPolicyDecision,
  WanRouteContext,
  WanRouteModelId,
  WanRouteResult,
  WanRouteShot,
  WanRouteVideoInput,
} from "./types.js";

export type WanRouteResultResolution = "480P" | "720P" | "1080P";

/**
 * Minimal client port for submission. Structural twin of KIE-005's
 * WanClientPort: `createTask(body)` returns the provider task id.
 */
export interface WanRouteClientPort {
  createTask(body: {
    model: string;
    input: Record<string, unknown>;
    callBackUrl?: string;
  }): Promise<{ taskId: string }>;
}

/** One pre-submit wire-level validation failure. */
export interface WanRouteValidationIssue {
  field: string;
  message: string;
  limit?: number;
  actual?: number;
}

/** Thrown by validateWanRouteInput; lists ALL problems in one pass. */
export class WanRouteValidationError extends Error {
  readonly issues: WanRouteValidationIssue[];
  constructor(issues: WanRouteValidationIssue[]) {
    super(
      `Wan route input rejected (${issues.length} problem${issues.length === 1 ? "" : "s"}): ${issues
        .map((i) => `${i.field}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "WanRouteValidationError";
    this.issues = issues;
  }
}

/** URL fields this route can emit, with their verified maxima. */
const URL_FIELD_CHECKS: ReadonlyArray<{
  field: string;
  get: (input: WanRouteVideoInput) => string[] | undefined;
  max: number;
}> = [
  { field: "first_frame_url", get: (i) => (i.firstFrameUrl ? [i.firstFrameUrl] : undefined), max: 1 },
  { field: "last_frame_url", get: (i) => (i.lastFrameUrl ? [i.lastFrameUrl] : undefined), max: 1 },
  { field: "reference_image_urls", get: (i) => i.referenceImageUrls, max: WAN_ROUTE_LIMITS.maxReferenceImages },
  { field: "reference_video_urls", get: (i) => i.referenceVideoUrls, max: WAN_ROUTE_LIMITS.maxReferenceVideos },
  { field: "reference_audio_urls", get: (i) => i.referenceAudioUrls, max: WAN_ROUTE_LIMITS.maxReferenceAudio },
];

function hasAny(list: string[] | undefined): boolean {
  return Array.isArray(list) && list.length > 0;
}

function hasMedia(input: WanRouteVideoInput): boolean {
  return (
    Boolean(input.firstFrameUrl) ||
    Boolean(input.lastFrameUrl) ||
    hasAny(input.referenceImageUrls) ||
    hasAny(input.referenceVideoUrls) ||
    hasAny(input.referenceAudioUrls)
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && /^[^\s]+$/.test(value);
}

/**
 * Final pre-submit validation of the wire input (structural twin of
 * KIE-005's validateWanInput for the fields this route emits). Throws
 * WanRouteValidationError with every failure — a bad request must never
 * reach the provider.
 */
export function validateWanRouteInput(
  input: WanRouteVideoInput,
  model: WanRouteModelId,
): { promptCharacterCount: number } {
  const issues: WanRouteValidationIssue[] = [];

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const promptCharacterCount = [...prompt].length;
  if (promptCharacterCount > WAN_ROUTE_LIMITS.hardMaxPromptCharacters) {
    issues.push({
      field: "prompt",
      message: `exceeds the hard maximum of ${WAN_ROUTE_LIMITS.hardMaxPromptCharacters} characters`,
      limit: WAN_ROUTE_LIMITS.hardMaxPromptCharacters,
      actual: promptCharacterCount,
    });
  }
  if (promptCharacterCount === 0 && !hasMedia(input)) {
    issues.push({ field: "prompt", message: "prompt is required for text-to-video" });
  }

  for (const check of URL_FIELD_CHECKS) {
    const value = check.get(input);
    if (value === undefined) continue;
    if (value.length > check.max) {
      issues.push({
        field: check.field,
        message: `too many entries (max ${check.max})`,
        limit: check.max,
        actual: value.length,
      });
    }
    if (value.some((u) => typeof u !== "string" || !isHttpUrl(u))) {
      issues.push({ field: check.field, message: "every entry must be an http(s) URL string" });
    }
  }

  const frames = [input.firstFrameUrl, input.lastFrameUrl].filter(Boolean).length;
  const refs =
    hasAny(input.referenceImageUrls) || hasAny(input.referenceVideoUrls) || hasAny(input.referenceAudioUrls);
  if (frames > 0 && refs) {
    issues.push({
      field: "input",
      message: "first/last-frame inputs cannot be combined with multimodal reference inputs",
    });
  }

  if (input.duration !== undefined) {
    const d = input.duration;
    if (!Number.isInteger(d)) {
      issues.push({ field: "duration", message: "must be an integer number of seconds" });
    } else if (d !== -1 && (d < WAN_ROUTE_LIMITS.minDurationSeconds || d > WAN_ROUTE_LIMITS.maxDurationSeconds)) {
      issues.push({
        field: "duration",
        message: `must be within [${WAN_ROUTE_LIMITS.minDurationSeconds}, ${WAN_ROUTE_LIMITS.maxDurationSeconds}] or -1 (model decides)`,
        limit: WAN_ROUTE_LIMITS.maxDurationSeconds,
        actual: d,
      });
    }
  }

  if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2_147_483_647)) {
    issues.push({ field: "seed", message: "must be an integer in [0, 2147483647]" });
  }

  if (model !== "wan/3-0-video" && model !== "wan/3-0-video-prime") {
    issues.push({ field: "model", message: `unknown Wan model id "${model}"` });
  }

  if (issues.length > 0) throw new WanRouteValidationError(issues);
  return { promptCharacterCount };
}

/** Build the exact createTask wire body for the chosen model/resolution. */
export function buildWanRouteBody(
  input: WanRouteVideoInput,
  model: WanRouteModelId,
  resolution: WanRouteResultResolution,
  callBackUrl?: string,
): {
  model: WanRouteModelId;
  callBackUrl?: string;
  input: {
    prompt?: string;
    first_frame_url?: string;
    last_frame_url?: string;
    reference_image_urls?: string[];
    reference_video_urls?: string[];
    reference_audio_urls?: string[];
    resolution: WanRouteResultResolution;
    aspect_ratio: "adaptive" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
    duration: number;
    audio: boolean;
    seed?: number;
  };
} {
  const wireInput: {
    prompt?: string;
    first_frame_url?: string;
    last_frame_url?: string;
    reference_image_urls?: string[];
    reference_video_urls?: string[];
    reference_audio_urls?: string[];
    resolution: WanRouteResultResolution;
    aspect_ratio: "adaptive" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
    duration: number;
    audio: boolean;
    seed?: number;
  } = {
    resolution,
    aspect_ratio: "adaptive",
    duration: input.duration ?? 5,
    audio: input.audio ?? true,
  };
  if (input.prompt !== "") wireInput.prompt = input.prompt;
  if (input.firstFrameUrl) wireInput.first_frame_url = input.firstFrameUrl;
  if (input.lastFrameUrl) wireInput.last_frame_url = input.lastFrameUrl;
  if (hasAny(input.referenceImageUrls)) wireInput.reference_image_urls = input.referenceImageUrls;
  if (hasAny(input.referenceVideoUrls)) wireInput.reference_video_urls = input.referenceVideoUrls;
  if (hasAny(input.referenceAudioUrls)) wireInput.reference_audio_urls = input.referenceAudioUrls;
  if (input.seed !== undefined) wireInput.seed = input.seed;

  return {
    model,
    ...(callBackUrl !== undefined ? { callBackUrl } : {}),
    input: wireInput,
  };
}

/** Errors the route surfaces to the retry orchestrator. */
export class WanRouteSubmitError extends Error {
  constructor(
    message: string,
    readonly overrideCause?: unknown,
  ) {
    super(message);
    this.name = "WanRouteSubmitError";
  }
}

/**
 * Route one shot to the Wan tier: policy decision → wire validation →
 * submit. Resolution comes from the policy (1080P). Throws
 * WanRouteValidationError on wire-invalid input (the prompt budget missed
 * something — repair, never auto-truncate: spec §23).
 */
export async function routeShotToWan(
  client: WanRouteClientPort,
  shot: WanRouteShot,
  context: WanRouteContext,
  options: { callBackUrl?: string } = {},
): Promise<WanRouteResult> {
  const decision: WanPolicyDecision = evaluateWanPolicy(shot, context);
  if (decision.outcome === "skip") {
    return { status: "skipped", shotId: shot.shotId, reasons: decision.reasons };
  }
  if (decision.outcome === "hold") {
    return { status: "held-for-approval", shotId: shot.shotId, reasons: decision.reasons };
  }

  const input: WanRouteVideoInput = {
    prompt: shot.compiledPrompt,
    ...(shot.firstFrameUrl !== undefined ? { firstFrameUrl: shot.firstFrameUrl } : {}),
    ...(shot.lastFrameUrl !== undefined ? { lastFrameUrl: shot.lastFrameUrl } : {}),
    ...(shot.referenceImageUrls !== undefined ? { referenceImageUrls: shot.referenceImageUrls } : {}),
    ...(shot.referenceVideoUrls !== undefined ? { referenceVideoUrls: shot.referenceVideoUrls } : {}),
    ...(shot.referenceAudioUrls !== undefined ? { referenceAudioUrls: shot.referenceAudioUrls } : {}),
    duration: shot.targetDurationSeconds,
    resolution: decision.resolution,
  };
  // The spend gate's projection must match what we report on submit.
  const projectedCostUsd =
    projectWanSpendUsd(shot, decision.resolution, decision.model === "wan/3-0-video-prime")?.totalUsd ?? 0;

  validateWanRouteInput(input, decision.model);
  if (options.callBackUrl !== undefined && !isHttpUrl(options.callBackUrl)) {
    throw new WanRouteValidationError([
      { field: "callBackUrl", message: "must be an http(s) URL string" },
    ]);
  }

  const body = buildWanRouteBody(input, decision.model, decision.resolution, options.callBackUrl);
  try {
    const created = await client.createTask(body);
    return {
      status: "submitted",
      shotId: shot.shotId,
      taskId: created.taskId,
      model: decision.model,
      resolution: decision.resolution,
      projectedCostUsd,
      reasons: decision.reasons,
      input,
    };
  } catch (err) {
    throw new WanRouteSubmitError(`Wan createTask failed for shot ${shot.shotId} (model ${decision.model})`, err);
  }
}