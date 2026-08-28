/**
 * Camera grammar — DIR-010 (spec §7 input: "camera grammar").
 *
 * Assigns shot scale, motion, and lens/style per beat type following
 * conventional narrative grammar. A 45-second dialogue scene reads:
 * establishing → mediums/close-ups on dialogue → reaction inserts → closer
 * beat on the emotional turn. Repeated consecutive scales are avoided by
 * rotating among the grammar set for a beat type.
 */

import type { BeatType, SceneBeat, ShotCameraPlan } from "./types.js";

/** Default grammar per beat type, most-preferred first. */
export const BEAT_CAMERA_GRAMMAR: Readonly<Record<BeatType, readonly ShotCameraPlan[]>> =
  Object.freeze({
    establishing: [
      { camera_angle: "wide", camera_motion: "slow push in", lens_style: "24mm wide" },
      { camera_angle: "wide", camera_motion: "crane down", lens_style: "24mm wide" },
      { camera_angle: "extreme wide", camera_motion: "static", lens_style: "18mm wide" },
    ],
    dialogue: [
      { camera_angle: "medium", camera_motion: "static", lens_style: "50mm" },
      { camera_angle: "medium close-up", camera_motion: "slow push in", lens_style: "85mm" },
      { camera_angle: "close-up", camera_motion: "static", lens_style: "85mm" },
      { camera_angle: "over-the-shoulder", camera_motion: "static", lens_style: "50mm" },
    ],
    reaction: [
      { camera_angle: "close-up", camera_motion: "static", lens_style: "85mm" },
      { camera_angle: "medium close-up", camera_motion: "static", lens_style: "65mm" },
      { camera_angle: "insert", camera_motion: "static", lens_style: "100mm macro" },
    ],
    emotional: [
      { camera_angle: "close-up", camera_motion: "slow push in", lens_style: "85mm" },
      { camera_angle: "medium close-up", camera_motion: "handheld drift", lens_style: "65mm" },
      { camera_angle: "close-up", camera_motion: "static", lens_style: "100mm" },
    ],
    action: [
      { camera_angle: "medium", camera_motion: "tracking", lens_style: "35mm" },
      { camera_angle: "wide", camera_motion: "whip pan", lens_style: "24mm wide" },
      { camera_angle: "close-up", camera_motion: "handheld", lens_style: "35mm" },
      { camera_angle: "medium close-up", camera_motion: "static", lens_style: "50mm" },
    ],
    insert: [
      { camera_angle: "insert", camera_motion: "static", lens_style: "100mm macro" },
      { camera_angle: "close-up", camera_motion: "static", lens_style: "85mm" },
    ],
  });

/** Fallback grammar for beats whose type carries no entry (never happens for
 * the six known types; kept for forward compatibility). */
const FALLBACK_GRAMMAR: readonly ShotCameraPlan[] = [
  { camera_angle: "medium", camera_motion: "static", lens_style: "50mm" },
  { camera_angle: "medium close-up", camera_motion: "slow push in", lens_style: "85mm" },
];

/**
 * Pick camera grammar for a beat occurrence. `occurrenceIndex` rotates
 * through the grammar set so consecutive same-type shots vary; grammar list
 * order biases the first occurrence toward the most conventional choice.
 */
export function cameraForBeat(
  beat: SceneBeat,
  occurrenceIndex: number,
): ShotCameraPlan {
  const grammar = BEAT_CAMERA_GRAMMAR[beat.type] ?? FALLBACK_GRAMMAR;
  return grammar[occurrenceIndex % grammar.length] as ShotCameraPlan;
}