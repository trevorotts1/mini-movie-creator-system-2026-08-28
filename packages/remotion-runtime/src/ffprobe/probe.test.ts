/// <reference types="node" />
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeMedia, ProbeFailedError, runFfprobe } from "./probe.js";
import {
  corruptInteriorBytes,
  makeEmptyFile,
  makeFixtureDir,
  makeTestAudio,
  makeTestVideo,
  makeTextFileDisguisedAsVideo,
  truncateFile,
  type FixtureDir,
} from "./fixtures.js";

let fx: FixtureDir;

beforeAll(async () => {
  fx = await makeFixtureDir();
});

afterAll(async () => {
  await fx?.cleanup();
});

describe("probeMedia", () => {
  it("reports codec / duration / resolution / bitrate for an mp4", async () => {
    const path = await makeTestVideo(fx.dir, "probe.mp4", {
      seconds: 2,
      width: 320,
      height: 568,
    });
    const probe = await probeMedia(path);

    expect(probe.video?.codecName).toBe("h264");
    expect(probe.video?.width).toBe(320);
    expect(probe.video?.height).toBe(568);
    expect(probe.audio?.codecName).toBe("aac");
    expect(probe.durationSeconds).toBeDefined();
    expect(probe.durationSeconds).toBeGreaterThan(1.5);
    expect(probe.durationSeconds).toBeLessThan(3.5);
    expect(probe.bitRate).toBeGreaterThan(0);
    expect(probe.sizeBytes).toBeGreaterThan(0);
    expect(probe.nbStreams).toBe(2);
    expect(probe.streams).toHaveLength(2);
  }, 30_000);

  it("probes a WAV audio file (no video stream)", async () => {
    const path = await makeTestAudio(fx.dir, "probe.wav", 1);
    const probe = await probeMedia(path);

    expect(probe.audio?.codecName).toBe("pcm_s16le");
    expect(probe.audio?.sampleRate).toBe(44100);
    expect(probe.video).toBeUndefined();
    expect(probe.durationSeconds).toBeGreaterThan(0.5);
  }, 30_000);

  it("throws ProbeFailedError on a truncated mp4", async () => {
    const path = await makeTestVideo(fx.dir, "cut.mp4", { seconds: 2 });
    const truncated = await truncateFile(path, 0.5);
    await expect(probeMedia(truncated)).rejects.toBeInstanceOf(ProbeFailedError);
  }, 30_000);

  it("throws ProbeFailedError on a text file disguised as mp4", async () => {
    const p = await makeTextFileDisguisedAsVideo(fx.dir);
    await expect(probeMedia(p)).rejects.toBeInstanceOf(ProbeFailedError);
  }, 30_000);

  it("throws ProbeFailedError on an empty file", async () => {
    const p = await makeEmptyFile(fx.dir);
    await expect(probeMedia(p)).rejects.toBeInstanceOf(ProbeFailedError);
  }, 30_000);

  it("throws ProbeFailedError on a missing file", async () => {
    await expect(probeMedia(join(fx.dir, "nope.mp4"))).rejects.toBeInstanceOf(
      ProbeFailedError,
    );
  }, 30_000);

  it("accepts a corrupted-interior mp4 at the metadata layer (decode catches it later)", async () => {
    // Documents the boundary: bitstream damage can keep metadata probing
    // working — which is exactly why verifyPlayback exists.
    const path = await makeTestVideo(fx.dir, "interior.mp4", { seconds: 1 });
    const corrupted = await corruptInteriorBytes(path);
    const probe = await probeMedia(corrupted);
    expect(probe.video?.codecName).toBe("h264");
  }, 30_000);

  it("runFfprobe returns raw JSON stdout", async () => {
    const path = await makeTestVideo(fx.dir, "raw.mp4", { seconds: 0.5 });
    const { stdout } = await runFfprobe(path);
    const parsed = JSON.parse(stdout) as { streams: unknown[]; format: unknown };
    expect(Array.isArray(parsed.streams)).toBe(true);
    expect(parsed.format).toBeDefined();
  }, 30_000);
});
