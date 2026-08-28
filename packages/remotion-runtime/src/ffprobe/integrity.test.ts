/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MediaIntegrityError,
  checkIntegrity,
  validateRenderOutput,
  verifyPlayback,
} from "./integrity.js";
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

describe("checkIntegrity — healthy media passes", () => {
  it("passes a valid mp4 with default constraints", async () => {
    const p = await makeTestVideo(fx.dir, "ok.mp4", { seconds: 1 });
    const r = await checkIntegrity(p);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.videoCodec).toBe("h264");
    expect(r.audioCodec).toBe("aac");
    expect(r.width).toBe(320);
    expect(r.height).toBe(568);
    expect(r.durationSeconds).toBeGreaterThan(0.1);
    expect(r.bitRate).toBeGreaterThan(0);
  }, 30_000);

  it("passes with explicit constraint expectations met", async () => {
    const p = await makeTestVideo(fx.dir, "ok2.mp4", {
      seconds: 1,
      width: 320,
      height: 568,
    });
    const r = await checkIntegrity(p, {
      expectedWidth: 320,
      expectedHeight: 568,
      expectedVideoCodec: "h264",
      expectedAudioCodec: "aac",
      minDurationSeconds: 0.5,
      maxDurationSeconds: 5,
      requireVideo: true,
      requireAudio: true,
    });
    expect(r.ok).toBe(true);
  }, 30_000);

  it("passes a WAV with requireVideo:false", async () => {
    const p = await makeTestAudio(fx.dir, "ok.wav", 1);
    const r = await checkIntegrity(p, { requireVideo: false });
    expect(r.ok).toBe(true);
    expect(r.audioCodec).toBe("pcm_s16le");
  }, 30_000);
});

describe("checkIntegrity — corrupted fixtures fail", () => {
  it("fails a truncated mp4 (the acceptance-critical case)", async () => {
    const p = await makeTestVideo(fx.dir, "trunc.mp4", { seconds: 2 });
    const truncated = await truncateFile(p, 0.5);
    const r = await checkIntegrity(truncated);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 30_000);

  it("fails a truncated mp4 that ffprobe still parses via duration bound", async () => {
    // Aggressive truncation that may keep the moov atom but cuts mdat: if the
    // header survives, the duration/bitrate constraints must still catch it.
    const p = await makeTestVideo(fx.dir, "trunc2.mp4", { seconds: 2 });
    const truncated = await truncateFile(p, 0.9);
    const r = await checkIntegrity(truncated, {
      minDurationSeconds: 0.1,
      maxDurationSeconds: 2.5,
    });
    // Either the probe fails outright or the reported duration/bitrate is off.
    expect(r.ok).toBe(false);
  }, 30_000);

  it("fails an empty file", async () => {
    const p = await makeEmptyFile(fx.dir);
    const r = await checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/empty|parse/i);
  }, 30_000);

  it("fails a text file disguised as mp4", async () => {
    const p = await makeTextFileDisguisedAsVideo(fx.dir);
    const r = await checkIntegrity(p);
    expect(r.ok).toBe(false);
  }, 30_000);

  it("fails a missing file", async () => {
    const r = await checkIntegrity(`${fx.dir}/ghost.mp4`);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/does not exist/i);
  }, 30_000);

  it("fails on wrong resolution expectations", async () => {
    const p = await makeTestVideo(fx.dir, "res.mp4", { seconds: 1, width: 320, height: 568 });
    const r = await checkIntegrity(p, { expectedWidth: 1080, expectedHeight: 1920 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/width/);
  }, 30_000);

  it("fails on wrong codec expectations", async () => {
    const p = await makeTestVideo(fx.dir, "codec.mp4", { seconds: 1 });
    const r = await checkIntegrity(p, { expectedVideoCodec: "hevc" });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/video codec/);
  }, 30_000);

  it("fails when duration underflows the minimum", async () => {
    const p = await makeTestVideo(fx.dir, "short.mp4", { seconds: 0.5 });
    const r = await checkIntegrity(p, { minDurationSeconds: 10 });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/minimum/);
  }, 30_000);

  it("fails when audio is required but absent", async () => {
    const p = await makeTestVideo(fx.dir, "silent.mp4", { seconds: 1, withAudio: false });
    const r = await checkIntegrity(p, { requireAudio: true });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/no audio stream/);
  }, 30_000);
});

describe("verifyPlayback (decode verification)", () => {
  it("decodes a healthy mp4 without errors", async () => {
    const p = await makeTestVideo(fx.dir, "play.mp4", { seconds: 1 });
    const r = await verifyPlayback(p);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  }, 60_000);

  it("flags decode errors on corrupted-interior bytes", async () => {
    const p = await makeTestVideo(fx.dir, "playcorrupt.mp4", { seconds: 2 });
    const corrupted = await corruptInteriorBytes(p);
    const r = await verifyPlayback(corrupted);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  }, 60_000);

  it("fails on a truncated mp4", async () => {
    const p = await makeTestVideo(fx.dir, "playtrunc.mp4", { seconds: 2 });
    const truncated = await truncateFile(p, 0.5);
    const r = await verifyPlayback(truncated);
    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("validateRenderOutput — pre-ARCHIVED gate", () => {
  it("passes a healthy render output and returns its probe summary", async () => {
    const p = await makeTestVideo(fx.dir, "gate.mp4", { seconds: 1 });
    const r = await validateRenderOutput(p);
    expect(r.ok).toBe(true);
    expect(r.videoCodec).toBe("h264");
  }, 60_000);

  it("throws MediaIntegrityError for a truncated output", async () => {
    const p = await makeTestVideo(fx.dir, "gatetrunc.mp4", { seconds: 2 });
    const truncated = await truncateFile(p, 0.5);
    await expect(validateRenderOutput(truncated)).rejects.toBeInstanceOf(
      MediaIntegrityError,
    );
    await expect(validateRenderOutput(truncated)).rejects.toThrow(
      /media integrity check failed/,
    );
  }, 60_000);

  it("throws MediaIntegrityError when constraints are violated", async () => {
    const p = await makeTestVideo(fx.dir, "gatecons.mp4", { seconds: 1 });
    await expect(
      validateRenderOutput(p, { constraints: { expectedWidth: 999 } }),
    ).rejects.toBeInstanceOf(MediaIntegrityError);
  }, 60_000);

  it("skips decode verification when asked (metadata-only gate)", async () => {
    const p = await makeTestVideo(fx.dir, "gatemeta.mp4", { seconds: 1 });
    const corrupted = await corruptInteriorBytes(p);
    // decodeVerify:false — the metadata layer alone still passes this fixture;
    // full-gate behavior (default) catches it in verifyPlayback above.
    const r = await validateRenderOutput(corrupted, { decodeVerify: false });
    expect(r.ok).toBe(true);
  }, 60_000);

  it("default full gate throws on the corrupted-interior fixture", async () => {
    const p = await makeTestVideo(fx.dir, "gatefull.mp4", { seconds: 2 });
    const corrupted = await corruptInteriorBytes(p);
    await expect(validateRenderOutput(corrupted)).rejects.toBeInstanceOf(
      MediaIntegrityError,
    );
  }, 60_000);
});
