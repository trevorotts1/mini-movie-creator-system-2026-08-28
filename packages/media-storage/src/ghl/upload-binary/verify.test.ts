/// <reference types="node" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfprobeVerifier, DecodeError } from "./verify.js";

/**
 * Real ffprobe/ffmpeg verification (spec §17.4: "ffprobe/decode verify").
 * Tiny fixtures are generated in a temp dir with the local ffmpeg; skipped
 * cleanly only if ffmpeg itself is unavailable on the box.
 */
let ffmpegAvailable = true;
let dir: string;

// 1-second 64x64 black mp4, ~few KB.
async function makeTestVideo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-y",
        path,
      ],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mmcs-ffprobe-test-"));
  try {
    await makeTestVideo(join(dir, "fixture.mp4"));
  } catch {
    ffmpegAvailable = false;
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FfprobeVerifier (real binaries)", () => {
  it("verifies a real mp4: format + video stream detected", async () => {
    if (!ffmpegAvailable) return; // ffmpeg missing on this box
    const verifier = new FfprobeVerifier();
    const probe = await verifier.verify(join(dir, "fixture.mp4"), "video");

    expect(probe.format).toContain("mp4");
    expect(probe.streams.some((s) => s.codecType === "video")).toBe(true);
    expect(probe.durationSeconds).toBeGreaterThan(0);
  });

  it("rejects garbage bytes marked as video", async () => {
    if (!ffmpegAvailable) return;
    const garbage = join(dir, "garbage.mp4");
    await writeFile(garbage, new Uint8Array(256).fill(0x5a));
    const verifier = new FfprobeVerifier();

    await expect(verifier.verify(garbage, "video")).rejects.toBeInstanceOf(DecodeError);
  });

  it("rejects an audio-only file marked as video (no video stream)", async () => {
    if (!ffmpegAvailable) return;
    const audioOnly = join(dir, "audio-only.mp4");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=0.5",
          "-c:a",
          "aac",
          "-y",
          audioOnly,
        ],
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const verifier = new FfprobeVerifier();

    await expect(verifier.verify(audioOnly, "video")).rejects.toThrow(/no video stream/);
  });

  it("audio kind decodes via ffmpeg null pass and reports its format", async () => {
    if (!ffmpegAvailable) return;
    const audio = join(dir, "voice.mp3");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=0.5",
          "-y",
          audio,
        ],
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const verifier = new FfprobeVerifier();
    const probe = await verifier.verify(audio, "audio");
    expect(probe.format).toBe("audio");
  });

  it("audio kind rejects garbage bytes", async () => {
    if (!ffmpegAvailable) return;
    const garbage = join(dir, "garbage.mp3");
    await writeFile(garbage, new Uint8Array(64).fill(0x11));
    const verifier = new FfprobeVerifier();
    await expect(verifier.verify(garbage, "audio")).rejects.toBeInstanceOf(DecodeError);
  });

  it("generic kind skips decode (no ffmpeg contract for opaque blobs)", async () => {
    const opaque = join(dir, "opaque.bin");
    await writeFile(opaque, new Uint8Array([1, 2, 3]));
    const verifier = new FfprobeVerifier();
    const probe = await verifier.verify(opaque, "generic");
    expect(probe.format).toBe("unknown");
  });
});