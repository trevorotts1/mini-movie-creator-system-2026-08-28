/**
 * AGN-003 — normalize the OpenAI-compatible image-generation response into
 * the MMCS `AgnesImageComposeResult`.
 *
 * The doc declares `return_base64` / `extra_body.response_format` (values
 * `url` | `b64_json`). The default output is a URL; when the caller requests
 * base64 the payload carries `b64_json` instead. Both are collapsed here; an
 * empty payload (neither field) is an explicit error rather than a silent
 * undefined — a provider success with no usable image must never pass unseen.
 */

import type { AgnesImageComposeResult, AgnesImageError } from "./types.js";

/** Raw response body for one generation. */
export interface AgnesImageRawResponse {
  data?: ReadonlyArray<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

/** Extract the first usable image, or an explicit error. */
export function normalizeAgnesImageResponse(
  response: AgnesImageRawResponse,
): { ok: true; value: AgnesImageComposeResult } | { ok: false; error: AgnesImageError } {
  if (response.error) {
    return {
      ok: false,
      error: {
        code: "HTTP_ERROR",
        message: response.error.message ?? "Agnes image API error (no message)",
      },
    };
  }
  const first = response.data?.[0];
  if (!first) {
    return {
      ok: false,
      error: {
        code: "HTTP_ERROR",
        message: "Agnes image API returned success with no data[] entry",
      },
    };
  }
  if (!first.url && !first.b64_json) {
    return {
      ok: false,
      error: {
        code: "HTTP_ERROR",
        message: "Agnes image API data[] entry has neither url nor b64_json",
      },
    };
  }
  return {
    ok: true,
    value: {
      url: first.url,
      b64Json: first.b64_json,
    },
  };
}
