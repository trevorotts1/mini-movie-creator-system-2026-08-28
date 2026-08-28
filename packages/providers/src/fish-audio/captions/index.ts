/// <reference types="node" />
/**
 * FISH-007 — caption output public surface.
 *
 * Word-exact caption track from a FISH-006 alignment record (upstream
 * gen_voice.py word-exact discipline), persisted per dialogue asset key,
 * consumable by the VID-004 dialogue/captions layer.
 */
export type {
  CaptionBuildOptions,
  CaptionCue,
  CaptionSourceAlignment,
  CaptionSourceWord,
  CaptionTrack,
  CaptionWord,
} from "./types.js";
export {
  DEFAULT_MAX_WORDS,
  MAX_MAX_WORDS,
  buildCaptionTrack,
  framesToMs,
  isDeliveryTag,
  msToFrames,
} from "./build.js";
export { isCurrentDialogueAssetKey, FISH_CACHE_KEY_VERSION } from "./key.js";
export { parseAlignmentDoc, loadCaptionTrack, type CaptionReadFs, type LoadCaptionTrackOptions } from "./load.js";
export {
  CaptionTrackStore,
  parseCaptionTrackDoc,
  type CaptionTrackFs,
  type CaptionTrackStoreOptions,
} from "./store.js";
export type { CaptionTrackFile } from "./file.js";