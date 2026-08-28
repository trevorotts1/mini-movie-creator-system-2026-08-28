/**
 * Agnes Video 2.5 regular adapter (@mmcs/providers/agnes/profiles/regular).
 *
 * Task AGN-007. The model-profile layer over the shared Agnes transport
 * (AGN-001 client / AGN-004 submit). Responsibilities (and ONLY these):
 *   - validate structured input against the VERIFIED regular profile
 *   - build the exact request body for agnes-video-2.5
 *   - submit via the injected client port and return the provider task ID
 *
 * Polling lives in packages/providers/src/agnes/video/poll (AGN-005);
 * pre-flight first/last/reference combination validation is AGN-008;
 * quota accounting is AGN-009; retry/idempotency is AGN-010.
 */

import {
  AGNES_REGULAR_MODEL,
  agnesRegularRetrieveUrl,
  type AgnesRegularModelId,
} from "./capability.js";
import {
  buildAgnesRegularRequest,
  regularExcessImageCount,
  regularPromptCharacterCount,
  type AgnesRegularRequest,
} from "./request.js";
import {
  validateAgnesRegularInput,
  type AgnesRegularValidationError,
} from "./validate.js";
import type { AgnesRegularInput } from "./validate.js";

/**
 * Minimal client port the adapter submits through. Shaped exactly like the
 * Agnes client (packages/providers/src/agnes/client — AGN-001), so the real
 * client satisfies it structurally; tests inject a stub.
 */
export interface AgnesRegularClientPort {
  createVideo(body: AgnesRegularRequest): Promise<{ videoId: string }>;
}

export interface AgnesRegularSubmitResult {
  /** Provider task ID — persist BEFORE polling (runbook §21 idempotency). */
  videoId: string;
  model: AgnesRegularModelId;
  /** The exact wire body submitted (audit trail / resume context). */
  request: AgnesRegularRequest;
  /** Detected generation mode. */
  mode: AgnesRegularRequest["mode"];
  /** Character count of the prompt as submitted. */
  promptCharacterCount: number;
  /** Billable input images beyond the free allowance (0 when ≤5 images). */
  excessImageCount: number;
}

/** Errors the adapter surfaces (validation failures carry the full list). */
export class AgnesRegularSubmitError extends Error {
  readonly overrideCause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AgnesRegularSubmitError";
    if (cause !== undefined) this.overrideCause = cause;
  }
}

/**
 * Validate + submit one regular generation against the live schema. Never
 * retries submission (AGN-010 owns retry); never resolves without a videoId.
 */
export async function submitAgnesRegular(
  input: AgnesRegularInput,
  client: AgnesRegularClientPort,
): Promise<AgnesRegularSubmitResult> {
  const validation = validateAgnesRegularInput(input);
  if (!validation.ok) {
    const msgs = validation.errors
      .map((e: AgnesRegularValidationError) => `${e.field}: ${e.message}`)
      .join("; ");
    throw new AgnesRegularSubmitError(`invalid regular request — ${msgs}`);
  }

  const request = buildAgnesRegularRequest(input);
  const result = await client.createVideo(request);
  if (
    !result ||
    typeof result.videoId !== "string" ||
    result.videoId.length === 0
  ) {
    throw new AgnesRegularSubmitError(
      "Agnes regular submit returned no videoId — do not treat as submitted",
    );
  }
  return {
    videoId: result.videoId,
    model: AGNES_REGULAR_MODEL,
    request,
    mode: request.mode,
    promptCharacterCount: regularPromptCharacterCount(input),
    excessImageCount: regularExcessImageCount(input),
  };
}

/** Retrieve URL for an in-flight regular job (model_name always included). */
export function regularJobRetrieveUrl(videoId: string): string {
  return agnesRegularRetrieveUrl(videoId);
}
