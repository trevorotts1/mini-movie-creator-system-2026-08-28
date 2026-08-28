/// <reference types="node" />
/**
 * Configuration for the Kie HTTP client.
 * Mirrors the shape of other MMCS provider client configs; the API key comes
 * from the validated engine config (CORE-010 `KIE_API_KEY`), never inlined.
 */
export interface KieClientConfig {
  /** Kie API bearer token. Treated as a secret; never logged or serialized. */
  apiKey: string;
  /**
   * Base URL of the Kie REST API. Default: the documented production base
   * `https://api.kie.ai` (docs.kie.ai/market/quickstart, verified 2026-08-28).
   * Override for tests/mocks.
   */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default: 30000 (generation APIs are slow). */
  timeoutMs?: number;
  /** Total request attempts (1 = no retry). Default: 3. */
  maxRetries?: number;
  /** Base delay for the exponential backoff between attempts, in ms. Default: 500. */
  retryBackoffMs?: number;
  /** Optional clock injection for deterministic backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Resolved, fully-defaulted client config (internal). */
export interface ResolvedKieClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const KIE_DEFAULT_BASE_URL = "https://api.kie.ai";
export const KIE_DEFAULT_TIMEOUT_MS = 30_000;
export const KIE_DEFAULT_MAX_RETRIES = 3;
export const KIE_DEFAULT_RETRY_BACKOFF_MS = 500;

/** Validate + default a client config. Throws on a missing API key. */
export function resolveKieClientConfig(config: KieClientConfig): ResolvedKieClientConfig {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error("KieClientConfig.apiKey is required (engine config KIE_API_KEY)");
  }
  const maxRetries = config.maxRetries ?? KIE_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error("KieClientConfig.maxRetries must be a positive integer");
  }
  const timeoutMs = config.timeoutMs ?? KIE_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("KieClientConfig.timeoutMs must be a positive number");
  }
  const retryBackoffMs = config.retryBackoffMs ?? KIE_DEFAULT_RETRY_BACKOFF_MS;
  if (!Number.isFinite(retryBackoffMs) || retryBackoffMs < 0) {
    throw new Error("KieClientConfig.retryBackoffMs must be a non-negative number");
  }
  return {
    apiKey,
    baseUrl: (config.baseUrl ?? KIE_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs,
    maxRetries,
    retryBackoffMs,
    sleep: config.sleep ?? defaultSleep,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}