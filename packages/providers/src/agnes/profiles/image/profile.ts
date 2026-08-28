/**
 * Agnes Image request profile — sizes, aspect ratios, reference-image rules,
 * and per-call limits for `agnes-image-2.1-flash` (@mmcs/providers/agnes/image).
 *
 * Task AGN-002. This module is the model-specific REQUEST PROFILE consumed by
 * the pre-request validation chain (spec §14: resolve capability profile →
 * compile prompt → count characters → validate references → validate modes →
 * estimate spend → only then submit). It encodes ONLY values read from the
 * live official Agnes AI docs on 2026-08-28 (all URLs fetched HTTP 200):
 *   - https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash
 *   - https://wiki.agnes-ai.com/en/docs/pricing
 *
 * Everything the docs do NOT state stays UNKNOWN (spec §14: "never invent a
 * number to replace UNKNOWN") — most importantly the prompt character
 * ceiling, the maximum reference-image count, seed support, and rate limits.
 * A sibling capability seed already carries these same numbers in
 * `@mmcs/capability-registry/src/data/agnes.ts` (CAP-002); this profile is
 * the request-builder/validation side of the same verified facts.
 */

/** Verified-on stamp (ISO date) shared by every VERIFIED limit below. */
export const AGNES_IMAGE_VERIFIED_ON = "2026-08-28";

/** Official docs the verified values were read from. */
export const AGNES_IMAGE_SOURCE_URLS = [
  "https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash",
  "https://wiki.agnes-ai.com/en/docs/pricing",
] as const;

/** Default image model (preferred image path, spec §15). */
export const AGNES_IMAGE_2_1_FLASH_MODEL = "agnes-image-2.1-flash";

/** Images endpoint — synchronous (no task id returned). */
export const AGNES_IMAGE_GENERATIONS_URL =
  "https://apihub.agnes-ai.com/v1/images/generations";

/**
 * Recommended client timeout window from the docs: 60s–360s. The adapter
 * default is the upper bound so no generation dies client-side.
 */
export const AGNES_IMAGE_TIMEOUT_MS_RANGE = [60_000, 360_000] as const;
export const AGNES_IMAGE_DEFAULT_TIMEOUT_MS: number =
  AGNES_IMAGE_TIMEOUT_MS_RANGE[1];

/** A capability limit whose value the live Agnes docs do NOT state. */
export interface UnknownLimit {
  readonly status: "UNKNOWN";
  /** Why the value is unknown — where verification was attempted. */
  readonly note: string;
}

/** A capability limit stated by the live Agnes docs. */
export interface VerifiedLimit<T> {
  readonly status: "VERIFIED";
  /** Doc URL the value was read from. */
  readonly source: string;
  /** Date the doc was verified, ISO YYYY-MM-DD. */
  readonly verifiedOn: string;
  readonly value: T;
}

/** An MMCS adapter policy choice where the docs state NO value (runbook §16
 * confidence vocabulary: PROVISIONAL). Never labeled VERIFIED. */
export interface ProvisionalLimit<T> {
  readonly status: "PROVISIONAL";
  /** Why provisional — what the docs do/do not say. */
  readonly note: string;
  readonly value: T;
}

/** A verified value, a provisional adapter policy, or an explicit UNKNOWN. */
export type Limit<T> = VerifiedLimit<T> | UnknownLimit | ProvisionalLimit<T>;

/** Output size tiers documented for the images API (legacy exact pixel
 * sizes like `1024x768` are accepted but normalized by the provider; MMCS
 * passes tiers only). */
export const AGNES_IMAGE_SIZES = ["1K", "2K", "3K", "4K"] as const;
export type AgnesImageSize = (typeof AGNES_IMAGE_SIZES)[number];

/** Aspect ratios documented for `ratio` (default `1:1`). */
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

/** `response_format` values; must be nested under `extra_body` (top-level
 * placement returns HTTP 400 per the docs pitfall note). */
export const AGNES_IMAGE_RESPONSE_FORMATS = ["url", "b64_json"] as const;
export type AgnesImageResponseFormat =
  (typeof AGNES_IMAGE_RESPONSE_FORMATS)[number];

/** List price per output image for each tier, in USD (docs pricing table:
 * $10/$18/$21/$24 per 1,000 images; currently $0 promo). */
export const AGNES_IMAGE_LIST_USD_PER_IMAGE: Readonly<
  Record<AgnesImageSize, number>
> = Object.freeze({
  "1K": 0.01,
  "2K": 0.018,
  "3K": 0.021,
  "4K": 0.024,
});

/**
 * Free allowance + overage for INPUT reference images (docs billing rule):
 * first 3 input images free at list price; from the 4th onward
 * $0.003/image (currently $0 promo).
 */
export const AGNES_IMAGE_FREE_INPUT_IMAGES = 3;
export const AGNES_IMAGE_LIST_USD_PER_EXCESS_INPUT_IMAGE = 0.003;

/**
 * Input reference images: public HTTPS URLs or `data:` URIs (docs). No
 * private/cookie-protected hosts — the provider fetches the URL itself.
 */
export const AGNES_IMAGE_REFERENCE_URL_SCHEMES = [
  "https://",
  "data:",
] as const;

/** Per-call limits exactly as stated (or not stated) by the live docs. */
export const AGNES_IMAGE_2_1_FLASH_LIMITS: Readonly<{
  /** Prompt string character ceiling. NOT stated anywhere → UNKNOWN. */
  promptHardMaxCharacters: UnknownLimit;
  /** Seed parameter. Not documented for the image API → UNKNOWN. */
  seed: UnknownLimit;
  /** Number of output images per request (`n`). No such param → UNKNOWN. */
  outputImagesPerCall: UnknownLimit;
  /** Negative prompt support. No such param → UNKNOWN. */
  negativePrompt: UnknownLimit;
  /** Max count of input reference images. Only a 3-free billing rule is
   * documented — that is pricing, not a hard cap → UNKNOWN. */
  maxReferenceImages: UnknownLimit;
  /** Output size tiers. */
  sizes: VerifiedLimit<readonly string[]>;
  /** MMCS adapter default tier when `size` is omitted. Docs state NO
   * default and mark `size` required → PROVISIONAL policy, never VERIFIED. */
  sizeDefault: ProvisionalLimit<AgnesImageSize>;
  /** Aspect-ratio enum. */
  ratios: VerifiedLimit<readonly string[]>;
  /** Default ratio when `ratio` is omitted. */
  ratioDefault: VerifiedLimit<string>;
  /** Output-count per call is exactly the single `data[]` item the docs
   * show; MMCS treats each call as one output image. */
  outputsPerCall: VerifiedLimit<number>;
  /** Reference URL forms accepted. */
  referenceUrlSchemes: VerifiedLimit<readonly string[]>;
  /** Free input-image allowance before per-image overage. */
  freeInputImages: VerifiedLimit<number>;
  /** Per-image list price per tier. */
  listUsdPerImage: VerifiedLimit<Record<AgnesImageSize, number>>;
  /** Per-image overage for input references above the allowance. */
  listUsdPerExcessInputImage: VerifiedLimit<number>;
  /** Recommended client timeout window, ms. */
  timeoutMsRange: VerifiedLimit<readonly [number, number]>;
}> = {
  promptHardMaxCharacters: {
    status: "UNKNOWN",
    note: "No prompt character limit stated on the Agnes Image 2.1 Flash doc page (checked 2026-08-28). Preserved UNKNOWN — spec §14 forbids inventing a ceiling.",
  },
  seed: {
    status: "UNKNOWN",
    note: "Seed parameter not documented for the images API (checked 2026-08-28). Omitted from requests, never asserted.",
  },
  outputImagesPerCall: {
    status: "UNKNOWN",
    note: "No `n` parameter exists in the documented schema; response shows a single data[] item. Treated UNKNOWN — do not send n, never rely on multiple outputs.",
  },
  negativePrompt: {
    status: "UNKNOWN",
    note: "No negative_prompt parameter documented (checked 2026-08-28). Do not send.",
  },
  maxReferenceImages: {
    status: "UNKNOWN",
    note: "image[] supports multiple for edit/composition; the only stated number is the first-3-free billing rule, which is pricing, not a hard cap → UNKNOWN.",
  },
  sizes: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_SIZES,
  },
  sizeDefault: {
    status: "PROVISIONAL",
    note: "Docs state NO default for `size` (page marks it required; no sentence names a fallback tier). Adapter policy: default to the cheapest tier 1K when omitted. PROVISIONAL — flagged, not VERIFIED (runbook §16: never label an unstated value VERIFIED).",
    value: "1K",
  },
  ratios: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_RATIOS,
  },
  ratioDefault: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: "1:1",
  },
  outputsPerCall: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: 1,
  },
  referenceUrlSchemes: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_REFERENCE_URL_SCHEMES,
  },
  freeInputImages: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[1],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_FREE_INPUT_IMAGES,
  },
  listUsdPerImage: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[1],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_LIST_USD_PER_IMAGE,
  },
  listUsdPerExcessInputImage: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[1],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_LIST_USD_PER_EXCESS_INPUT_IMAGE,
  },
  timeoutMsRange: {
    status: "VERIFIED",
    source: AGNES_IMAGE_SOURCE_URLS[0],
    verifiedOn: AGNES_IMAGE_VERIFIED_ON,
    value: AGNES_IMAGE_TIMEOUT_MS_RANGE,
  },
};

/** Mutually exclusive request modes, selected purely by input-image count
 * (docs: text-to-image vs image-to-image vs multi-image composition all share
 * the one endpoint; there are no tags and no separate compose endpoint). */
export type AgnesImageMode = "text-to-image" | "edit" | "compose";

/** Classify the generation mode from the reference-image list. */
export function agnesImageMode(
  images: readonly string[] | undefined,
): AgnesImageMode {
  const count = images?.length ?? 0;
  if (count === 0) return "text-to-image";
  if (count === 1) return "edit";
  return "compose";
}

/** True when the URL is an accepted reference form (public HTTPS or data: URI). */
export function isAgnesImageReferenceUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("data:");
}

/** A single validation failure against the live Agnes images schema. */
export interface AgnesImageValidationError {
  /** Dotted path to the offending field (e.g. "size"). */
  field: string;
  message: string;
}

/** Result of validating a request against the live Agnes images schema. */
export interface AgnesImageValidationResult {
  ok: boolean;
  mode?: AgnesImageMode;
  errors: AgnesImageValidationError[];
}

/** Adapter-level input for one image call (model-agnostic field names). */
export interface AgnesImageInput {
  /** Text instruction. Prompt hard max UNKNOWN — never enforced against a guess. */
  prompt: string;
  /** Output size tier; default "1K". */
  size?: AgnesImageSize;
  /** Aspect ratio; default "1:1". */
  ratio?: AgnesImageRatio;
  /** 0 images → text-to-image; 1 → edit; ≥2 → compose. Max count UNKNOWN. */
  images?: readonly string[];
  /** `url` | `b64_json` — ALWAYS sent under extra_body (never top-level). */
  responseFormat?: AgnesImageResponseFormat;
  /** Docs: top-level `return_base64` boolean for Base64 output (text-to-image). */
  returnBase64?: boolean;
  /** Agnes model id; defaults to {@link AGNES_IMAGE_2_1_FLASH_MODEL}. */
  model?: string;
}

/** Exact Agnes images/generations request body (wire format).
 *
 * Docs-verified placements (https://wiki.agnes-ai.com/en/docs/agnes-image-21-flash,
 * checked 2026-08-28):
 * - `model` / `prompt` / `size` top-level.
 * - `ratio` top-level (size+ratio pairing; legacy exact pixels unsupported for ratio pairing).
 * - `return_base64` top-level (text-to-image only).
 * - Input reference images ONLY inside `extra_body.image` — every img2img and
 *   multi-image example nests them there; no example shows a top-level `image`.
 * - `response_format` ONLY inside `extra_body` — top-level placement returns HTTP 400.
 */
export interface AgnesImageApiRequest {
  model: string;
  prompt: string;
  size: string;
  ratio?: string;
  return_base64?: boolean;
  /** Advanced params — response_format and input image[] MUST live here. */
  extra_body?: {
    response_format?: AgnesImageResponseFormat;
    /** Input reference images (HTTPS URLs or data: URIs). */
    image?: string[];
  };
}

/** Validate an adapter-level input against the verified profile. */
export function validateAgnesImageRequest(
  input: AgnesImageInput,
): AgnesImageValidationResult {
  const errors: AgnesImageValidationError[] = [];

  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    errors.push({ field: "prompt", message: "prompt is required" });
  } else if (AGNES_IMAGE_2_1_FLASH_LIMITS.promptHardMaxCharacters.status ===
    "UNKNOWN") {
    // Prompt max is UNKNOWN — no character-limit error may ever be produced
    // (spec §14: never invent a ceiling). Recorded deliberately as a no-op
    // guard: if this line ever becomes a limit check, a test fails.
  }

  if (
    input.size !== undefined &&
    !AGNES_IMAGE_SIZES.includes(input.size)
  ) {
    errors.push({
      field: "size",
      message: `size must be one of ${AGNES_IMAGE_SIZES.join(", ")} (legacy exact pixel sizes are normalized by the provider — MMCS passes tiers only)`,
    });
  }
  if (
    input.ratio !== undefined &&
    !AGNES_IMAGE_RATIOS.includes(input.ratio)
  ) {
    errors.push({
      field: "ratio",
      message: `ratio must be one of ${AGNES_IMAGE_RATIOS.join(", ")}`,
    });
  }
  if (
    input.responseFormat !== undefined &&
    !AGNES_IMAGE_RESPONSE_FORMATS.includes(input.responseFormat)
  ) {
    errors.push({
      field: "response_format",
      message: `response_format must be one of ${AGNES_IMAGE_RESPONSE_FORMATS.join(", ")}`,
    });
  }

  if (input.images !== undefined) {
    input.images.forEach((url, i) => {
      if (!isAgnesImageReferenceUrl(url)) {
        errors.push({
          field: `image[${i}]`,
          message:
            "reference images must be public HTTPS URLs or data: URIs (no private/cookie-protected hosts)",
        });
      }
    });
  }

  const ok = errors.length === 0;
  return { ok, mode: ok ? agnesImageMode(input.images) : undefined, errors };
}

/** Build the exact wire request for a validated input.
 *
 * Pitfalls encoded here (docs-verified 2026-08-28):
 * - `response_format` goes under `extra_body` — top-level returns HTTP 400.
 * - Reference images ride `extra_body.image` ONLY (every img2img /
 *   multi-image doc example nests them there; no top-level `image` exists).
 * - No `n`, no `seed`, no `negative_prompt`, no task id is ever sent.
 */
export function buildAgnesImageRequest(
  input: AgnesImageInput,
): AgnesImageApiRequest {
  const images = input.images ?? [];
  const request: AgnesImageApiRequest = {
    model: input.model ?? AGNES_IMAGE_2_1_FLASH_MODEL,
    prompt: input.prompt,
    size: input.size ?? AGNES_IMAGE_2_1_FLASH_LIMITS.sizeDefault.value,
  };
  if (input.ratio !== undefined) request.ratio = input.ratio;
  if (input.returnBase64 !== undefined)
    request.return_base64 = input.returnBase64;
  if (input.responseFormat !== undefined || images.length > 0) {
    request.extra_body = {};
    if (input.responseFormat !== undefined) {
      request.extra_body.response_format = input.responseFormat;
    }
    if (images.length > 0) request.extra_body.image = [...images];
  }
  return request;
}

/**
 * List-price spend estimate for one image call (spec §4 reservation input).
 * Uses list prices; current promo ($0) is a provider-side temporary state
 * and never assumed. Returns null components where the docs leave a value
 * UNKNOWN (never a guessed number).
 */
export function estimateAgnesImageCost(
  input: AgnesImageInput,
): {
  currency: "USD";
  /** null when size is outside the verified tier set. */
  listUsdTotal: number | null;
  /** Input-image overage at list price (first 3 free). */
  excessInputImages: number;
  excessInputUsdTotal: number;
  unknownNotes: string[];
} {
  const size = input.size ?? AGNES_IMAGE_2_1_FLASH_LIMITS.sizeDefault.value;
  const unknownNotes: string[] = [];
  const perImage = AGNES_IMAGE_LIST_USD_PER_IMAGE[size];
  const listUsdTotal = perImage ?? null;
  if (perImage === undefined) unknownNotes.push(`unverified size tier ${size}`);

  const imageCount = input.images?.length ?? 0;
  const excessInputImages = Math.max(
    0,
    imageCount - AGNES_IMAGE_FREE_INPUT_IMAGES,
  );
  const excessInputUsdTotal =
    excessInputImages * AGNES_IMAGE_LIST_USD_PER_EXCESS_INPUT_IMAGE;
  if (imageCount > 0) {
    unknownNotes.push(
      "max reference-image count is UNKNOWN (only the 3-free pricing rule is documented)",
    );
  }
  return {
    currency: "USD",
    listUsdTotal,
    excessInputImages,
    excessInputUsdTotal,
    unknownNotes,
  };
}
