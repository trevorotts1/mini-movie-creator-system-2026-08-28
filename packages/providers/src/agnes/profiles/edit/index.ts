/**
 * AGN-003 — Agnes image edit/compose (conditional).
 *
 * Verdict after live-API verification (2026-08-28, docs cited in
 * docs/provider-capabilities/agnes.md):
 *
 *   - multi-image COMPOSE   — SUPPORTED. `POST /v1/images/generations` with
 *     `model=agnes-image-2.1-flash`, `prompt`, `size`(, `ratio`) and input
 *     images in `extra_body.image[]` (URLs or Data URI Base64).
 *
 *   - MASKED EDIT           — NOT SUPPORTED. No `mask` parameter, no
 *     `/v1/images/edits` endpoint, no inpainting wording on any official
 *     page (checked both image-21-flash page and the llms.txt index).
 *     Masked edit is gated behind the capability record and every masked
 *     attempt fails with `MASKED_EDIT_UNSUPPORTED` before any HTTP call.
 *
 * Capability flags the acceptance requires live in
 * {@link AGNES_IMAGE_EDIT_CAPABILITY} (this module) AND in the registry
 * capability data (`packages/capability-registry/src/data/agnes.ts`) so the
 * router can consult the profile without importing the provider module.
 */

export * from "./types.js";
export * from "./modes.js";
export * from "./request.js";
export * from "./normalize.js";
