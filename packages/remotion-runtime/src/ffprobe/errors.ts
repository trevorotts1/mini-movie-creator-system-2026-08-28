/**
 * Error types for the ffprobe wrapper and media integrity checks.
 *
 * The wrapper shells out to the system `ffprobe` binary (FFmpeg/ffprobe owns
 * probing + integrity checks per spec §21). Every failure mode is normalized
 * to one of these typed errors so callers (render pipelines, archival) can
 * decide between "probe unavailable" and "media is corrupt" without parsing
 * stderr.
 */

/** Base class for all ffprobe-module errors. */
export class FfprobeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The `ffprobe` binary could not be run at all: not installed, not on PATH,
 * or not executable. This is an environment problem, not a media problem.
 */
export class FfprobeUnavailableError extends FfprobeError {
  constructor(detail: string) {
    super(`ffprobe is unavailable: ${detail}`);
    this.name = "FfprobeUnavailableError";
  }
}

/**
 * `ffprobe` ran but failed to parse the file (or was invoked on a missing
 * path). This is the "media is corrupt / not a media file" signal.
 */
export class ProbeFailedError extends FfprobeError {
  readonly path: string;
  /** Exit code of the ffprobe process, when known. */
  readonly exitCode: number | null;
  /** Combined stderr/stdout tail — useful for diagnostics, kept short. */
  readonly stderrTail: string;

  constructor(path: string, exitCode: number | null, stderrTail: string) {
    super(
      `ffprobe failed on ${path}` +
        (exitCode !== null ? ` (exit ${exitCode})` : "") +
        (stderrTail ? `: ${stderrTail}` : ""),
    );
    this.name = "ProbeFailedError";
    this.path = path;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** ffprobe produced output that could not be parsed as the expected JSON. */
export class ProbeOutputParseError extends FfprobeError {
  constructor(detail: string, cause?: unknown) {
    super(`ffprobe output could not be parsed: ${detail}`);
    this.name = "ProbeOutputParseError";
    this.cause = cause;
  }
}

/**
 * A pre-render validation constraint was violated (e.g. unknown extra ffprobe
 * flag, malformed output spec). Raised before any process is spawned.
 */
export class InvalidProbeOptionsError extends FfprobeError {
  constructor(detail: string) {
    super(`invalid ffprobe options: ${detail}`);
    this.name = "InvalidProbeOptionsError";
  }
}
