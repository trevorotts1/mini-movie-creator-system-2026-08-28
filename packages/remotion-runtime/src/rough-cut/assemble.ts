/**
 * Rough-cut assembly (VID-012) — plan → deterministic frame timeline.
 *
 * Spec §21: "Remotion owns: timeline; clips; images; … music/SFX placement;
 * rough-cut and final render compositions." The rough cut is the first
 * full-episode preview: the shot plan + archived assets + dialogue + temp
 * music assembled onto ONE episodic timeline for automated QC and Gate 5.
 *
 * Frame math is deterministic and integer, preserving the upstream frame-QA
 * convention VID-003 maps (`local_f = round(global_s * fps) − sequence_from`,
 * remotion/scripts/frames.mjs):
 *
 *   - every shot boundary is `round(cumulativeSeconds * fps)` — seconds are
 *     converted ONCE per boundary with Math.round, all other math is exact
 *     integer frame arithmetic (the VID-003 `buildShotTimeline` discipline);
 *   - shots mount back-to-back: shot n+1's `sequenceFrom` equals shot n's
 *     `globalOutFrame` (no gaps, no overlaps — quantization note in VID-003);
 *   - dialogue master seconds convert once via `Math.round(startSec * fps)`
 *     (the VID-010 placement discipline); music always starts at frame 0;
 *   - identical plans produce byte-identical timelines (sorted by
 *     `sequenceIndex`, no wall-clock, no randomness).
 *
 * Story/dialogue text and asset refs are UNTRUSTED (spec §29): validated
 * structurally, carried verbatim, never executed or content-parsed.
 */

import {
  RESOLUTION_16_9,
  RESOLUTION_9_16,
  ROUGH_CUT_PLAN_VERSION,
  type MasterFormat,
  type PlacedRoughCutDialogue,
  type Resolution,
  type RoughCutLayerKind,
  type RoughCutPlan,
  type RoughCutSegment,
  type RoughCutShotInput,
  type RoughCutTimeline,
} from "./types.js";
import { RoughCutError } from "./errors.js";

/** Upstream baseline composition rate: 1080x1920@30 (spec §2). */
export const DEFAULT_FPS = 30;

/** Upstream default music bed level (felt-not-heard), dB. */
export const DEFAULT_TEMP_MUSIC_GAIN_DB = -7;

/** Kinds that MUST carry an archived asset ref (spec §19/§22). */
const ASSET_REQUIRED_KINDS: readonly RoughCutLayerKind[] = [
  "generated-video",
  "still-motion",
  "stock",
];

const LAYER_KINDS: readonly RoughCutLayerKind[] = [
  "generated-video",
  "still-motion",
  "stock",
  "graphics",
];

const FORMATS: readonly MasterFormat[] = ["16:9", "9:16", "custom"];

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RoughCutError("PLAN_INVALID", `${label} must be a non-empty string`);
  }
  return value;
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RoughCutError("PLAN_INVALID", `${label} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function assertNonNegativeNumber(value: unknown, label: string): number {
  const n = assertFiniteNumber(value, label);
  if (n < 0) {
    throw new RoughCutError("PLAN_INVALID", `${label} must be non-negative, got ${String(n)}`);
  }
  return n;
}

/** Seconds → frames: `Math.round(seconds * fps)` (upstream convention). */
export function framesForSeconds(seconds: number, fps: number): number {
  assertNonNegativeNumber(seconds, "seconds");
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new RoughCutError("PLAN_INVALID", `fps must be a finite number in (0, 240], got ${String(fps)}`);
  }
  return Math.round(seconds * fps);
}

/** Master resolution for a §23 format (custom requires plan.custom). */
export function resolutionForFormat(
  format: MasterFormat,
  custom?: Resolution,
): Resolution {
  if (format === "16:9") return RESOLUTION_16_9;
  if (format === "9:16") return RESOLUTION_9_16;
  if (!custom) {
    throw new RoughCutError("PLAN_INVALID", 'format "custom" requires a custom resolution');
  }
  const { width, height } = custom;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RoughCutError(
      "PLAN_INVALID",
      `custom resolution must be positive integers, got ${String(width)}x${String(height)}`,
    );
  }
  return { width, height };
}

/**
 * Structural plan validation. Throws `RoughCutError("PLAN_INVALID", …)` on
 * any inconsistency: wrong version, missing ids, unknown layer kinds,
 * missing asset refs on asset-bearing kinds, duplicate shot
 * `sequenceIndex`es, or a custom format without a custom resolution.
 * Never inspects or "fixes" field CONTENT — structure only.
 */
export function validateRoughCutPlan(plan: RoughCutPlan): void {
  if (!plan || typeof plan !== "object") {
    throw new RoughCutError("PLAN_INVALID", "plan must be an object");
  }
  if (plan.formatVersion !== ROUGH_CUT_PLAN_VERSION) {
    throw new RoughCutError(
      "PLAN_INVALID",
      `unsupported plan formatVersion ${String(plan.formatVersion)}, expected ${ROUGH_CUT_PLAN_VERSION}`,
    );
  }
  assertNonEmptyString(plan.seriesId, "seriesId");
  assertNonEmptyString(plan.episodeId, "episodeId");
  assertNonEmptyString(plan.episodeCode, "episodeCode");
  if (!FORMATS.includes(plan.format)) {
    throw new RoughCutError("PLAN_INVALID", `format must be one of ${FORMATS.join(", ")}`);
  }
  if (plan.format === "custom" && !plan.custom) {
    throw new RoughCutError("PLAN_INVALID", 'format "custom" requires a custom resolution');
  }
  if (!Array.isArray(plan.shots) || plan.shots.length === 0) {
    throw new RoughCutError("PLAN_INVALID", "plan.shots must be a non-empty array");
  }
  const seen = new Set<number>();
  for (const shot of plan.shots as readonly RoughCutShotInput[]) {
    assertNonEmptyString(shot?.shotId, "shotId");
    if (!LAYER_KINDS.includes(shot.layerKind)) {
      throw new RoughCutError(
        "PLAN_INVALID",
        `shot ${shot.shotId}: unknown layerKind ${String(shot.layerKind)}`,
      );
    }
    if (!Number.isInteger(shot.sequenceIndex) || shot.sequenceIndex < 0) {
      throw new RoughCutError(
        "PLAN_INVALID",
        `shot ${shot.shotId}: sequenceIndex must be a non-negative integer`,
      );
    }
    if (seen.has(shot.sequenceIndex)) {
      throw new RoughCutError(
        "PLAN_INVALID",
        `duplicate sequenceIndex ${shot.sequenceIndex} (${shot.shotId} collides with an earlier shot)`,
      );
    }
    seen.add(shot.sequenceIndex);
    assertNonNegativeNumber(shot.targetDurationSeconds, `shot ${shot.shotId} targetDurationSeconds`);
    if (ASSET_REQUIRED_KINDS.includes(shot.layerKind)) {
      if (typeof shot.assetRef !== "string" || shot.assetRef.trim() === "") {
        throw new RoughCutError(
          "ASSET_MISSING",
          `shot ${shot.shotId} (${shot.layerKind}) requires an archived assetRef (spec §19)`,
        );
      }
    }
  }
  for (const line of plan.dialogue ?? []) {
    assertNonEmptyString(line?.dialogueId, "dialogueId");
    assertNonEmptyString(line?.assetKey, `dialogue ${line.dialogueId} assetKey`);
    assertNonNegativeNumber(line.startSec, `dialogue ${line.dialogueId} startSec`);
    if (line.durationSec !== undefined) {
      assertNonNegativeNumber(line.durationSec, `dialogue ${line.dialogueId} durationSec`);
    }
  }
  if (plan.tempMusic !== undefined) {
    assertNonEmptyString(plan.tempMusic.assetRef, "tempMusic.assetRef");
    if (plan.tempMusic.gainDb !== undefined) {
      assertFiniteNumber(plan.tempMusic.gainDb, "tempMusic.gainDb");
    }
  }
}

/**
 * Assemble the rough-cut frame timeline from a validated plan.
 *
 * Deterministic: shots sorted by `sequenceIndex`, boundaries rounded once,
 * dialogue placed by master seconds, bed pinned to frame 0. The SAME plan
 * ALWAYS yields the SAME timeline (proven by the determinism test).
 */
export function assembleRoughCut(plan: RoughCutPlan): RoughCutTimeline {
  validateRoughCutPlan(plan);
  const fps = plan.fps ?? DEFAULT_FPS;
  const resolution = resolutionForFormat(plan.format, plan.custom);

  const ordered = [...plan.shots].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const segments: RoughCutSegment[] = [];
  let cumulativeSeconds = 0;
  for (const shot of ordered) {
    const sequenceFrom = framesForSeconds(cumulativeSeconds, fps);
    const globalOutFrame = framesForSeconds(
      cumulativeSeconds + shot.targetDurationSeconds,
      fps,
    );
    // A plan is never allowed to emit a zero-frame segment: an episode with
    // a zero-duration shot cannot render it (Remotion durations are >= 1).
    const durationInFrames = Math.max(1, globalOutFrame - sequenceFrom);
    segments.push({
      shotId: shot.shotId,
      sequenceIndex: shot.sequenceIndex,
      layerKind: shot.layerKind,
      assetRef: shot.assetRef ?? null,
      sequenceFrom,
      globalOutFrame: sequenceFrom + durationInFrames,
      durationInFrames,
      targetDurationSeconds: shot.targetDurationSeconds,
    });
    cumulativeSeconds += shot.targetDurationSeconds;
  }

  const totalFrames = segments.reduce((sum, s) => sum + s.durationInFrames, 0);

  const dialogue: PlacedRoughCutDialogue[] = (plan.dialogue ?? []).map((line) => ({
    dialogueId: line.dialogueId,
    assetKey: line.assetKey,
    startFrame: framesForSeconds(line.startSec, fps),
    durationFrames:
      line.durationSec === undefined ? null : framesForSeconds(line.durationSec, fps),
    sourceSec: line.startSec,
  }));

  const tempMusic = plan.tempMusic
    ? {
        assetRef: plan.tempMusic.assetRef,
        gainDb: plan.tempMusic.gainDb ?? DEFAULT_TEMP_MUSIC_GAIN_DB,
      }
    : null;

  return {
    fps,
    format: plan.format,
    resolution,
    totalFrames,
    durationSeconds: totalFrames / fps,
    segments,
    dialogue,
    tempMusic,
  };
}

/**
 * Deterministic rough-cut preview filename (spec §19: provenance lives in
 * the DB, the name stays stable): `S01E01_roughcut_v01.mp4`.
 */
export function roughCutFileName(episodeCode: string, version = 1): string {
  const v = String(version).padStart(2, "0");
  return `${episodeCode}_roughcut_v${v}.mp4`;
}
