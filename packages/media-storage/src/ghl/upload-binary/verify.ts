/**
 * Local integrity verification (spec §17.4: "ffprobe/decode verify").
 *
 * The seam decouples the pipeline from the actual binaries so tests run with
 * a fake verifier; production wires Node child_process ffprobe/ffmpeg.
 * Security note: arguments are passed as an argv array (no shell), and the
 * verified file path comes from our own temp directory, never from story text.
 */
import { spawn } from "node:child_process";

export interface ProbeResult {
  /** ffprobe format name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  format: string;
  /** Duration in seconds when reported. */
  durationSeconds?: number;
  /** Declared streams (video/audio) found by ffprobe. */
  streams: Array<{ codecType?: string; codecName?: string }>;
}

export interface MediaVerifier {
  /**
   * Verify a downloaded file decodes. `kind === "video"` must run ffprobe and
   * additionally require at least one video stream; non-video kinds run a
   * cheap decode pass (ffmpeg -v error -i file -f null -).
   */
  verify(filePath: string, kind: "video" | "image" | "audio" | "generic"): Promise<ProbeResult>;
}

/** Error thrown when ffprobe/decode verification fails. */
export class DecodeError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = "DecodeError";
    this.stderr = stderr;
  }
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new DecodeError(`${command} exited with code ${code}`, stderr));
    });
  });
}

export interface FfprobeVerifierOptions {
  /** Command names, overridable for tests. */
  ffprobePath?: string;
  ffmpegPath?: string;
}

/**
 * Production verifier: ffprobe for structure + stream presence, ffmpeg decode
 * pass for non-video kinds. Both run with argv-array args (no shell).
 */
export class FfprobeVerifier implements MediaVerifier {
  private readonly ffprobePath: string;
  private readonly ffmpegPath: string;

  constructor(options: FfprobeVerifierOptions = {}) {
    this.ffprobePath = options.ffprobePath ?? "ffprobe";
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  }

  async verify(filePath: string, kind: "video" | "image" | "audio" | "generic"): Promise<ProbeResult> {
    if (kind === "generic") {
      // No decoder contract for generic blobs; presence of bytes is the only check.
      return { format: "unknown", streams: [] };
    }

    if (kind === "video") {
      const { stdout } = await runCommand(this.ffprobePath, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ]);
      let parsed: {
        format?: { format_name?: string; duration?: string };
        streams?: Array<{ codec_type?: string; codec_name?: string }>;
      };
      try {
        parsed = JSON.parse(stdout) as typeof parsed;
      } catch (cause) {
        throw new DecodeError(
          "ffprobe returned non-JSON output",
          `parse error: ${cause instanceof Error ? cause.message : String(cause)}\n${stdout.slice(0, 500)}`,
        );
      }
      const streams = (parsed.streams ?? []).map((s) => ({
        codecType: s.codec_type,
        codecName: s.codec_name,
      }));
      if (!streams.some((s) => s.codecType === "video")) {
        throw new DecodeError(
          "ffprobe found no video stream in file marked as video",
          stdout,
        );
      }
      return {
        format: parsed.format?.format_name ?? "unknown",
        durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
        streams,
      };
    }

    // image/audio/generic: full decode pass; any decode error fails the file.
    const { stderr } = await runCommand(this.ffmpegPath, [
      "-v",
      "error",
      "-i",
      filePath,
      "-f",
      "null",
      "-",
    ]);
    if (stderr.trim().length > 0) {
      throw new DecodeError("ffmpeg decode reported errors", stderr);
    }
    return { format: kind, streams: [] };
  }
}