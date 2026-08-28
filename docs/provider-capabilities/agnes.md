# Provider Capabilities — Agnes (Agnes AI)

Verified 2026-08-28 against the live official Agnes AI docs (all URLs fetched
HTTP 200 on that date). Registry data: `packages/capability-registry/src/data/agnes.ts`.

- Base URL: `https://apihub.agnes-ai.com/v1` (OpenAI-compatible; video tasks via
  `POST /v1/videos`, async retrieval via `GET /agnesapi?video_id=…&model_name=…`)
- Docs index: https://wiki.agnes-ai.com/llms.txt
- Sources read:
  - https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash
  - https://wiki.agnes-ai.com/en/docs/agnes-video-25
  - https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
  - https://wiki.agnes-ai.com/en/docs/pricing

## Agnes Video 2.5 Flash (`agnes-video-2.5-flash`) — VERIFIED

| Capability | Value | Source page |
|---|---|---|
| Modes | `text` / `keyframe` (first/last/both) / `reference` | video-25-flash |
| Duration | `seconds` string `"4"`–`"12"`, default `"5"` | video-25-flash |
| Resolution | `size` fixed `"720P"` only (else HTTP 400) | video-25-flash |
| Aspect ratios | 21:9, 16:9 (default), 4:3, 1:1, 3:4, 9:16 | video-25-flash |
| Reference images | max 5 (`images length must not exceed 5` HTTP 400) | video-25-flash |
| Reference video | NOT SUPPORTED (`videos is not supported` HTTP 400) | video-25-flash |
| Reference audio | per Video 2.5 common rules (max count not stated → UNKNOWN) | video-25-flash |
| First/last frame | yes (`first_frame`/`last_frame`, ≥1 required in keyframe mode) | video-25-flash |
| Outputs | `n` = 1 only | video-25-flash |
| Seed | `seed` integer supported | video-25-flash |
| Prompt hard max chars | **UNKNOWN — not stated on any Agnes page** | video-25-flash + video-25 |
| Negative prompt | not documented → UNKNOWN | video-25-flash |
| Pricing (list) | $0.025 / output second at 720P; currently **$0** (limited-time promo) | pricing |
| Excess input images | $0.005 each from the 6th (5 free) | pricing |

Retrieval: `video_id` + `model_name=agnes-video-2.5-flash` required for
keyframe/reference tasks; bare `video_id` works only for `mode: "text"`.

## Agnes Video 2.5 (`agnes-video-2.5`) — VERIFIED

| Capability | Value | Source page |
|---|---|---|
| Modes | `text` / `keyframe` / `reference` | video-25 |
| Duration | `seconds` string `"4"`–`"12"`, default `"5"` | video-25 |
| Resolutions | `"720P"`, `"960P"`, `"2K"` (exact pixels + `auto` rejected with 400) | video-25 |
| Aspect ratios | 21:9, 16:9 (default), 4:3, 1:1, 3:4, 9:16 | video-25 |
| Reference images | `images[]` accepted; **max count NOT stated → UNKNOWN** (first 5 free is a billing allowance, not a documented cap) | video-25 |
| Reference videos | `videos[]` objects (`url`, `start_seconds`, `require_audio`); max count NOT stated → UNKNOWN | video-25 |
| Reference audio | `audios[]` accepted; max count NOT stated → UNKNOWN | video-25 |
| Prompt hard max chars | **UNKNOWN — not stated** | video-25 |
| Pricing | 720P `$0.025/s` · 960P `$0.040/s` · 2K `$0.055/s`; billable = output s + input video s; images 6+ at $0.005 | pricing |

Mode exclusivity (both 2.5 variants): `keyframe` excludes
`images/audios/videos`; `reference` excludes `first_frame/last_frame` (Flash
additionally rejects any non-empty `videos`).

## Agnes Image 2.1 Flash (`agnes-image-2.1-flash`) — VERIFIED

Preferred image path (runbook §29); never architect around one image provider.

| Capability | Value | Source page |
|---|---|---|
| Endpoint | `POST /v1/images/generations` | image-21-flash |
| Modes | text-to-image, image-to-image (`image[]`), multi-image composition | image-21-flash |
| Sizes | tiers `1K` `2K` `3K` `4K` (legacy exact sizes may be normalized) | image-21-flash |
| Ratios | 1:1 (default), 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9 | image-21-flash |
| Reference images | multiple allowed; **max count NOT stated → UNKNOWN** (first 3 free at list price) | image-21-flash |
| Prompt hard max chars | **NOT STATED → UNKNOWN** | image-21-flash |
| Pricing (list) | `$10 / 1,000 images` every tier; all tiers + reference images currently **free** | pricing |

## UNKNOWN policy (binding)

The Agnes hard prompt character ceiling is not published on any official page.
It stays `null` (UNKNOWN) in the registry. Validators must not enforce a limit
against `null`; nobody may copy another model's 20,000 limit onto Agnes
(runbook §25: "preserve UNKNOWN for undocumented Agnes hard prompt maximum").
`agnes-video-v2.0` also exists and is currently free, but MMCS seeds only the
2.5 family (runbook §26 initial providers).