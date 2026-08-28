/**
 * FISH-009 — Mix pipeline (dialogue / music bed / SFX).
 *
 * The mix plan is DATA (serializable JSON): inputs, dialogue lines, one music
 * bed, SFX cues, output settings. `compileMixGraph` turns it into a
 * DETERMINISTIC ffmpeg filter graph + argv (same plan → same argv,
 * byte-for-byte); `runMix` executes it and verifies the output with ffprobe.
 *
 * Untrusted text policy (spec §21): story/dialogue text may ride in the plan
 * for traceability but is never executed; only validated numbers and
 * caller-supplied paths reach argv, and the invocation is a child process
 * with argv passed verbatim — never a shell string.
 */
export {
  compileMixGraph,
  DEFAULT_BED_GAIN_DB,
  DEFAULT_BITRATE,
  DEFAULT_CODEC,
  DEFAULT_DUCK_DB,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RATIO,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_DUCK_THRESHOLD,
  DEFAULT_FADE_SEC,
  DEFAULT_HIGHPASS_HZ,
  DEFAULT_LIMITER,
  DEFAULT_SAMPLE_RATE,
} from "./graph.js";
export { MixPlanError, validateMixPlan } from "./plan.js";
export {
  MixExecError,
  runCompiledMix,
  runFfmpeg,
  runMix,
  type MixRunOptions,
} from "./executor.js";
export type {
  CompiledMix,
  GainDb,
  MixDialogueLayer,
  MixInput,
  MixInputKind,
  MixMusicLayer,
  MixOutputFile,
  MixOutputSettings,
  MixPlan,
  MixResult,
  MixSfxCue,
} from "./types.js";
