/**
 * Filter-graph compiler (FISH-009) — plan (data) → deterministic FFmpeg
 * filter_complex + argv. Determinism contract: the same plan ALWAYS compiles
 * to the same argv, byte-for-byte — inputs are emitted in plan order, every
 * numeric default is fixed, and every number is rendered with fixed precision.
 * Nothing here reads the clock, the filesystem, or the network.
 *
 * Graph shape (ported from the upstream audition mixers, tools/mix_sfx.py +
 * tools/mix_music.py — same 48k/stereo aformat, adelay, amix(normalize=0),
 * sidechain duck, alimiter idiom):
 *   dialogue lines : aformat → adelay → volume → [afade in/out] → (dLn)
 *   sfx cues       : aformat → adelay → volume → (sN)
 *   buses          : amix(normalize=0) — dialogue bus "voice", sfx bus "sfx"
 *   music bed      : aformat → [highpass] → volume → afade in/out → (bed)
 *   bed duck       : voice asplit=2 (key + keep) → sidechaincompress → (bedduck)
 *   master         : amix(normalize=0) of voice+sfx+bed → alimiter → (mix)
 *
 * The plan declares `output.durationSec` (master timeline length). The
 * executor bounds the render with -t; the bed (looped at input level) is
 * trimmed by that same -t and its fade-out is anchored at durationSec minus
 * the fade length. durationSec is required when the bed fades out; otherwise
 * optional and no -t is emitted.
 */
import type { CompiledMix, MixPlan } from "./types.js";
import { MixPlanError, validateMixPlan } from "./plan.js";

export const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_LAYOUT = "stereo";
export const DEFAULT_LIMITER = 0.97;
export const DEFAULT_BED_GAIN_DB = -7;
export const DEFAULT_DUCK_DB = 9;
export const DEFAULT_FADE_SEC = 1.5;
export const DEFAULT_HIGHPASS_HZ = 90;
export const DEFAULT_DUCK_THRESHOLD = 0.03;
export const DEFAULT_DUCK_RATIO = 3;
export const DEFAULT_DUCK_ATTACK_MS = 15;
export const DEFAULT_DUCK_RELEASE_MS = 450;
export const DEFAULT_CODEC = "aac";
export const DEFAULT_BITRATE = "192k";

/** Fixed-precision number rendering — no locale, no exponent drift. */
function f(value: number, decimals = 3): string {
  return value.toFixed(decimals);
}

/**
 * Compile a plan into the complete ffmpeg argv. `ffmpegBin` defaults to
 * "ffmpeg" (resolved on PATH at exec time); pass an absolute path to pin it.
 */
export function compileMixGraph(plan: MixPlan, ffmpegBin = "ffmpeg"): CompiledMix {
  validateMixPlan(plan);

  const out = plan.output?.path;
  if (typeof out !== "string" || out.trim() === "") {
    throw new MixPlanError("plan.output.path is required");
  }
  if (/[\r\n\0]/.test(out)) throw new MixPlanError("plan.output.path contains control characters");

  const outSettings = plan.output ?? { path: out };
  const sampleRate = outSettings.sampleRateHz ?? DEFAULT_SAMPLE_RATE;
  const layout = outSettings.channelLayout ?? DEFAULT_LAYOUT;
  const limiter = outSettings.limiterCeiling ?? DEFAULT_LIMITER;
  const durationSec = outSettings.durationSec;
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new MixPlanError(`output.sampleRateHz out of range [8000, 192000]: ${String(sampleRate)}`);
  }
  if (!Number.isFinite(limiter) || limiter <= 0 || limiter > 1) {
    throw new MixPlanError(`output.limiterCeiling must be in (0, 1]: ${String(limiter)}`);
  }
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec <= 0)) {
    throw new MixPlanError(`output.durationSec must be > 0: ${String(durationSec)}`);
  }
  const codec = outSettings.codec ?? DEFAULT_CODEC;
  const bitrate = outSettings.bitrate ?? DEFAULT_BITRATE;

  const byIndex = new Map<string, number>();
  // Input order = plan.inputs order → argv order (-i flags), 0-based.
  plan.inputs.forEach((input, index) => byIndex.set(input.id, index));

  const parts: string[] = [];
  const dialogueLabels: string[] = [];
  const sfxLabels: string[] = [];

  // --- dialogue lines -------------------------------------------------------
  // Fades are applied on the line's OWN timeline BEFORE adelay placement
  // (upstream idiom, tools/mix_sfx.py + mix_music.py): after adelay the
  // stream's timeline is the master timeline, so a fade would otherwise land
  // at the wrong offset. The line duration is caller data (never probed:
  // determinism), so a fade-out requires durationSec on the layer.
  for (let i = 0; i < (plan.dialogue?.length ?? 0); i++) {
    const line = plan.dialogue![i]!;
    const idx = byIndex.get(line.inputId)!;
    const chain: string[] = [`[${idx}:a]aformat=sample_rates=${sampleRate}:channel_layouts=${layout}`];
    chain.push(`volume=${f(line.gainDb ?? 0)}dB`);
    if ((line.fadeInSec ?? 0) > 0) {
      chain.push(`afade=t=in:st=0:d=${f(line.fadeInSec!)}`);
    }
    if ((line.fadeOutSec ?? 0) > 0) {
      const outStart = (line.durationSec ?? 0) - (line.fadeOutSec ?? 0);
      chain.push(`afade=t=out:st=${f(outStart)}:d=${f(line.fadeOutSec!)}`);
    }
    const delayMs = Math.round(line.startSec * 1000);
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
    const label = `dL${i}`;
    parts.push(chain.join(",") + `[${label}]`);
    dialogueLabels.push(`[${label}]`);
  }

  // --- sfx cues ---------------------------------------------------------------
  for (let i = 0; i < (plan.sfx?.length ?? 0); i++) {
    const cue = plan.sfx![i]!;
    const idx = byIndex.get(cue.inputId)!;
    const chain: string[] = [`[${idx}:a]aformat=sample_rates=${sampleRate}:channel_layouts=${layout}`];
    chain.push(`volume=${f(cue.gainDb ?? 0)}dB`);
    const delayMs = Math.round(cue.atSec * 1000);
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
    const label = `s${i}`;
    parts.push(chain.join(",") + `[${label}]`);
    sfxLabels.push(`[${label}]`);
  }

  // --- buses ------------------------------------------------------------------
  let sfxBus: string | null = null;
  if (sfxLabels.length === 1) {
    parts.push(`${sfxLabels[0]}anull[sfx]`);
    sfxBus = "[sfx]";
  } else if (sfxLabels.length > 1) {
    parts.push(`${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:normalize=0:dropout_transition=0[sfx]`);
    sfxBus = "[sfx]";
  }

  let voiceBus: string | null = null;
  if (dialogueLabels.length === 1) {
    voiceBus = dialogueLabels[0]!;
  } else if (dialogueLabels.length > 1) {
    parts.push(
      `${dialogueLabels.join("")}amix=inputs=${dialogueLabels.length}:normalize=0:dropout_transition=0[voice]`,
    );
    voiceBus = "[voice]";
  }

  // --- music bed --------------------------------------------------------------
  let bedLabel: string | null = null;
  if (plan.music) {
    const music = plan.music;
    const idx = byIndex.get(music.inputId)!;
    const bedGain = music.gainDb ?? DEFAULT_BED_GAIN_DB;
    const duckDb = music.duckDb ?? DEFAULT_DUCK_DB;
    const fadeIn = music.fadeInSec ?? DEFAULT_FADE_SEC;
    const fadeOut = music.fadeOutSec ?? DEFAULT_FADE_SEC;
    if (fadeOut > 0 && durationSec === undefined) {
      throw new MixPlanError("output.durationSec is required when the music bed fades out");
    }
    if (durationSec === undefined) {
      // The bed input is compiled with -stream_loop -1: without a -t bound the
      // encode never terminates, so a bed plan must declare the mix length.
      throw new MixPlanError("output.durationSec is required when a music bed is present");
    }
    if (duckDb > 0 && dialogueLabels.length === 0) {
      throw new MixPlanError("music duckDb > 0 requires dialogue (no sidechain key)");
    }
    const chain: string[] = [`[${idx}:a]aformat=sample_rates=${sampleRate}:channel_layouts=${layout}`];
    if ((music.highpassHz ?? DEFAULT_HIGHPASS_HZ) > 0) {
      chain.push(`highpass=f=${Math.round(music.highpassHz ?? DEFAULT_HIGHPASS_HZ)}`);
    }
    chain.push(`volume=${f(bedGain)}dB`);
    if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${f(fadeIn)}`);
    if (fadeOut > 0 && durationSec !== undefined) {
      const outStart = Math.max(0, durationSec - fadeOut);
      chain.push(`afade=t=out:st=${f(outStart)}:d=${f(fadeOut)}`);
    }
    parts.push(chain.join(",") + `[bed]`);
    bedLabel = "[bed]";

    // --- bed duck: sidechaincompress keyed by a copy of the voice bus ----------
    if (duckDb > 0) {
      // voiceBus is non-null here (duckDb > 0 requires dialogue, checked above).
      // Split the voice: one copy keys the compressor, one reaches the sum —
      // sidechaincompress consumes its key input. The key copy is padded with
      // apad: sidechaincompress ENDS when its key ends, which would otherwise
      // truncate the whole master sum at the last dialogue line instead of the
      // -t bound. After the voice ends, silence keys the bed back to full.
      parts.push(`${voiceBus!}asplit=2[voicekey0][voiceout]`);
      parts.push(`[voicekey0]apad[voicekey]`);
      parts.push(
        `[bed][voicekey]sidechaincompress=threshold=${f(outSettings.duckThreshold ?? DEFAULT_DUCK_THRESHOLD, 4)}:` +
          `ratio=${f(outSettings.duckRatio ?? DEFAULT_DUCK_RATIO, 2)}:` +
          `attack=${Math.round(outSettings.duckAttackMs ?? DEFAULT_DUCK_ATTACK_MS)}:` +
          `release=${Math.round(outSettings.duckReleaseMs ?? DEFAULT_DUCK_RELEASE_MS)}:makeup=1[bedduck]`,
      );
      bedLabel = "[bedduck]";
      // The kept voice copy replaces the original voice bus in the sum.
      voiceBus = "[voiceout]";
    }
  }

  // --- master sum -------------------------------------------------------------
  const sumLabels: string[] = [];
  if (voiceBus) sumLabels.push(voiceBus);
  if (sfxBus) sumLabels.push(sfxBus);
  if (bedLabel) sumLabels.push(bedLabel);

  let mixLabel: string;
  if (sumLabels.length === 1) {
    parts.push(`${sumLabels[0]}anull[mixpre]`);
    mixLabel = "[mixpre]";
  } else {
    parts.push(`${sumLabels.join("")}amix=inputs=${sumLabels.length}:normalize=0:dropout_transition=0[mixpre]`);
    mixLabel = "[mixpre]";
  }
  parts.push(`${mixLabel}alimiter=level_in=1:level_out=1:limit=${f(limiter)}[mix]`);

  const filterGraph = parts.join(";");

  // --- argv -------------------------------------------------------------------
  const argv: string[] = [ffmpegBin, "-y", "-hide_banner"];
  for (const input of plan.inputs) {
    // The bed must cover the whole mix: loop its input forever; -t bounds it.
    if (plan.music && input.id === plan.music.inputId) {
      argv.push("-stream_loop", "-1");
    }
    argv.push("-i", input.path);
  }
  argv.push("-filter_complex", filterGraph, "-map", "[mix]");
  argv.push("-c:a", codec);
  if (bitrate) argv.push("-b:a", bitrate);
  if (durationSec !== undefined) argv.push("-t", f(durationSec));
  argv.push(out);

  return {
    argv,
    filterGraph,
    output: { path: out, codec, bitrate },
    summary: {
      dialogueLines: plan.dialogue?.length ?? 0,
      sfxCues: plan.sfx?.length ?? 0,
      hasMusic: plan.music !== undefined,
      musicDucked: plan.music !== undefined && (plan.music.duckDb ?? DEFAULT_DUCK_DB) > 0,
    },
  };
}