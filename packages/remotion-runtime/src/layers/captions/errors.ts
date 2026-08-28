/**
 * Typed errors for the dialogue/captions layer. Error messages may quote
 * COUNTS and structural facts only — never dump untrusted dialogue text.
 */

/** Thrown when an alignment input cannot be converted into a caption
 * track (empty/invalid words, non-finite or negative timings). */
export class CaptionTrackError extends Error {
  readonly code = "CAPTION_TRACK_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CaptionTrackError";
  }
}