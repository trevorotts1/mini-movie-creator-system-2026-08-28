/**
 * Error taxonomy for the audio normalization pipeline (FISH-008).
 *
 * One error class with a `kind` discriminator — matches the shape of the
 * Fish client's `FishApiError` (FISH-001) so callers can branch on kind
 * without instanceof chains across modules.
 */

/** Where in the normalize pipeline the failure happened. */
export type NormalizeErrorKind =
  /** Invalid options (out-of-range LUFS/TP/LRA, bad codec, bad paths). */
  | "config"
  /** Input missing, empty, or unreadable. */
  | "input"
  /** ffprobe failed or returned unusable audio facts. */
  | "probe"
  /** Loudness measurement failed (e.g. silent input reports -inf). */
  | "measure"
  /** The ffmpeg binary itself failed (spawn error, non-zero exit). */
  | "ffmpeg"
  /** Output verification failed (missing/empty file, unusable facts). */
  | "verify";

export class NormalizeError extends Error {
  override readonly name = "NormalizeError";

  constructor(
    readonly kind: NormalizeErrorKind,
    message: string,
    /** Captured ffmpeg/ffprobe stderr tail, when the failure came from a run. */
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "NormalizeError";
  }
}
