/**
 * Reasoning / vision LLM registry seeds — CAP-002 (runbook §28).
 *
 * All four preset models verified live against the OpenRouter public model
 * catalog API (https://openrouter.ai/api/v1/models, HTTP 200) on 2026-08-28.
 * The catalog is the router's own machine-readable listing — PROVISIONAL by
 * registry policy (router metadata, not the upstream model vendor's docs),
 * except where the vendor's own docs were also read.
 *
 * Effort levels come straight from each entry's `reasoning.supported_efforts`:
 *   - glm-5.3-flash:  ["max","high","low"],  default max   → MAX maps to "max"
 *   - v4-flash-vision-exp: ["max","high","low"], default high → MAX maps to max
 *   - qwen3.8-flash:  efforts unstated (reasoning flag supported only)
 *                     → MAX unmappable here (CAP-008 decides per-adapter)
 *   - gemini-3.7-flash: ["high","medium","low"], default medium → MAX maps high
 * Runbook: "never assume every API accepts literal 'max'" — exactly why
 * supportedEfforts/maxReasoningEffort are per-model data, not constants.
 */

import type { ReasoningModelCapabilitySeed } from "./types.js";

const VERIFIED_ON = "2026-08-28";

const OPENROUTER_MODELS_API = "https://openrouter.ai/api/v1/models";

function or(modelSlug: string): string {
  return `https://openrouter.ai/${modelSlug}`;
}

/** Z.ai GLM 5.3 Flash — multimodal (text/image/video), efforts max|high|low. */
export const GLM_5_3_FLASH: ReasoningModelCapabilitySeed = Object.freeze({
  provider: "openrouter",
  modelId: "z-ai/glm-5.3-flash",
  kind: "reasoning",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [OPENROUTER_MODELS_API, or("z-ai/glm-5.3-flash")],
  confidence: "PROVISIONAL",
  contextTokens: 1_310_720,
  maxCompletionTokens: 131_072,
  vision: true,
  videoInput: true,
  reasoningEffort: true,
  supportedEfforts: ["max", "high", "low"],
  maxReasoningEffort: "max",
  prompt: { hardMaxCharacters: null },
  pricing: {
    unit: "usd-per-million-tokens",
    usdPerMillionInput: 0.075,
    usdPerMillionOutput: 0.25,
    currency: "USD",
  },
  notes: {
    confidenceBasis:
      "PROVISIONAL: values from the OpenRouter router's public catalog, not Z.ai's own model card. Re-verify against vendor docs before relying on limits.",
    inputModalities: "text, image, video (modality text+image+video->text).",
    pricing: "$0.075/M input, $0.25/M output, $0.015/M cache read (50% off via ZAI through 2026-09-09).",
    defaultEffort: "max (default_enabled true) — GLM already runs MAX by default.",
  },
});

/** DeepSeek V4 Flash Vision Experimental — text+image in, text out. */
export const DEEPSEEK_V4_FLASH_VISION_EXP: ReasoningModelCapabilitySeed =
  Object.freeze({
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash-vision-exp",
    kind: "reasoning",
    lastVerifiedAt: VERIFIED_ON,
    sourceUrls: [OPENROUTER_MODELS_API, or("deepseek/deepseek-v4-flash-vision-exp")],
    confidence: "PROVISIONAL",
    contextTokens: 1_048_576,
    maxCompletionTokens: 384_000,
    vision: true,
    videoInput: false,
    reasoningEffort: true,
    supportedEfforts: ["max", "high", "low"],
    maxReasoningEffort: "max",
    prompt: { hardMaxCharacters: null },
    pricing: {
      unit: "usd-per-million-tokens",
      usdPerMillionInput: 0.22,
      usdPerMillionOutput: 0.66,
      currency: "USD",
    },
    notes: {
      confidenceBasis:
        "PROVISIONAL: values from the OpenRouter public model catalog (experimental model; vendor card fetched but JS-rendered).",
      inputModalities: "text, image — no video input (extract frames for video QC).",
      variant:
        "Experimental vision-enabled version of deepseek-v4-flash-0731, matching the base model on text capabilities.",
    },
  });

/** Qwen 3.8 Flash — multimodal reasoning; no effort ladder published. */
export const QWEN_3_8_FLASH: ReasoningModelCapabilitySeed = Object.freeze({
  provider: "openrouter",
  modelId: "qwen/qwen3.8-flash",
  kind: "reasoning",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [OPENROUTER_MODELS_API, or("qwen/qwen3.8-flash")],
  confidence: "PROVISIONAL",
  contextTokens: 1_000_000,
  maxCompletionTokens: 131_072,
  vision: true,
  videoInput: true,
  reasoningEffort: false,
  supportedEfforts: null,
  maxReasoningEffort: null,
  prompt: { hardMaxCharacters: null },
  pricing: {
    unit: "usd-per-million-tokens",
    usdPerMillionInput: 0.15,
    usdPerMillionOutput: 0.47,
    currency: "USD",
  },
  notes: {
    confidenceBasis:
      "PROVISIONAL: values from the OpenRouter public model catalog.",
    inputModalities: "text, image, video (long-video analysis per model card).",
    reasoning:
      "Catalog lists `reasoning` (toggle) in supported_parameters but publishes NO supported_efforts ladder → maxReasoningEffort null; CAP-008 must map MAX_REASONING for this route from the vendor's own docs, never assume 'max'.",
  },
});

/** Google Gemini 3.7 Flash — widest modality set; efforts high|medium|low. */
export const GEMINI_3_7_FLASH: ReasoningModelCapabilitySeed = Object.freeze({
  provider: "openrouter",
  modelId: "google/gemini-3.7-flash",
  kind: "reasoning",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [OPENROUTER_MODELS_API, or("google/gemini-3.7-flash")],
  confidence: "PROVISIONAL",
  contextTokens: 1_048_576,
  maxCompletionTokens: 65_536,
  vision: true,
  videoInput: true,
  reasoningEffort: true,
  supportedEfforts: ["high", "medium", "low"],
  maxReasoningEffort: "high",
  prompt: { hardMaxCharacters: null },
  pricing: {
    unit: "usd-per-million-tokens",
    usdPerMillionInput: 0.375,
    usdPerMillionOutput: 1.875,
    currency: "USD",
  },
  notes: {
    confidenceBasis:
      "PROVISIONAL: values from the OpenRouter public model catalog; Gemini vendor docs to be re-verified at adapter build (CAP-007/CAP-008).",
    inputModalities: "text, image, video, file, audio — direct video ingestion.",
    reasoning:
      "No literal 'max' effort on this route — highest supported effort is 'high' (runbook §28: never assume every API accepts literal 'max').",
    batch: "google/gemini-3.7-flash:batch exists at half price ($0.1875/$0.9375 per M).",
  },
});

/** All seeded reasoning/vision profiles keyed by OpenRouter model id. */
export const REASONING_PROFILES: Readonly<
  Record<string, ReasoningModelCapabilitySeed>
> = Object.freeze({
  [GLM_5_3_FLASH.modelId]: GLM_5_3_FLASH,
  [DEEPSEEK_V4_FLASH_VISION_EXP.modelId]: DEEPSEEK_V4_FLASH_VISION_EXP,
  [QWEN_3_8_FLASH.modelId]: QWEN_3_8_FLASH,
  [GEMINI_3_7_FLASH.modelId]: GEMINI_3_7_FLASH,
});