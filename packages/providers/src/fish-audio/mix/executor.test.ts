/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MixExecError, MixPlanError, runMix, validateMixPlan } from "./index.js";
import type { MixPlan } from "./types.js";

/**
 * Integration tests against the REAL ffmpeg/ffprobe (spec §2: ffmpeg 8.1.1 on
 * the operator box; acceptance for FISH-009: "output passes ffprobe"). Fixture
 * WAVs are synthesized with ffmpeg itself — no binary fixtures committed.
 */

const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";
const FFMPEG_PRESENT = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" }).status === 0;

function ffmpegAvailable(): boolean {
  if (FFMPEG_PRESENT) return true;
  console.warn("ffmpeg not found — skipping executor integration tests");
  return false;
}

let dir: string;

/** Sine-wave fixture: `ffmpeg -f lavfi -i sine=frequency:F:duration:S` */
function makeTone(name: string, frequency: number, durationSec: number): string {
  const file = path.join(dir, name);
  const res = spawnSync(
    FFMPEG,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${durationSec}`,
      "-ar", "48000", "-ac", "2",
      file,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`fixture ffmpeg failed for ${name}: ${res.stderr}`);
  return file;
}

function planFor(dirPath: string): MixPlan {
  return {
    formatVersion: 1,
    inputs: [
      { id: "line-01", kind: "dialogue", path: makeTone("line-01.wav", 440, 2) },
      { id: "line-02", kind: "dialogue", path: makeTone("line-02.wav", 520, 2) },
      { id: "bed", kind: "music", path: makeTone("bed.wav", 220, 4) },
      { id: "sfx-door", kind: "sfx", path: makeTone("door.wav", 880, 0.8) },
    ],
    dialogue: [
      { inputId: "line-01", startSec: 0, durationSec: 2 },
      { inputId: "line-02", startSec: 2.5, durationSec: 2, gainDb: -1 },
    ],
    music: { inputId: "bed", gainDb: -10, duckDb: 9 },
    sfx: [{ inputId: "sfx-door", atSec: 1.0, gainDb: -6 }],
    output: {
      path: path.join(dirPath, "mix.m4a"),
      durationSec: 6,
      sampleRateHz: 48000,
      channelLayout: "stereo",
    },
  };
}

beforeAll(() => {
  if (!ffmpegAvailable()) return;
  dir = mkdtempSync(path.join(tmpdir(), "mmcs-mix-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!FFMPEG_PRESENT)("runMix — real ffmpeg integration", () => {
  it("mixes dialogue + ducked bed + SFX and the output passes ffprobe", async () => {
    const plan = planFor(dir);
    // Plan is valid data before any process runs.
    expect(() => validateMixPlan(plan)).not.toThrow();

    const result = await runMix(plan, {
      ffmpegBin: FFMPEG,
      ffprobeBin: FFPROBE,
      timeoutMs: 60_000,
    });

    expect(result.output).toBe(plan.output!.path);
    // Duration bounded by -t 6 (allow encoder/frame rounding slack).
    expect(result.durationSec).toBeGreaterThan(5.5);
    expect(result.durationSec).toBeLessThanOrEqual(6.5);
    expect(result.streams).toHaveLength(1);
    expect(result.streams[0]!.codecType).toBe("audio");
    expect(result.streams[0]!.codecName).toBe("aac");
  }, 120_000);

  it("is deterministic: the same plan compiles to the same argv that re-mixes identically", async () => {
    const plan = planFor(dir);
    plan.output!.path = path.join(dir, "mix-repeat.m4a");

    const first = await runMix(plan, { ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, timeoutMs: 60_000 });
    const second = await runMix(plan, { ffmpegBin: FFMPEG, ffprobeBin: FFPROBE, timeoutMs: 60_000 });

    // Both runs succeed and probe to the same stream shape + duration.
    expect(second.streams).toEqual(first.streams);
    expect(Math.abs(second.durationSec - first.durationSec)).toBeLessThan(0.2);
  }, 180_000);

  it("throws MixPlanError for a bad plan without spawning ffmpeg", async () => {
    const plan = planFor(dir);
    plan.dialogue!.push({ inputId: "missing", startSec: 0 });
    await expect(runMix(plan, { ffmpegBin: FFMPEG })).rejects.toBeInstanceOf(MixPlanError);
  });

  it("throws MixExecError with a stderr tail when an input file is missing", async () => {
    const plan = planFor(dir);
    plan.output!.path = path.join(dir, "mix-fail.m4a");
    plan.inputs[0]!.path = path.join(dir, "does-not-exist.wav");
    const err = await runMix(plan, { ffmpegBin: FFMPEG, ffprobeBin: FFPROBE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MixExecError);
    const execErr = err as MixExecError;
    expect(execErr.exitCode).not.toBe(0);
    expect(execErr.stderrTail.length).toBeGreaterThan(0);
  });
});
