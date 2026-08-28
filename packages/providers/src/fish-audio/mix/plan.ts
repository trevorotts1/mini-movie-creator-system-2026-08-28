/**
 * Mix-plan validation (FISH-009). The plan is data from upstream planners, so
 * every numeric/path field is validated BEFORE it can reach an argv: finite
 * non-negative times, sane gains, bounded fades, no duplicate input IDs, no
 * missing/ambiguous input references, and paths that stay where the caller
 * put them (no shell metacharacter injection is possible because we never
 * build a shell string — but a path must still be a single real argument).
 * Story/dialogue text never appears in argv at all.
 */
import type {
  MixDialogueLayer,
  MixMusicLayer,
  MixPlan,
  MixSfxCue,
} from "./types.js";

/** Thrown for any plan that cannot be compiled safely. */
export class MixPlanError extends Error {
  constructor(message: string) {
    super(`MixPlanError: ${message}`);
    this.name = "MixPlanError";
  }
}

const MAX_SEC = 24 * 60 * 60; // one day: no sane episode exceeds this
const GAIN_LIMIT_DB = 60; // |gain| bound; keeps volume= expressions sane
const FADE_LIMIT_SEC = 30;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function requireRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!isFiniteNumber(value)) throw new MixPlanError(`${label} must be a finite number`);
  if (value < min || value > max) {
    throw new MixPlanError(`${label} must be within [${min}, ${max}], got ${value}`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new MixPlanError(`${label} must be a non-empty string (<= 128 chars)`);
  }
  return value;
}

function validateLayerTimes(layer: MixDialogueLayer): void {
  requireRange(layer.startSec, `dialogue ${layer.inputId} startSec`, 0, MAX_SEC);
  if (layer.durationSec !== undefined) {
    requireRange(layer.durationSec, `dialogue ${layer.inputId} durationSec`, 0, MAX_SEC);
  }
  if (layer.gainDb !== undefined) {
    requireRange(layer.gainDb, `dialogue ${layer.inputId} gainDb`, -GAIN_LIMIT_DB, GAIN_LIMIT_DB);
  }
  if (layer.fadeInSec !== undefined) {
    requireRange(layer.fadeInSec, `dialogue ${layer.inputId} fadeInSec`, 0, FADE_LIMIT_SEC);
  }
  if (layer.fadeOutSec !== undefined) {
    requireRange(layer.fadeOutSec, `dialogue ${layer.inputId} fadeOutSec`, 0, FADE_LIMIT_SEC);
  }
}

function validateMusic(music: MixMusicLayer): void {
  if (music.gainDb !== undefined) {
    requireRange(music.gainDb, "music gainDb", -GAIN_LIMIT_DB, GAIN_LIMIT_DB);
  }
  if (music.duckDb !== undefined) {
    requireRange(music.duckDb, "music duckDb", 0, GAIN_LIMIT_DB);
  }
  if (music.fadeInSec !== undefined) {
    requireRange(music.fadeInSec, "music fadeInSec", 0, FADE_LIMIT_SEC);
  }
  if (music.fadeOutSec !== undefined) {
    requireRange(music.fadeOutSec, "music fadeOutSec", 0, FADE_LIMIT_SEC);
  }
  if (music.highpassHz !== undefined) {
    requireRange(music.highpassHz, "music highpassHz", 0, 20_000);
  }
}

function validateCue(cue: MixSfxCue): void {
  requireRange(cue.atSec, `sfx ${cue.inputId} atSec`, 0, MAX_SEC);
  if (cue.gainDb !== undefined) {
    requireRange(cue.gainDb, `sfx ${cue.inputId} gainDb`, -GAIN_LIMIT_DB, GAIN_LIMIT_DB);
  }
}

/**
 * Validate a plan's structure and references. Returns the plan typed as the
 * narrowed internal shape (defaults are applied at compile time, not here).
 */
export function validateMixPlan(plan: MixPlan): MixPlan {
  if (!plan || typeof plan !== "object") throw new MixPlanError("plan must be an object");
  if (plan.formatVersion !== 1) {
    throw new MixPlanError(`unsupported plan formatVersion ${String(plan.formatVersion)}`);
  }
  if (!Array.isArray(plan.inputs) || plan.inputs.length === 0) {
    throw new MixPlanError("plan.inputs must be a non-empty array");
  }

  const ids = new Set<string>();
  for (const input of plan.inputs) {
    requireId(input.id, "input id");
    if (ids.has(input.id)) throw new MixPlanError(`duplicate input id "${input.id}"`);
    ids.add(input.id);
    if (input.kind !== "dialogue" && input.kind !== "music" && input.kind !== "sfx") {
      throw new MixPlanError(`input ${input.id} has invalid kind "${String(input.kind)}"`);
    }
    requireId(input.path, `input ${input.id} path`);
  }

  const known = ids;
  const usedInputs = new Set<string>();
  const markUsed = (id: string, label: string): void => {
    if (!known.has(id)) throw new MixPlanError(`${label} references unknown input "${id}"`);
    usedInputs.add(id);
  };

  if (plan.dialogue !== undefined) {
    if (!Array.isArray(plan.dialogue)) throw new MixPlanError("dialogue must be an array");
    for (const line of plan.dialogue) {
      markUsed(line.inputId, "dialogue line");
      validateLayerTimes(line);
    }
  }
  if (plan.music !== undefined) {
    markUsed(plan.music.inputId, "music");
    validateMusic(plan.music);
  }
  if (plan.sfx !== undefined) {
    if (!Array.isArray(plan.sfx)) throw new MixPlanError("sfx must be an array");
    for (const cue of plan.sfx) {
      markUsed(cue.inputId, "sfx cue");
      validateCue(cue);
    }
  }

  if (usedInputs.size === 0) {
    throw new MixPlanError("plan defines no dialogue, music, or sfx layers");
  }
  if (plan.music !== undefined && plan.dialogue === undefined && (plan.music.duckDb ?? 9) > 0) {
    // Ducking with no dialogue key is a no-op at best; refuse so plans stay honest.
    throw new MixPlanError("music duckDb > 0 requires dialogue (no sidechain key)");
  }
  return plan;
}