/**
 * Runtime observed capability overrides (runbook §24 CAP-010, §61, §22;
 * spec subsystem 2). Records what the runtime actually observed from a
 * provider — runtime-discovered model IDs, limits, refusals — and refines
 * registry profiles with them.
 *
 * Confidence rules (binding):
 * - Every runtime observation lands at PROVISIONAL confidence with provenance
 *   (source, observed date, endpoint, evidence). Runtime data never upgrades
 *   itself to VERIFIED — a human verifies, CAP-009's verify command reports.
 * - A VERIFIED profile value is immutable on ONE transient failure
 *   (network error, 5xx, timeout). A VERIFIED value is only demoted by
 *   `CONFIRMED_FAILURES_THRESHOLD` (default 3) CONSECUTIVE, DISTINCT-DAY
 *   failures of the same failure class — never by a single blip.
 * - UNKNOWN values may be filled by runtime observation (PROVISIONAL);
 *   PROVISIONAL values may be refined by newer observations; VERIFIED never
 *   silently rewritten.
 */

import type { Confidence } from "./confidence.js";

/** What kind of runtime observation this is. */
export const OBSERVATION_KINDS = [
  "modelList", // GET /v1/models style listing — runtime-discovered model IDs
  "limitProbe", // accepted/rejected probe of a limit (context, output, frames)
  "capabilityProbe", // feature accepted/refused (tool calls, params, modes)
  "transientFailure", // network/5xx/timeout — proves nothing about capability
  "definitiveRejection", // provider explicitly rejected a capability (non-transient)
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** How the value was observed. Runtime discovery is never human verification. */
export const OBSERVATION_METHODS = ["runtime", "docs"] as const;
export type ObservationMethod = (typeof OBSERVATION_METHODS)[number];

/**
 * Transient failure classes: these prove the request did not reach a real
 * capability verdict, so they can never demote a VERIFIED value on their own.
 */
export const TRANSIENT_FAILURE_CLASSES = [
  "network",
  "timeout",
  "serverError",
  "rateLimited",
  "authUnavailable",
] as const;
export type TransientFailureClass = (typeof TRANSIENT_FAILURE_CLASSES)[number];

/** One runtime observation about one model's one capability facet. */
export interface RuntimeObservation {
  /** Logical facet observed, e.g. "modelList", "contextWindowTokens", "numFrames". */
  facet: string;
  kind: ObservationKind;
  /** Runtime discovery only — "docs" entries cannot refine VERIFIED values. */
  method: ObservationMethod;
  /** Where the observation came from: endpoint URL or doc URL. */
  sourceUrl: string;
  /** ISO-8601 instant the observation was made. */
  observedAt: string;
  /** What was seen. null = facet probed but indeterminate. */
  observedValue: string | number | boolean | string[] | null;
  /** For limitProbe/definitiveRejection: the exact provider error text. */
  evidence: string | null;
  /** For transientFailure: which class of transient it was. */
  transientClass: TransientFailureClass | null;
}

/**
 * A persisted override derived from runtime observations for one model.
 * Provenance is mandatory; confidence is always PROVISIONAL at creation —
 * runtime never writes VERIFIED.
 */
export interface ObservedOverride {
  provider: string;
  modelId: string;
  facet: string;
  value: string | number | boolean | string[] | null;
  confidence: Extract<Confidence, "PROVISIONAL">;
  sourceUrl: string;
  observedAt: string;
  /** Number of runtime observations backing this value. */
  observationCount: number;
  /** Failure class only when this override records a refusal/rejection. */
  rejectionClass: TransientFailureClass | null;
}

/**
 * Consecutive distinct-day failures required before a VERIFIED value may be
 * demoted. Runbook §61: never silently rewrite VERIFIED capabilities based on
 * one transient failure. Three consecutive distinct-day failures of the same
 * class is a pattern, not a blip.
 */
export const CONFIRMED_FAILURES_THRESHOLD = 3;

/** A failure event against a VERIFIED value, for the demotion ledger. */
export interface VerifiedFailureEvent {
  facet: string;
  failureClass: TransientFailureClass | "definitive";
  /** ISO-8601 instant of the failure. */
  at: string;
}

/** Outcome of attempting to refine one profile facet. */
export type RefineOutcome =
  | { action: "filled"; facet: string; value: string | number | boolean | string[] | null; confidence: "PROVISIONAL" }
  | { action: "refined"; facet: string; value: string | number | boolean | string[] | null; confidence: "PROVISIONAL" }
  | { action: "keptVerified"; facet: string; reason: "verified-immutable-on-transient" | "verified-matches-observation" | "single-transient-failure" }
  | { action: "demoted"; facet: string; reason: "confirmed-failures-exceed-threshold" }
  | { action: "ignored"; facet: string; reason: "stale-observation" | "no-change" };

/** Max age (ms) of an observation before it is considered stale. */
export const OBSERVATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isTransientFailure(obs: RuntimeObservation): boolean {
  return obs.kind === "transientFailure" && obs.transientClass !== null;
}

/** Parse an ISO-8601 timestamp safely; returns Number.NaN when malformed. */
function parseIso(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * Decide what a runtime observation does to an existing profile facet value.
 *
 * - Existing value VERIFIED: immutable on one transient failure. Demoted only
 *   when `verifiedFailures` (consecutive, same failureClass, distinct days)
 *   reaches CONFIRMED_FAILURES_THRESHOLD — or a `definitiveRejection`
 *   observation directly contradicts it.
 * - Existing value PROVISIONAL or UNKNOWN: filled/refined by any fresh,
 *   runtime-method observation carrying a non-null value.
 */
export function refineFacet(
  current: { value: string | number | boolean | string[] | null; confidence: Confidence } | null,
  observation: RuntimeObservation,
  nowMs: number = Date.now(),
): RefineOutcome {
  const observedAtMs = parseIso(observation.observedAt);
  if (Number.isNaN(observedAtMs) || nowMs - observedAtMs > OBSERVATION_MAX_AGE_MS) {
    return { action: "ignored", facet: observation.facet, reason: "stale-observation" };
  }

  // Transient failures carry no capability information at all.
  if (isTransientFailure(observation)) {
    if (current?.confidence === "VERIFIED") {
      return { action: "keptVerified", facet: observation.facet, reason: "single-transient-failure" };
    }
    return { action: "ignored", facet: observation.facet, reason: "no-change" };
  }

  if (observation.observedValue === null && observation.kind !== "definitiveRejection") {
    return { action: "ignored", facet: observation.facet, reason: "no-change" };
  }

  if (current?.confidence === "VERIFIED") {
    const same = valuesEqual(current.value, observation.observedValue);
    if (same) {
      return { action: "keptVerified", facet: observation.facet, reason: "verified-matches-observation" };
    }
    // Contradiction: handled by the caller through recordVerifiedFailure —
    // one runtime contradiction never rewrites a VERIFIED value inline.
    return { action: "keptVerified", facet: observation.facet, reason: "verified-immutable-on-transient" };
  }

  if (
    current !== null &&
    current.confidence === "PROVISIONAL" &&
    valuesEqual(current.value, observation.observedValue)
  ) {
    return { action: "ignored", facet: observation.facet, reason: "no-change" };
  }

  if (current === null || current.confidence === "UNKNOWN") {
    return {
      action: "filled",
      facet: observation.facet,
      value: observation.observedValue,
      confidence: "PROVISIONAL",
    };
  }
  return {
    action: "refined",
    facet: observation.facet,
    value: observation.observedValue,
    confidence: "PROVISIONAL",
  };
}

/** Structural equality for capability values (order-sensitive for arrays). */
function valuesEqual(
  a: string | number | boolean | string[] | null,
  b: string | number | boolean | string[] | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

/**
 * Record a failure against a VERIFIED facet and decide whether the threshold
 * for demotion is met. Demotion requires CONFIRMED_FAILURES_THRESHOLD
 * consecutive failures of the SAME failureClass on DISTINCT calendar days —
 * one transient failure (the runbook §61 rule) can never pass this gate.
 * The caller applies the demotion itself; this function only decides.
 */
export function recordVerifiedFailure(
  events: VerifiedFailureEvent[],
  event: VerifiedFailureEvent,
): { demote: boolean; consecutiveSameClass: number; distinctDays: number } {
  const all = [...events, event];
  const lastClass = event.failureClass;
  let consecutive = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const entry = all[i];
    if (entry === undefined || entry.failureClass !== lastClass) break;
    consecutive += 1;
  }
  const sameClassTail = all.slice(all.length - consecutive);
  const distinctDays = new Set(
    sameClassTail.map((e) => {
      const ms = parseIso(e.at);
      return Number.isNaN(ms) ? e.at : new Date(ms).toISOString().slice(0, 10);
    }),
  ).size;
  return {
    demote: consecutive >= CONFIRMED_FAILURES_THRESHOLD && distinctDays >= CONFIRMED_FAILURES_THRESHOLD,
    consecutiveSameClass: consecutive,
    distinctDays,
  };
}

/**
 * Build an override record from a runtime observation. Runtime overrides are
 * always PROVISIONAL — never VERIFIED, never guessed up from absence.
 */
export function toObservedOverride(
  provider: string,
  modelId: string,
  observation: RuntimeObservation,
): ObservedOverride | null {
  if (isTransientFailure(observation)) return null;
  if (observation.observedValue === null && observation.kind !== "definitiveRejection") return null;
  const observedAtMs = parseIso(observation.observedAt);
  if (Number.isNaN(observedAtMs) || Date.now() - observedAtMs > OBSERVATION_MAX_AGE_MS) return null;
  return {
    provider,
    modelId,
    facet: observation.facet,
    value: observation.observedValue,
    confidence: "PROVISIONAL",
    sourceUrl: observation.sourceUrl,
    observedAt: observation.observedAt,
    observationCount: 1,
    rejectionClass:
      observation.kind === "definitiveRejection"
        ? (observation.transientClass ?? null)
        : null,
  };
}

/**
 * Merge an override into an existing override list: same provider+model+facet
 * bumps observationCount and refreshes observedAt; a different value replaces
 * it (newer runtime observation wins; still PROVISIONAL). Returns a new array;
 * never mutates the input.
 */
export function mergeOverride(
  existing: ObservedOverride[],
  override: ObservedOverride,
): ObservedOverride[] {
  const idx = existing.findIndex(
    (o) =>
      o.provider === override.provider &&
      o.modelId === override.modelId &&
      o.facet === override.facet,
  );
  if (idx === -1) return [...existing, override];
  const prior = existing[idx];
  if (prior === undefined) return [...existing, override];
  const sameValue = valuesEqual(prior.value, override.value);
  const next: ObservedOverride = sameValue
    ? { ...override, observationCount: prior.observationCount + 1 }
    : { ...override, observationCount: 1 };
  return [...existing.slice(0, idx), next, ...existing.slice(idx + 1)];
}