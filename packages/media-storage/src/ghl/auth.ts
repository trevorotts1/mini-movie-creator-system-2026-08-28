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
 */

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
}

export interface GhlAuthConfig {
  readonly baseUrl: string;
  readonly locationId: string;
  readonly tokenKind: GhlTokenKind;
  /** Builds the exact headers a medias request needs. Never logs the token. */
  buildHeaders(): Record<string, string>;
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

  const config: GhlAuthConfig = {
    baseUrl,
    locationId,
    tokenKind: kind,
    buildHeaders(): Record<string, string> {
      return {
        [GHL_AUTH_HEADER]: `Bearer ${token}`,
        [GHL_VERSION_HEADER]: GHL_API_VERSION,
        Accept: "application/json",
      };
    },
    // Guard rails so an accidental stringification (console.log, JSON.stringify,
    // template literal) can never print the bearer token.
    toString(): string {
      return `GhlAuthConfig(baseUrl=${baseUrl}, locationId=${locationId}, token=${redactGhlToken(token)})`;
    },
    toJSON(): string {
      return redactGhlToken(token);
    },
  };
  return Object.freeze(config);
}

/**
 * Builds config from `process.env` (`GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`).
 * Throws `MissingGhlConfigError` when either variable is absent/blank.
 */
interface MinimalProcessLike {
  env?: Record<string, string | undefined>;
}

function defaultEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: MinimalProcessLike }).process;
  return proc?.env ?? {};
}

export function ghlAuthConfigFromEnv(
  env: Record<string, string | undefined> = defaultEnv(),
): GhlAuthConfig {
  const missing: string[] = [];
  const token = env[GHL_TOKEN_ENV_VAR];
  const locationId = env[GHL_LOCATION_ID_ENV_VAR];
  if (!isGhlTokenPresent(token)) missing.push(GHL_TOKEN_ENV_VAR);
  if (!locationId || locationId.trim().length === 0) missing.push(GHL_LOCATION_ID_ENV_VAR);
  if (missing.length > 0) throw new MissingGhlConfigError(missing);
  return createGhlAuthConfig({
    token: token as string,
    locationId: locationId as string,
  });
}