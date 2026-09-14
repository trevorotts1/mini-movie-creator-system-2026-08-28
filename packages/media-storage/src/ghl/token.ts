/// <reference types="node" />
/**
 * GHL token lifecycle (SKR-026).
 *
 * WHY THIS EXISTS: the auth config stores a `GhlTokenKind` that nothing ever
 * read. A static Private Integration Token and an OAuth sub-account access
 * token (which expires daily — see docs/provider-capabilities/ghl.md) behaved
 * identically: there was no token cache, no refresh, and no 401 recovery, so a
 * long ingest run simply died with 401s once the token aged out.
 *
 * This module gives the kind a meaning:
 *  - `private-integration-token` is a STATIC credential (rotated by the
 *    operator every ~90 days). It is never "refreshed"; a 401 means it was
 *    rotated or revoked, so recovery fails loudly with instructions instead of
 *    quietly retrying the same dead credential.
 *  - `sub-account-access-token` is refreshed through the injected refresher
 *    when it is close to expiry, or immediately after a 401. Concurrent callers
 *    share ONE refresh so a burst of requests cannot stampede the token
 *    endpoint.
 *
 * The token is never logged or serialized here; no error carries token
 * material. A failed refresh keeps the previous token rather than corrupting
 * state — the next call can try again.
 */
import type { GhlTokenKind } from "./auth.js";

/** Outcome of one token refresh. */
export interface GhlTokenRefreshResult {
  token: string;
  /** ISO 8601 expiry of the new token, when the refresh response discloses it. */
  expiresAt?: string;
}

/**
 * Refreshes an expiring token. Implementations own the OAuth call; this module
 * only sequences it. `current` is handed over so a refresher can reuse the
 * credential it is replacing (e.g. a refresh token flow that needs no secret
 * beyond it) — it must never be logged.
 */
export type GhlTokenRefresher = (current: {
  token: string;
  kind: GhlTokenKind;
}) => Promise<GhlTokenRefreshResult>;

/** Thrown when a token could not be refreshed (or must not be). */
export class GhlTokenRefreshError extends Error {
  readonly kind: GhlTokenKind;
  override readonly cause?: unknown;

  constructor(kind: GhlTokenKind, message: string, cause?: unknown) {
    super(message);
    this.name = "GhlTokenRefreshError";
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Thrown when a refresh is required for a credential that cannot be refreshed:
 * a Private Integration Token (rotate it in the environment) or an OAuth token
 * with no refresher wired.
 */
export class GhlTokenRefreshUnsupportedError extends GhlTokenRefreshError {
  constructor(kind: GhlTokenKind, reason: string) {
    super(kind, `GHL ${kind} cannot be refreshed in-process: ${reason}`);
    this.name = "GhlTokenRefreshUnsupportedError";
  }
}

export interface GhlTokenCacheOptions {
  /** The initial bearer credential. */
  readonly token: string;
  /** Which documented token kind this is — this is what drives refresh. */
  readonly kind: GhlTokenKind;
  /** ISO 8601 expiry of the initial token, when known. */
  readonly expiresAt?: string;
  /** Refresh path. Required for `sub-account-access-token` to be refreshable. */
  readonly refresh?: GhlTokenRefresher;
  /** Refresh this long before the stated expiry. Default 60000 (1 minute). */
  readonly refreshSkewMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

/** Cached, kind-aware bearer token with a single-flight refresh. */
export class GhlTokenCache {
  private token: string;
  private readonly tokenKind: GhlTokenKind;
  private expiresAt?: string;
  private readonly refresh?: GhlTokenRefresher;
  private readonly refreshSkewMs: number;
  private readonly now: () => number;
  /** In-flight refresh, so concurrent callers share one token request. */
  private refreshing?: Promise<string>;

  constructor(options: GhlTokenCacheOptions) {
    this.token = options.token;
    this.tokenKind = options.kind;
    this.expiresAt = options.expiresAt;
    this.refresh = options.refresh;
    this.refreshSkewMs =
      options.refreshSkewMs !== undefined && Number.isFinite(options.refreshSkewMs) && options.refreshSkewMs >= 0
        ? options.refreshSkewMs
        : DEFAULT_REFRESH_SKEW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** The stored token kind — the value that decides every refresh decision. */
  get kind(): GhlTokenKind {
    return this.tokenKind;
  }

  /** ISO expiry of the current token, when known. */
  get currentExpiresAt(): string | undefined {
    return this.expiresAt;
  }

  /** The cached token. Performs no I/O — use `getToken` before a request. */
  current(): string {
    return this.token;
  }

  /**
   * True when the token is unusable or close enough to expiry that a request
   * should refresh first. An UNKNOWN expiry is never treated as expiring: the
   * 401 path is what covers that case.
   */
  needsRefresh(atMs: number = this.now()): boolean {
    if (this.expiresAt === undefined) return false;
    const expiresMs = Date.parse(this.expiresAt);
    if (Number.isNaN(expiresMs)) return false;
    return expiresMs - this.refreshSkewMs <= atMs;
  }

  /** True when an emitted `expiresAt` is already in the past. */
  isExpired(atMs: number = this.now()): boolean {
    if (this.expiresAt === undefined) return false;
    const expiresMs = Date.parse(this.expiresAt);
    if (Number.isNaN(expiresMs)) return false;
    return expiresMs <= atMs;
  }

  /** Token to use for the next request, refreshing first when expiring. */
  async getToken(): Promise<string> {
    if (!this.needsRefresh()) return this.token;
    return this.refreshToken();
  }

  /**
   * 401 recovery. A sub-account access token is refreshed once and the new
   * token returned; a Private Integration Token cannot be refreshed, so this
   * throws `GhlTokenRefreshUnsupportedError` telling the operator to rotate the
   * credential rather than retrying a revoked token.
   */
  async recoverFromUnauthorized(): Promise<string> {
    if (this.tokenKind !== "sub-account-access-token") {
      throw new GhlTokenRefreshUnsupportedError(
        this.tokenKind,
        "private integration tokens are static — rotate GHL_ACCESS_TOKEN and restart (docs: ~90-day rotation)",
      );
    }
    if (this.refresh === undefined) {
      throw new GhlTokenRefreshUnsupportedError(
        this.tokenKind,
        "no refresher is wired; supply one so an expired OAuth token can be renewed",
      );
    }
    return this.refreshToken();
  }

  /** Refresh, sharing one in-flight refresh across concurrent callers. */
  private refreshToken(): Promise<string> {
    if (this.refreshing !== undefined) return this.refreshing;
    const refresh = this.refresh;
    if (refresh === undefined) {
      return Promise.reject(
        new GhlTokenRefreshUnsupportedError(this.tokenKind, "no refresher is wired"),
      );
    }
    const pending = refresh({ token: this.token, kind: this.tokenKind }).then(
      (result) => {
        if (typeof result?.token !== "string" || result.token.trim().length === 0) {
          throw new GhlTokenRefreshError(this.tokenKind, "refresh returned no token");
        }
        this.token = result.token.trim();
        this.expiresAt = result.expiresAt ?? this.expiresAt;
        return this.token;
      },
      (cause: unknown) => {
        // Keep the previous token: a failed refresh must not leave the cache
        // empty, and the caller decides whether to retry or abort.
        throw new GhlTokenRefreshError(
          this.tokenKind,
          `token refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      },
    );
    this.refreshing = pending.finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
}
