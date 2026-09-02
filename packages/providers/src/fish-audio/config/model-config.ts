/**
 * FISH-010 — Fish Audio model/cost configuration (@mmcs/providers fish-audio/config).
 *
 * Spec §16: "user may initially use the developer-access S2.1 Pro / free
 * developer route if still available, but MMCS must not assume it stays free —
 * model selection and pricing are config-driven." Runbook §30 repeats the same
 * iron rule: "Fish Audio: do not assume s2.1-pro-free stays free."
 *
 * This module owns model selection + pricing resolution:
 *
 *  - Model selection is EXPLICIT and REQUIRED. `resolveFishModelConfig`
 *    throws when no model is configured — there is no default, and in
 *    particular no default of `s2.1-pro-free`. The free tier is only ever
 *    used when the operator names it.
 *  - The selected model must be BOTH a value the Fish `model` header accepts
 *    (FISH-001 `FISH_TTS_MODELS`, verified against api.fish.audio 2026-08-28)
 *    AND a seeded registry profile (CAP-002 `FISH_VOICE_PROFILES`, verified
 *    against docs.fish.audio 2026-08-28) — an unseeded model has no pricing
 *    provenance and cannot be cost-gated.
 *  - Pricing comes from the registry seed (USD per million UTF-8 bytes) with
 *    an optional operator price override — when Fish reprices (e.g. the free
 *    tier becomes paid), the operator corrects it in config, not in code.
 *
 * The API key is NOT this module's business: it arrives from the validated
 * engine config (CORE-010 `FISH_API_KEY`) into the FISH-001 client config.
 * Model selection here is a programmatic config object; env-schema wiring
 * (e.g. a FISH_MODEL variable) belongs to CORE-010's owned schema.
 */

import { FISH_TTS_MODELS } from "../client/config.js";
import { FISH_VOICE_PROFILES } from "@mmcs/capability-registry/data/fish.js";
import type { VoiceModelCapabilitySeed } from "@mmcs/capability-registry/data/types.js";
import type { CapabilityConfidence } from "@mmcs/capability-registry/data/types.js";
import { AUTO_SPEND_LIMIT_USD } from "../../../../capability-registry/src/pricing/pricing.js";

/** Fish TTS models the client `model` header accepts (FISH-001, verified 2026-08-28). */
export const FISH_CONFIG_TTS_MODELS: readonly string[] = FISH_TTS_MODELS;

/** Registry voice profiles this module consults by default (CAP-002). */
export type FishProfileMap = Readonly<Record<string, VoiceModelCapabilitySeed>>;

/** Operator-supplied price overrides, keyed by model id, in USD per million UTF-8 bytes. */
export type FishPriceOverrides = Readonly<Record<string, number>>;

/** Config input for Fish model selection + pricing (all config-driven, nothing hard-coded). */
export interface FishModelConfigInput {
  /**
   * The Fish TTS model MMCS will synthesize with. REQUIRED — the resolver
   * never picks one, and never picks the free tier on the operator's behalf.
   */
  model: string;
  /**
   * Optional per-model price corrections in USD per million UTF-8 bytes,
   * applied on top of the registry seed when Fish reprices (spec §16: pricing
   * is config-driven — a price change is a config change, not a code change).
   */
  priceOverrides?: FishPriceOverrides;
  /**
   * Cumulative auto-spend ceiling in USD passed through to spend decisions
   * (runbook §33). Default: the registry's 25.00.
   */
  autoLimitUsd?: number;
}

/** Resolved Fish model + pricing configuration. */
export interface ResolvedFishModelConfig {
  /** The selected model id (trimmed). */
  model: string;
  /** Registry seed backing this model (provenance + capabilities). */
  seed: VoiceModelCapabilitySeed;
  /** Effective price in USD per million UTF-8 bytes (override applied when present). */
  pricePerMillionBytes: number;
  /** Where the effective price came from. */
  priceSource: "registry" | "config_override";
  /** True when the registry records this model as a free/fair-use tier. Never assumed — read from the seed. */
  freeTier: boolean;
  /** Registry provenance (live provider URLs), preserved for the cost ledger. */
  sourceUrls: readonly string[];
  /** Registry confidence tier. */
  confidence: CapabilityConfidence;
  /** Auto-spend ceiling for {@link fishSpendDecision}. */
  autoLimitUsd: number;
}

/** Error carrying the invalid Fish config field. */
export class FishConfigError extends Error {
  readonly field: string;
  constructor(field: string, detail?: string) {
    super(`invalid fish config ${field}${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "FishConfigError";
    this.field = field;
  }
}

/**
 * Validate one price override: a finite, non-negative USD amount per million
 * UTF-8 bytes. NaN/Infinity/negative would poison cost estimates downstream
 * (NaN bypasses `>=` limit comparisons exactly like the registry's own
 * validation guards), so they are rejected at the config boundary.
 */
function validateOverridePrice(modelId: string, amount: number): void {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new FishConfigError(`priceOverrides[${modelId}]`, "must be a finite number");
  }
  if (amount < 0) {
    throw new FishConfigError(`priceOverrides[${modelId}]`, "must not be negative");
  }
}

/**
 * Resolve Fish model selection + pricing from config. Throws when the model
 * is missing (NO default — not even the free tier), unknown to the registry
 * seed, or not accepted by the Fish client `model` header enum. The optional
 * price override is validated and folded over the registry amount.
 */
export function resolveFishModelConfig(
  input: FishModelConfigInput,
  profiles: FishProfileMap = FISH_VOICE_PROFILES,
): ResolvedFishModelConfig {
  const model = input?.model?.trim();
  if (!model) {
    // The heart of spec §16: selection is explicit config. No default means
    // MMCS can never silently drift onto (or off of) the free tier.
    throw new FishConfigError(
      "model",
      "Fish TTS model is required from config — never defaulted (do not assume s2.1-pro-free stays free)",
    );
  }
  const seed = profiles[model];
  if (seed === undefined) {
    throw new FishConfigError(
      "model",
      `"${model}" has no seeded Fish registry profile (seeded: ${Object.keys(profiles).join(", ")})`,
    );
  }
  if (!FISH_CONFIG_TTS_MODELS.includes(model)) {
    // Cross-layer guard: the registry may seed a model the client header
    // rejects; selection must satisfy both (spec: capability profile selects
    // the model, but the HTTP contract must accept it).
    throw new FishConfigError(
      "model",
      `"${model}" is not accepted by the Fish TTS \`model\` header enum (${FISH_CONFIG_TTS_MODELS.join(", ")})`,
    );
  }
  const registryAmount = seed.pricing.amount;
  if (registryAmount !== null && (typeof registryAmount !== "number" || !Number.isFinite(registryAmount) || registryAmount < 0)) {
    throw new FishConfigError("model", `registry price for "${model}" is invalid (${String(registryAmount)})`);
  }
  const override = input.priceOverrides?.[model];
  if (override !== undefined) {
    validateOverridePrice(model, override);
  }
  const autoLimitUsd = input.autoLimitUsd ?? AUTO_SPEND_LIMIT_USD;
  if (!Number.isFinite(autoLimitUsd) || autoLimitUsd <= 0) {
    throw new FishConfigError("autoLimitUsd", "must be a positive finite number");
  }
  return {
    model,
    seed,
    pricePerMillionBytes: override ?? registryAmount!,
    priceSource: override !== undefined ? "config_override" : "registry",
    freeTier: seed.freeTier === true,
    sourceUrls: seed.sourceUrls,
    confidence: seed.confidence,
    autoLimitUsd,
  };
}
