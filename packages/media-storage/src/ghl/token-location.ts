/**
 * Verify that a GHL token can actually ACCESS the location it claims.
 *
 * Why this exists: the tenant guards elsewhere in this package compare
 * locationId STRINGS — a stored location against a requested one. That catches
 * a re-pointed GHL_LOCATION_ID, but it cannot catch the case where the token
 * and the configured location simply do not belong together. A location-scoped
 * token for sub-account A, paired with GHL_LOCATION_ID=B, passes every string
 * check and then writes into B (or fails opaquely on the first real call). An
 * agency-scoped token is worse: it can address ANY sub-account, so the string
 * guard is the only thing standing between two clients.
 *
 * This module closes that gap by asking GHL. It runs in EACH deployment, using
 * THAT deployment's own token and location — it has no notion of any shared or
 * default account, and nothing here reads a global credential. Multi-tenant
 * deployments therefore verify per tenant, which is the point.
 *
 * Deliberately dependency-injected: no HTTP client, no env access and no
 * globals. The caller supplies the base URL, the already-built auth headers and
 * a fetch implementation, so this is testable without credentials and reusable
 * against whichever transport the deployment uses.
 */

/** Minimal response shape this module needs — satisfied by global fetch(). */
export interface TokenLocationResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** Minimal fetch shape this module needs. */
export type TokenLocationFetch = (
  url: string,
  init: { readonly method: "GET"; readonly headers: Record<string, string> },
) => Promise<TokenLocationResponse>;

/** GHL endpoint for one location (v2). */
export const GHL_LOCATION_PATH = "/locations";

export interface VerifyTokenLocationOptions {
  /** API base, e.g. https://services.leadconnectorhq.com */
  readonly baseUrl: string;
  /** The sub-account this deployment is configured for. */
  readonly locationId: string;
  /** Already-built auth headers (Bearer + Version) for THIS deployment's token. */
  readonly headers: Record<string, string>;
  readonly fetchImpl: TokenLocationFetch;
  /** Optional timeout; omitted means the fetch implementation decides. */
  readonly timeoutMs?: number;
}

export interface VerifiedTokenLocation {
  readonly locationId: string;
  /** Location name when GHL returns one — useful in a startup log line. */
  readonly name?: string;
}

/**
 * Raised when the configured token cannot access the configured location. The
 * message names both, because the fix is always a configuration change and the
 * operator needs to know WHICH two things disagree.
 */
export class GhlTokenLocationMismatchError extends Error {
  readonly locationId: string;
  readonly status: number;
  constructor(locationId: string, status: number, detail: string) {
    super(
      `the configured GHL token cannot access location ${locationId} (HTTP ${status})${detail}` +
        "; this deployment's GHL_ACCESS_TOKEN and GHL_LOCATION_ID do not belong together — " +
        "refusing to write into a sub-account this token may not own",
    );
    this.name = "GhlTokenLocationMismatchError";
    this.locationId = locationId;
    this.status = status;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Ask GHL whether this token can see this location.
 *
 * Resolves with the verified location on success. Throws
 * {@link GhlTokenLocationMismatchError} on 401/403/404 — the three responses
 * that mean "this token does not own this location" — and on any other
 * non-2xx, because an unverifiable pairing must not be treated as verified.
 *
 * A transport failure propagates as-is: caller code distinguishes "could not
 * check" from "checked and it failed", and must not silently continue on the
 * former.
 */
export async function verifyTokenLocation(
  options: VerifyTokenLocationOptions,
): Promise<VerifiedTokenLocation> {
  const { baseUrl, locationId, headers, fetchImpl, timeoutMs } = options;
  if (locationId.trim().length === 0) {
    throw new GhlTokenLocationMismatchError(locationId, 0, " (location id is blank)");
  }
  const url = joinUrl(baseUrl, `${GHL_LOCATION_PATH}/${encodeURIComponent(locationId)}`);
  const response = await fetchImpl(url, { method: "GET", headers });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GhlTokenLocationMismatchError(locationId, response.status, "");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new GhlTokenLocationMismatchError(
      locationId,
      response.status,
      " (unexpected status — treating an unverifiable pairing as unverified)",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 2xx with an unreadable body still means the token reached the location,
    // which is what was being asked. Do not fail on a parse error.
    return { locationId };
  }
  const record = asRecord(body);
  const inner = asRecord(record?.["location"]) ?? record;
  const name = inner?.["name"];
  return typeof name === "string" && name.length > 0
    ? { locationId, name }
    : { locationId };
}
