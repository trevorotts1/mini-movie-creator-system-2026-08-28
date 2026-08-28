# Kie.ai Provider Capabilities

**Subsystem:** packages/providers/src/kie/
**Facts verified live from docs.kie.ai: 2026-08-28** (KIE-001).
Every fact below carries its source URL. Numeric limits not listed here stay
UNKNOWN/PROVISIONAL per spec §5 — never invented.

## API fundamentals

| Fact | Value | Source (fetched 2026-08-28) |
|---|---|---|
| Base URL | `https://api.kie.ai` | https://docs.kie.ai/market/quickstart |
| Auth | `Authorization: Bearer <KIE_API_KEY>` + `Content-Type: application/json` | https://docs.kie.ai/ |
| Create task | `POST https://api.kie.ai/api/v1/jobs/createTask` | https://docs.kie.ai/market/quickstart |
| Query task | `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId={taskId}` | https://docs.kie.ai/market/common/get-task-detail |
| Credits | `GET https://api.kie.ai/api/v1/chat/credit` | https://docs.kie.ai/market/quickstart |
| API key page | https://kie.ai/api-key | https://docs.kie.ai/ |

## Async semantics (critical)

- HTTP `200` on createTask means **task created**, NOT task completed.
  https://docs.kie.ai/
- Final result arrives via optional `callBackUrl` webhook **or** polling
  `recordInfo` with the `taskId`.
- Recommended polling: exponential backoff 2–3s; stop after 10–15 min.
  https://docs.kie.ai/market/common/get-task-detail
- Rate limit: up to **20 new generation requests per 10 seconds**; excess
  requests rejected with HTTP 429 and **do not enter the queue**.
  https://docs.kie.ai/
- Retention: generated media stored **14 days**; log records **2 months**;
  result URLs expire **24h** (OmniHuman mask URLs 1h). https://docs.kie.ai/

## JSON envelope (all /api/v1 responses)

```json
{ "code": 200, "msg": "success", "data": { "taskId": "task_bytedance_1765186743319" } }
```

- Top-level fields: `code` (int), `msg` (string), `data` (object|null).
- `code` 200 = success; documented error codes: 200, 401, 402, 404, 422, 429,
  433, 455, 500, 501, 505. Example 422: `{"code":422,"msg":"recordInfo is null","data":null}`.
- Auth failure (missing/malformed bearer): `{"code":401,"msg":"You do not have access permissions"}`.
  Sources: https://docs.kie.ai/market/common/get-task-detail, https://docs.kie.ai/

## recordInfo response `data` fields

`taskId` (string), `model` (string, e.g. `grok-imagine/text-to-image`),
`state` (enum: `waiting` | `queuing` | `generating` | `success` | `fail`),
`param` (JSON string of original request params), `resultJson` (JSON string,
present on success), `failCode` (string), `failMsg` (string),
`costTime` (int64 ms), `createTime`/`updateTime`/`completeTime` (int64 Unix ms),
`progress` (int 0–100, sora2 only), `creditsConsumed` (number).
Source: https://docs.kie.ai/market/common/get-task-detail

## resultJson shapes

- Media: `{"resultUrls":["https://..."]}`
- Seedance 2 with `return_last_frame`: `{"resultUrls":[],"firstFrameUrl":[],"lastFrameUrl":[]}`
- Text output: `{"resultObject":{}}`
Source: https://docs.kie.ai/market/common/get-task-detail

## Seedance 2.0 Mini (video)

Model string: `bytedance/seedance-2-mini`. Source (fetched 2026-08-28):
https://docs.kie.ai/market/bytedance/seedance-2-mini

Request body: `{model, input, callBackUrl?}`; `input` fields:

| Field | Type | Constraint |
|---|---|---|
| `prompt` | string | required, 3–20000 chars |
| `first_frame_url` | uri | optional |
| `last_frame_url` | uri | optional |
| `reference_image_urls` | uri[] | optional, maxItems 9 |
| `reference_video_urls` | uri[] | optional, maxItems 3 |
| `reference_audio_urls` | uri[] | optional, maxItems 3 |
| `generate_audio` | boolean | optional, default true |
| `resolution` | enum | `480p` \| `720p`, default `720p` |
| `aspect_ratio` | enum | `1:1`,`4:3`,`3:4`,`16:9`,`9:16`,`21:9`,`adaptive`; required, default `16:9` |
| `duration` | int | optional, default 5, range 4–15 s |
| `web_search` | boolean | optional, t2v scene only |
| `nsfw_checker` | boolean | optional |

Generation modes are mutually exclusive: first-frame I2V; first+last-frame I2V;
multimodal reference (images/videos/audio). Never combine.
Source: page above. (Spec §5 said "verify at build time" — these are the
verified values; note maxItems 9 ref images / maxItems 3 ref videos+audio are
the current doc values, not the older research baseline.)

## Wan 3.0 (video)

Model string: `wan/3-0-video`. Endpoint: `POST https://api.kie.ai/api/v3/jobs/createTask`
(note: **/api/v3/** for this model family, not /api/v1/).
Source (fetched 2026-08-28): https://docs.kie.ai/market/wan/3-0-video

`input` fields (verified): `prompt` (max 20000 chars); `first_frame_url`,
`last_frame_url` (image spec objects); `reference_image_urls` (maxItems 10);
`reference_video_urls` (maxItems 5, each 1–15s, total ≤15s, mp4/mov ≤100MB);
`reference_audio_urls` (maxItems 5, each 1–15s, total ≤15s, wav/mp3 ≤15MB);
`reference_file_urls` (maxItems 1); `reference_link_urls` (maxItems 1);
`resolution` enum `480P`|`720P`|`1080P` (default `1080P`); `aspect_ratio` enum
`adaptive`,`16:9`,`4:3`,`1:1`,`3:4`,`9:16` (default `adaptive`); `duration` int
default 5, range 2–30 (−1 = model-chosen); `audio` boolean default true;
`seed` int [0, 2147483647]; `nsfw_checker` boolean default false.

Mutual exclusions (verified): frame URLs cannot pair with any `reference_*_urls`;
`reference_file_urls` cannot pair with `reference_link_urls` or frame URLs.

Spec §5 baseline vs live docs discrepancies (log per §33): baseline said
"≤10 ref images, ≤5 ref videos, ≤5 ref audio, ≤30s, 480p/720p/1080p" — live docs
CONFIRM all of those; live docs additionally document `reference_file_urls`,
`reference_link_urls`, `seed`, and `-1` duration sentinel.

## Callback payload (POST to callBackUrl)

Top-level `{code: 200|501, msg, data}`; `data` carries `taskId`, `model`,
`state` (`success`|`fail`), `param`, `resultJson` (nullable JSON string),
`failCode`, `failMsg`, `costTime`, `completeTime`, `createTime`, `updateTime`,
`creditsConsumed`. Sources: seedance-2-mini + wan/3-0-video pages above.

## Market scope (non-video, for later tasks)

docs.kie.ai sitemap (fetched 2026-08-28) also covers image models
(Seedream v4–v5, nano-banana, Flux 2, GPT Image, Qwen image…), audio
(ElevenLabs, Google TTS, Suno), and chat LLMs. Only video providers are in
MMCS V1 scope (spec §5); record here that the same createTask/recordInfo
transport applies.

## Client contract (KIE-001 implementation)

- Bearer auth from validated engine config (`KIE_API_KEY`, CORE-010 schema).
- Per-attempt timeout (default 30s), bounded retries (default 3) on
  network/timeout/429/5xx, exponential backoff (500ms base), 429 honors
  `Retry-After` (capped 30s).
- Envelope validation: HTTP 2xx with `code != 200` is a failure; non-JSON or
  malformed envelope is `bad-response` (terminal).
- The API key never appears in errors, retry callbacks, or log lines.