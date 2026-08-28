# Provider Capabilities — Reasoning / Vision LLMs (runbook §28)

Verified 2026-08-28 against the OpenRouter public model catalog API
(https://openrouter.ai/api/v1/models — the router's own machine-readable
listing, fetched HTTP 200; z-ai/glm-5.3-flash page also fetched). Registry
data: `packages/capability-registry/src/data/reasoning.ts`.

Confidence is **PROVISIONAL** for all four: OpenRouter metadata is authoritative
for routing slugs/pricing but is not the model vendor's own documentation.
CAP-007 (reasoning registry) and CAP-008 (MAX_REASONING mapper) should
re-verify against vendor cards before shipping per-adapter behavior.

## Presets

| Model | OpenRouter slug | Context | Max completion | Vision (image in) | Video in | Effort ladder | MAX_REASONING → | $/M in | $/M out |
|---|---|---|---|---|---|---|---|---|---|
| GLM 5.3 Flash (Z.ai) | `z-ai/glm-5.3-flash` | 1,310,720 | 131,072 | yes | yes | max, high, low (default max) | **max** | 0.075 | 0.25 |
| DeepSeek V4 Flash Vision Exp | `deepseek/deepseek-v4-flash-vision-exp` | 1,048,576 | 384,000 | yes | **no** (frames) | max, high, low (default high) | **max** | 0.22 | 0.66 |
| Qwen 3.8 Flash (Alibaba) | `qwen/qwen3.8-flash` | 1,000,000 | 131,072 | yes | yes | **none published** (toggle only) | **null — unmappable** | 0.15 | 0.47 |
| Gemini 3.7 Flash (Google) | `google/gemini-3.7-flash` | 1,048,576 | 65,536 | yes | yes (also file+audio) | high, medium, low (default medium) | **high** | 0.375 | 1.875 |

Notes:

- Gemini 3.7 Flash has **no literal `"max"` effort** — the highest supported
  effort is `high`. Runbook §28: "never assume every API accepts literal
  'max'" — this is the case in point.
- Qwen 3.8 Flash exposes a `reasoning` toggle but no effort ladder in the
  catalog → `supportedEfforts: null`, `maxReasoningEffort: null`. CAP-008 must
  map MAX_REASONING for that route from vendor docs, never from this registry.
- DeepSeek V4 Flash Vision Exp is image-only: if selected for video QC, FFmpeg
  extracts representative frames first (runbook §28).
- `google/gemini-3.7-flash:batch` exists at half price (0.1875 / 0.9375 per M).

## Registry rules implemented here

1. Effort ladders are **per-model data** (`supportedEfforts`), not shared
   constants — the test suite locks this.
2. `vision` / `videoInput` flags decide direct-video vs frame-extraction QC
   routing.
3. Never closed to four models: any compatible OpenRouter model id may be
   added as a new seed row with the same provenance triple.