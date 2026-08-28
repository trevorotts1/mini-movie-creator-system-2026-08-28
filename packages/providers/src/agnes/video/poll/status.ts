/**
 * AGN-005 — Agnes video poll status mapping.
 *
 * Folds Agnes' raw retrieval strings into the normalized status union and
 * maps a raw task-info payload onto the spec §18 pipeline machine. Agnes'
 * documented status enum (verified 2026-08-28 against the Agnes Video 2.5 /
 * 2.5 Flash docs): `queued`, `in_progress`, `completed`, `failed`. Unknown
 * values map to "waiting" (still in flight) — an unknown provider string must
 * never be read as success or failure.
 */

import type {
  AgnesTaskStatus,
  AgnesVideoFailure,
  AgnesVideoTaskInfo,
  AgnesPipelineState,
} from "./types.js";

/** Fold a raw Agnes status string into the normalized status union. */
export function normalizeAgnesStatus(raw: string): AgnesTaskStatus {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "completed":
    case "success":
    case "succeeded":
      return "success";
    case "failed":
    case "fail":
    case "error":
      return "failed";
    case "in_progress":
    case "generating":
    case "running":
      return "running";
    case "queued":
    case "waiting":
    case "pending":
    case "submitted":
    case "queuing":
      return "waiting";
    default:
      // Unknown → in-flight; never guess a terminal state.
      return "waiting";
  }
}

/** Extract the temporary output URL from `metadata` (verified field name). */
export function parseAgnesResultUrl(info: AgnesVideoTaskInfo): string | undefined {
  const metadata = info.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const url = metadata["url"];
  return typeof url === "string" && isHttpUrl(url) ? url : undefined;
}

/**
 * Map a raw task-info payload onto the spec §18 pipeline machine.
 *
 * - completed + metadata.url → GENERATED_TEMPORARY (URL is temporary; the
 *   archival layer archives it per spec §17 before it is canonical) +
 *   expiration captured ONLY when the provider returns one (never invented).
 * - completed without URL → REJECTED (cannot archive nothing; surface as
 *   failure).
 * - failed → REJECTED with failure detail.
 * - queued/in_progress/unknown → GENERATING (still in flight).
 */
export function mapAgnesToPipelineState(info: AgnesVideoTaskInfo): {
  state: AgnesPipelineState;
  resultUrl?: string;
  urlExpiration?: string | null;
  failure?: AgnesVideoFailure;
} {
  const status = normalizeAgnesStatus(info.status);
  if (status === "success") {
    const url = parseAgnesResultUrl(info);
    if (url) {
      return {
        state: "GENERATED_TEMPORARY",
        resultUrl: url,
        urlExpiration: extractUrlExpiration(info),
      };
    }
    return {
      state: "REJECTED",
      failure: {
        message: "Agnes task reported completed but returned no result URL",
        raw: info.metadata ?? info,
      },
    };
  }
  if (status === "failed") {
    const message = info.error?.message ?? "Agnes task failed";
    return {
      state: "REJECTED",
      failure: {
        message,
        code: info.error?.code,
        raw: info,
      },
    };
  }
  return { state: "GENERATING" };
}

/**
 * Capture a provider-declared URL expiration when and only when the provider
 * actually returns one. Agnes documents no expiration field on any page, so
 * every documented shape yields `undefined`; future provider-added fields
 * (`expires_at`, `url_expiration`, `metadata.expires_at`, …) are captured,
 * never invented. Epoch seconds are converted to ISO-8601; ISO strings pass
 * through as-is.
 */
export function extractUrlExpiration(info: AgnesVideoTaskInfo): string | null | undefined {
  const candidates = [
    info.urlExpiration,
    info.expiresAt,
    metadataField(info, "expires_at"),
    metadataField(info, "expiration"),
    metadataField(info, "expire_at"),
  ];
  for (const candidate of candidates) {
    // 0 / negative numbers are sentinel "no expiration" values, not real
    // timestamps: converting them would persist "1970-01-01…" as a genuine
    // (already-expired) expiration the archival layer could act on. Absent
    // beats corrupt — fall through to the next candidate.
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return new Date(candidate * 1000).toISOString();
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return undefined;
}

function metadataField(info: AgnesVideoTaskInfo, key: string): unknown {
  if (!info.metadata || typeof info.metadata !== "object") return undefined;
  return info.metadata[key];
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
