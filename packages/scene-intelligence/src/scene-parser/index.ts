import type {
  ParseResult,
  SceneParseWarning,
  SceneParseWarningCode,
  StructuredScreenplay,
} from "./types.js";
import { normalizeStructuredScreenplay } from "./normalize-structured.js";
import { parseScreenplayTextResult } from "./parse-text.js";

/**
 * Entry point for DIR-009: parse an approved screenplay (fountain-style
 * text or structured document) into narrative scenes with per-scene
 * characters, location and estimated duration (spec §7 first four steps).
 *
 * Story text is UNTRUSTED DATA (spec §29): this module treats it purely as
 * text — no execution, no shell, no instruction interpretation.
 */

export function parseScreenplay(
  input: string | StructuredScreenplay,
  options: {
    approved?: boolean;
    knownCharacters?: string[];
    sceneIdPrefix?: string;
  } = {},
): ParseResult {
  if (typeof input === "string") {
    return parseScreenplayTextResult(input, options);
  }

  // Structured path: normalize the document, then honor caller approval.
  const effectiveApproved = options.approved ?? input.approved;

  const scenes = normalizeStructuredScreenplay(input);
  const structuredWarnings: SceneParseWarning[] = [];
  if (scenes.length === 0) {
    structuredWarnings.push({
      code: "INVALID_STRUCTURED_SCREENPLAY",
      message: "Structured screenplay contained no scenes.",
    });
  }
  if (effectiveApproved === false) {
    structuredWarnings.push(unapprovedWarning());
  }
  for (const scene of scenes) {
    if (!scene.location || scene.location === "UNKNOWN") {
      structuredWarnings.push({
        code: "SCENE_WITHOUT_LOCATION",
        message: `Scene ${scene.index + 1} ("${scene.name}") has no location.`,
      });
    }
  }

  return {
    scenes,
    totalDurationSeconds:
      Math.round(scenes.reduce((sum, s) => sum + s.durationSeconds, 0) * 10) / 10,
    warnings: structuredWarnings,
    source: "structured",
  };
}

function unapprovedWarning(): SceneParseWarning {
  return {
    code: "UNAPPROVED_SCREENPLAY",
    message:
      "Screenplay has not passed the script approval gate; parsed scenes are provisional (Gate 2).",
  };
}

export type { SceneParseWarningCode };
export * from "./types.js";
export * from "./slug.js";
export * from "./normalize-structured.js";
export {
  parseScreenplayText,
  parseScreenplayTextResult,
} from "./parse-text.js";