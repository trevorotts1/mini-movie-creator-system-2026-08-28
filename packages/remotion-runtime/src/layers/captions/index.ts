/**
 * Dialogue/captions layer (VID-004) — public surface.
 *
 * Consumers (VID-002 composition registry, VID-012 rough cut) import the
 * track builder + renderer from here; nothing else in this package needs
 * to know about the Fish alignment shape.
 */

export type {
  AlignmentTrackInput,
  AlignmentWordInput,
  CaptionChunk,
  CaptionTrack,
  CaptionWord,
  CaptionStyleOptions,
  DialogueAssetKey,
} from "./types.js";
export { CaptionTrackError } from "./errors.js";
export { msToFrame, normalizeWord } from "./timing.js";
export {
  activeChunkAt,
  activeWordAt,
  buildCaptionTrack,
  CAPTION_DEFAULTS,
  CHUNK_TAIL_S,
  chunkTrack,
  LAST_TAIL_S,
} from "./track.js";
export {
  CaptionsLayer,
  FONT_STACK,
  type CaptionsLayerProps,
  type CaptionTrackLike,
} from "./CaptionsLayer.js";