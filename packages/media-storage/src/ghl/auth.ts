/**
 * GHL (GoHighLevel) auth + config for the Media Storage API.
 *
 * Verified against the official HighLevel developer docs (v3), 2026-08-28:
 * - https://marketplace.gohighlevel.com/docs/ghl/medias/media-storage-api  (Bearer Auth:
 *   Access Token generated with user type as Sub-Account OR Private Integration Token
 *   of Sub-Account; scheme `http`, `bearer`, JWT format)
 * - https://marketplace.gohighlevel.com/docs/ghl/medias/fetch-media-content  (header
 *   parameter `Version`, required, option `v3`)
 * - https://marketplace.gohighlevel.com/docs/ghl/medias/upload-media-content  (same
 *   `Version: v3` header requirement)
 * - https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken
 *   (token used in the `Authorization: Bearer <token>` header, like an access token)
 *
 * Base URL for all Media Storage endpoints: https://services.leadconnectorhq.com
 * (per the official examples, e.g. the Authorization page's curl examples).
 *
 * SECURITY: the token is a credential. It is never logged by this module; see
 * `redactGhlToken` and the redaction tests. `toString`/`toJSON` on the config object
 * are overridden so accidental interpolation into a log line masks the token.
 *
 * LIFECYCLE (SKR-026): the token is held in a `GhlTokenCache` and the stored
 * `tokenKind` now decides behaviour — a private integration token is static
 * (no refresh; a 401 means rotate it), a sub-account access token refreshes
 * before expiry and after a 401. `authorizedHeaders()` and
 * `recoverFromUnauthorized()` are the refresh-aware entry points;
 * `buildHeaders()` stays the synchronous snapshot.
 */
import {
  GhlTokenCache,
  type GhlTokenRefresher,
} from "./token.js";

/** Official GHL API base URL (HighLevel developer docs, 2026-08-28). */
export const GHL_API_BASE_URL = "https://services.leadconnectorhq.com" as const;

/** Required `Version` header value for the Media Storage (medias) endpoints. */
export const GHL_API_VERSION = "v3" as const;

/** Header names, exactly as the official docs specify them. */
export const GHL_AUTH_HEADER = "Authorization" as const;
export const GHL_VERSION_HEADER = "Version" as const;

/** Where the token is read from when constructing config from the environment. */
export const GHL_TOKEN_ENV_VAR = "GHL_ACCESS_TOKEN" as const;
export const GHL_LOCATION_ID_ENV_VAR = "GHL_LOCATION_ID" as const;
/**
 * Optional: which documented token kind `GHL_ACCESS_TOKEN` holds. Defaults to
 * `private-integration-token` (the credential MMCS ships with). Set it to
 * `sub-account-access-token` so the token is treated as OAuth (expiring,
 * refreshable) instead of static (SKR-026).
 */
export const GHL_TOKEN_KIND_ENV_VAR = "GHL_TOKEN_KIND" as const;
/** Optional: ISO 8601 expiry of `GHL_ACCESS_TOKEN`, when known. */
export const GHL_TOKEN_EXPIRES_AT_ENV_VAR = "GHL_TOKEN_EXPIRES_AT" as const;

/** The two documented token kinds (media-storage-api "Bearer Auth" scheme). */
export type GhlTokenKind = "sub-account-access-token" | "private-integration-token";

export interface GhlAuthConfigInput {
  /** The bearer credential (sub-account access token or private integration token). */
  token: string;
  /** GHL sub-account (location) ID all media operations are scoped to. */
  locationId: string;
  /** Which documented token kind this is. Defaults to `private-integration-token`. */
  tokenKind?: GhlTokenKind;
  /** Base URL override (tests / future environments). Defaults to the official base. */
  baseUrl?: string;
  /** ISO 8601 expiry of `token`, when known (drives the refresh path, SKR-026). */
  expiresAt?: string;
  /** Refresh path for an expiring OAuth token (SKR-026). */
  refresh?: GhlTokenRefresher;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface GhlAuthConfig {
  readonly baseUrl: string;
  readonly locationId: string;
  readonly tokenKind: GhlTokenKind;
  /** Builds the exact headers a medias request needs. Never logs the token. */
  buildHeaders(): Record<string, string>;
  /**
   * Refresh-aware headers: renews an expiring OAuth token before building the
   * header set. Prefer this on any long-running path (SKR-026).
   */
  authorizedHeaders(): Promise<Record<string, string>>;
  /**
   * 401 recovery: renew the token once after the server rejected it and return
   * fresh headers. Throws for a static Private Integration Token, which cannot
   * be refreshed in-process.
   */
  recoverFromUnauthorized(): Promise<Record<string, string>>;
  /** ISO expiry of the token in use, when known. */
  tokenExpiresAt(): string | undefined;
  /** Redacting string form — never prints the token. */
  toString(): string;
  /** Redacting JSON form — never serializes the token. */
  toJSON(): string;
}

export class MissingGhlConfigError extends Error {
  constructor(missing: string[]) {
    super(`GHL auth config incomplete — missing: ${missing.join(", ")}`);
    this.name = "MissingGhlConfigError";
  }
}

export class InvalidGhlTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid GHL token: ${reason}`);
    this.name = "InvalidGhlTokenError";
  }
}

/**
 * Masks a token for logging: keeps nothing but a length marker. Deliberately returns
 * the same fixed shape regardless of token content so logs never leak token material.
 */
export function redactGhlToken(token: string): string {
  return "[REDACTED_GHL_TOKEN]";
}

/** True when the value looks like a real credential rather than a placeholder. */
export function isGhlTokenPresent(token: string | undefined): token is string {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  return trimmed.length >= 8;
}

/**
 * Builds GHL auth config from explicit values. Throws on missing/empty inputs so a
 * misconfigured environment fails fast at startup instead of mid-pipeline.
 */
export function createGhlAuthConfig(input: GhlAuthConfigInput): GhlAuthConfig {
  const missing: string[] = [];
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const locationId = typeof input.locationId === "string" ? input.locationId.trim() : "";
  if (!isGhlTokenPresent(token)) missing.push("token");
  if (locationId.length === 0) missing.push("locationId");
  if (missing.length > 0) throw new MissingGhlConfigError(missing);

  const baseUrl = (input.baseUrl ?? GHL_API_BASE_URL).replace(/\/+$/, "");
  if (baseUrl.length === 0 || !/^https?:\/\//i.test(baseUrl)) {
    throw new MissingGhlConfigError([
      "baseUrl (must be an absolute http(s) URL)",
    ]);
  }
  const kind: GhlTokenKind = input.tokenKind ?? "private-integration-token";
  // The token lives in a kind-aware cache so an expiring OAuth token can be
  // renewed and a 401 recovered (SKR-026) instead of the stored kind being
  // decoration.
  const tokens = new GhlTokenCache({
    token,
    kind,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.refresh !== undefined ? { refresh: input.refresh } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const headersFor = (bearer: string): Record<string, string> => ({
    [GHL_AUTH_HEADER]: `Bearer ${bearer}`,
    [GHL_VERSION_HEADER]: GHL_API_VERSION,
    Accept: "application/json",
  });

  const config: GhlAuthConfig = {
    baseUrl,
    locationId,
    tokenKind: kind,
    buildHeaders(): Record<string, string> {
      return headersFor(tokens.current());
    },
    async authorizedHeaders(): Promise<Record<string, string>> {
      return headersFor(await tokens.getToken());
    },
    async recoverFromUnauthorized(): Promise<Record<string, string>> {
      return headersFor(await tokens.recoverFromUnauthorized());
    },
    tokenExpiresAt(): string | undefined {
      return tokens.currentExpiresAt;
    },
    // Guard rails so an accidental stringification (console.log, JSON.stringify,
    // template literal) can never print the bearer token.
    toString(): string {
      return `GhlAuthConfig(baseUrl=${baseUrl}, locationId=${locationId}, tokenKind=${kind}, token=${redactGhlToken(token)})`;
    },
    toJSON(): string {
      return redactGhlToken(token);
    },
  };
  return Object.freeze(config);
}

/**
 * Builds config from `process.env` (`GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, plus
 * optional `GHL_TOKEN_KIND` / `GHL_TOKEN_EXPIRES_AT`).
 * Throws `MissingGhlConfigError` when either required variable is absent/blank,
 * and `InvalidGhlTokenError` when `GHL_TOKEN_KIND` is not a documented kind.
 *
 * `options.refresh` is how a production caller supplies the OAuth refresh path
 * — without it a `sub-account-access-token` can only be replaced by restarting
 * with a new token (SKR-026).
 */
interface MinimalProcessLike {
  env?: Record<string, string | undefined>;
}

function defaultEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: MinimalProcessLike }).process;
  return proc?.env ?? {};
}

/** The two documented kinds, for validating `GHL_TOKEN_KIND`. */
const GHL_TOKEN_KINDS: readonly GhlTokenKind[] = [
  "private-integration-token",
  "sub-account-access-token",
];

export function ghlAuthConfigFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
  options: { refresh?: GhlTokenRefresher; now?: () => number } = {},
): GhlAuthConfig {
  const missing: string[] = [];
  const token = env[GHL_TOKEN_ENV_VAR];
  const locationId = env[GHL_LOCATION_ID_ENV_VAR];
  if (!isGhlTokenPresent(token)) missing.push(GHL_TOKEN_ENV_VAR);
  if (!locationId || locationId.trim().length === 0) missing.push(GHL_LOCATION_ID_ENV_VAR);
  if (missing.length > 0) throw new MissingGhlConfigError(missing);

  const rawKind = env[GHL_TOKEN_KIND_ENV_VAR]?.trim();
  let tokenKind: GhlTokenKind | undefined;
  if (rawKind !== undefined && rawKind.length > 0) {
    if (!GHL_TOKEN_KINDS.includes(rawKind as GhlTokenKind)) {
      throw new InvalidGhlTokenError(
        `${GHL_TOKEN_KIND_ENV_VAR} must be one of ${GHL_TOKEN_KINDS.join(", ")} (got ${JSON.stringify(rawKind)})`,
      );
    }
    tokenKind = rawKind as GhlTokenKind;
  }
  const expiresAt = env[GHL_TOKEN_EXPIRES_AT_ENV_VAR]?.trim();

  return createGhlAuthConfig({
    token: token as string,
    locationId: locationId as string,
    ...(tokenKind !== undefined ? { tokenKind } : {}),
    ...(expiresAt !== undefined && expiresAt.length > 0 ? { expiresAt } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}