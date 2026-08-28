/**
 * QC-009 — Seedance fallback route (spec §13 video-router policy, step 3).
 *
 * Trigger: the reference/identity problem PERSISTS after the Agnes Video 2.5
 * regular escalation (the route that runs after a Flash retry fails). When
 * Agnes regular also fails on the SAME reference/identity failure class, the
 * shot escalates to Kie.ai Seedance 2.0 Mini — the only registered provider
 * with native multimodal-reference support (reference-image capability for
 * identity/wardrobe anchoring).
 *
 * Mode constraints are honored on every fallback request, never inferred
 * silently: the route maps the shot's keyframe/reference strategy onto the
 * single Seedance mode the inputs imply and REJECTS impossible combinations
 * (spec §26.3: the first/last-frame fields can never be combined with
 * reference inputs; a last frame without a first frame is not a mode).
 * Composition is delegated to the merged KIE-003 adapter
 * (`validateSeedanceRequest` + `buildSeedanceRequest`), so every numeric limit
 * encoded there (prompt 3–20000, references 9/3/3, duration 4–15, 480p/720p)
 * is enforced unchanged; this module owns ONLY the escalation decision, mode
 * mapping, and refusal to resubmit a request whose constraints cannot hold.
 *
 * Pure module — no I/O. The caller submits the returned request through the
 * Kie task runner (KIE-002) and keeps the provider job ID for resume.
 */

import {
  SEEDANCE_2_MINI_MODEL,
  SEEDANCE_2_MINI_LIMITS,
  validateSeedanceRequest,
  buildSeedanceRequest,
  type SeedanceGenerationMode,
  type SeedanceInput,
  type SeedanceRequest,
} from "@mmcs/providers/kie/seedance/seedance.js";

/** The failure class this route exists for (spec §13: reference/identity problem). */
export const IDENTITY_FAILURE_CLASS = "reference-identity-mismatch" as const;
export type IdentityFailureClass = typeof IDENTITY_FAILURE_CLASS;

/** QC failure classes the Seedance escalation accepts. */
export type PersistingFailureClass =
  | typeof IDENTITY_FAILURE_CLASS
  | "wardrobe-mismatch"
  | "hair-mismatch"
  | "prop-mismatch";

/** QC verdict shape this route consumes (QC-001 schema fields, structural only). */
export interface QcFailure {
  readonly failureClass: string;
  readonly detail?: string;
}

/** Minimal QC result the escalation gate reads. */
export interface QcOutcome {
  readonly status: "PASS" | "FAIL" | "REVIEW";
  readonly failures: readonly QcFailure[];
}

/** The QC-008 escalation stage the shot must have exhausted first. */
export type EscalationStage = "agnes-flash" | "agnes-regular";

/** Full fallback history for one shot, newest last. */
export interface EscalationHistory {
  /** Stages already tried and failed, in escalation order. */
  readonly exhausted: readonly EscalationStage[];
  /** Failure classes observed at each exhausted stage (aligned with `exhausted`). QC failure classes are open-ended; identity-class membership decided by {@link PersistingFailureClass} values. */
  readonly failures: readonly string[];
}

/** Shot inputs the mode mapper consumes (spec §21 reference fields). */
export interface SeedanceFallbackShot {
  readonly shotId: string;
  /** Optional exact start-frame keyframe URL (approved internal asset URL). */
  readonly firstFrameUrl?: string;
  /** Optional exact end-frame keyframe URL — REQUIRES firstFrameUrl. */
  readonly lastFrameUrl?: string;
  /** Approved reference assets for identity/wardrobe/location anchoring. */
  readonly referenceImageUrls?: readonly string[];
  readonly referenceVideoUrls?: readonly string[];
  readonly referenceAudioUrls?: readonly string[];
  /** Compiled shot prompt (must already satisfy Seedance prompt bounds). */
  readonly prompt: string;
  readonly durationSeconds?: number;
  readonly resolution?: "480p" | "720p";
  readonly aspectRatio?: SeedanceInput["aspectRatio"];
}

/** Why the escalation was refused. `constraints-unimplementable` = fail closed. */
export type SeedanceFallbackRefusal =
  | { reason: "escalation-not-earned"; detail: string }
  | { reason: "constraints-unimplementable"; detail: string }
  | { reason: "invalid-request"; detail: string };

/** Success: a fully validated, mode-constrained Seedance createTask request. */
export interface SeedanceFallbackRequest {
  readonly provider: "kie";
  readonly model: string;
  readonly mode: SeedanceGenerationMode;
  /** Exact Kie createTask body (KIE-003 adapter output). */
  readonly request: SeedanceRequest;
  /** Reference inputs carried onto the fallback, for provenance/manifest. */
  readonly referencesUsed: readonly string[];
}

/** One of: a validated fallback request, or a typed refusal. */
export type SeedanceFallbackResult =
  | { ok: true; value: SeedanceFallbackRequest }
  | { ok: false; refusal: SeedanceFallbackRefusal };

/** True when the failure class observed at the LATEST exhausted stage is the reference/identity class — the problem persisted through escalation. */
function hasIdentityClassFailure(failures: readonly string[]): boolean {
  const latest = failures[failures.length - 1];
  return (
    latest === IDENTITY_FAILURE_CLASS ||
    latest === "wardrobe-mismatch" ||
    latest === "hair-mismatch"
  );
}

/**
 * Should this shot escalate to Seedance? True only when BOTH Agnes stages
 * (flash with its retry, then regular) are exhausted AND the persisting
 * failure is the reference/identity class (spec §13 wording: "reference/
 * identity problem remains"). A cost/timeout failure is NOT this route's
 * trigger — it belongs to the retry policy (QC-006).
 */
export function shouldEscalateToSeedance(
  qc: QcOutcome,
  history: EscalationHistory,
): boolean {
  if (qc.status !== "FAIL") return false;
  const exhausted = new Set(history.exhausted);
  if (!exhausted.has("agnes-flash") || !exhausted.has("agnes-regular")) {
    return false;
  }
  return hasIdentityClassFailure(history.failures);
}

/** Every reference URL the shot carries, in canonical order. */
function collectReferences(shot: SeedanceFallbackShot): string[] {
  const refs: string[] = [];
  if (shot.firstFrameUrl !== undefined) refs.push(shot.firstFrameUrl);
  if (shot.lastFrameUrl !== undefined) refs.push(shot.lastFrameUrl);
  refs.push(...(shot.referenceImageUrls ?? []));
  refs.push(...(shot.referenceVideoUrls ?? []));
  refs.push(...(shot.referenceAudioUrls ?? []));
  return refs;
}

/** Classify the inputs into the single Seedance mode they imply, or null. */
function impliedMode(
  shot: SeedanceFallbackShot,
): SeedanceGenerationMode | null {
  const hasFirst = shot.firstFrameUrl !== undefined;
  const hasLast = shot.lastFrameUrl !== undefined;
  const hasRefs =
    (shot.referenceImageUrls?.length ?? 0) > 0 ||
    (shot.referenceVideoUrls?.length ?? 0) > 0 ||
    (shot.referenceAudioUrls?.length ?? 0) > 0;
  if (hasRefs && (hasFirst || hasLast)) return null; // mutually exclusive groups
  if (hasFirst) {
    return hasLast ? "first-last-frame-i2v" : "first-frame-i2v";
  }
  if (hasLast) return null; // last frame without a first frame is not a mode
  if (hasRefs) return "multimodal-reference";
  return null; // zero-reference: cannot address the identity failure trigger
}

/**
 * Build the Seedance 2.0 Mini fallback request for an escalated shot.
 *
 * The mode constraints are honored by construction: the implied mode is
 * computed from the shot's fields, refused outright when the combination is
 * impossible, and the composed request is re-validated through the KIE-003
 * adapter before being returned — a constraint-violating payload can never
 * leave this function.
 *
 * Zero-reference fallbacks are refused too: this route exists because the
 * reference/identity problem persisted through both Agnes stages, so a
 * text-only request (no identity anchoring at all) cannot address the
 * documented trigger and is not a meaningful fallback.
 */
export function buildSeedanceFallback(
  shot: SeedanceFallbackShot,
): SeedanceFallbackResult {
  const mode = impliedMode(shot);
  if (mode === null || mode === undefined) {
    return {
      ok: false,
      refusal: {
        reason: "constraints-unimplementable",
        detail:
          "shot inputs do not imply a valid single Seedance mode (mutually exclusive mode groups combined, last_frame without first_frame, or no reference inputs at all for an identity-driven fallback); refusing to submit",
      },
    };
  }

  const input: SeedanceInput = {
    prompt: shot.prompt,
    duration: shot.durationSeconds,
    resolution: shot.resolution,
    aspectRatio: shot.aspectRatio,
  };
  if (shot.firstFrameUrl !== undefined) input.firstFrameUrl = shot.firstFrameUrl;
  if (shot.lastFrameUrl !== undefined) input.lastFrameUrl = shot.lastFrameUrl;
  if (shot.referenceImageUrls !== undefined)
    input.referenceImageUrls = shot.referenceImageUrls;
  if (shot.referenceVideoUrls !== undefined)
    input.referenceVideoUrls = shot.referenceVideoUrls;
  if (shot.referenceAudioUrls !== undefined)
    input.referenceAudioUrls = shot.referenceAudioUrls;

  // Validate through the adapter's exact live-schema limits (KIE-003).
  const validation = validateSeedanceRequest(input);
  if (!validation.ok) {
    return {
      ok: false,
      refusal: {
        reason: "invalid-request",
        detail: validation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join("; "),
      },
    };
  }

  return {
    ok: true,
    value: {
      provider: "kie",
      model: SEEDANCE_2_MINI_MODEL,
      mode,
      request: buildSeedanceRequest(input),
      referencesUsed: collectReferences(shot),
    },
  };
}

/**
 * Full route step: QC-gate, then compose the fallback request.
 * Convenience wrapper the video router calls with its accumulated history.
 */
export function routeSeedanceFallback(
  qc: QcOutcome,
  history: EscalationHistory,
  shot: SeedanceFallbackShot,
): SeedanceFallbackResult {
  if (!shouldEscalateToSeedance(qc, history)) {
    return {
      ok: false,
      refusal: {
        reason: "escalation-not-earned",
        detail:
          "Seedance escalation requires FAIL after BOTH agnes-flash and agnes-regular stages on the reference/identity failure class",
      },
    };
  }
  return buildSeedanceFallback(shot);
}

/** Documented duration bounds the caller should clamp against (KIE-003). */
export const SEEDANCE_FALLBACK_DURATION = {
  min: SEEDANCE_2_MINI_LIMITS.durationSeconds.value.min,
  max: SEEDANCE_2_MINI_LIMITS.durationSeconds.value.max,
  default: SEEDANCE_2_MINI_LIMITS.durationDefault.value,
} as const;