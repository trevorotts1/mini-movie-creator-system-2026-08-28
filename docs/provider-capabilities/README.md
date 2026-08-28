# Provider Capability Documentation (CAP-002)

One file per provider family. Every value in these files is mirrored in the
machine-readable registry at `packages/capability-registry/src/data/` and
carries the provenance triple: `lastVerifiedAt` + `sourceUrls` + `confidence`.

| File | Provider family | Seeded models |
|---|---|---|
| `agnes.md` | Agnes AI (video + image) | agnes-video-2.5-flash, agnes-video-2.5, agnes-image-2.1-flash |
| `kie.md` | Kie.ai (video) | bytedance/seedance-2-mini, wan/3-0-video, wan/3-0-video-prime |
| `fish-audio.md` | Fish Audio (voice) | s2.1-pro, s2.1-pro-free, s2-pro, s1 |
| `reasoning-models.md` | OpenRouter (reasoning/vision) | z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash-vision-exp, qwen/qwen3.8-flash, google/gemini-3.7-flash |

## Confidence meanings

- **VERIFIED** — value read from the provider's own live docs on
  `lastVerifiedAt` (Agnes, Kie, Fish data).
- **PROVISIONAL** — value from an authoritative router catalog (OpenRouter
  model API), not the vendor's own docs; re-verify at adapter build.
- **UNKNOWN** — the provider does not state the value; the registry keeps
  `null` and a `notes` entry explaining what was checked. UNKNOWN IS VALID.
  Never invent a value to fill a null — specifically, the Agnes hard prompt
  character ceiling stays UNKNOWN (runbook §25/§26.1/§26.2), and a test
  asserts it.

## Maintenance rule

Re-verify every source URL before changing a number. Promotional prices
(currently $0 for several Agnes models and the Fish free tier) are recorded as
`pricingDetail` entries with their list prices — MMCS must not architect around
promotions (runbook §30).