/**
 * AGN-003 — compose request builder for the Agnes Image 2.1 Flash API.
 *
 * Wire shape verified against the live doc table (2026-08-28):
 *   model=agnes-image-2.1-flash (required)
 *   prompt (required; "text instruction for image generation or image editing")
 *   size ("1K"|"2K"|"3K"|"4K", required)
 *   ratio (optional, defaults "1:1")
 *   extra_body.image[] (required for image-to-image / multi-image composition;
 *                       public URLs or Data URI Base64)
 */

import {
  AGNES_IMAGE_GENERATIONS_URL,
  AGNES_IMAGE_MODEL,
  type AgnesImageComposeInput,
  type AgnesImageComposeRequest,
  type AgnesImageResult,
} from "./types.js";
import {
  validateComposeImageUrls,
  validateComposeInputCount,
  validateComposeOutputConstraints,
  validateComposePrompt,
} from "./modes.js";

/** Build the POST /v1/images/generations body for a compose request. */
export function buildAgnesImageComposeRequest(
  input: AgnesImageComposeInput,
): AgnesImageResult<AgnesImageComposeRequest> {
  const prompt = validateComposePrompt(input.prompt);
  if (!prompt.ok) {
    return prompt;
  }
  const count = validateComposeInputCount(input.images);
  if (!count.ok) {
    return count;
  }
  const urls = validateComposeImageUrls(input.images);
  if (!urls.ok) {
    return urls;
  }
  const constraints = validateComposeOutputConstraints(input.size, input.ratio);
  if (!constraints.ok) {
    return constraints;
  }

  const request: AgnesImageComposeRequest = {
    model: AGNES_IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size,
    extra_body: {
      image: input.images.map((image) => image.url),
    },
  };
  if (input.ratio !== undefined) {
    request.ratio = input.ratio;
  }

  return { ok: true, value: request };
}

/** Endpoint the composed body POSTs to. */
export const AGNES_COMPOSE_ENDPOINT = AGNES_IMAGE_GENERATIONS_URL;
