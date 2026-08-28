/**
 * Plan validation (VID-010). FISH-009 compiles the FFmpeg mix; this layer
 * compiles the Remotion placement from the SAME plan — so it must reject the
 * same class of bad plans. A plan that fails here must never reach the
 * timeline: bad numbers would silently shift audio off the frame grid.
 *
 * All errors are deterministic (same plan → same error message) and contain
 * only plan-provided strings — story text is untrusted data and is echoed
 * inside quotes, never executed or interpolated.
 */
import type {
  AudioClipInput,
  AudioDialoguePlacement,
  AudioMusicPlacement,
  AudioSfxCue,
  AudioTimelinePlan,
} from "./types.js";

/** Thrown for any invalid audio timeline plan. */
export class AudioPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioPlanError";
  }
}

const INPUT_ID_RE = /^[A-Za-z0-9._-]+$/;
/** Human-text fields (cue/shot notes). Bounded, not restricted to ids. */
const MAX_TEXT_LEN = 300;
const MAX_GAIN_DB = 24;
const MIN_GAIN_DB = -120;
const MAX_FADE_SEC = 30;
const MAX_DUCK_DB = 60;
const MAX_HIGHPASS_HZ = 20_000;
const MAX_DURATION_SEC = 3_600;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requireFiniteNumber(value: unknown, field: string, min: number, max: number): number {
  if (!isFiniteNumber(value)) {
    throw new AudioPlanError(`${field} must be a finite number: ${String(value)}`);
  }
  if (value < min || value > max) {
    throw new AudioPlanError(`${field} out of range [${min}, ${max}]: ${String(value)}`);
  }
  return value;
}

function optionalNumber(
  container: Record<string, unknown> | undefined,
  field: string,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = container?.[key];
  if (raw === undefined) return undefined;
  return requireFiniteNumber(raw, `${field}.${key}`, min, max);
}

function validateInputId(inputId: string, field: string): string {
  if (typeof inputId !== "string" || inputId.trim() === "") {
    throw new AudioPlanError(`${field}.inputId must be a non-empty string`);
  }
  if (!INPUT_ID_RE.test(inputId)) {
    throw new AudioPlanError(
      `${field}.inputId must match ${INPUT_ID_RE.source} (safe for argv/graph labels): "${inputId}"`,
    );
  }
  return inputId;
}

function validateInputs(inputs: AudioClipInput[]): void {
  if (!Array.isArray(inputs)) {
    throw new AudioPlanError("inputs must be an array");
  }
  if (inputs.length === 0) {
    throw new AudioPlanError("inputs must not be empty");
  }
  const seen = new Set<string>();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] as AudioClipInput;
    if (input === null || typeof input !== "object") {
      throw new AudioPlanError(`inputs[${i}] must be an object`);
    }
    if (input.kind !== "dialogue" && input.kind !== "music" && input.kind !== "sfx") {
      throw new AudioPlanError(
        `inputs[${i}].kind must be "dialogue" | "music" | "sfx": ${String(input.kind)}`,
      );
    }
    if (typeof input.path !== "string" || input.path.trim() === "") {
      throw new AudioPlanError(`inputs[${i}].path must be a non-empty string`);
    }
    if (/[\r\n\0]/.test(input.path)) {
      throw new AudioPlanError(`inputs[${i}].path contains control characters`);
    }
    if (typeof input.id !== "string" || input.id.trim() === "") {
      throw new AudioPlanError(`inputs[${i}].id must be a non-empty string`);
    }
    if (!INPUT_ID_RE.test(input.id)) {
      throw new AudioPlanError(
        `inputs[${i}].id must match ${INPUT_ID_RE.source} (safe for argv/graph labels): "${input.id}"`,
      );
    }
    if (seen.has(input.id)) {
      throw new AudioPlanError(`duplicate input id: "${input.id}"`);
    }
    seen.add(input.id);
  }
}

function validateDialogueLines(lines: AudioDialoguePlacement[]): void {
  for (let i = 0; i < lines.length; i++) {
    const field = `dialogue[${i}]`;
    const line = lines[i] as AudioDialoguePlacement;
    if (line === null || typeof line !== "object") {
      throw new AudioPlanError(`${field} must be an object`);
    }
    validateInputId(line.inputId, field);
    requireFiniteNumber(line.startSec, `${field}.startSec`, 0, MAX_DURATION_SEC);
    optionalNumber(line as unknown as Record<string, unknown>, field, "gainDb", MIN_GAIN_DB, MAX_GAIN_DB);
    optionalNumber(line as unknown as Record<string, unknown>, field, "fadeInSec", 0, MAX_FADE_SEC);
    optionalNumber(line as unknown as Record<string, unknown>, field, "fadeOutSec", 0, MAX_FADE_SEC);
    optionalNumber(line as unknown as Record<string, unknown>, field, "durationSec", 0, MAX_DURATION_SEC);
  }
}

function validateMusic(music: AudioMusicPlacement): void {
  const field = "music";
  if (music === null || typeof music !== "object") {
    throw new AudioPlanError(`${field} must be an object when present`);
  }
  validateInputId(music.inputId, field);
  optionalNumber(music as unknown as Record<string, unknown>, field, "gainDb", MIN_GAIN_DB, MAX_GAIN_DB);
  optionalNumber(music as unknown as Record<string, unknown>, field, "duckDb", 0, MAX_DUCK_DB);
  optionalNumber(music as unknown as Record<string, unknown>, field, "fadeInSec", 0, MAX_FADE_SEC);
  optionalNumber(music as unknown as Record<string, unknown>, field, "fadeOutSec", 0, MAX_FADE_SEC);
  optionalNumber(music as unknown as Record<string, unknown>, field, "highpassHz", 0, MAX_HIGHPASS_HZ);
}

function validateSfxCues(cues: AudioSfxCue[]): void {
  for (let i = 0; i < cues.length; i++) {
    const field = `sfx[${i}]`;
    const cue = cues[i] as AudioSfxCue;
    if (cue === null || typeof cue !== "object") {
      throw new AudioPlanError(`${field} must be an object`);
    }
    validateInputId(cue.inputId, field);
    requireFiniteNumber(cue.atSec, `${field}.atSec`, 0, MAX_DURATION_SEC);
    optionalNumber(cue as unknown as Record<string, unknown>, field, "gainDb", MIN_GAIN_DB, MAX_GAIN_DB);
    optionalNumber(cue as unknown as Record<string, unknown>, field, "durationSec", 0, MAX_DURATION_SEC);
    if (cue.shot !== undefined) {
      if (typeof cue.shot !== "string" || cue.shot.length > MAX_TEXT_LEN) {
        throw new AudioPlanError(`${field}.shot must be a string of at most ${MAX_TEXT_LEN} characters`);
      }
    }
    if (cue.cue !== undefined) {
      if (typeof cue.cue !== "string" || cue.cue.length > MAX_TEXT_LEN) {
        throw new AudioPlanError(`${field}.cue must be a string of at most ${MAX_TEXT_LEN} characters`);
      }
    }
  }
}

/**
 * Validate an audio timeline plan. Throws `AudioPlanError` on the first
 * problem. Structural shape (arrays, objects, ids, numeric ranges) only —
 * cross-references (placement → input kind) are checked by `placeAudio`
 * after this passes.
 */
export function validateAudioPlan(plan: AudioTimelinePlan): void {
  if (plan === null || typeof plan !== "object") {
    throw new AudioPlanError("plan must be an object");
  }
  if (plan.formatVersion !== 1) {
    throw new AudioPlanError(`plan.formatVersion must be 1: ${String(plan.formatVersion)}`);
  }
  validateInputs(plan.inputs);
  if (plan.dialogue !== undefined) {
    if (!Array.isArray(plan.dialogue)) {
      throw new AudioPlanError("dialogue must be an array when present");
    }
    validateDialogueLines(plan.dialogue);
  }
  if (plan.music !== undefined) {
    validateMusic(plan.music);
  }
  if (plan.sfx !== undefined) {
    if (!Array.isArray(plan.sfx)) {
      throw new AudioPlanError("sfx must be an array when present");
    }
    validateSfxCues(plan.sfx);
  }
}

/** True when the plan is valid (safe for type-narrowing at call sites). */
export function isValidAudioPlan(plan: AudioTimelinePlan): boolean {
  try {
    validateAudioPlan(plan);
    return true;
  } catch {
    return false;
  }
}