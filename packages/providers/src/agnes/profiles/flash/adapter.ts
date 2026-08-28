/**
 * Agnes Video 2.5 Flash adapter (@mmcs/providers/agnes/profiles/flash).
 *
 * Task AGN-006. The model-profile layer over the shared Agnes transport
 * (AGN-001 client / AGN-004 submit). Responsibilities (and ONLY these):
 *   - validate structured input against the VERIFIED Flash profile
 *   - build the exact request body for agnes-video-2.5-flash
 *   - submit via the injected client port and return the provider task ID
 *
 * Polling lives in packages/providers/src/agnes/video-poll.ts (AGN-005);
 * quota accounting is AGN-009; retry/idempotency is AGN-010.
 */

import {
  AGNES_FLASH_MODEL,
  agnesFlashRetrieveUrl,
  type AgnesFlashModelId,
} from "./capability.js";
import {
  buildAgnesFlashRequest,
  flashPromptCharacterCount,
  type AgnesFlashRequest,
} from "./request.js";
import {
  validateAgnesFlashInput,
  type AgnesFlashValidationError,
} from "./validate.js";
import type { AgnesFlashInput } from "./validate.js";

/**
 * Minimal client port the adapter submits through. Shaped exactly like the
 * Agnes client (packages/providers/src/agnes/client — AGN-001), so the real
 * client satisfies it structurally; tests inject a stub.
 */
export interface AgnesClientPort {
  createVideo(body: AgnesFlashRequest): Promise<{ videoId: string }>;
}

export interface AgnesFlashSubmitResult {
  /** Provider task ID — persist BEFORE polling (runbook §21 idempotency). */
  videoId: string;
  model: AgnesFlashModelId;
  /** The exact wire body submitted (audit trail / resume context). */
  request: AgnesFlashRequest;
  /** Detected generation mode. */
  mode: AgnesFlashRequest["mode"];
  /** Character count of the prompt as submitted. */
  promptCharacterCount: number;
}

/** Errors the adapter surfaces (validation failures carry the full list). */
export class AgnesFlashSubmitError extends Error {
  readonly overrideCause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AgnesFlashSubmitError";
    if (cause !== undefined) this.overrideCause = cause;
  }
}

/**
 * Validate + submit one Flash generation against the live schema. Never
 * retries submission (AGN-010 owns retry); never resolves without a videoId.
 */
export async function submitAgnesFlash(
  input: AgnesFlashInput,
  client: AgnesClientPort,
): Promise<AgnesFlashSubmitResult> {
  const validation = validateAgnesFlashInput(input);
  if (!validation.ok) {
    const msgs = validation.errors
      .map((e: AgnesFlashValidationError) => `${e.field}: ${e.message}`)
      .join("; ");
    throw new AgnesFlashSubmitError(`invalid Flash request — ${msgs}`);
  }

  const request = buildAgnesFlashRequest(input);
  const result = await client.createVideo(request);
  if (!result || typeof result.videoId !== "string" || result.videoId.length === 0) {
    throw new AgnesFlashSubmitError(
      "Agnes Flash submit returned no videoId — do not treat as submitted",
    );
  }
  return {
    videoId: result.videoId,
    model: AGNES_FLASH_MODEL,
    request,
    mode: request.mode,
    promptCharacterCount: flashPromptCharacterCount(input),
  };
}

/** Retrieve URL for an in-flight Flash job (model_name required for non-text). */
export function flashJobRetrieveUrl(videoId: string): string {
  return agnesFlashRetrieveUrl(videoId);
}
