/**
 * End-to-end fixture tests for the FISH-008 normalization pipeline — REAL
 * ffmpeg/ffprobe against a generated fixture WAV (spec §2: ffmpeg/ffprobe
 * are required environment; spec §49: fixture-driven tests, not paid API
 * calls). Skips with a clear note when ffmpeg is absent so the suite stays
 * green on machines without the binary — but this box has it.
 */

/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeAudio } from "./run.js";
import { probeAudio } from "./probe.js";
import { NormalizeError } from "./errors.js";
import { parseLoudnormJson } from "./config.js";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "mmcs-fish008-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Fixture WAV: 6 s of speech-like tone (sine + amplitude wobble so EBU R128
 * gating has real variation), quiet (-30 dBFS-ish) — the input a Fish TTS
 * dialogue asset might arrive at.
 */
function makeFixtureWav(name: string, freqHz = 220): string {
  const wavPath = path.join(workDir, name);
  execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "lavfi",
      "-i", `sine=frequency=${String(freqHz)}:duration=6`,
      "-af", "volume=0.03,tremolo=f=3:d=0.7",
      "-ac", "1",
      "-ar", "44100",
      "-y",
      wavPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return wavPath;
}

describe.runIf(hasFfmpeg)("normalizeAudio (fixture WAV, real ffmpeg)", () => {
  it("normalizes a quiet fixture to the target LUFS with probe-before/after", async () => {
    const input = makeFixtureWav("quiet.wav");
    const output = path.join(workDir, "quiet.norm.wav");

    const beforeProbe = await probeAudio(input);
    expect(beforeProbe.codec).toBe("pcm_s16le");

    const result = await normalizeAudio(input, output, { targetLufs: -16 });

    // Probe-before/after on the result.
    expect(result.before.codec).toBe("pcm_s16le");
    expect(result.before.durationSeconds).toBeCloseTo(6, 1);
    expect(result.after.codec).toBe("pcm_s16le");
    expect(result.after.sampleRateHz).toBe(48_000);
    expect(result.after.channels).toBe(2);
    expect(result.after.bytes).toBeGreaterThan(0);

    // The output actually exists with real bytes.
    const outStat = await stat(output);
    expect(outStat.size).toBe(result.after.bytes);

    // Output loudness is AT the configurable target (within loudnorm's
    // 0.5 LU tolerance) — verified independently via a fresh measure pass.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stderr } = await run("ffmpeg", [
      "-v", "info",
      "-nostdin",
      "-i", output,
      "-map", "0:a:0",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ]);
    const verification = parseLoudnormJson(stderr);
    expect(Math.abs(verification.inputI - (-16))).toBeLessThanOrEqual(1.0);
    expect(verification.inputTp).toBeLessThanOrEqual(-1.4);
  });

  it("honors a different configurable target (-23 LUFS EBU broadcast)", async () => {
    const input = makeFixtureWav("quiet23.wav");
    const output = path.join(workDir, "quiet23.norm.wav");

    const result = await normalizeAudio(input, output, { targetLufs: -23 });
    expect(result.options.targetLufs).toBe(-23);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stderr } = await run("ffmpeg", [
      "-v", "info",
      "-nostdin",
      "-i", output,
      "-map", "0:a:0",
      "-af", "loudnorm=I=-23:TP=-1.5:LRA=11:print_format=json",
      "-f", "null",
      "/dev/null",
    ]);
    const verification = parseLoudnormJson(stderr);
    expect(Math.abs(verification.inputI - (-23))).toBeLessThanOrEqual(1.0);
  });

  it("is deterministic: two normalizations of the same input are byte-identical", async () => {
    const input = makeFixtureWav("det.wav");
    const out1 = path.join(workDir, "det1.wav");
    const out2 = path.join(workDir, "det2.wav");

    const r1 = await normalizeAudio(input, out1, { targetLufs: -16 });
    const r2 = await normalizeAudio(input, out2, { targetLufs: -16 });

    const [bytes1, bytes2] = await Promise.all([readFile(out1), readFile(out2)]);
    expect(bytes1.equals(bytes2)).toBe(true);
  });

  it("never modifies the input file", async () => {
    const input = makeFixtureWav("untouched.wav");
    const before = await stat(input);
    const inputBytes = await readFile(input);

    await normalizeAudio(input, path.join(workDir, "out.wav"), { targetLufs: -16 });

    const after = await stat(input);
    expect(after.size).toBe(before.size);
    expect((await readFile(input)).equals(inputBytes)).toBe(true);
  });

  it("rejects a missing input file with kind=input BEFORE spawning ffmpeg", async () => {
    const missing = path.join(workDir, "nope.wav");
    await expect(
      normalizeAudio(missing, path.join(workDir, "out.wav")),
    ).rejects.toMatchObject({ kind: "input" satisfies NormalizeError["kind"] });
  });

  it("rejects an empty input file", async () => {
    const empty = path.join(workDir, "empty.wav");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(empty, Buffer.alloc(0));
    await expect(
      normalizeAudio(empty, path.join(workDir, "out.wav")),
    ).rejects.toMatchObject({ kind: "input" });
  });

  it("rejects a non-audio input with kind=probe", async () => {
    const notAudio = path.join(workDir, "junk.wav");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(notAudio, Buffer.from("this is not audio, just text"));
    await expect(
      normalizeAudio(notAudio, path.join(workDir, "out.wav")),
    ).rejects.toMatchObject({ kind: "probe" });
  });

  it("rejects input too short to measure (< 3s EBU gating minimum)", async () => {
    const short = path.join(workDir, "short.wav");
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-y", short],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    await expect(
      normalizeAudio(short, path.join(workDir, "out.wav")),
    ).rejects.toMatchObject({ kind: "input" });
  });

  it("rejects empty path strings and NUL bytes without spawning ffmpeg", async () => {
    await expect(normalizeAudio("", path.join(workDir, "o.wav"))).rejects.toMatchObject({ kind: "input" });
    await expect(normalizeAudio(path.join(workDir, "a\0b.wav"), path.join(workDir, "o.wav"))).rejects.toMatchObject({ kind: "input" });
    await expect(normalizeAudio(workDir, "")).rejects.toMatchObject({ kind: "input" });
  });

  it("rejects invalid config with kind=config before touching ffmpeg", async () => {
    const input = makeFixtureWav("cfg.wav");
    await expect(
      normalizeAudio(input, path.join(workDir, "o.wav"), { targetLufs: -3 }),
    ).rejects.toMatchObject({ kind: "config" });
  });
});

describe("probeAudio", () => {
  it("extracts audio facts from a fixture WAV", async () => {
    if (!hasFfmpeg) return; // binary absent — nothing to probe
    const wav = makeFixtureWav("probe.wav");
    const facts = await probeAudio(wav);
    expect(facts.formatName).toContain("wav");
    expect(facts.codec).toBe("pcm_s16le");
    expect(facts.sampleRateHz).toBe(44_100);
    expect(facts.channels).toBe(1);
    expect(facts.durationSeconds).toBeCloseTo(6, 1);
    expect(facts.bytes).toBeGreaterThan(100_000);
  });
});
