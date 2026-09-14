/// <reference types="node" />
/**
 * GHL tenant (sub-account) scoping — SKR-011.
 *
 * WHY THIS EXISTS: GHL auth here is one global credential pair
 * (`GHL_ACCESS_TOKEN` + `GHL_LOCATION_ID`, see `auth.ts`) while every media
 * call takes a caller-supplied `locationId`/`altId`. Persisted GHL linkage
 * carried no record of the sub-account that owns it (`assets` had
 * `ghl_file_id` / `ghl_folder_id` / `ghl_url` only), so re-pointing the
 * environment variable silently redirected one client's media into another
 * client's sub-account, and a caller could pass *any* location id on any
 * write. A GHL location is the tenant boundary: a mismatch is a client-data
 * leak, never a recoverable condition.
 *
 * The rule is deliberately fail-closed and I/O-free:
 *  - a location id a write depends on must be a non-empty string;
 *  - a *stored* location id is authoritative — writing the same record under
 *    a different location throws instead of silently retargeting it.
 *
 * `EpisodeFolderEnsurer` used to hold the only instance of this check
 * (episode_folders.location_id); it now calls `assertStoredLocationMatches`
 * as well, so every persisted GHL linkage shares one rule.
 */

/** Machine-readable code carried by {@link GhlLocationMismatchError}. */
export const GHL_LOCATION_MISMATCH_CODE = "GHL_LOCATION_MISMATCH" as const;

/**
 * Thrown when a write would move already-persisted GHL linkage to a different
 * sub-account (or when a caller supplies a location the store is not bound to).
 */
export class GhlLocationMismatchError extends Error {
  readonly code = GHL_LOCATION_MISMATCH_CODE;
  /** The location the record was persisted under (authoritative). */
  readonly storedLocationId: string;
  /** The location the caller asked for. */
  readonly requestedLocationId: string;

  constructor(subject: string, storedLocationId: string, requestedLocationId: string, action: string) {
    super(
      `${subject} is persisted for GHL location "${storedLocationId}"; ` +
        `refusing ${action} under "${requestedLocationId}" — a GHL location is a tenant boundary`,
    );
    this.name = "GhlLocationMismatchError";
    this.storedLocationId = storedLocationId;
    this.requestedLocationId = requestedLocationId;
  }
}

/** Thrown when a write that must be tenant-scoped has no location id at all. */
export class MissingGhlLocationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`${field}: a GHL location id is required to scope this write to one sub-account`);
    this.name = "MissingGhlLocationError";
    this.field = field;
  }
}

/**
 * Trim and validate a location id that a write depends on. An absent/blank
 * value is fatal: defaulting to "whichever tenant the environment points at"
 * is exactly the failure this module exists to prevent.
 */
export function requireLocationId(value: string | undefined, field = "locationId"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MissingGhlLocationError(field);
  }
  return value.trim();
}

export interface StoredLocationCheck {
  /** Location the record was persisted under; undefined when never recorded. */
  readonly storedLocationId?: string | undefined;
  /** Location the caller supplied for this write; undefined when omitted. */
  readonly requestedLocationId?: string | undefined;
  /** What is being guarded, e.g. `asset "mmcs_asset_1"`. */
  readonly subject: string;
  /** Verb for the message; defaults to "re-ensure". */
  readonly action?: string;
}

/**
 * Fail-closed tenant check shared by every persisted GHL record.
 *
 * Returns the location id the write may proceed under (requested when
 * supplied, otherwise the stored one; undefined when neither is known), or
 * throws {@link GhlLocationMismatchError} when the two disagree.
 */
export function assertStoredLocationMatches(check: StoredLocationCheck): string | undefined {
  const stored = normalise(check.storedLocationId);
  const requested = normalise(check.requestedLocationId);
  if (stored !== undefined && requested !== undefined && stored !== requested) {
    throw new GhlLocationMismatchError(
      check.subject,
      stored,
      requested,
      check.action ?? "re-ensure",
    );
  }
  return requested ?? stored;
}

function normalise(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
