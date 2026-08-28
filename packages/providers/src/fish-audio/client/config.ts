/// <reference types="node" />
/**
 * Configuration for the Fish Audio HTTP client (FISH-001).
 * Mirrors the shape of the other MMCS provider client configs (Kie); the API
 * key comes from the validated engine config (CORE-010 `FISH_API_KEY`),
 * never inlined.
 */
export interface FishClientConfig {
  /** Fish Audio API key. Treated as a secret; never logged or serialized. */
  apiKey: string;
  /**
   * Base URL of the Fish Audio REST API. Default: the documented production
   * base `https://api.fish.audio` (https://api.fish.audio/openapi.json,
   * verified 2026-08-28). Override for tests/mocks.
   */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default: 30000 (TTS synthesis is slow). */
  timeoutMs?: number;
  /** Total request attempts (1 = no retry). Default: 3. */
  maxRetries?: number;
  /** Base delay for the exponential backoff between attempts, in ms. Default: 500. */
  retryBackoffMs?: number;
  /** Optional clock injection for deterministic backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Resolved, fully-defaulted client config (internal). */
export interface ResolvedFishClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const FISH_DEFAULT_BASE_URL = "https://api.fish.audio";
export const FISH_DEFAULT_TIMEOUT_MS = 30_000;
export const FISH_DEFAULT_MAX_RETRIES = 3;
export const FISH_DEFAULT_RETRY_BACKOFF_MS = 500;
/** Upper bound on maxRetries: total attempts stay finite even with hostile config. */
export const FISH_MAX_RETRIES = 10;
/**
 * Hard ceiling for any single sleep between attempts (QC fix 2026-08-28):
 * without it the exponential path grows unboundedly with maxRetries
 * (500ms * 2^19 ≈ 109h). Applies to both the exponential and the
 * Retry-After backoff paths.
 */
export const FISH_MAX_BACKOFF_MS = 30_000;

/**
 * TTS model IDs accepted by the `model` HTTP header (verified 2026-08-28,
 * https://api.fish.audio/openapi.json). NOT a default: MMCS selects the model
 * from config — `s2.1-pro-free` availability is recorded but never assumed
 * (it is a fair-use free tier without TTFA/DPA guarantees and can be retired).
 */
export const FISH_TTS_MODELS = ["s1", "s2-pro", "s2.1-pro", "s2.1-pro-free"] as const;
export type FishTtsModel = (typeof FISH_TTS_MODELS)[number];

/** Validate + default a client config. Throws on a missing API key. */
export function resolveFishClientConfig(config: FishClientConfig): ResolvedFishClientConfig {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error("FishClientConfig.apiKey is required (engine config FISH_API_KEY)");
  }
  const maxRetries = config.maxRetries ?? FISH_DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > FISH_MAX_RETRIES) {
    throw new Error(`FishClientConfig.maxRetries must be an integer between 1 and ${FISH_MAX_RETRIES}`);
  }
  const timeoutMs = config.timeoutMs ?? FISH_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("FishClientConfig.timeoutMs must be a positive number");
  }
  const retryBackoffMs = config.retryBackoffMs ?? FISH_DEFAULT_RETRY_BACKOFF_MS;
  if (!Number.isFinite(retryBackoffMs) || retryBackoffMs < 0) {
    throw new Error("FishClientConfig.retryBackoffMs must be a non-negative number");
  }
  return {
    apiKey,
    baseUrl: (config.baseUrl ?? FISH_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs,
    maxRetries,
    retryBackoffMs,
    sleep: config.sleep ?? defaultSleep,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}