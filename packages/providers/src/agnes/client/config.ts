/// <reference types="node" />
/**
 * Configuration for the Agnes HTTP client.
 * Mirrors the shape of other MMCS provider client configs (KIE-001); the API
 * key comes from the validated engine config (CORE-010 `AGNES_API_KEY`),
 * never inlined.
 */
export interface AgnesClientConfig {
  /** Agnes API bearer token. Treated as a secret; never logged or serialized. */
  apiKey: string;
  /**
   * Base URL of the Agnes REST API. Default: the documented production base
   * `https://apihub.agnes-ai.com/v1` (wiki.agnes-ai.com, verified 2026-08-28
   * — see docs/provider-capabilities/agnes.md). Override for tests/mocks.
   */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default: 30000 (video tasks are slow). */
  timeoutMs?: number;
  /** Total request attempts (1 = no retry). Default: 3; capped at 10. */
  maxRetries?: number;
  /** Base delay for the exponential backoff between attempts, in ms. Default: 500. */
  retryBackoffMs?: number;
  /** Optional clock injection for deterministic backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Resolved, fully-defaulted client config (internal). */
export interface ResolvedAgnesClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const AGNES_DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const AGNES_DEFAULT_TIMEOUT_MS = 30_000;
export const AGNES_DEFAULT_MAX_RETRIES = 3;
export const AGNES_DEFAULT_RETRY_BACKOFF_MS = 500;
/**
 * Hard ceilings for user-supplied options (spec §29 "provider timeout/retry
 * limits", "no unbounded automatic retry loops"). Out-of-range values throw —
 * silently capping hides a misconfigured engine.
 */
export const AGNES_MAX_RETRIES = 10;
export const AGNES_MAX_TIMEOUT_MS = 300_000;
export const AGNES_MAX_RETRY_BACKOFF_MS = 60_000;
/**
 * Upper bound on honoring a server-supplied Retry-After (spec §29 — no
 * unbounded waits). Values above this are clamped at parse time.
 */
export const AGNES_MAX_RETRY_AFTER_MS = 300_000;

/** Validate + default a client config. Throws on a missing API key. */
export function resolveAgnesClientConfig(config: AgnesClientConfig): ResolvedAgnesClientConfig {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error("AgnesClientConfig.apiKey is required (engine config AGNES_API_KEY)");
  }
  const maxRetries = config.maxRetries ?? AGNES_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error("AgnesClientConfig.maxRetries must be a positive integer");
  }
  if (maxRetries > AGNES_MAX_RETRIES) {
    throw new Error(`AgnesClientConfig.maxRetries must not exceed ${AGNES_MAX_RETRIES} (spec §29: no unbounded retries)`);
  }
  const timeoutMs = config.timeoutMs ?? AGNES_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AgnesClientConfig.timeoutMs must be a positive number");
  }
  if (timeoutMs > AGNES_MAX_TIMEOUT_MS) {
    throw new Error(`AgnesClientConfig.timeoutMs must not exceed ${AGNES_MAX_TIMEOUT_MS}ms (spec §29: bounded timeouts)`);
  }
  const retryBackoffMs = config.retryBackoffMs ?? AGNES_DEFAULT_RETRY_BACKOFF_MS;
  if (!Number.isFinite(retryBackoffMs) || retryBackoffMs < 0) {
    throw new Error("AgnesClientConfig.retryBackoffMs must be a non-negative number");
  }
  if (retryBackoffMs > AGNES_MAX_RETRY_BACKOFF_MS) {
    throw new Error(
      `AgnesClientConfig.retryBackoffMs must not exceed ${AGNES_MAX_RETRY_BACKOFF_MS}ms (spec §29: no unbounded backoff)`,
    );
  }
  const baseUrl = config.baseUrl ?? AGNES_DEFAULT_BASE_URL;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error("AgnesClientConfig.baseUrl must be a valid absolute http(s) URL");
  }
  if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
    throw new Error("AgnesClientConfig.baseUrl must use http or https");
  }
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs,
    maxRetries,
    retryBackoffMs,
    sleep: config.sleep ?? defaultSleep,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
