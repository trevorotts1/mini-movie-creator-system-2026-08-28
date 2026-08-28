/**
 * AGN-003 — Agnes image edit/compose types.
 *
 * Verified 2026-08-28 against the live Agnes Image 2.1 Flash doc
 * (https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash.md, fetched HTTP 200)
 * and the docs index (https://wiki.agnes-ai.com/llms.txt). The index lists
 * exactly two image pages (`agnes-image-20-flash`, `agnes-image-21-flash`);
 * the 2.1 page is the current one.
 *
 * WHAT THE LIVE API SUPPORTS (verified verdict):
 *
 *  - MULTI-IMAGE COMPOSE: supported. `POST /v1/images/generations` takes the
 *    reference/input image array in `extra_body.image[]` (public URLs or Data
 *    URI Base64); `model=agnes-image-2.1-flash` + `prompt` + `size` (+
 *    `ratio`) describe how the inputs combine.
 *
 *  - MASKED EDIT: NOT SUPPORTED. No `mask` parameter, no `masks` array, no
 *    `/v1/images/edits` endpoint, and no inpainting wording exists on either
 *    Image 2.1 Flash page or the docs index. The only edit mechanism is
 *    prompt-driven transform/redraw of the whole input image (`image[]` +
 *    prompt — "preserves the original composition and subject layout"). The
 *    module therefore exposes edit/compose behind capability flags that gate
 *    masked edit OFF (`supported: false`) and keep compose ON.
 *
 * The capability registry (`packages/capability-registry`) remains the routing
 * source of truth; this module owns the wire shape + the pinned mode verdict
 * so a future Agnes mask parameter changes exactly one record.
 */

/** Agnes Image 2.1 Flash — the only live image model (verified 2026-08-28). */
export const AGNES_IMAGE_MODEL = "agnes-image-2.1-flash";

/** Base URL used by every Agnes endpoint (OpenAI-compatible). */
export const AGNES_IMAGE_API_BASE = "https://apihub.agnes-ai.com/v1";

/** Endpoint for text-to-image, image-to-image and multi-image composition. */
export const AGNES_IMAGE_GENERATIONS_URL = `${AGNES_IMAGE_API_BASE}/images/generations`;

/** Doc-stated output size tiers (Image 2.1 Flash). */
export const AGNES_IMAGE_SIZES = ["1K", "2K", "3K", "4K"] as const;
export type AgnesImageSize = (typeof AGNES_IMAGE_SIZES)[number];

/** Doc-stated aspect ratios usable with tier-based `size` (default 1:1). */
export const AGNES_IMAGE_RATIOS = [
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
] as const;
export type AgnesImageRatio = (typeof AGNES_IMAGE_RATIOS)[number];

/**
 * Edit/compose capability verdict for the live Agnes image API.
 * Pinned to the values verified on 2026-08-28; when Agnes ships a mask
 * parameter, only this record changes.
 */
export interface AgnesImageEditCapability {
  /** Multi-image composition via extra_body.image[] (documented, VERIFIED). */
  readonly compose: { readonly supported: true };
  /**
   * Masked edit (inpainting): NOT SUPPORTED — no mask parameter and no
   * /edits endpoint on any official page as of 2026-08-28 (documented
   * evidence in docs/provider-capabilities/agnes.md).
   */
  readonly maskedEdit: { readonly supported: false };
  /** Doc URL the verdict was read from. */
  readonly sourceUrl: string;
  /** ISO date (YYYY-MM-DD) of the verification pass. */
  readonly verifiedOn: string;
}

/** The single Agnes edit/compose capability record (verified 2026-08-28). */
export const AGNES_IMAGE_EDIT_CAPABILITY: Readonly<AgnesImageEditCapability> =
  Object.freeze({
    compose: { supported: true },
    maskedEdit: { supported: false },
    sourceUrl: "https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash",
    verifiedOn: "2026-08-28",
  } as const satisfies AgnesImageEditCapability);

/**
 * One input image: a public URL or a Data URI Base64 string.
 * Doc: "Supports public image URLs or Data URI Base64."
 */
export interface AgnesImageInput {
  readonly url: string;
}

/** Input accepted by the compose request builder. */
export interface AgnesImageComposeInput {
  /** Text instruction describing the composition. REQUIRED by the doc. */
  prompt: string;
  /** Input images (order matters — the prompt describes each image's role). */
  images: readonly AgnesImageInput[];
  /** Output size tier: "1K" | "2K" | "3K" | "4K". REQUIRED by the doc. */
  size: AgnesImageSize;
  /** Aspect ratio; default "1:1" when omitted. */
  ratio?: AgnesImageRatio;
}

/** Output constraints of the Agnes Image 2.1 Flash edit/compose API. */
export const AGNES_IMAGE_OUTPUT_CONSTRAINTS = Object.freeze({
  /** Doc-stated size tiers; `size` is REQUIRED in every request. */
  sizes: AGNES_IMAGE_SIZES,
  /** Doc-stated ratios; omitted ratio defaults to "1:1" per the doc. */
  ratios: AGNES_IMAGE_RATIOS,
  /** Default aspect ratio when `ratio` is omitted (doc). */
  defaultRatio: "1:1" as const,
  /** Response format requested by MMCS (default `url` output). */
  responseFormat: "url" as const,
  /** Doc's note that editing preserves the input composition/layout. */
  editPreservesComposition: true,
} as const);

/**
 * Request envelope for POST /v1/images/generations (compose mode).
 * Wire shape per the doc table: `model`, `prompt`, `size`, `ratio`,
 * `extra_body.image[]`. `return_base64`/`response_format` are deliberately not
 * surfaced here — MMCS always requests the default `url` output.
 */
export interface AgnesImageComposeRequest {
  model: typeof AGNES_IMAGE_MODEL;
  prompt: string;
  size: AgnesImageSize;
  ratio?: AgnesImageRatio;
  extra_body: {
    image: readonly string[];
  };
}

/** One generated image from the OpenAI-compatible response envelope. */
export interface AgnesImageGeneratedResult {
  /** public URL of the generated image (or b64_json when response_format set). */
  url?: string;
  b64_json?: string;
  /** Echoed request identifier supplied by Agnes. */
  revised_prompt?: string;
}

/** Normalized success payload for one compose request. */
export interface AgnesImageComposeResult {
  /** Generated image URL when the default `url` response format is used. */
  url?: string;
  /** Generated image base64 when `return_base64`/b64_json is used. */
  b64Json?: string;
}

/**
 * Unified error result. Fetch from a capability or a validator gate: the
 * caller decides before any HTTP request is made.
 */
export interface AgnesImageError {
  readonly code:
    | "MASKED_EDIT_UNSUPPORTED"
    | "INVALID_REQUEST"
    | "HTTP_ERROR";
  readonly message: string;
}

/** Result union for request building / capability consulting. */
export type AgnesImageResult<T> = { ok: true; value: T } | { ok: false; error: AgnesImageError };
