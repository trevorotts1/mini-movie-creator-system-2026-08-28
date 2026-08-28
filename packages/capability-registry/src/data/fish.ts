/**
 * Fish Audio provider family — seeded capability data (CAP-002).
 *
 * Values read from the live official Fish Audio docs on 2026-08-28 (HTTP 200):
 *   - https://docs.fish.audio/developer-guide/models-pricing/models-overview
 *   - https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
 *   - https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
 *   - https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps
 *   - https://docs.fish.audio/developer-guide/models-pricing/deprecations
 *
 * Verified facts:
 *  - TTSRequest model enum: s1 | s2-pro | s2.1-pro | s2.1-pro-free (default s2.1-pro)
 *  - s2.1 pricing: $15.00 per M UTF-8 bytes (s2.1-pro-free $0, fair-use)
 *  - No per-request character limit stated anywhere → UNKNOWN (null)
 *  - Word timestamps: POST /v1/tts/stream/with-timestamp → alignment.segments
 *  - s2.1-pro / s2.1-pro-free: 83 languages; s2-pro 80+; s1 13
 *  - `s2.1-mini` / `s2.1-turbo` do NOT exist in the model enum or pricing —
 *    only s2.1-pro / s2.1-pro-free are seeded (runbook §30 S2.1 family).
 *  - Rate limits are tier-based concurrent requests (5/15/50), not per-model.
 */

import type { VoiceModelCapabilitySeed } from "./types.js";

const VERIFIED_ON = "2026-08-28";

const MODELS_DOC =
  "https://docs.fish.audio/developer-guide/models-pricing/models-overview";
const PRICING_DOC =
  "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits";
const TTS_API_DOC =
  "https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech";
const TIMESTAMP_DOC =
  "https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps";

/** Fish Audio S2.1 Pro — recommended production model. */
export const FISH_S2_1_PRO: VoiceModelCapabilitySeed = Object.freeze({
  provider: "fish",
  modelId: "s2.1-pro",
  kind: "voice",
  lastVerifiedAt: VERIFIED_ON,
  sourceUrls: [MODELS_DOC, PRICING_DOC, TTS_API_DOC, TIMESTAMP_DOC],
  confidence: "VERIFIED",
  hardMaxCharacters: null,
  languages: 83,
  wordTimestamps: true,
  voiceReference: true,
  outputFormats: ["wav", "pcm", "mp3", "opus"],
  freeTier: false,
  pricing: {
    unit: "usd-per-million-utf8-bytes",
    amount: 15.0,
    currency: "USD",
  },
  notes: {
    promptHardMax:
      "No character/context limit stated in the TTSRequest schema (text: string, required, 'Text to convert to speech.') → UNKNOWN, never invented.",
    wordTimestamps:
      "POST /v1/tts/stream/with-timestamp returns alignment.segments with per-word start/end (chunk-local; add chunk_audio_offset_sec for the global timeline).",
    voiceReference:
      "reference_id accepts one voice model id (single speaker) or an array (multi-speaker, S2 family only, not s1).",
    control:
      "Natural-language control via [bracket] cues, not a fixed token set (e.g. [whispers sweetly]).",
    ttfaDpa:
      "Production option for workloads that need TTFA and DPA guarantees.",
    rateLimits:
      "Concurrent-request tiers: < $100 paid → 5; ≥ $100 → 15; ≥ $1,000 → 50; enterprise custom. No per-model limits stated.",
  },
});

/**
 * Fish Audio S2.1 Pro Free — same model at $0 for development/testing.
 * MMCS must not assume it stays free (runbook §30).
 */
export const FISH_S2_1_PRO_FREE: VoiceModelCapabilitySeed = Object.freeze({
  ...FISH_S2_1_PRO,
  modelId: "s2.1-pro-free",
  freeTier: true,
  pricing: {
    unit: "usd-per-million-utf8-bytes",
    amount: 0,
    currency: "USD",
  },
  notes: {
    ...FISH_S2_1_PRO.notes,
    freeTier:
      "Same model as s2.1-pro at $0 under fair-use limits; NO TTFA or DPA guarantees. Do not architect around it staying free (runbook §30).",
  },
});

/** Fish Audio S2 Pro — previous-generation S2 model, still in the API enum. */
export const FISH_S2_PRO: VoiceModelCapabilitySeed = Object.freeze({
  ...FISH_S2_1_PRO,
  modelId: "s2-pro",
  languages: null,
  sourceUrls: [MODELS_DOC, PRICING_DOC, TTS_API_DOC],
  notes: {
    ...FISH_S2_1_PRO.notes,
    languages:
      "Doc states 80+ languages (not an exact count) → null with note rather than a fabricated number.",
    wordTimestamps:
      "Timestamps endpoint is model-agnostic on the stream endpoint; per-model statement absent → asserted only for the documented endpoint, model-specific UNKNOWN.",
    latency: "100ms time-to-first-audio; full SGLang-based serving stack; open-source.",
  },
});

/** Fish Audio S1 — previous model, 13 languages, available for existing integrations. */
export const FISH_S1: VoiceModelCapabilitySeed = Object.freeze({
  ...FISH_S2_1_PRO,
  modelId: "s1",
  languages: 13,
  sourceUrls: [MODELS_DOC, PRICING_DOC, TTS_API_DOC],
  notes: {
    promptHardMax:
      "No character limit stated → UNKNOWN.",
    languages:
      "Doc lists exactly 13 languages: English, Chinese, Japanese, German, French, Spanish, Korean, Arabic, Russian, Dutch, Italian, Polish, Portuguese.",
    wordTimestamps:
      "Per-model timestamps support not stated → UNKNOWN (endpoint exists but doc does not tie alignment to s1).",
    control:
      "64+ emotional expressions via (parenthesis) syntax; WER 0.008 / CER 0.004; RTF ~1:7.",
    multiSpeaker:
      "Multi-speaker reference_id arrays are S2-family only; not supported on s1 (TTSRequest schema).",
  },
});

/** All seeded Fish voice profiles keyed by model id. */
export const FISH_VOICE_PROFILES: Readonly<Record<string, VoiceModelCapabilitySeed>> =
  Object.freeze({
    [FISH_S2_1_PRO.modelId]: FISH_S2_1_PRO,
    [FISH_S2_1_PRO_FREE.modelId]: FISH_S2_1_PRO_FREE,
    [FISH_S2_PRO.modelId]: FISH_S2_PRO,
    [FISH_S1.modelId]: FISH_S1,
  });