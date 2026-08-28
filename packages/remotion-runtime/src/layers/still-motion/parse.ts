/**
 * `camera_motion` text → StillMotionSpec parser (spec §12/§21/§22).
 *
 * The §12 shot record carries `camera_motion` as free-form creative text
 * ("slow push in", "handheld drift", "static", …) written by the shot
 * planner (DIR-010 camera grammar emits exactly such strings). This parser
 * recognizes the conventional vocabulary and falls back to a safe, varied
 * default for unrecognized text — a still never renders dead-static when
 * motion was intended, and never invents motion for "static".
 *
 * Pure function: same text + duration + seed → same spec, always.
 */

import type { CameraMotionKind, MotionEase, StillMotionSpec } from "./types.js";
import { hashSeed, mulberry32 } from "./random.js";

/**
 * Default zoom base and range. Mirrors the upstream story-kit convention
 * (remotion/src/lib/story.tsx): base scale stays >= 1.12 so soft image edges
 * always crop outside the frame while panning; zoom range 1.12 → 1.22.
 */
export const MOTION_BASE_SCALE = 1.12;
export const MOTION_ZOOM_RANGE = 0.08;

/** Pan/drift travel cap (percent of image size) — never reveals an edge. */
export const MOTION_MAX_TRAVEL_PERCENT = 2;

/** Handheld jitter defaults (percent translate / degrees rotate). */
export const HANDHELD_JITTER = { translate: 0.4, rotate: 0.35, scale: 0.006 } as const;

/**
 * Vocabulary → kind mapping, checked in order (first match wins).
 * Word boundaries are load-bearing: creative motion text regularly carries
 * words that merely CONTAIN a motion term ("ecstatic", "companion",
 * "handshake") and an unbounded substring match would silently flip the
 * shot to the wrong kind (e.g. "ecstatic push in" → static).
 * Inflected forms (panned/tilted/drifted/cranes…) stay recognized via the
 * explicit suffix groups.
 */
const KIND_PATTERNS: ReadonlyArray<readonly [CameraMotionKind, RegExp]> = [
  ["whip_pan", /\bwhip[-\s]*pan\b|\bwhippan\b/i],
  ["handheld", /\bhandheld\b|\bshake\b/i],
  ["static", /\bstatic\b|\blocked\s*off\b|\bno\s*motion\b|\bstill\b/i],
  ["zoom_in", /push\s*in|zoom\s*in|zoom\s*-\s*in|dolly\s*in|punch\s*in/i],
  ["zoom_out", /pull\s*(?:out|back)|zoom\s*out|zoom\s*-\s*out|dolly\s*out/i],
  ["crane", /\bcrane(?:d|s)?(?:\s*(?:up|down))?\b|\bjib\b|\bboom\s*(?:up|down)\b/i],
  ["tracking", /tracking|dolly\s*(?:left|right)|truck(?:ing)?\s*(?:left|right)/i],
  ["pan", /\bpan(?:ning|ned|s)?\b(?:\s*(?:left|right))?|\bwhip\b(?!.*\bpan\b)/i],
  ["tilt", /\btilt(?:ing|ed|s)?\b(?:\s*(?:up|down))?/i],
  ["drift", /\bdrift(?:ing|ed|s)?\b|float|breathe|slow\s*move/i],
];

/** Parse `camera_motion` text into a motion kind. Unknown text → "drift". */
export function parseMotionKind(cameraMotion: string): CameraMotionKind {
  const text = cameraMotion.trim();
  if (text.length === 0) return "static";
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "drift";
}

/** Direction detected in the motion text: -1 (left/up), +1 (right/down), 0 (none). */
export function parseDirection(cameraMotion: string): { horizontal: number; vertical: number } {
  const text = cameraMotion.toLowerCase();
  let horizontal = 0;
  let vertical = 0;
  if (/\bleft\b/.test(text)) horizontal -= 1;
  if (/\bright\b/.test(text)) horizontal += 1;
  if (/\bupward?s?\b/.test(text) && !/\bdownward?s?\b/.test(text)) vertical -= 1;
  else if (/\bdownward?s?\b/.test(text) && !/\bupward?s?\b/.test(text)) vertical += 1;
  else if (/\bup\b/.test(text) && !/\bdown\b/.test(text)) vertical -= 1;
  else if (/\bdown\b/.test(text) && !/\bup\b/.test(text)) vertical += 1;
  return { horizontal, vertical };
}

/** Ease selection: snappy kinds ease out, everything else eases in-out. */
function easeForKind(kind: CameraMotionKind, text: string): MotionEase {
  if (/snap|quick|fast|whip/i.test(text)) return "ease_out";
  return "ease_in_out";
}

/**
 * Parse `camera_motion` free-form text (plus duration + seed) into a
 * deterministic StillMotionSpec.
 *
 * @param cameraMotion free-form §12 `camera_motion` text (may be empty/undefined → static)
 * @param durationInFrames shot length in frames (>= 1)
 * @param seed determinism seed (drives direction breakdowns + jitter)
 */
export function parseCameraMotion(
  cameraMotion: string | undefined,
  durationInFrames: number,
  seed: number,
): StillMotionSpec {
  if (!Number.isFinite(durationInFrames) || durationInFrames < 1) {
    throw new RangeError(`durationInFrames must be >= 1, got ${durationInFrames}`);
  }
  const text = cameraMotion?.trim() ?? "";
  const kind = parseMotionKind(text);
  const ease = easeForKind(kind, text);
  const rand = mulberry32(hashSeed(`${seed}:${text}`));

  // Signed random value in [-1, 1] for undecided directions.
  const signed = (): number => rand() * 2 - 1;

  let scaleFrom = MOTION_BASE_SCALE;
  let scaleTo = MOTION_BASE_SCALE;
  let translateXFrom = 0;
  let translateXTo = 0;
  let translateYFrom = 0;
  let translateYTo = 0;
  let rotateFrom = 0;
  let rotateTo = 0;
  let jitter = 0;

  switch (kind) {
    case "static":
      // Intentionally motionless; base scale keeps edges safe.
      break;
    case "zoom_in": {
      scaleFrom = MOTION_BASE_SCALE;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE;
      break;
    }
    case "zoom_out": {
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE;
      scaleTo = MOTION_BASE_SCALE;
      break;
    }
    case "pan": {
      const dir = parseDirection(text);
      const h = dir.horizontal !== 0 ? dir.horizontal : signed() < 0 ? -1 : 1;
      translateXFrom = h * MOTION_MAX_TRAVEL_PERCENT;
      translateXTo = -h * MOTION_MAX_TRAVEL_PERCENT;
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE / 2;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE / 2;
      break;
    }
    case "tilt": {
      const dir = parseDirection(text);
      const v = dir.vertical !== 0 ? dir.vertical : signed() < 0 ? -1 : 1;
      translateYFrom = v * MOTION_MAX_TRAVEL_PERCENT;
      translateYTo = -v * MOTION_MAX_TRAVEL_PERCENT;
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE / 2;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE / 2;
      break;
    }
    case "drift": {
      // Gentle simultaneous zoom + sub-pixel pan, per-shot random direction.
      scaleFrom = MOTION_BASE_SCALE;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * (0.5 + rand() * 0.5);
      translateXFrom = signed() * MOTION_MAX_TRAVEL_PERCENT;
      translateXTo = -translateXFrom * 0.5;
      translateYFrom = signed() * MOTION_MAX_TRAVEL_PERCENT * 0.75;
      translateYTo = -translateYFrom * 0.5;
      break;
    }
    case "crane": {
      // Crane down (default) or up per text: vertical travel with settle.
      const down = !/\bup\b/i.test(text);
      translateYFrom = down ? -MOTION_MAX_TRAVEL_PERCENT : MOTION_MAX_TRAVEL_PERCENT;
      translateYTo = down ? MOTION_MAX_TRAVEL_PERCENT * 0.5 : -MOTION_MAX_TRAVEL_PERCENT * 0.5;
      scaleFrom = MOTION_BASE_SCALE;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.5;
      break;
    }
    case "tracking": {
      const dir = parseDirection(text);
      const h = dir.horizontal !== 0 ? dir.horizontal : signed() < 0 ? -1 : 1;
      translateXFrom = h * MOTION_MAX_TRAVEL_PERCENT;
      translateXTo = -h * MOTION_MAX_TRAVEL_PERCENT;
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.25;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.4;
      jitter = HANDHELD_JITTER.translate * 0.5;
      break;
    }
    case "handheld": {
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.15;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.3;
      translateXFrom = signed() * MOTION_MAX_TRAVEL_PERCENT * 0.5;
      translateXTo = -translateXFrom;
      translateYFrom = signed() * MOTION_MAX_TRAVEL_PERCENT * 0.5;
      translateYTo = -translateYFrom;
      rotateFrom = signed() * 0.6;
      rotateTo = -rotateFrom * 0.5;
      jitter = 1; // full handheld amplitude
      break;
    }
    case "whip_pan": {
      const h = signed() < 0 ? -1 : 1;
      translateXFrom = h * MOTION_MAX_TRAVEL_PERCENT * 1.5;
      translateXTo = -h * MOTION_MAX_TRAVEL_PERCENT * 0.25;
      scaleFrom = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE;
      scaleTo = MOTION_BASE_SCALE + MOTION_ZOOM_RANGE * 0.3;
      break;
    }
  }

  return Object.freeze({
    kind,
    scaleFrom,
    scaleTo,
    translateXFrom,
    translateXTo,
    translateYFrom,
    translateYTo,
    rotateFrom,
    rotateTo,
    ease,
    jitter,
  });
}