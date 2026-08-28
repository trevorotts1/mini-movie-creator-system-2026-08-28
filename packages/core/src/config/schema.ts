import { z } from "zod";

/**
 * Environment variable names recognized by the MMCS engine (runbook §15, spec §33).
 * Single source of truth for the config contract; .env.example mirrors these names.
 */
export const MMCS_ENV_KEYS = [
  "AGNES_API_KEY",
  "KIE_API_KEY",
  "FISH_API_KEY",
  "GHL_ACCESS_TOKEN",
  "GHL_LOCATION_ID",
  "OPENROUTER_API_KEY",
  "NINEROUTER_URL",
  "NINEROUTER_KEY",
  "AUTO_SPEND_LIMIT_USD",
] as const;

export type MmcsEnvKey = (typeof MMCS_ENV_KEYS)[number];

/** Default cumulative paid-spend gate in USD (spec §33: approval required at/above this). */
export const DEFAULT_AUTO_SPEND_LIMIT_USD = 25;

/** Env entries arrive as strings (or undefined); "" counts as unset, never as a value. */
function emptyToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

const envString = z.preprocess(emptyToUndefined, z.string().trim().min(1));

const envUrl = z.preprocess(emptyToUndefined, z.url());

const envUsd = z.preprocess(
  emptyToUndefined,
  z.coerce.number().finite().positive(),
);

/**
 * Strict schema: every provider credential is required. Used by production
 * entry points that cannot run without configured providers.
 */
export const mmcsRequiredEnvSchema = z.object({
  AGNES_API_KEY: envString,
  KIE_API_KEY: envString,
  FISH_API_KEY: envString,
  GHL_ACCESS_TOKEN: envString,
  GHL_LOCATION_ID: envString,
  OPENROUTER_API_KEY: envString,
  NINEROUTER_URL: envUrl,
  NINEROUTER_KEY: envString,
  AUTO_SPEND_LIMIT_USD: envUsd.default(DEFAULT_AUTO_SPEND_LIMIT_USD),
});

/**
 * Lenient schema: provider credentials optional (each end user supplies their
 * own; `mmcs doctor` reports what is missing without refusing to run).
 */
export const mmcsOptionalEnvSchema = z.object({
  AGNES_API_KEY: envString.optional(),
  KIE_API_KEY: envString.optional(),
  FISH_API_KEY: envString.optional(),
  GHL_ACCESS_TOKEN: envString.optional(),
  GHL_LOCATION_ID: envString.optional(),
  OPENROUTER_API_KEY: envString.optional(),
  NINEROUTER_URL: envUrl.optional(),
  NINEROUTER_KEY: envString.optional(),
  AUTO_SPEND_LIMIT_USD: envUsd.default(DEFAULT_AUTO_SPEND_LIMIT_USD),
});

/** Fully validated engine configuration (strict mode). */
export type MmcsConfig = z.infer<typeof mmcsRequiredEnvSchema>;

/** Partially validated configuration (lenient mode); undefined = not configured. */
export type MmcsPartialConfig = z.infer<typeof mmcsOptionalEnvSchema>;

/** One named, human-readable config problem. Never carries the variable's value. */
export interface ConfigIssue {
  /** Environment variable name, e.g. "GHL_LOCATION_ID". */
  key: string;
  /** Plain-language reason; safe to display (value-free by construction). */
  reason: string;
}