/// <reference types="node" />
/**
 * Provider temporary URL emergency archival (MMCS task GHL-012).
 *
 * Spec §17 step 3 + §18 (runbook §14.3/§23): "Restart at GENERATED_TEMPORARY
 * → archive the known provider URL immediately if valid — never regenerate
 * because an agent forgot; the URL/task ID lives in SQLite/state."
 *
 * This module is the resume path a restarted process takes when the durable
 * provider-job record already sits at GENERATED_TEMPORARY (or ARCHIVING —
 * the process died mid-archival). It takes the persisted provider URL and
 * drives it straight into hosted ingest (the GHL-005 flow; injected as a
 * port because GHL-005/GHL-006 own their own modules and this task owns the
 * orchestration seam). It has NO ability to submit, poll, or generate:
 * regeneration is structurally absent from this surface. The two possible
 * outcomes are:
 *
 * - `ARCHIVED` — the hosted ingest reported a verified GHL fileId + storage
 *   URL. Safe to advance the state machine (ARCHIVING → ARCHIVED).
 * - `BLOCKED` — the known URL was missing, invalid, known-expired, or
 *   unreachable, or the hosted ingest failed. The outcome carries the
 *   machine-readable reason, the preserved provider task/job ID + URL, and
 *   a documented next action. The caller persists the BLOCKED state with
 *   the reason (spec §18: never regenerate merely because archival failed;
 *   runbook §14.4: URL expiration must never destroy the only copy of a
 *   paid asset). Silent regeneration is impossible: no code path here
 *   produces a generation request, and every non-archived path returns
 *   BLOCKED with the provider task ID attached.
 *
 * Deliberate design decisions:
 * - A blocked archival is a RETURNED OUTCOME, not a thrown error. An
 *   exception invites a catch-block that "recovers" by regenerating; an
 *   explicit BLOCKED union member forces the caller to persist the state.
 * - Throwing is reserved for programming errors: a malformed record, or a
 *   call from a state this layer does not own (e.g. SUBMITTED belongs to
 *   the poll runner, ARCHIVED needs no archival).
 * - No retry loop here: bounded retry + the lost-success ledger are
 *   GHL-011's concern and wrap the injected archive port. This module makes
 *   at most ONE archival attempt per call — "immediately, if valid".
 * - The expiration check is clock-injectable. A known-expired URL is
 *   BLOCKED without any network attempt; an unparseable/absent expiration
 *   is treated as unknown and decided by the reachability probe alone.
 */

/** Pipeline states this module may resume archival from (spec §18 machine). */
export type EmergencyResumableState = "GENERATED_TEMPORARY" | "ARCHIVING";

/** Durable provider-job record as persisted by the KIE/Agnes layers. */
export interface EmergencyArchivalRecord {
  /**
   * Current pipeline state. Only {@link EmergencyResumableState} values
   * proceed; anything else throws INVALID_ENTRY_STATE (wrong layer, or the
   * asset is already safely archived — never re-archive, never regenerate).
   */
  state: string;
  /**
   * Provider task/job ID — persisted BEFORE polling (spec §18). Required:
   * an emergency resume without it could not be proven non-duplicate.
   */
  providerTaskId: string;
  /**
   * Temporary provider URL persisted the moment the job hit
   * GENERATED_TEMPORARY. Absent/blank → BLOCKED (never regenerate).
   */
  providerUrl?: string | null;
  /**
   * Provider-disclosed expiration as ISO-8601, when disclosed. Unparseable
   * values are ignored (treated as unknown) rather than trusted either way.
   */
  providerUrlExpiresAt?: string | null;
  /** Deterministic canonical filename (spec §19). Required. */
  name: string;
  /** Destination GHL folder ID (episode/character folder). Required. */
  parentId: string;
  /** GHL location (sub-account) ID, passed through when supplied. */
  altId?: string;
}

/** Request handed to the injected hosted-ingest port (GHL-005 shape). */
export interface EmergencyHostedArchiveRequest {
  fileUrl: string;
  name: string;
  parentId: string;
  altId?: string;
}

/**
 * Hosted-ingest port. Adapter binds the GHL-005 transport, e.g.
 * `(request) => archiveHostedUrl(http, request)`. Implementations must
 * verify the returned GHL URL is reachable before reporting ARCHIVED
 * (spec §17 step 3) and throw on anything short of that.
 */
export type EmergencyArchiveHosted = (
  request: EmergencyHostedArchiveRequest,
) => Promise<EmergencyHostedArchiveResult>;

/** Successful, reachability-verified hosted archival (GHL-005 result shape). */
export interface EmergencyHostedArchiveResult {
  status: "ARCHIVED";
  fileId: string;
  url: string;
  name: string;
  raw?: unknown;
}

/** Minimal structural response the URL probe needs (fetch-compatible). */
export interface EmergencyUrlProbeResponse {
  ok: boolean;
  status: number;
}

/** Reachability probe port — same shape as GHL-005's UrlProbe. */
export type EmergencyUrlProbe = (
  url: string,
  init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
) => Promise<EmergencyUrlProbeResponse>;

/** Machine-readable reasons an archival resume ends BLOCKED. */
export type EmergencyBlockReason =
  | "MISSING_PROVIDER_URL"
  | "URL_INVALID"
  | "EXPIRED_URL"
  | "URL_UNREACHABLE"
  | "HOSTED_INGEST_FAILED";

/** All block reasons, in canonical order. */
export const EMERGENCY_BLOCK_REASONS: readonly EmergencyBlockReason[] = [
  "MISSING_PROVIDER_URL",
  "URL_INVALID",
  "EXPIRED_URL",
  "URL_UNREACHABLE",
  "HOSTED_INGEST_FAILED",
];

/** Documented next action per block reason — persisted with the record. */
export const EMERGENCY_BLOCK_NEXT_ACTIONS: Readonly<
  Record<EmergencyBlockReason, string>
> = {
  MISSING_PROVIDER_URL:
    "No provider URL was persisted at GENERATED_TEMPORARY. Keep the provider task/job ID and record persisted; escalate for manual recovery. Never regenerate automatically.",
  URL_INVALID:
    "The persisted provider URL is not a usable http(s) URL. Keep the provider task/job ID and record persisted; escalate for manual recovery. Never regenerate automatically.",
  EXPIRED_URL:
    "The provider URL expired before archival completed. Keep the provider task/job ID persisted; escalate for manual recovery (provider-side re-fetch only if the provider supports it). Never regenerate automatically.",
  URL_UNREACHABLE:
    "The provider URL did not answer 2xx at resume. It may be transiently down or already expired; keep the record persisted and re-run this resume later, or escalate. Never regenerate automatically.",
  HOSTED_INGEST_FAILED:
    "The provider URL was reachable but GHL hosted ingest failed. Run the binary fallback upload (GHL-006) while the URL is still valid, or escalate. Never regenerate automatically.",
};

/** The documented BLOCKED outcome — persisted, never silently recovered. */
export interface EmergencyBlockedOutcome {
  status: "BLOCKED";
  /** Machine-readable reason; persist alongside the asset record. */
  reason: EmergencyBlockReason;
  /** Preserved provider task/job ID — never regenerate on this. */
  providerTaskId: string;
  /** The persisted provider URL (when one existed), for manual recovery. */
  providerUrl?: string;
  /** ISO-8601 UTC instant the block was recorded. */
  blockedAt: string;
  /** Documented next action (see EMERGENCY_BLOCK_NEXT_ACTIONS). */
  nextAction: string;
  /** Extra diagnostics: probe status, underlying error message, etc. */
  detail?: string;
}

/** The documented success outcome — safe to advance ARCHIVING → ARCHIVED. */
export interface EmergencyArchivedOutcome {
  status: "ARCHIVED";
  fileId: string;
  /** Verified GHL storage URL. */
  url: string;
  name: string;
  raw?: unknown;
}

export type EmergencyArchivalOutcome =
  | EmergencyArchivedOutcome
  | EmergencyBlockedOutcome;

/** Error thrown only for caller/programming mistakes (never for blocks). */
export class EmergencyArchivalError extends Error {
  readonly code: "INVALID_RECORD" | "INVALID_ENTRY_STATE";
  readonly detail?: string;

  constructor(
    code: "INVALID_RECORD" | "INVALID_ENTRY_STATE",
    message: string,
    detail?: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "EmergencyArchivalError";
    this.code = code;
    this.detail = detail;
  }
}

export interface EmergencyArchivalOptions {
  /** Injectable clock (ms epoch); defaults to Date.now. */
  now?: () => number;
  /** Reachability probe override (tests inject a fake; default is fetch). */
  probe?: EmergencyUrlProbe;
  /** Probe method: HEAD by default; GET for CDNs that reject HEAD. */
  probeMethod?: "HEAD" | "GET";
  /** Probe timeout in milliseconds. Defaults to 10000. */
  probeTimeoutMs?: number;
}

const RESUMABLE_STATES: ReadonlySet<string> = new Set([
  "GENERATED_TEMPORARY",
  "ARCHIVING",
]);

function defaultProbe(
  url: string,
  init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
): Promise<EmergencyUrlProbeResponse> {
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== "function") {
    return Promise.resolve({ ok: false, status: 0 });
  }
  return fetchImpl(url, {
    method: init?.method,
    signal: init?.signal,
  }) as unknown as Promise<EmergencyUrlProbeResponse>;
}

/**
 * Is the record's disclosed expiration in the past? Returns:
 * - `true`  — parseable timestamp at/before `now` (known expired);
 * - `false` — parseable timestamp in the future (known valid horizon);
 * - `null`  — absent or unparseable (unknown; the probe decides).
 * Pure — same inputs, same answer; never throws.
 */
export function isProviderUrlExpired(
  expiresAt: string | null | undefined,
  now: number,
): boolean | null {
  if (expiresAt === undefined || expiresAt === null || expiresAt === "") {
    return null;
  }
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return null;
  return parsed <= now;
}

/** Scheme allowlist for provider URLs, matching the GHL-005 hosted ingest. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

function validateRecord(record: EmergencyArchivalRecord): void {
  if (!record || typeof record !== "object") {
    throw new EmergencyArchivalError("INVALID_RECORD", "record is required");
  }
  if (
    typeof record.providerTaskId !== "string" ||
    record.providerTaskId.trim() === ""
  ) {
    throw new EmergencyArchivalError(
      "INVALID_RECORD",
      "providerTaskId is required — persist it before polling (spec §18)",
    );
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new EmergencyArchivalError(
      "INVALID_RECORD",
      "canonical name is required (spec §19)",
    );
  }
  if (typeof record.parentId !== "string" || record.parentId.trim() === "") {
    throw new EmergencyArchivalError(
      "INVALID_RECORD",
      "parentId (destination GHL folder) is required",
    );
  }
  if (
    record.providerUrl !== undefined &&
    record.providerUrl !== null &&
    typeof record.providerUrl !== "string"
  ) {
    throw new EmergencyArchivalError(
      "INVALID_RECORD",
      "providerUrl must be a string when present",
    );
  }
}

function blocked(
  reason: EmergencyBlockReason,
  record: EmergencyArchivalRecord,
  now: number,
  detail?: string,
): EmergencyBlockedOutcome {
  const outcome: EmergencyBlockedOutcome = {
    status: "BLOCKED",
    reason,
    providerTaskId: record.providerTaskId,
    blockedAt: new Date(now).toISOString(),
    nextAction: EMERGENCY_BLOCK_NEXT_ACTIONS[reason],
  };
  if (typeof record.providerUrl === "string" && record.providerUrl !== "") {
    outcome.providerUrl = record.providerUrl;
  }
  if (detail !== undefined) outcome.detail = detail;
  return outcome;
}

/**
 * Emergency resume of archival for a provider job already at
 * GENERATED_TEMPORARY / ARCHIVING. Exactly one attempt:
 *
 * 1. gate the entry state (wrong state → throw, never act);
 * 2. no persisted URL → BLOCKED MISSING_PROVIDER_URL (never regenerate);
 * 3. URL not usable http(s) → BLOCKED URL_INVALID (no network);
 * 4. known-expired (parseable expiresAt ≤ now) → BLOCKED EXPIRED_URL (no
 *    network — a dead URL gets no request);
 * 5. probe unreachable → BLOCKED URL_UNREACHABLE (probe status preserved);
 * 6. probe reachable → hand the EXACT persisted URL to the injected hosted
 *    ingest (GHL-005 adapter) → ARCHIVED, or BLOCKED HOSTED_INGEST_FAILED
 *    with the ingest error carried in `detail`.
 *
 * Never resubmits, never polls, never generates: the module holds no
 * generation capability at all. At most one archival attempt per call —
 * retry/idempotency layering is GHL-011's contract around the injected port.
 */
export async function resumeEmergencyArchival(
  record: EmergencyArchivalRecord,
  archiveHosted: EmergencyArchiveHosted,
  options: EmergencyArchivalOptions = {},
): Promise<EmergencyArchivalOutcome> {
  validateRecord(record);

  if (!RESUMABLE_STATES.has(record.state)) {
    throw new EmergencyArchivalError(
      "INVALID_ENTRY_STATE",
      `emergency archival resumes only from GENERATED_TEMPORARY or ARCHIVING, got ${record.state}` +
        (record.state === "ARCHIVED"
          ? " — already archived, do not re-archive"
          : record.state === "SUBMITTED" || record.state === "GENERATING"
            ? " — resume polling instead (never resubmit)"
            : ""),
      record.state,
    );
  }

  const now = options.now ?? Date.now;
  const nowMs = now();

  const providerUrl = record.providerUrl;
  if (
    providerUrl === undefined ||
    providerUrl === null ||
    providerUrl.trim() === ""
  ) {
    return blocked("MISSING_PROVIDER_URL", record, nowMs);
  }

  let parsed: URL;
  try {
    parsed = new URL(providerUrl);
  } catch {
    return blocked("URL_INVALID", record, nowMs, "URL is unparseable");
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return blocked(
      "URL_INVALID",
      record,
      nowMs,
      `scheme must be http/https, got ${parsed.protocol}`,
    );
  }

  const expired = isProviderUrlExpired(record.providerUrlExpiresAt, nowMs);
  if (expired === true) {
    return blocked(
      "EXPIRED_URL",
      record,
      nowMs,
      `expiredAt ${record.providerUrlExpiresAt} <= now`,
    );
  }

  const probe = options.probe ?? defaultProbe;
  let reachable = false;
  let probeStatus: number | undefined;
  try {
    const response = await probe(providerUrl, {
      method: options.probeMethod ?? "HEAD",
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? 10000),
    });
    probeStatus = response.status;
    reachable = response.ok && response.status >= 200 && response.status < 300;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    return blocked(
      "URL_UNREACHABLE",
      record,
      nowMs,
      probeStatus === undefined
        ? "probe failed (network error/timeout)"
        : `probe status ${probeStatus}`,
    );
  }

  try {
    const result = await archiveHosted({
      fileUrl: providerUrl,
      name: record.name,
      parentId: record.parentId,
      ...(record.altId !== undefined ? { altId: record.altId } : {}),
    });
    if (!result || result.status !== "ARCHIVED") {
      return blocked(
        "HOSTED_INGEST_FAILED",
        record,
        nowMs,
        "hosted ingest returned a non-ARCHIVED result",
      );
    }
    return {
      status: "ARCHIVED",
      fileId: result.fileId,
      url: result.url,
      name: result.name,
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return blocked("HOSTED_INGEST_FAILED", record, nowMs, reason);
  }
}