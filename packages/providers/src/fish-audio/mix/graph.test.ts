/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  compileMixGraph,
  DEFAULT_BED_GAIN_DB,
  DEFAULT_BITRATE,
  DEFAULT_CODEC,
  DEFAULT_DUCK_DB,
  DEFAULT_FADE_SEC,
  DEFAULT_LIMITER,
  DEFAULT_SAMPLE_RATE,
  MixPlanError,
} from "./index.js";
import type { MixPlan } from "./types.js";

function fullPlan(overrides: Partial<MixPlan> = {}): MixPlan {
  return {
    formatVersion: 1,
    inputs: [
      { id: "line-01", kind: "dialogue", path: "/tmp/line-01.wav" },
      { id: "line-02", kind: "dialogue", path: "/tmp/line-02.wav" },
      { id: "bed", kind: "music", path: "/tmp/bed.mp3" },
      { id: "sfx-door", kind: "sfx", path: "/tmp/door.wav" },
      { id: "sfx-thunder", kind: "sfx", path: "/tmp/thunder.wav" },
    ],
    dialogue: [
      { inputId: "line-01", startSec: 0.5, durationSec: 2.0 },
      { inputId: "line-02", startSec: 3.25, gainDb: -1.5 },
    ],
    music: { inputId: "bed", gainDb: -8, duckDb: 9 },
    sfx: [
      { inputId: "sfx-door", atSec: 1.2, gainDb: -3 },
      { inputId: "sfx-thunder", atSec: 4.0 },
    ],
    output: { path: "/tmp/mix.m4a", durationSec: 6 },
    ...overrides,
  };
}

describe("compileMixGraph — determinism", () => {
  it("compiles the same plan to byte-identical argv twice", () => {
    const a = compileMixGraph(fullPlan(), "/bin/ffmpeg");
    const b = compileMixGraph(fullPlan(), "/bin/ffmpeg");
    expect(a.argv).toEqual(b.argv);
    expect(a.filterGraph).toBe(b.filterGraph);
    expect(JSON.stringify(a.argv)).toBe(JSON.stringify(b.argv));
  });

  it("emits inputs in plan order with the bed looped", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    // -i order matches plan.inputs order; -stream_loop precedes only the bed.
    const iIndices = c.argv
      .map((arg, i) => (arg === "-i" ? i : -1))
      .filter((i) => i >= 0);
    const paths = iIndices.map((i) => c.argv[i + 1]!);
    expect(paths).toEqual(["/tmp/line-01.wav", "/tmp/line-02.wav", "/tmp/bed.mp3", "/tmp/door.wav", "/tmp/thunder.wav"]);
    const bedIdx = c.argv.indexOf("/tmp/bed.mp3");
    expect(c.argv[bedIdx - 1]).toBe("-i");
    expect(c.argv[bedIdx - 2]).toBe("-1");
    expect(c.argv[bedIdx - 3]).toBe("-stream_loop");
  });

  it("pins ffmpegBin into argv[0] when provided", () => {
    const c = compileMixGraph(fullPlan(), "/opt/homebrew/bin/ffmpeg");
    expect(c.argv[0]).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("keeps numeric defaults out of the plan but in the graph", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.summary).toEqual({
      dialogueLines: 2,
      sfxCues: 2,
      hasMusic: true,
      musicDucked: true,
    });
    // Bed gain -8 comes from the plan; the duck and limiter defaults show up.
    expect(c.filterGraph).toContain("volume=-8.000dB");
    expect(c.filterGraph).toContain(`limit=${DEFAULT_LIMITER.toFixed(3)}`);
    expect(c.filterGraph).toContain("sidechaincompress");
    expect(c.argv).toContain("-t");
    expect(c.argv[c.argv.indexOf("-t") + 1]).toBe((6).toFixed(3));
  });
});

describe("compileMixGraph — filter graph shape", () => {
  it("formats every stream to the target rate/layout, delays in ms, gains in dB", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.filterGraph).toContain(
      "[0:a]aformat=sample_rates=48000:channel_layouts=stereo",
    );
    expect(c.filterGraph).toContain("adelay=500:all=1");
    expect(c.filterGraph).toContain("adelay=3250:all=1");
    expect(c.filterGraph).toContain("adelay=1200:all=1");
    expect(c.filterGraph).toContain("volume=-1.500dB");
    expect(c.filterGraph).toContain("volume=-3.000dB");
  });

  it("sums buses with amix normalize=0 and ends in alimiter [mix]", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.filterGraph).toContain("amix=inputs=2:normalize=0:dropout_transition=0");
    expect(c.filterGraph).toContain(`alimiter=level_in=1:level_out=1:limit=${DEFAULT_LIMITER.toFixed(3)}`);
    expect(c.filterGraph.endsWith("[mix]")).toBe(true);
    expect(c.argv[c.argv.indexOf("-map") + 1]).toBe("[mix]");
  });

  it("applies dialogue fade-out anchored to the line's own duration", () => {
    const plan = fullPlan({
      dialogue: [{ inputId: "line-01", startSec: 0, durationSec: 2, fadeOutSec: 0.4 }],
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.filterGraph).toContain("afade=t=out:st=1.600:d=0.400");
  });

  it("applies dialogue fade-in from stream start", () => {
    const plan = fullPlan({
      dialogue: [{ inputId: "line-01", startSec: 1, fadeInSec: 0.25 }],
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.filterGraph).toContain("afade=t=in:st=0:d=0.250");
  });

  it("highpasses and fades the bed; anchors fade-out at durationSec - fade", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.filterGraph).toContain("highpass=f=90");
    expect(c.filterGraph).toContain("afade=t=in:st=0:d=1.500");
    // durationSec=6, fadeOut default 1.5 → st=4.5
    expect(c.filterGraph).toContain("afade=t=out:st=4.500:d=1.500");
  });

  it("disables ducking when duckDb=0 and keeps the single voice bus direct", () => {
    const plan = fullPlan({
      music: { inputId: "bed", duckDb: 0 },
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.filterGraph).not.toContain("sidechaincompress");
    expect(c.filterGraph).not.toContain("asplit");
    expect(c.summary.musicDucked).toBe(false);
  });

  it("skips -t when durationSec is absent (bed-less plan)", () => {
    const plan = fullPlan({
      music: undefined,
      dialogue: [{ inputId: "line-01", startSec: 0, durationSec: 2 }],
      output: { path: "/tmp/mix.m4a" },
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.argv).not.toContain("-t");
  });

  it("requires durationSec whenever a music bed is present (looped input)", () => {
    const plan = fullPlan({
      music: { inputId: "bed", fadeOutSec: 0 },
      output: { path: "/tmp/mix.m4a" },
    });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/durationSec is required/);
  });

  it("uses an anull passthrough for a single-stream bus instead of amix", () => {
    const plan = fullPlan({
      dialogue: [{ inputId: "line-01", startSec: 0 }],
      sfx: [{ inputId: "sfx-door", atSec: 0 }],
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.filterGraph).toContain("[s0]anull[sfx]");
    expect(c.filterGraph).not.toContain("amix=inputs=2:normalize=0:dropout_transition=0[voice]");
  });

  it("carries codec/bitrate defaults into the argv and output descriptor", () => {
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.argv).toContain("-c:a");
    expect(c.argv[c.argv.indexOf("-c:a") + 1]).toBe(DEFAULT_CODEC);
    expect(c.argv).toContain("-b:a");
    expect(c.argv[c.argv.indexOf("-b:a") + 1]).toBe(DEFAULT_BITRATE);
    expect(c.output).toEqual({ path: "/tmp/mix.m4a", codec: DEFAULT_CODEC, bitrate: DEFAULT_BITRATE });
  });

  it("honors mono/8k-ish override output settings", () => {
    const plan = fullPlan({
      output: {
        path: "/tmp/mix.wav",
        codec: "pcm_s16le",
        sampleRateHz: 44100,
        channelLayout: "mono",
        durationSec: 6,
      },
    });
    const c = compileMixGraph(plan, "ffmpeg");
    expect(c.filterGraph).toContain("aformat=sample_rates=44100:channel_layouts=mono");
    expect(c.argv[c.argv.indexOf("-c:a") + 1]).toBe("pcm_s16le");
  });
});

describe("compileMixGraph — plan validation", () => {
  it("rejects a missing/empty output path", () => {
    expect(() =>
      compileMixGraph(fullPlan({ output: { path: "" } }), "ffmpeg"),
    ).toThrow(MixPlanError);
    expect(() =>
      compileMixGraph({ ...fullPlan(), output: undefined as unknown as MixPlan["output"] }, "ffmpeg"),
    ).toThrow(/output\.path is required/);
  });

  it("rejects control characters in the output path", () => {
    expect(() =>
      compileMixGraph(fullPlan({ output: { path: "/tmp/x\n-y" } }), "ffmpeg"),
    ).toThrow(/control characters/);
  });

  it("rejects unknown formatVersion", () => {
    const plan = { ...fullPlan(), formatVersion: 99 as unknown as 1 };
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/formatVersion/);
  });

  it("rejects duplicate input ids", () => {
    const plan = fullPlan();
    plan.inputs.push({ id: "line-01", kind: "dialogue", path: "/tmp/dupe.wav" });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/duplicate input id/);
  });

  it("rejects layers referencing unknown inputs", () => {
    const plan = fullPlan({ sfx: [{ inputId: "nope", atSec: 1 }] });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/unknown input "nope"/);
  });

  it("rejects a plan with no layers", () => {
    const plan = fullPlan({ dialogue: undefined, music: undefined, sfx: undefined });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/no dialogue, music, or sfx/);
  });

  it("rejects non-finite and out-of-range numbers", () => {
    expect(() =>
      compileMixGraph(fullPlan({ sfx: [{ inputId: "sfx-door", atSec: Number.NaN }] }), "ffmpeg"),
    ).toThrow(MixPlanError);
    expect(() =>
      compileMixGraph(fullPlan({ dialogue: [{ inputId: "line-01", startSec: -1 }] }), "ffmpeg"),
    ).toThrow(/startSec/);
    expect(() =>
      compileMixGraph(fullPlan({ music: { inputId: "bed", gainDb: 999 } }), "ffmpeg"),
    ).toThrow(/gainDb/);
    expect(() =>
      compileMixGraph(fullPlan({ output: { path: "/tmp/m.m4a", sampleRateHz: 1000 } }), "ffmpeg"),
    ).toThrow(/sampleRateHz/);
    expect(() =>
      compileMixGraph(fullPlan({ output: { path: "/tmp/m.m4a", limiterCeiling: 1.5 } }), "ffmpeg"),
    ).toThrow(/limiterCeiling/);
  });

  it("rejects bed fade-out without durationSec", () => {
    const plan = fullPlan({ output: { path: "/tmp/m.m4a" } });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/durationSec is required/);
  });

  it("rejects ducking with no dialogue key", () => {
    const plan = fullPlan({ dialogue: undefined });
    expect(() => compileMixGraph(plan, "ffmpeg")).toThrow(/requires dialogue/);
  });

  it("never interpolates untrusted text into the graph", () => {
    // Input PATHS are caller data and do appear; nothing else textual does.
    const c = compileMixGraph(fullPlan(), "ffmpeg");
    expect(c.filterGraph).not.toMatch(/inputId|startSec|gainDb|dialogue|music/);
  });
});

describe("module defaults", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_SAMPLE_RATE).toBe(48000);
    expect(DEFAULT_LIMITER).toBe(0.97);
    expect(DEFAULT_DUCK_DB).toBe(9);
    expect(DEFAULT_FADE_SEC).toBe(1.5);
    expect(DEFAULT_CODEC).toBe("aac");
    expect(DEFAULT_BITRATE).toBe("192k");
  });
});
