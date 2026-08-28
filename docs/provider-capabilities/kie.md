# Provider Capabilities — Kie (kie.ai)

Verified 2026-08-28 against the live official Kie docs (all URLs fetched HTTP
200 on that date). Registry data: `packages/capability-registry/src/data/kie.ts`.
Adapter-side constants live with KIE-003 (Seedance) and KIE-005 (Wan); this
file is the capability-registry copy.

- API base: `https://api.kie.ai` (createTask / recordInfo jobs API)
- Sources read:
  - https://docs.kie.ai/market/bytedance/seedance-2-mini (OpenAPI schema)
  - https://docs.kie.ai/market/wan/3-0-video (OpenAPI schema)
  - https://docs.kie.ai/market/wan/3-0-video-prime
  - https://kie.ai/seedance-2-0-mini (pricing description)
  - https://kie.ai/wan3.0-video · https://kie.ai/wan3.0-video-prime (pricing)
  - https://docs.kie.ai/market/quickstart (rate limit)

## Seedance 2.0 Mini (`bytedance/seedance-2-mini`) — VERIFIED

| Capability | Value | Source |
|---|---|---|
| Prompt length | min 3 / max **20,000 chars** (schema `maxLength: 20000`) | schema |
| Modes (mutually exclusive) | first-frame I2V (`first_frame_url`); first+last-frame I2V; multimodal-reference (`reference_*_urls`) | schema |
| Reference images | max **9** (300–6000 px side, AR 0.4–2.5, ≤30 MB, jpeg/png/webp/bmp/tiff/gif) | schema |
| Reference videos | max **3**, each 2–15 s, total ≤15 s, 480p/720p, ≤50 MB, mp4/mov, 24–60 fps | schema |
| Reference audio | max **3**, each 2–15 s, total ≤15 s, ≤15 MB, wav/mp3 | schema |
| Duration | 4–15 s (description), default 5 | schema |
| Resolution | `480p` \| `720p`, default `720p` | schema |
| Aspect ratios | 1:1, 4:3, 3:4, 16:9 (default), 9:16, 21:9, adaptive | schema |
| `return_last_frame` | **UNKNOWN** — omitted from schema properties (example payload only; deprecated on seedance-2/-fast) → do not send | schema |
| Pricing | 480p 2.4 credits/s ($0.012/s) with video input, 3.8 ($0.019/s) without; 720p 5.0 ($0.025/s) with, 8.2 ($0.041/s) without; 1 credit = $0.005; with-video billing = rate × (input + output) | kie.ai page |
| Rate limit | 20 requests / 10 s (account-wide) | quickstart |

Mode exclusivity (runbook §26.3): never combine first/last-frame inputs with
any `reference_*_urls`. Unstated numeric values stay UNKNOWN/PROVISIONAL —
never invented.

## Wan 3.0 (`wan/3-0-video`) — VERIFIED

| Capability | Value | Source |
|---|---|---|
| Prompt length | max **20,000 chars** (server truncates excess — MMCS validates pre-submit; runbook §26.4) | schema |
| Reference images | max **10** (240–8000 px side, AR ≤8:1, ≤20 MB) | schema |
| Reference videos | max **5**, each 1–15 s, total ≤15 s, ≤100 MB; input s + output s ≤ 30 | schema |
| Reference audio | max **5**, each 1–15 s, total ≤15 s, ≤15 MB, wav/mp3 | schema |
| Reference files | max **1** (file-to-video; ≤100 MB, ≤50 pages) — exclusive with links + first/last frame | schema |
| Reference links | max **1** (link-to-video) — exclusive with files + first/last frame | schema |
| First/last frame | `first_frame_url` / `last_frame_url` (exclusive with all `reference_*_urls`) | schema |
| Duration | [2, 30] s without video input; default 5; `-1` = model-chosen sentinel | schema |
| Resolution | `480P` \| `720P` \| `1080P`, default **1080P** | schema |
| Aspect ratios | adaptive (default), 16:9, 4:3, 1:1, 3:4, 9:16 | schema |
| Audio track | `audio` boolean, default true | schema |
| Seed | `seed` integer documented | schema |
| Negative prompt | absent from schema → `false` (field does not exist) | schema |
| Pricing | 8 credits/s 480P ($0.04), 16/s 720P ($0.08), 32/s 1080P ($0.16); credit = $0.005; billed (input video s + output s) × rate | kie.ai page |

## Wan 3.0 Video Prime (`wan/3-0-video-prime`) — VERIFIED

Same capability envelope as the standard model (verified prime schema). Pricing:
12.2 credits/s 480P ($0.0612), 25.2/s 720P ($0.126), 50.4/s 1080P ($0.252) —
10% below official. Same (input + output) × rate rule.

## UNKNOWN policy (binding)

Anything the Kie schema does not state stays UNKNOWN/PROVISIONAL — never
invented (runbook §26.3/§26.4). Acceptance tests (runbook §25) require Wan
>20,000-char prompts and >10 reference images to be rejected BEFORE any
provider call, using exactly these registry numbers.