/// <reference types="node" />
/**
 * Test fixtures: real media files generated with the system ffmpeg
 * (`lavfi` test sources), plus corrupted variants (truncation, garbage
 * bytes, empty files). Nothing here ships in the repo — fixtures are
 * created in per-test temp dirs and cleaned up.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "./which.js";

export interface FixtureDir {
  dir: string;
  cleanup(): Promise<void>;
}

/** Create a fresh temp dir for fixtures. */
export async function makeFixtureDir(prefix = "mmcs-ffprobe-"): Promise<FixtureDir> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function run(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

async function ffmpegPath(): Promise<string> {
  const bin = process.env.FFMPEG_BIN ?? "ffmpeg";
  const found = bin.includes("/") ? bin : ((await which(bin)) ?? bin);
  return found;
}

/**
 * Generate a small H.264 + AAC MP4 (silent tone audio) with real frames.
 * `seconds` capped small to keep the suite fast.
 */
export async function makeTestVideo(
  dir: string,
  name = "sample.mp4",
  opts: { seconds?: number; width?: number; height?: number; withAudio?: boolean } = {},
): Promise<string> {
  const seconds = Math.min(opts.seconds ?? 1, 5);
  const width = opts.width ?? 320;
  const height = opts.height ?? 568;
  const withAudio = opts.withAudio ?? true;
  const out = join(dir, name);
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  }
  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
  );
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  await run(await ffmpegPath(), args);
  return out;
}

/** Generate a small WAV (sine tone). */
export async function makeTestAudio(
  dir: string,
  name = "sample.wav",
  seconds = 1,
): Promise<string> {
  const out = join(dir, name);
  await run(await ffmpegPath(), [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:a",
    "pcm_s16le",
    out,
  ]);
  return out;
}

/**
 * Truncate a file to `keepFraction` of its size (default: cut the tail 40%).
 * For MP4s this usually destroys or displaces the moov atom (when written at
 * the end) and/or clips data chunks — ffprobe and/or decode must fail.
 */
export async function truncateFile(path: string, keepFraction = 0.6): Promise<string> {
  const buf = await readFile(path);
  const keep = Math.max(1, Math.floor(buf.byteLength * keepFraction));
  const truncatedPath = `${path}.truncated`;
  await writeFile(truncatedPath, buf.subarray(0, keep));
  return truncatedPath;
}

/**
 * Corrupt interior bytes (keeps size and header atoms intact) — simulates
 * bitstream damage that survives metadata probing. Corrupts the middle of
 * every 64 KiB chunk so decode hits damage no matter the offset.
 */
export async function corruptInteriorBytes(path: string): Promise<string> {
  const buf = await readFile(path);
  const chunk = 64 * 1024;
  for (let start = chunk; start < buf.byteLength; start += chunk) {
    const end = Math.min(start + 1024, buf.byteLength);
    for (let i = start; i < end; i++) {
      buf[i] = 0xff;
    }
  }
  const corruptedPath = `${path}.corrupt`;
  await writeFile(corruptedPath, buf);
  return corruptedPath;
}

/** An empty (0-byte) file. */
export async function makeEmptyFile(dir: string, name = "empty.mp4"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, Buffer.alloc(0));
  return p;
}

/** A non-media text file with an mp4 extension. */
export async function makeTextFileDisguisedAsVideo(
  dir: string,
  name = "fake.mp4",
): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, "this is definitely not an mp4 file\n".repeat(10), "utf8");
  return p;
}
