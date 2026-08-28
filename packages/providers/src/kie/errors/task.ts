/**
 * KIE-009 — normalize a Kie task-info failure payload (state=fail / failMsg /
 * failCode) into the unified taxonomy.
 *
 * KIE-002 preserves the raw provider payload on a REJECTED record specifically
 * so this module can normalize it after the fact. Task-level failures are
 * terminal generation outcomes: they are FATAL for that attempt's request
 * bytes (the model refused the payload), but a caller may legitimately retry
 * with CHANGED inputs — hence {@link NormalizedKieFailure.retryable} stays
 * false while a distinct `changeInputs` hint distinguishes "give up" from
 * "fix the prompt and resubmit as a new job".
 */
import type { NormalizedKieFailure } from "./taxonomy.js";
import { redactDeep, redactSecrets } from "./redact.js";

/** Minimal structural subset of a raw Kie task-info payload. */
export interface KieTaskFailurePayload {
  /** Raw provider status string, e.g. "fail" / "failed" / "error". */
  state?: string;
  /** Provider failure message. */
  failMsg?: string;
  /** Provider failure code. */
  failCode?: number;
  /** Full raw payload; only redacted diagnostics are kept from it. */
  result?: unknown;
  [key: string]: unknown;
}

/**
 * True when the provider's failure message/code indicates a quota/billing
 * problem rather than a payload problem. Quota-shaped task failures fold to
 * the `quota` classification so the budget engine can react.
 */
export function isQuotaShapedTaskFailure(payload: KieTaskFailurePayload): boolean {
  const haystack = `${payload.failMsg ?? ""} ${extractDeepText(payload.result)}`.toLowerCase();
  if (typeof payload.failCode === "number" && (payload.failCode === 402 || payload.failCode === 429)) {
    return true;
  }
  return /balance|insufficient funds|quota exceeded|quota exhausted|rate limit|billing|credit(?:s)? exhausted|out of credit/.test(
    haystack,
  );
}

/**
 * Task-info failure payload → taxonomy entry. Never throws: an unparseable
 * payload still normalizes (to an unknown fatal with redacted diagnostics).
 */
export function classifyKieTaskFailure(
  payload: KieTaskFailurePayload,
  opts: { attempt?: number } = {},
): NormalizedKieFailure {
  const rawMsg = payload.failMsg !== undefined && payload.failMsg !== null ? String(payload.failMsg) : "";
  const message = rawMsg.trim() !== "" ? redactSecrets(rawMsg.trim()) : "Kie task failed without a failure message";
  const detail = {
    failCode: typeof payload.failCode === "number" ? payload.failCode : undefined,
    state: typeof payload.state === "string" ? payload.state : undefined,
    // Raw payload redacted, depth-capped: diagnostics without leakage.
    raw: redactDeep(payload.result ?? payload),
  };

  if (isQuotaShapedTaskFailure(payload)) {
    return {
      classification: "quota",
      retryable: false,
      code: "kie:task_quota",
      message: `Kie task failed on quota/billing: ${message}`,
      source: "task",
      attempt: opts.attempt,
      detail,
    };
  }

  return {
    classification: "fatal",
    // Terminal for THIS request; a changed-input resubmit is a new job, not a retry.
    retryable: false,
    code: "kie:task_failed",
    message: `Kie task failed: ${message}`,
    source: "task",
    attempt: opts.attempt,
    detail,
  };
}

/** Collect all string leaves of a value (for quota-shape sniffing). */
function extractDeepText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => extractDeepText(entry, depth + 1)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((entry) => extractDeepText(entry, depth + 1))
      .join(" ");
  }
  return "";
}