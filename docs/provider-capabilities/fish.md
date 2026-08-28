# Fish Audio Provider Capabilities

**Subsystem:** packages/providers/src/fish-audio/
**Facts verified live from official sources: 2026-08-28** (FISH-001).
Every fact below carries its source URL. Numeric limits not listed here stay
UNKNOWN/PROVISIONAL per spec §5 — never invented.

## API fundamentals

| Fact | Value | Source (fetched 2026-08-28) |
|---|---|---|
| Base URL | `https://api.fish.audio` | https://api.fish.audio/openapi.json (OpenAPI 3.1.0, `servers[0].url`) |
| Auth | `Authorization: Bearer <FISH_API_KEY>` — OpenAPI `securitySchemes.BearerAuth: {type: http, scheme: bearer}` | https://api.fish.audio/openapi.json |
| TTS (non-stream) | `POST https://api.fish.audio/v1/tts` — request body `application/json` or `application/msgpack`; response = binary audio in the requested format (no JSON envelope) | https://api.fish.audio/openapi.json (`/v1/tts`) |
| TTS (stream + timestamps) | `POST https://api.fish.audio/v1/tts/stream/with-timestamp` — same request fields, response `text/event-stream`; each SSE `data:` frame = one audio chunk (`audio_base64`) + cumulative `alignment` snapshot per `chunk_seq`; concatenate `audio_base64` in arrival order; REPLACE (do not append) a prior snapshot for the same `chunk_seq` | https://api.fish.audio/openapi.json (`/v1/tts/stream/with-timestamp`) |
| List voice models | `GET https://api.fish.audio/model` (query: `page_size`, `page_number`, `title`, `language`, `self`, `sort_by`) | https://api.fish.audio/openapi.json (`/model`) |
| Get voice model | `GET https://api.fish.audio/model/{id}` | https://api.fish.audio/openapi.json (`/model/{id}`) |
| Voice design | `POST https://api.fish.audio/v1/voice-design` → candidates with `audio_base64`, `sample_rate`, `duration_ms`, `text` | https://api.fish.audio/openapi.json (`/v1/voice-design`) |
| ASR | `POST https://api.fish.audio/v1/asr` (`multipart/form-data` or msgpack) | https://api.fish.audio/openapi.json (`/v1/asr`) |
| Error body shape | JSON `{"message": ..., "status": ...}` — "Every error returns a JSON body with a `message` and a `status`." | https://docs.fish.audio/api-reference/introduction |
| OpenAPI schema | https://api.fish.audio/openapi.json | fetched 2026-08-28 |

## Model selection (config-driven — never assumed)

Model travels in an optional **HTTP header `model`** on the TTS endpoints
(not in the JSON body). Verified header contract:

- Documented header values (enum): `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free`.
- Server default when the header is omitted or unrecognized: **falls back to
  `s2.1-pro`** (the paid production model).
- Header description (quoted): "Specify which TTS model to use. Use
  `s2.1-pro-free` for the free developer tier. If omitted or set to an
  unrecognized value, the request falls back to `s2.1-pro`."
  Source: https://api.fish.audio/openapi.json (`/v1/tts` header parameter `model`)

Source: https://api.fish.audio/openapi.json, fetched 2026-08-28.

## Models

| Model ID | Generation | Notes |
|---|---|---|
| `s2.1-pro` | S2.1 | "the recommended production model"; 83 languages; multi-speaker dialogue supported |
| `s2.1-pro-free` | S2.1 | "the same model at $0 for testing, prototyping, development, and smaller businesses, without TTFA or DPA guarantees"; "Free to use under fair-use limits"; **availability is NOT guaranteed and MUST NOT be assumed** — MMCS selects models from config |
| `s2-pro` | S2 | previous-gen, multi-speaker + NL expression; 80+ languages |
| `s1` | S1 | WER 0.008 / CER 0.004, TTS-Arena2 #1; 13 languages; **no multi-speaker** |

Sources: https://docs.fish.audio/ (landing), https://docs.fish.audio/developer-guide/models-pricing/models-overview, https://api.fish.audio/openapi.json — fetched 2026-08-28.

## Pricing (per UTF-8 byte of input text)

| Model | Price | Source (fetched 2026-08-28) |
|---|---|---|
| `s2.1-pro` | $15.00 / M UTF-8 bytes | https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits |
| `s2.1-pro-free` | $0.00 / M UTF-8 bytes | same |
| `s2-pro` | $15.00 / M UTF-8 bytes | same |
| `s1` | $15.00 / M UTF-8 bytes | same |

Volume hint: 1M UTF-8 bytes ≈ 180,000 English words ≈ 12 hours of speech.
Cost engine (FISH-010) must keep pricing config-driven — the free tier can be
retired and prices can change; this table is a verified snapshot, not a contract.

## Rate limits

No per-endpoint RPS/RPM caps documented. Limit is **concurrent in-flight
requests**, tiered by total prepaid spend (fetched 2026-08-28,
https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits):

| Tier | Threshold | Concurrent slots |
|---|---|---|
| Starter | < $100 paid | 5 |
| Elevated | ≥ $100 paid | 15 |
| High Volume | ≥ $1,000 paid | 50 |
| Enterprise | custom | custom |

"Concurrency tiers unlock as soon as your total prepaid amount reaches the
threshold. You do not need to spend the full balance first." QPS/QPM formulas
are provided but labeled "examples, not guarantees". The client therefore
retries 429/5xx with exponential backoff and honors `Retry-After`.

## TTSRequest fields (JSON body; verified against OpenAPI `TTSRequest`)

`text` (required), `temperature` (0–1, default 0.7), `top_p` (0–1, default
0.7), `references` (inline ReferenceAudio — zero-shot cloning, msgpack only),
`reference_id` (voice model ID string; array of IDs = S2-family
multi-speaker dialogue with `<|speaker:N|>` tags in `text`), `prosody`
(`speed` 0.5–2.0, `volume` dB, `normalize_loudness` — S2 family),
`chunk_length` (default 300), `normalize` (default true), `format`
(enum `wav|pcm|mp3|opus`, default mp3), `sample_rate`, `mp3_bitrate`
(64|128|192, default 128), `opus_bitrate`, `latency`
(enum `low|normal|balanced`, default normal), `max_new_tokens` (default
1024), `repetition_penalty` (default 1.2), `min_chunk_length` (default 50),
`condition_on_previous_chunks` (default true), `early_stop_threshold`
(default 1.0), `features` (e.g. `["quality-guard"]`).

Source: https://api.fish.audio/openapi.json, fetched 2026-08-28.

## Error semantics (TTS endpoint)

| Status | Meaning | Client treatment |
|---|---|---|
| 401 | No permission (auth) | terminal, no retry |
| 402 | No payment / credits exhausted | terminal, no retry |
| 429 | Rate limited (undocumented on TTS but standard; concurrency tiers above) | retry with `Retry-After` |
| 503 | "The server cannot process the request due to a high load" | retryable server-error |

Source: https://api.fish.audio/openapi.json (`/v1/tts` responses),
https://docs.fish.audio/api-reference/introduction — fetched 2026-08-28.

## Client contract (FISH-001, packages/providers/src/fish-audio/client/)

- Bearer auth from `FishClientConfig.apiKey` (engine config `FISH_API_KEY`).
  Key never logged: errors carry only status/kind/scrubbed server message.
- TTS model REQUIRED per call from config (`s2.1-pro-free` availability is
  recorded here but never defaulted).
- Per-attempt timeout (default 30s), bounded retries (default 3) with
  exponential backoff; retries network/timeout/429/5xx only.
- `POST /v1/tts` returns raw audio bytes; `POST /v1/tts/stream/with-timestamp`
  returns parsed SSE events (`audioBase64`, alignment segments, `chunkSeq`,
  `chunkAudioOffsetSec`).