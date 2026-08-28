/// <reference types="node" />
/**
 * On-disk caption track document (FISH-007). One JSON file per dialogue
 * asset key, mirroring the FISH-005/FISH-006 store layout: `<key>.json`.
 * Versioned for evolution.
 */
import type { CaptionTrack } from "./types.js";

export interface CaptionTrackFile {
  formatVersion: 1;
  track: CaptionTrack;
}

export { type CaptionBuildOptions, type CaptionCue, type CaptionSourceAlignment, type CaptionSourceWord, type CaptionTrack, type CaptionWord } from "./types.js";