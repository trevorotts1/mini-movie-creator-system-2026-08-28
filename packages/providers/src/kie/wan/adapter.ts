/**
 * Wan 3.0 adapter — the model profile layer over the shared Kie transport
 * (KIE-001 client) and generic task runner (KIE-002).
 *
 * Responsibilities (and ONLY these):
 *   - validate structured input against the VERIFIED capability profile
 *   - build the exact createTask body for wan/3-0-video | wan/3-0-video-prime
 *   - estimate cost before submission
 *   - submit via the injected client port and return the provider task ID
 *
 * Polling/state machine live in packages/providers/src/kie/task/ (KIE-002);
 * temporary-URL archival is KIE-008's job.
 */
import { isWanModel, type WanModelId } from "./capability.js";
import { buildCreateTaskBody, estimateWanCost, type WanCostEstimate } from "./request.js";
import { validateWanInput, type WanValidationContext } from "./validate.js";
import type { WanSubmitOptions, WanVideoInput } from "./types.js";

/**
 * Minimal client port the adapter submits through. Shaped exactly like the
 * shared Kie client (packages/providers/src/kie/client — KIE-001), so the real
 * client satisfies it structurally; tests inject a stub.
 */
export interface WanClientPort {
  createTask(body: {
    model: string;
    input: Record<string, unknown>;
    callBackUrl?: string;
  }): Promise<{ taskId: string }>;
}

export interface WanSubmitResult {
  /** Provider task ID — persist BEFORE polling (runbook §21 idempotency). */
  taskId: string;
  model: WanModelId;
  /** The exact wire body submitted (audit trail / resume context). */
  request: ReturnType<typeof buildCreateTaskBody>;
  /** Detected generation mode. */
  mode: ReturnType<typeof validateWanInput>["mode"];
  /** Cost estimate computed at submit time (null for duration -1). */
  estimate: WanCostEstimate | null;
  /** Character count of the prompt as submitted. */
  promptCharacterCount: number;
}

/** Errors the adapter surfaces (validation failures carry the full list). */
export class WanSubmitError extends Error {
  readonly overrideCause?: unknown;
  constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WanSubmitError";
    if (cause !== undefined) this.overrideCause = cause;
  }
}

/**
 * Validate + price + submit one Wan 3.0 generation. Never retries submission
 * itself (the shared Kie client owns transport retries); never polls.
 */
export async function submitWanVideo(
  client: WanClientPort,
  input: WanVideoInput,
  options: {
    model?: WanModelId;
    callBackUrl?: string;
    /** Caller-declared reference-video seconds for the ≤30s cross-check. */
    referenceVideoSeconds?: number;
  } = {},
): Promise<WanSubmitResult> {
  const model = options.model ?? "wan/3-0-video";
  if (!isWanModel(model)) {
    throw new WanSubmitError(`Unknown Wan model id "${model}"`);
  }
  const context: WanValidationContext =
    options.referenceVideoSeconds !== undefined
      ? { referenceVideoSeconds: options.referenceVideoSeconds }
      : {};
  const { mode } = validateWanInput(input, model, context);
  const estimate = estimateWanCost(input, model, options.referenceVideoSeconds ?? 0);
  const body = buildCreateTaskBody(input, model, options.callBackUrl);
  try {
    const created = await client.createTask(body);
    return {
      taskId: created.taskId,
      model,
      request: body,
      mode,
      estimate,
      promptCharacterCount: [...input.prompt].length,
    };
  } catch (err) {
    throw new WanSubmitError(`Wan createTask failed for model ${model}`, err);
  }
}