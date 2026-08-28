# Provider Capabilities — Fish Audio

Verified 2026-08-28 against the live official Fish Audio docs (all URLs fetched
HTTP 200 on that date). Registry data:
`packages/capability-registry/src/data/fish.ts`.

- API base: `https://api.fish.audio` (TTS: `POST /v1/tts`; timestamps:
  `POST /v1/tts/stream/with-timestamp`)
- Sources read:
  - https://docs.fish.audio/developer-guide/models-pricing/models-overview
  - https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
  - https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
  - https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps
  - https://docs.fish.audio/developer-guide/models-pricing/deprecations

## TTS model enum (TTSRequest `model` field) — VERIFIED

`s1` | `s2-pro` | `s2.1-pro` | `s2.1-pro-free` (default `s2.1-pro`).
`s2.1-mini` and `s2.1-turbo` do NOT exist in the enum or pricing table — they
are not seeded. `speech-1.5` / `speech-1.6` deprecated 2026-02-28.

## Fish S2.1 family — VERIFIED

| Capability | s2.1-pro | s2.1-pro-free | s2-pro | s1 |
|---|---|---|---|---|
| Role | recommended production | same model, $0, dev/testing | previous S2 | previous, kept for existing integrations |
| Languages | 83 | 83 | 80+ (exact count not stated → registry null) | 13 (listed exactly) |
| Multi-speaker `reference_id[]` | yes (S2 family) | yes | yes | no |
| Emotion control | `[bracket]` natural-language cues, any expression | same | same | `(parenthesis)` 64+ fixed expressions |
| TTFA/DPA guarantees | yes | no | 100 ms TTFA | n/a |
| Output formats | wav, pcm, mp3 (default), opus | same | same | same |
| Word timestamps | yes — `POST /v1/tts/stream/with-timestamp` → `alignment.segments` (per-word `text`/`start`/`end`, chunk-local; add `chunk_audio_offset_sec` for global timeline) | same endpoint | endpoint model-agnostic; per-model not stated | per-model not stated → UNKNOWN |
| Per-request character limit | **NOT STATED anywhere → UNKNOWN (null)** | same | same | same |
| Pricing | **$15.00 / M UTF-8 bytes** | **$0** (fair use) | $15.00 / M UTF-8 bytes | $15.00 / M UTF-8 bytes |

## Rate limits (account tier, not per-model) — VERIFIED

Concurrent-request thresholds on total prepaid: < $100 → 5; ≥ $100 → 15;
≥ $1,000 → 50; enterprise custom. No per-model QPS stated.

## Also documented (FISH-004/FISH-006 surfaces)

- Pronunciation control: English CMU Arpabet, Chinese tone-number pinyin,
  Japanese romaji + pitch accent (docs.fish.audio/developer-guide/core-features/fine-grained-control/*)
- ASR `transcribe-1` at $0.36 / audio hour (billed to the second, rounded up)
- `voice-design-1` at $0.01 / successful request

## UNKNOWN / non-assumption policy (binding)

- No per-request character limit is stated anywhere in the Fish docs → the
  registry keeps `hardMaxCharacters: null`. Dialogue chunking stays a
  policy decision (runbook §30), never a fake provider limit.
- The free developer route (`s2.1-pro-free`) must not be assumed to stay free
  (runbook §30) — pricing is config-driven; `freeTier: true` is a fact about
  today's promo, not an architecture assumption.