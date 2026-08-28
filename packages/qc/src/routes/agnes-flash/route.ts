/**
 * Agnes Video 2.5 Flash acceptance route (@mmcs/qc/routes/agnes-flash).
 *
 * Task QC-007. Implements the first hop of the spec §13 video router policy:
 *
 *   try Agnes Video 2.5 Flash when suitable → automated QC →
 *     PASS: keep →
 *     likely prompt/seed failure: retry Flash ONCE →
 *     still FAIL: Agnes Video 2.5 regular (QC-008 escalation) →
 *     reference/identity problem remains: Seedance 2.0 Mini (QC-009) →
 *     Wan 3.0 (QC-010) → human REVIEW (QC-011).
 *
 * BINDING (spec §12.1 / runbook §26.1): Flash footage that passes QC is valid
 * FINAL footage — never auto-discarded as preview-only. Every PASS decision
 * carries `isFinalFootage: true` / `previewOnly: false`, and this module has
 * no "preview" disposition at all: the only footage dispositions are FINAL
 * (kept) and ESCALATED (handed to the next router hop).
 *
 * Retry budget: exactly ONE Flash retry per shot, and only for failures that
 * look like prompt/seed nondeterminism. Identity/reference failures and
 * provider/transport errors never consume the retry — a seed re-roll cannot
 * fix either, so the shot escalates immediately (spec §13).
 *
 * Model id is the runtime-discovered `agnes-video-2.5-flash` (provenance:
 * packages/capability-registry/src/data/agnes.ts, docs/provider-capabilities/
 * agnes.md, verified 2026-08-28). The stale `agnes-video-v2.0` id is refused.
 */

/** Exact Flash model id — runtime-discovered from live Agnes docs 2026-08-28. */
export const AGNES_FLASH_MODEL = "agnes-video-2.5-flash" as const;
export type AgnesFlashModelId = typeof AGNES_FLASH_MODEL;

/** Next router hop when Flash is exhausted (spec §13): Agnes Video 2.5 regular. */
export const AGNES_REGULAR_MODEL = "agnes-video-2.5" as const;

/** Stale public-docs id that must never route (runbook §11.1). */
export const STALE_FLASH_MODEL = "agnes-video-v2.0" as const;

/**
 * Attempts allowed per shot on the Flash route: the initial generation plus
 * exactly one retry. Never more — a third Flash attempt is a policy defect.
 */
export const MAX_FLASH_ATTEMPTS = 2;

/**
 * QC checks (spec §20 list) whose failure means a reference/identity problem.
 * A seed re-roll on the same references cannot fix these — they escalate to
 * the Agnes regular fallback (and, per spec §13, on to Seedance when the
 * reference/identity problem persists) instead of burning the Flash retry.
 */
export const IDENTITY_REFERENCE_CHECKS: readonly string[] = Object.freeze([
  "character-identity",
  "face-consistency",
  "skin-tone",
  "hair",
  "wardrobe",
  "accessories",
]);

/** A single failed QC check on a generated Flash clip (spec §20 checks). */
export interface FlashQcFailure {
  /** Stable check name, e.g. "character-identity", "visual-artifacts". */
  readonly check: string;
  /** Free-form detail from the QC evaluator. Untrusted text — never executed. */
  readonly detail?: string;
}

/** Automated QC result for one generated Flash clip. */
export interface FlashQcResult {
  readonly verdict: "PASS" | "FAIL";
  /** Failed checks; empty when PASS. */
  readonly failures: readonly FlashQcFailure[];
  /**
   * True when the QC run itself could not complete because the provider job
   * failed / transport died (distinct from content QC failures).
   */
  readonly providerError?: boolean;
  /** Generated clip URL (temporary provider URL; archival is downstream). */
  readonly videoUrl?: string;
  /** Provider task/job id for provenance. */
  readonly providerTaskId?: string;
}

/** The shot the route is deciding about. */
export interface FlashShotContext {
  readonly shotId: string;
  readonly sceneId?: string;
  readonly episodeId?: string;
  /**
   * Must be the runtime-discovered Flash model id; anything else (including
   * the stale `agnes-video-v2.0`) is refused — the acceptance route only
   * governs Flash footage.
   */
  readonly model: string;
  /** Deterministic seed used for the attempt being routed (Flash supports seed). */
  readonly seed?: number;
}

/**
 * Footage disposition on this route. There is deliberately no "preview"
 * value: Flash PASS is FINAL footage (spec §12.1), and everything else
 * escalates rather than being kept in a lesser state.
 */
export type FlashFootageDisposition = "FINAL" | "ESCALATED";

/** Why the route did what it did. */
export type FlashRouteReason =
  | "flash-pass"
  | "likely-prompt-seed"
  | "identity-reference"
  | "provider-error"
  | "retry-budget-exhausted";

/** What the router hands to the next hop. */
export type FlashRouteDecision =
  | {
      readonly action: "KEEP_AS_FINAL";
      readonly disposition: "FINAL";
      /** Binding spec §12.1: Flash PASS is final footage, never preview-only. */
      readonly isFinalFootage: true;
      readonly previewOnly: false;
      readonly reason: "flash-pass";
      readonly model: AgnesFlashModelId;
      readonly shotId: string;
      /** Attempts consumed to reach this PASS (1 = initial, 2 = after retry). */
      readonly attemptsUsed: number;
      readonly videoUrl?: string;
      readonly providerTaskId?: string;
    }
  | {
      readonly action: "RETRY_FLASH";
      /** The single allowed retry is always attempt 2. */
      readonly attempt: 2;
      readonly maxAttempts: typeof MAX_FLASH_ATTEMPTS;
      readonly reason: "likely-prompt-seed";
      readonly model: AgnesFlashModelId;
      readonly shotId: string;
      /** Prompt is NOT rewritten on the retry — a seed re-roll, not an edit. */
      readonly promptUnchanged: true;
      /** Varied seed for the re-roll; undefined when the shot had no seed. */
      readonly seed?: number;
      readonly failures: readonly FlashQcFailure[];
    }
  | {
      readonly action: "ESCALATE";
      /** Spec §13: still FAIL after Flash → Agnes Video 2.5 regular (QC-008). */
      readonly to: typeof AGNES_REGULAR_MODEL;
      readonly reason: FlashRouteReason;
      readonly disposition: "ESCALATED";
      readonly shotId: string;
      readonly attemptsUsed: number;
      readonly failures: readonly FlashQcFailure[];
    };

/** Why a FlashRouteError was raised. */
export type FlashRouteErrorCode =
  | "stale-model"
  | "wrong-model"
  | "bad-context"
  | "bad-attempt"
  | "bad-qc";

/** Route input was invalid — a wiring bug, never a footage verdict. */
export class FlashRouteError extends Error {
  readonly code: FlashRouteErrorCode;

  constructor(code: FlashRouteErrorCode, message: string) {
    super(message);
    this.name = "FlashRouteError";
    this.code = code;
  }
}

/**
 * Classify one seed variation for the single Flash retry. Deterministic and
 * bounded to the int32 range Agnes-style seed fields accept; 0 stays reserved
 * (some APIs treat 0 as "unset") by wrapping to 1.
 */
export function nextRetrySeed(seed: number): number {
  if (!Number.isInteger(seed)) {
    throw new FlashRouteError("bad-context", `seed must be an integer, got ${seed}`);
  }
  const next = seed + 1;
  if (next > 2147483647) return 1;
  if (next === 0) return 1;
  return next;
}

/**
 * Classify a FAIL into the spec §13 buckets.
 *
 *  - `providerError` (or a provider-transport check failure) → provider-error
 *  - any identity/reference-block check failed → identity-reference
 *  - everything else (artifacts, anatomy, action, camera, lighting, …) →
 *    likely-prompt-seed: the one class a seed re-roll can plausibly fix.
 */
export function classifyFlashFailure(qc: FlashQcResult): FlashRouteReason {
  if (qc.providerError === true) return "provider-error";
  const failed = new Set(qc.failures.map((f) => f.check));
  if (failed.has("provider-transport")) return "provider-error";
  for (const check of IDENTITY_REFERENCE_CHECKS) {
    if (failed.has(check)) return "identity-reference";
  }
  return "likely-prompt-seed";
}

/** Runtime guard: only the real Flash model is routed here. */
function assertFlashModel(model: string): asserts model is AgnesFlashModelId {
  if (model === STALE_FLASH_MODEL) {
    throw new FlashRouteError(
      "stale-model",
      `refusing stale model id ${STALE_FLASH_MODEL}; the runtime-discovered Flash id is ${AGNES_FLASH_MODEL} (runbook §11.1)`,
    );
  }
  if (model !== AGNES_FLASH_MODEL) {
    throw new FlashRouteError(
      "wrong-model",
      `Agnes Flash acceptance route only governs ${AGNES_FLASH_MODEL}, got ${model}`,
    );
  }
}

function assertContext(ctx: FlashShotContext): void {
  assertFlashModel(ctx.model);
  if (typeof ctx.shotId !== "string" || ctx.shotId.trim().length === 0) {
    throw new FlashRouteError("bad-context", "shotId must be a non-empty string");
  }
  if (ctx.seed !== undefined && !Number.isInteger(ctx.seed)) {
    throw new FlashRouteError("bad-context", `seed must be an integer, got ${ctx.seed}`);
  }
}

function assertAttempt(attemptsUsed: number): void {
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 1) {
    throw new FlashRouteError(
      "bad-attempt",
      `attemptsUsed must be a positive integer (1-based), got ${attemptsUsed}`,
    );
  }
}

function assertQc(qc: FlashQcResult): void {
  if (qc.verdict !== "PASS" && qc.verdict !== "FAIL") {
    throw new FlashRouteError("bad-qc", `verdict must be PASS or FAIL, got ${String(qc.verdict)}`);
  }
  if (!Array.isArray(qc.failures)) {
    throw new FlashRouteError("bad-qc", "failures must be an array (empty when PASS)");
  }
  if (qc.verdict === "PASS" && qc.failures.length > 0) {
    throw new FlashRouteError("bad-qc", "PASS verdict must not carry failures");
  }
}

/**
 * Decide the fate of one Flash attempt (spec §13, first hop).
 *
 * `attemptsUsed` is 1-based: 1 = the initial generation, 2 = the single
 * allowed retry. The decision is pure — no provider calls, no state writes;
 * the caller persists it (spec §18) and owns the actual resubmission.
 *
 *  - PASS (any attempt) → KEEP_AS_FINAL. Final footage, never preview-only.
 *  - FAIL identity/reference → escalate immediately; seeds don't fix identity.
 *  - FAIL provider/transport → escalate; AGN-010 owns transport retries.
 *  - FAIL likely prompt/seed with budget left → the one Flash retry
 *    (prompt unchanged, seed varied).
 *  - Budget spent → escalate to Agnes Video 2.5 regular (QC-008's hop).
 */
export function routeFlashShot(
  ctx: FlashShotContext,
  qc: FlashQcResult,
  attemptsUsed: number,
): FlashRouteDecision {
  assertContext(ctx);
  assertAttempt(attemptsUsed);
  assertQc(qc);

  if (qc.verdict === "PASS") {
    return {
      action: "KEEP_AS_FINAL",
      disposition: "FINAL",
      isFinalFootage: true,
      previewOnly: false,
      reason: "flash-pass",
      model: AGNES_FLASH_MODEL,
      shotId: ctx.shotId,
      attemptsUsed,
      videoUrl: qc.videoUrl,
      providerTaskId: qc.providerTaskId,
    };
  }

  const failures = qc.failures;
  const classification = classifyFlashFailure(qc);

  if (classification === "identity-reference" || classification === "provider-error") {
    return escalate(ctx, attemptsUsed, classification, failures);
  }

  // likely-prompt-seed: exactly one retry remains when attempt 1 failed.
  if (attemptsUsed < MAX_FLASH_ATTEMPTS) {
    return {
      action: "RETRY_FLASH",
      attempt: 2,
      maxAttempts: MAX_FLASH_ATTEMPTS,
      reason: "likely-prompt-seed",
      model: AGNES_FLASH_MODEL,
      shotId: ctx.shotId,
      promptUnchanged: true,
      seed: ctx.seed === undefined ? undefined : nextRetrySeed(ctx.seed),
      failures,
    };
  }

  return escalate(ctx, attemptsUsed, "retry-budget-exhausted", failures);
}

function escalate(
  ctx: FlashShotContext,
  attemptsUsed: number,
  reason: FlashRouteReason,
  failures: readonly FlashQcFailure[],
): FlashRouteDecision {
  return {
    action: "ESCALATE",
    to: AGNES_REGULAR_MODEL,
    reason,
    disposition: "ESCALATED",
    shotId: ctx.shotId,
    attemptsUsed,
    failures,
  };
}

/**
 * Downstream guard for the binding acceptance rule: a Flash PASS must never
 * be re-wired into a preview-only or discarded state. Throws whenever a
 * decision produced for a PASS verdict is not KEEP_AS_FINAL/FINAL, or when a
 * KEEP_AS_FINAL decision has been tampered with.
 */
export function assertFlashPassIsFinal(decision: FlashRouteDecision): void {
  if (decision.action !== "KEEP_AS_FINAL") {
    throw new FlashRouteError(
      "bad-qc",
      `Flash PASS was downgraded to ${decision.action} — spec §12.1 forbids auto-discarding passing Flash footage as preview-only`,
    );
  }
  if (
    decision.disposition !== "FINAL" ||
    decision.isFinalFootage !== true ||
    decision.previewOnly !== false
  ) {
    throw new FlashRouteError(
      "bad-qc",
      "Flash PASS decision lost its FINAL-footage disposition — refusing to treat it as preview-only",
    );
  }
}