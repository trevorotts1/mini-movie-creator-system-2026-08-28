/**
 * Capability data types — CAP-002.
 *
 * The schema fields mirror the runbook §16 `MediaModelCapability` contract
 * (provider/modelId/kind/lastVerifiedAt/sourceUrls/confidence + prompt,
 * references, output, pricing). CAP-001 owns the canonical schema package;
 * this file only types the seeded data under src/data/. Every seeded record
 * carries the provenance triple the acceptance test enforces:
 * `lastVerifiedAt` + `sourceUrls` + `confidence`.
 *
 * Confidence values (runbook §16):
 *  - VERIFIED    — value read from live official provider docs on lastVerifiedAt
 *  - PROVISIONAL — value asserted by an authoritative-enough source that is not
 *                  the provider's own docs (e.g. a router's model listing)
 *  - UNKNOWN     — the provider docs do not state a value; null preserved.
 *                  UNKNOWN IS VALID. Never invent a number to fill a null
 *                  (runbook: "Never invent a hard Agnes prompt limit because
 *                  another model has one").
 */

export type CapabilityConfidence = "VERIFIED" | "PROVISIONAL" | "UNKNOWN";

/** Media (image/video) model capability record. */
export interface MediaModelCapabilitySeed {
  provider: string;
  modelId: string;
  kind: "image" | "video";
  /** ISO date (YYYY-MM-DD) the values were verified against the sources. */
  lastVerifiedAt: string;
  /** Live provider URLs the values were read from. */
  sourceUrls: string[];
  /** Highest confidence of the values below; UNKNOWN only when nothing is stated. */
  confidence: CapabilityConfidence;
  prompt: {
    /** null = undocumented (UNKNOWN) — validators must not enforce a limit. */
    hardMaxCharacters: number | null;
    /** null = undocumented. */
    recommendedMaxCharacters: number | null;
    /** null = undocumented. */
    negativePrompt: boolean | null;
  };
  references: {
    /** null = undocumented — reference-count validators must not enforce. */
    maxImages: number | null;
    maxVideos: number | null;
    maxAudio: number | null;
    firstFrame: boolean;
    lastFrame: boolean;
    firstLastFrame: boolean;
    multimodalReferences: boolean;
    /** Documented mutually exclusive input combinations. */
    incompatibleCombinations: string[];
  };
  output: {
    minDurationSeconds: number | null;
    maxDurationSeconds: number | null;
    resolutions: string[];
    aspectRatios: string[];
  };
  pricing: {
    unit: string | null;
    amount: number | null;
    currency: string;
  };
  /** Per-resolution / per-unit price detail where the provider states it. */
  pricingDetail?: Readonly<Record<string, number>>;
  /** Where the values came from and what was attempted for null fields. */
  notes: Readonly<Record<string, string>>;
}

/** Reasoning / vision LLM capability record (runbook §28). */
export interface ReasoningModelCapabilitySeed {
  provider: string;
  /** Exact routing slug (e.g. OpenRouter model id). */
  modelId: string;
  kind: "reasoning";
  lastVerifiedAt: string;
  sourceUrls: string[];
  confidence: CapabilityConfidence;
  contextTokens: number | null;
  maxCompletionTokens: number | null;
  /** true when the model accepts image input (vision QC route). */
  vision: boolean;
  /** true when the model accepts video input directly (else extract frames). */
  videoInput: boolean;
  /** true when the model supports a reasoning/thinking effort parameter. */
  reasoningEffort: boolean;
  /**
   * Documented supported effort levels, or null when unstated.
   * CAP-008's MAX_REASONING mapper reads this to pick the highest effort.
   */
  supportedEfforts: readonly string[] | null;
  /** Effort used when the caller requests MAX_REASONING, or null if unmappable. */
  maxReasoningEffort: string | null;
  prompt: {
    hardMaxCharacters: number | null;
  };
  pricing: {
    unit: string;
    usdPerMillionInput: number | null;
    usdPerMillionOutput: number | null;
    currency: string;
  };
  notes: Readonly<Record<string, string>>;
}

/** Voice (TTS) model capability record (runbook §30). */
export interface VoiceModelCapabilitySeed {
  provider: string;
  modelId: string;
  kind: "voice";
  lastVerifiedAt: string;
  sourceUrls: string[];
  confidence: CapabilityConfidence;
  /** null = undocumented (Fish states no per-request character limit). */
  hardMaxCharacters: number | null;
  languages: number | null;
  /** Word-level timestamps available (alignment segments). */
  wordTimestamps: boolean | null;
  /** Reference/voice id support (voice cloning). */
  voiceReference: boolean;
  outputFormats: readonly string[];
  /** Free tier available. */
  freeTier: boolean | null;
  pricing: {
    unit: string | null;
    amount: number | null;
    currency: string;
  };
  notes: Readonly<Record<string, string>>;
}

export type CapabilitySeed =
  | MediaModelCapabilitySeed
  | ReasoningModelCapabilitySeed
  | VoiceModelCapabilitySeed;