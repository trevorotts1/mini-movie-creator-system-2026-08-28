/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FrameExtractionError, extractFrames } from "./extract.js";
import {
  DEFAULT_FFPROBE_PATH,
  ProbeError,
  parseFfprobeJson,
  probeClip,
  verifyPngFile,
} from "./probe.js";
import { FramePlanError } from "./plan.js";
import { probeClip as probeClipReexport } from "./index.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "mmcs-frames-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 2s 320x180 30fps (60 frames) clip: red first second, blue second second. */
function makeClip(name: string): string {
  const clipPath = path.join(workDir, name);
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=red:size=320x180:rate=30:duration=1",
    "-f", "lavfi",
    "-i", "color=c=blue:size=320x180:rate=30:duration=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1",
    "-pix_fmt", "yuv420p",
    "-y",
    clipPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return clipPath;
}

describe("parseFfprobeJson", () => {
  it("parses format + video stream facts", () => {
    const json = JSON.stringify({
      format: { duration: "3.5" },
      streams: [
        { codec_type: "audio", codec_name: "aac" },
        {
          codec_type: "video",
          codec_name: "h264",
          width: "1920",
          height: "1080",
          avg_frame_rate: "30/1",
        },
      ],
    });
    expect(parseFfprobeJson(json)).toEqual({
      durationSeconds: 3.5,
      fps: 30,
      width: 1920,
      height: 1080,
      codec: "h264",
    });
  });

  it("falls back to r_frame_rate when avg_frame_rate unusable", () => {
    const json = JSON.stringify({
      format: { duration: "2" },
      streams: [
        { codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "24000/1001" },
      ],
    });
    const facts = parseFfprobeJson(json);
    expect(facts.fps).toBeCloseTo(23.976, 2);
  });

  it("throws ProbeError on garbage JSON / missing fields", () => {
    expect(() => parseFfprobeJson("not json")).toThrow(ProbeError);
    expect(() => parseFfprobeJson("{}")).toThrow(ProbeError);
    expect(() =>
      parseFfprobeJson(JSON.stringify({ format: { duration: "x" }, streams: [] })),
    ).toThrow(ProbeError);
  });
});

describe("probeClip (real ffprobe)", () => {
  it("probes duration/fps/codec of a real generated clip", async () => {
    const clip = makeClip("probe.mp4");
    const facts = await probeClip(clip);
    expect(facts.source).toBe("probe");
    // 2s fixture: two 1s inputs concatenated.
    expect(facts.durationSeconds).toBeGreaterThan(1.9);
    expect(facts.durationSeconds).toBeLessThanOrEqual(2.1);
    expect(facts.fps).toBeCloseTo(30, 0);
    expect(facts.codec).toBe("h264");
    expect(facts.width).toBe(320);
    expect(facts.height).toBe(180);
  });

  it("fails with ProbeError on a nonexistent file", async () => {
    await expect(probeClip(path.join(workDir, "missing.mp4"))).rejects.toBeInstanceOf(ProbeError);
  });

  it("exports the default ffprobe binary name", () => {
    expect(DEFAULT_FFPROBE_PATH).toBe("ffprobe");
  });

  it("index re-exports probeClip", () => {
    expect(probeClipReexport).toBe(probeClip);
  });
});

describe("verifyPngFile (frames.mjs READ-every-PNG discipline)", () => {
  it("accepts a real PNG", async () => {
    const pngPath = path.join(workDir, "ok.png");
    // 1x1 red PNG.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080200000090775" +
        "3de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
      "hex",
    );
    await writeFile(pngPath, png);
    const { bytes } = await verifyPngFile(pngPath);
    expect(bytes).toBe(png.length);
  });

  it("rejects a non-PNG file by magic bytes", async () => {
    const txtPath = path.join(workDir, "fake.png");
    await writeFile(txtPath, "GIF89a not a png at all.......");
    await expect(verifyPngFile(txtPath)).rejects.toThrow(/not a PNG/);
  });

  it("rejects missing and empty files", async () => {
    await expect(verifyPngFile(path.join(workDir, "nope.png"))).rejects.toThrow(/missing/);
    const emptyPath = path.join(workDir, "empty.png");
    await writeFile(emptyPath, Buffer.alloc(0));
    await expect(verifyPngFile(emptyPath)).rejects.toThrow(/too small/);
  });
});

describe("extractFrames (real ffmpeg)", () => {
  it("extracts default 4 representative frames from a real clip", async () => {
    const clip = makeClip("default.mp4");
    const outDir = path.join(workDir, "out-default");
    const result = await extractFrames(clip, { outputDir: outDir });
    expect(result.frames).toHaveLength(4);
    expect(result.facts.source).toBe("probe");
    expect(result.plan.frames).toHaveLength(4);
    for (const frame of result.frames) {
      expect(frame.fileName).toMatch(/^frames-f\d{4,}\.png$/);
      expect(frame.bytes).toBeGreaterThan(100);
      const s = await stat(frame.filePath);
      expect(s.size).toBe(frame.bytes);
    }
    // First frame = 0; last = frame 59 (2s @ 30fps = 60 frames).
    expect(result.frames[0]?.frameNumber).toBe(0);
    expect(result.frames[0]?.timestampSeconds).toBe(0);
    const last = result.frames[result.frames.length - 1];
    expect(last?.frameNumber).toBe(59);
    expect(last?.timestampSeconds).toBeCloseTo(59 / 30, 9);
    // Frames sorted ascending by timestamp.
    for (let i = 1; i < result.frames.length; i += 1) {
      expect(result.frames[i]!.timestampSeconds).toBeGreaterThan(
        result.frames[i - 1]!.timestampSeconds,
      );
    }
  });

  it("honors explicit timestamp plan (grid-snapped)", async () => {
    const clip = makeClip("ts.mp4");
    const outDir = path.join(workDir, "out-ts");
    const result = await extractFrames(clip, {
      outputDir: outDir,
      plan: { mode: "timestamps", timestamps: [0, 0.5, 1.999] },
    });
    // 0.5s -> frame 15; 1.999s -> frame 60 -> clamped to last usable 59.
    expect(result.frames.map((f) => f.frameNumber)).toEqual([0, 15, 59]);
    expect(result.frames.map((f) => f.timestampSeconds)).toEqual([0, 0.5, 59 / 30]);
    expect(result.frames[2]?.fileName).toBe("frames-f0059.png");
  });

  it("honors interval plan", async () => {
    const clip = makeClip("interval.mp4");
    const result = await extractFrames(clip, {
      outputDir: path.join(workDir, "out-interval"),
      plan: { mode: "interval", intervalSeconds: 0.5 },
    });
    // 2s clip, 0.5s interval = 15-frame step: 0,15,30,45,59(last).
    expect(result.frames.map((f) => f.frameNumber)).toEqual([0, 15, 30, 45, 59]);
    expect(result.frames[0]?.timestampSeconds).toBe(0);
  });

  it("supports scale < 1 (frames.mjs --scale=0.5 discipline)", async () => {
    const clip = makeClip("scale.mp4");
    const result = await extractFrames(clip, {
      outputDir: path.join(workDir, "out-scale"),
      plan: { mode: "count", count: 1 },
      scale: 0.5,
    });
    const fullResult = await extractFrames(clip, {
      outputDir: path.join(workDir, "out-full"),
      plan: { mode: "count", count: 1 },
      scale: 1,
    });
    // Same frame, half scale → smaller PNG.
    expect(result.frames[0]!.bytes).toBeLessThan(fullResult.frames[0]!.bytes);
  });

  it("refuses to overwrite existing frames without overwrite:true", async () => {
    const clip = makeClip("ow.mp4");
    const outDir = path.join(workDir, "out-ow");
    await extractFrames(clip, { outputDir: outDir, plan: { mode: "count", count: 1 } });
    await expect(
      extractFrames(clip, { outputDir: outDir, plan: { mode: "count", count: 1 } }),
    ).rejects.toThrow(/refusing to overwrite/);
    // With overwrite:true it succeeds.
    const again = await extractFrames(clip, {
      outputDir: outDir,
      plan: { mode: "count", count: 1 },
      overwrite: true,
    });
    expect(again.frames).toHaveLength(1);
  });

  it("works with provided facts (skips ffprobe)", async () => {
    const clip = makeClip("provided.mp4");
    const result = await extractFrames(clip, {
      outputDir: path.join(workDir, "out-provided"),
      plan: { mode: "count", count: 2 },
      facts: {
        durationSeconds: 1,
        fps: 30,
        source: "provided",
        codec: "h264",
        width: 320,
        height: 180,
      },
    });
    expect(result.facts.source).toBe("provided");
    expect(result.plan.frames.map((f) => f.frameNumber)).toEqual([0, 29]);
  });

  it("validates provided facts too (invalid duration rejected)", async () => {
    const clip = makeClip("badfacts.mp4");
    await expect(
      extractFrames(clip, {
        outputDir: path.join(workDir, "out-badfacts"),
        facts: { durationSeconds: 0, fps: 30, source: "provided" },
      }),
    ).rejects.toBeInstanceOf(FramePlanError);
  });

  it("throws FrameExtractionError when the frame dump writes nothing (verify fails)", async () => {
    const clip = makeClip("dumpfail.mp4");
    await expect(
      extractFrames(clip, { outputDir: path.join(workDir, "out-dumpfail") }, async () => {
        // simulate ffmpeg silently writing nothing
      }),
    ).rejects.toBeInstanceOf(FrameExtractionError);
  });

  it("surfaces real ffmpeg failures as FrameExtractionError", async () => {
    await expect(
      extractFrames(path.join(workDir, "absent.mp4"), {
        outputDir: path.join(workDir, "out-absent"),
        facts: { durationSeconds: 1, fps: 30, source: "provided" },
      }),
    ).rejects.toBeInstanceOf(FrameExtractionError);
  });

  it("writes files named per upstream frames.mjs convention", async () => {
    const clip = makeClip("names.mp4");
    const outDir = path.join(workDir, "out-names");
    const result = await extractFrames(clip, {
      outputDir: outDir,
      plan: { mode: "timestamps", timestamps: [0, 0.25] },
    });
    expect(result.frames[0]!.filePath).toBe(path.join(outDir, "frames-f0000.png"));
    // 0.25s at 30fps = 7.5 frames; local_f = global_s * fps rounds half up to 8.
    expect(result.frames[1]!.filePath).toBe(path.join(outDir, "frames-f0008.png"));
    // Files actually exist on disk.
    await stat(path.join(outDir, "frames-f0000.png"));
    await stat(path.join(outDir, "frames-f0008.png"));
  });

  it("produces decodable PNGs for image-vision QC", async () => {
    const clip = makeClip("decodable.mp4");
    const result = await extractFrames(clip, {
      outputDir: path.join(workDir, "out-decodable"),
      plan: { mode: "timestamps", timestamps: [1.9] },
    });
    const bytes = await readFile(result.frames[0]!.filePath);
    // PNG signature present and file large enough to contain real pixel data.
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.length).toBeGreaterThan(200);
  });
});