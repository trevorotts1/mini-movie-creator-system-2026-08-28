/**
 * MMCS audio/music/SFX timeline layer (spec §21, task VID-010).
 *
 * Owns the placement half of the audio subsystem: from the mix plan (data,
 * FISH-009-compatible) to every dialogue line, the music bed, and every SFX
 * cue placed on the composition timeline in frames, with the upstream frame
 * conversion (`local_f = global_s * fps − sequence_from`) and the upstream
 * loop discipline (last frame == frame 0) preserved.
 *
 * FFmpeg (FISH-009) owns the actual mix/normalize/encode; Remotion owns
 * placement on the timeline. The plan is the audited source of truth for
 * BOTH halves — one plan, two deterministic compilations.
 */

export * from "./types.js";
export * from "./validate.js";
export * from "./place.js";
export * from "./loop.js";
export * from "./sync.js";
export * from "./mount.js";