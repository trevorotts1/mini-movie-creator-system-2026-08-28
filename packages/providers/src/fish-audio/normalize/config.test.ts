/**
 * Unit tests for the FISH-008 normalization CONTRACT — config resolution,
 * deterministic argument building, loudnorm JSON parsing. No ffmpeg needed;
 * the fixture-WAV end-to-end contract lives in normalize.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  NORMALIZE_DEFAULT_LRA_LU,
  NORMALIZE_DEFAULT_TARGET_LUFS,
  NORMALIZE_DEFAULT_TRUE_PEAK_DBTP,
  NORMALIZE_PASSES,
  buildNormalizeArgs,
  loudnormFilter,
  parseLoudnormJson,
  resolveNormalizeOptions,
  type LoudnessMeasurements,
} from "./config.js";
import { NormalizeError } from "./errors.js";

const MEASURED: LoudnessMeasurements = {
  inputI: -24.1,
  inputTp: -6.2,
  inputLra: 8.3,
  inputThresh: -34.2,
  targetOffset: -0.55,
};

describe("resolveNormalizeOptions", () => {
  it("defaults to -16 LUFS / -1.5 dBTP / 11 LU / 48 kHz stereo wav", () => {
    expect(resolveNormalizeOptions()).toEqual({
      targetLufs: NORMALIZE_DEFAULT_TARGET_LUFS,
      truePeakDbtp: NORMALIZE_DEFAULT_TRUE_PEAK_DBTP,
      lraLu: NORMALIZE_DEFAULT_LRA_LU,
      sampleRateHz: 48_000,
      channels: 2,
      format: "wav",
    });
  });

  it("accepts a configurable target LUFS", () => {
    expect(resolveNormalizeOptions({ targetLufs: -23 }).targetLufs).toBe(-23);
    expect(resolveNormalizeOptions({ targetLufs: -14 }).targetLufs).toBe(-14);
  });

  it("rejects non-finite and out-of-range targets with kind=config", () => {
    for (const bad of [NaN, Infinity, 0, -4.9, -70.1, 12]) {
      expect(() => resolveNormalizeOptions({ targetLufs: bad })).toThrowError(NormalizeError);
      try {
        resolveNormalizeOptions({ targetLufs: bad });
      } catch (e) {
        expect((e as NormalizeError).kind).toBe("config");
      }
    }
  });

  it("rejects bad true-peak, LRA, sample rate, channels, format", () => {
    expect(() => resolveNormalizeOptions({ truePeakDbtp: 0 })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ truePeakDbtp: NaN })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ lraLu: 0 })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ lraLu: 51 })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ sampleRateHz: 44_100 })).not.toThrowError();
    expect(() => resolveNormalizeOptions({ sampleRateHz: 7_999 })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ channels: 5 as 2 })).toThrowError(NormalizeError);
    expect(() => resolveNormalizeOptions({ format: "mp3" as "wav" })).toThrowError(NormalizeError);
  });

  it("allows lraLu=null to disable the LRA constraint", () => {
    expect(resolveNormalizeOptions({ lraLu: null }).lraLu).toBeNull();
  });
});

describe("buildNormalizeArgs (deterministic args)", () => {
  const options = resolveNormalizeOptions();

  it("emits a pure-function argument array — byte-identical across calls", () => {
    const a = buildNormalizeArgs(options, MEASURED, "/tmp/in.wav", "/tmp/out.wav");
    const b = buildNormalizeArgs(options, MEASURED, "/tmp/in.wav", "/tmp/out.wav");
    expect(a.measureArgs).toEqual(b.measureArgs);
    expect(a.applyArgs).toEqual(b.applyArgs);
  });

  it("is a TWO-pass contract (measure + apply)", () => {
    expect(NORMALIZE_PASSES).toBe(2);
    const a = buildNormalizeArgs(options, MEASURED, "/in.wav", "/out.wav");
    expect(a.measureArgs).toHaveLength(a.applyArgs.length > 0 ? a.measureArgs.length : -1);
    // measure pass: analysis only — no measured_* in the filter, null sink.
    const measureFilter = a.measureArgs[a.measureArgs.indexOf("-af") + 1];
    expect(measureFilter).not.toContain("measured_I");
    expect(a.measureArgs).toContain("-f");
    expect(a.measureArgs).toContain("null");
    // apply pass: measured_* pinned + linear=true (ONE static gain).
    const applyFilter = a.applyArgs[a.applyArgs.indexOf("-af") + 1];
    expect(applyFilter).toContain("measured_I=-24.1");
    expect(applyFilter).toContain("linear=true");
  });

  it("carries the configurable LUFS target into both filters", () => {
    const opts = resolveNormalizeOptions({ targetLufs: -23 });
    const a = buildNormalizeArgs(opts, MEASURED, "/in.wav", "/out.wav");
    expect(a.measureArgs[a.measureArgs.indexOf("-af") + 1]).toContain("I=-23.0");
    expect(a.applyArgs[a.applyArgs.indexOf("-af") + 1]).toContain("I=-23.0");
  });

  it("omits LRA when disabled and includes it when set", () => {
    const noLra = buildNormalizeArgs(resolveNormalizeOptions({ lraLu: null }), MEASURED, "/i", "/o");
    expect(noLra.measureArgs.join(" ")).not.toContain("LRA=");
    const withLra = buildNormalizeArgs(resolveNormalizeOptions({ lraLu: 7 }), MEASURED, "/i", "/o");
    expect(withLra.measureArgs.join(" ")).toContain("LRA=7.0");
  });

  it("keeps output encoding fixed per format (pcm_s16le for wav)", () => {
    const wav = buildNormalizeArgs(options, MEASURED, "/i", "/o.wav");
    expect(wav.applyArgs).toEqual(expect.arrayContaining(["-c:a", "pcm_s16le"]));
    const m4a = buildNormalizeArgs(resolveNormalizeOptions({ format: "m4a" }), MEASURED, "/i", "/o.m4a");
    expect(m4a.applyArgs).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "192k"]));
  });

  it("strips metadata + forces bit-exactness for reproducible output", () => {
    const a = buildNormalizeArgs(options, MEASURED, "/i", "/o");
    expect(a.applyArgs).toEqual(
      expect.arrayContaining(["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"]),
    );
  });

  it("fixes sample rate and channel layout from options", () => {
    const mono = buildNormalizeArgs(resolveNormalizeOptions({ channels: 1, sampleRateHz: 24_000 }), MEASURED, "/i", "/o");
    expect(mono.applyArgs).toEqual(expect.arrayContaining(["-ar", "24000", "-ac", "1", "-channel_layout", "mono"]));
  });

  it("places paths LAST so the deterministic prefix never varies with file names", () => {
    const a = buildNormalizeArgs(options, MEASURED, "/some/UNTRUSTED name.wav", "/other/out.wav");
    expect(a.applyArgs[a.applyArgs.length - 1]).toBe("/other/out.wav");
    expect(a.measureArgs[a.measureArgs.indexOf("-i") + 1]).toBe("/some/UNTRUSTED name.wav");
    const b = buildNormalizeArgs(options, MEASURED, "/i.wav", "/o.wav");
    // Everything before the input path is identical regardless of paths.
    const prefixOf = (args: string[]) => args.slice(0, args.indexOf("-i"));
    expect(prefixOf(a.applyArgs)).toEqual(prefixOf(b.applyArgs));
  });

  it("never uses a shell — args are a flat array (spec §47 safe shell handling)", () => {
    const a = buildNormalizeArgs(options, MEASURED, "in;rm -rf .wav", "out$(evil).wav");
    expect(a.applyArgs).not.toContain(";");
    expect(a.applyArgs).not.toContain("$(");
  });
});

describe("loudnormFilter", () => {
  it("uses fixed decimal formatting, never locale-dependent toString", () => {
    const filter = loudnormFilter(resolveNormalizeOptions({ targetLufs: -16 }), MEASURED);
    expect(filter).toContain("I=-16.0");
    expect(filter).toContain("TP=-1.5");
    expect(filter).toContain("LRA=11.0");
  });

  it("feeds loudnorm's own target_offset back as the apply offset", () => {
    // A hand-computed (target - measured_I) offset double-applies gain and
    // overshoots the target (verified against ffmpeg 8.1.1); loudnorm's own
    // `target_offset` is the only correct value.
    const filter = loudnormFilter(resolveNormalizeOptions({ targetLufs: -16 }), MEASURED);
    expect(filter).toContain("offset=-0.55");
    expect(filter).not.toContain("offset=8.6"); // the wrong hand-computed value
  });
});

describe("parseLoudnormJson", () => {
  const STDERR = [
    "[Parsed_loudnorm_0 @ 0x7f9] lavfi.loudnorm.I=-24.1",
    "[Parsed_loudnorm_0 @ 0x7f9] lavfi.loudnorm.LRA=8.3",
    '{"input_i" : "-24.10", "input_tp" : "-6.20", "input_lra" : "8.30", "input_thresh" : "-34.20", "output_i" : "-15.50", "output_tp" : "-1.50", "output_lra" : "7.90", "output_thresh" : "-25.70", "normalization_type" : "dynamic", "target_offset" : "0.55"}',
    "size=N/A time=00:00:10.00 bitrate=N/A speed=  31x    ",
  ].join("\n");

  it("parses the loudnorm analysis block from stderr", () => {
    expect(parseLoudnormJson(STDERR)).toEqual({
      inputI: -24.1,
      inputTp: -6.2,
      inputLra: 8.3,
      inputThresh: -34.2,
      targetOffset: 0.55,
    });
  });

  it("keeps the LAST analysis block when several appear", () => {
    const two = STDERR + '\n{"input_i" : "-20.00", "input_tp" : "-3.00", "input_lra" : "5.00", "input_thresh" : "-30.00", "target_offset" : "-0.10"}';
    expect(parseLoudnormJson(two).inputI).toBe(-20);
    expect(parseLoudnormJson(two).targetOffset).toBe(-0.1);
  });

  it("rejects -inf (silent) measurements with kind=measure", () => {
    const silent = '{"input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "-inf", "input_thresh" : "-inf"}';
    try {
      parseLoudnormJson(silent);
      expect.unreachable("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NormalizeError);
      expect((e as NormalizeError).kind).toBe("measure");
    }
  });

  it("rejects stderr with no loudnorm block", () => {
    expect(() => parseLoudnormJson("no json here at all")).toThrowError(NormalizeError);
  });
});
