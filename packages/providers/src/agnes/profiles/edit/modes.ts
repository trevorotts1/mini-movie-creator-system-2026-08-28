/**
 * AGN-003 — mode classification + capability gate for Agnes image edit/compose.
 *
 * The live Agnes Image 2.1 Flash API (verified 2026-08-28) supports exactly
 * one of the two edit/compose shapes:
 *
 *   1. multi-image compose  — SUPPORTED (extra_body.image[] + prompt)
 *   2. masked edit          — NOT SUPPORTED (no mask param, no /edits route)
 *
 * Every entry point consults {@link AGNES_IMAGE_EDIT_CAPABILITY} first so unsupported
 * modes fail with an explicit {@link AgnesImageError} BEFORE any HTTP call — the
 * capability profile (spec §15 / runbook §16) is the single source of truth,
 * never a hard-coded branch alone.
 */

import {
  AGNES_IMAGE_EDIT_CAPABILITY,
  AGNES_IMAGE_RATIOS,
  AGNES_IMAGE_SIZES,
  type AgnesImageError,
  type AgnesImageResult,
} from "./types.js";

/** The two doc-supported edit/compose shapes. */
export type AgnesImageEditMode = "compose" | "masked-edit";

/**
 * True when the live Agnes image API supports the mode, per the verified
 * capability record. Masked edit is false as of 2026-08-28 (evidence:
 * docs/provider-capabilities/agnes.md).
 */
export function isAgnesImageModeSupported(mode: AgnesImageEditMode): boolean {
  switch (mode) {
    case "compose":
      return AGNES_IMAGE_EDIT_CAPABILITY.compose.supported;
    case "masked-edit":
      return AGNES_IMAGE_EDIT_CAPABILITY.maskedEdit.supported;
  }
}

/**
 * Gate for masked edit. Always errors today with the documented evidence;
 * when Agnes ships a mask parameter this is the single place that flips.
 */
export function assertMaskedEditSupported(): AgnesImageResult<true> {
  if (AGNES_IMAGE_EDIT_CAPABILITY.maskedEdit.supported) {
    return { ok: true, value: true };
  }
  const error: AgnesImageError = {
    code: "MASKED_EDIT_UNSUPPORTED",
    message:
      "Agnes Image 2.1 Flash does not expose a mask parameter or an image-edits endpoint " +
      "(verified 2026-08-28 against " +
      AGNES_IMAGE_EDIT_CAPABILITY.sourceUrl +
      "). Only prompt-driven image-to-image / multi-image composition is available; " +
      "use compose mode or a provider with mask support.",
  };
  return { ok: false, error };
}

/** Classify a wrapped request shape into the supported mode union. */
export function classifyAgnesImageEdit(
  input:
    | { prompt: string; images: readonly { url: string }[]; mask?: never }
    | { prompt: string; images: readonly { url: string }[]; mask: { url: string } },
): AgnesImageResult<{ mode: AgnesImageEditMode }> {
  const mask = "mask" in input ? input.mask : undefined;
  if (mask) {
    const gate = assertMaskedEditSupported();
    return gate.ok
      ? { ok: true, value: { mode: "masked-edit" } }
      : gate;
  }
  return { ok: true, value: { mode: "compose" } };
}

/**
 * OUTPUT CONSTRAINT GATE — validate `size`/`ratio` against the doc-stated
 * tiers before any HTTP call (spec §15: aspect ratios + resolutions are part
 * of the image capability profile). Invalid combos fail with
 * INVALID_REQUEST; a size/ratio the doc does not list is never passed
 * through on the chance the API might accept it.
 */
export function validateComposeOutputConstraints(
  size: string,
  ratio?: string,
): AgnesImageResult<true> {
  if (!(AGNES_IMAGE_SIZES as readonly string[]).includes(size)) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message:
          `size "${size}" is not a documented Agnes Image 2.1 Flash tier ` +
          `(expected one of ${AGNES_IMAGE_SIZES.join(", ")}).`,
      },
    };
  }
  if (ratio !== undefined && !(AGNES_IMAGE_RATIOS as readonly string[]).includes(ratio)) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message:
          `ratio "${ratio}" is not a documented Agnes Image 2.1 Flash ratio ` +
          `(expected one of ${AGNES_IMAGE_RATIOS.join(", ")}).`,
      },
    };
  }
  return { ok: true, value: true };
}

/**
 * REFERENCE COUNT GATE — pre-request validation (runbook §16): the doc
 * says multi-image composition takes an input image array but does NOT state
 * a maximum count (only "first 3 free" billing is documented). The capability
 * record keeps maxImages null, so this validator enforces NOTHING except
 * "at least one image" — never invent a cap that the provider did not
 * document (spec §26.1 UNKNOWN policy).
 */
export function validateComposeInputCount(images: readonly unknown[]): AgnesImageResult<number> {
  if (!Array.isArray(images) || images.length === 0) {
    const error: AgnesImageError = {
      code: "INVALID_REQUEST",
      message: "Compose mode requires at least one input image (extra_body.image[]).",
    };
    return { ok: false, error };
  }
  return { ok: true, value: images.length };
}
