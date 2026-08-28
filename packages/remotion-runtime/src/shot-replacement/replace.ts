import {
  SHOT_LAYER_KINDS,
  ShotReplacementError,
  type CompositionDiff,
  type EpisodicShotPlan,
  type RetryShotPlan,
  type ShotInputs,
  type ShotLayerKind,
  type ShotReplacement,
  type ShotSegment,
  type TimedSegment,
} from "./types.js";

/** Validate a layer kind string as one of the spec §22 kinds. */
export function isShotLayerKind(value: unknown): value is ShotLayerKind {
  return (
    typeof value === "string" &&
    (SHOT_LAYER_KINDS as readonly string[]).includes(value)
  );
}

/** Stable structural fingerprint of a shot's render inputs. */
export function inputsKey(inputs: ShotInputs): string {
  const trim =
    inputs.trimInFrames === undefined && inputs.trimOutFrames === undefined
      ? ""
      : `[${inputs.trimInFrames ?? ""},${inputs.trimOutFrames ?? ""}]`;
  const refs = (list: readonly string[] | undefined): string =>
    list ? JSON.stringify([...list]) : "";
  return JSON.stringify([
    inputs.layerKind,
    inputs.assetRef ?? "",
    trim,
    inputs.cameraMotion ?? "",
    refs(inputs.captionRefs),
    refs(inputs.audioRefs),
  ]);
}

/** Validate a plan's invariants: unique shotIds, ascending sequence, positive durations. */
export function validatePlan(plan: EpisodicShotPlan): void {
  const seen = new Set<string>();
  let prevSeq = -Infinity;
  for (const segment of plan.segments) {
    if (seen.has(segment.shotId)) {
      throw new ShotReplacementError(
        "duplicate-shot",
        `duplicate shotId in plan: ${segment.shotId}`,
      );
    }
    seen.add(segment.shotId);
    if (segment.sequenceIndex <= prevSeq) {
      throw new ShotReplacementError(
        "invalid-plan",
        `segments not ordered by sequenceIndex at ${segment.shotId}`,
      );
    }
    prevSeq = segment.sequenceIndex;
    if (!Number.isInteger(segment.durationInFrames) || segment.durationInFrames <= 0) {
      throw new ShotReplacementError(
        "invalid-duration",
        `shot ${segment.shotId} durationInFrames must be a positive integer, got ${segment.durationInFrames}`,
      );
    }
  }
  if (!Number.isInteger(plan.fps) || plan.fps <= 0) {
    throw new ShotReplacementError(
      "invalid-duration",
      `plan fps must be a positive integer, got ${plan.fps}`,
    );
  }
}

/** Derived timeline placement: ordered segments with absolute frame ranges. */
export function timelineLayout(plan: EpisodicShotPlan): readonly TimedSegment[] {
  validatePlan(plan);
  const timed: TimedSegment[] = [];
  let cursor = 0;
  for (const segment of plan.segments) {
    timed.push({
      segment,
      startFrame: cursor,
      endFrame: cursor + segment.durationInFrames,
    });
    cursor += segment.durationInFrames;
  }
  return timed;
}

/** Total episode duration in frames. */
export function totalDurationFrames(plan: EpisodicShotPlan): number {
  return plan.segments.reduce((sum, s) => sum + s.durationInFrames, 0);
}

function findSegment(plan: EpisodicShotPlan, shotId: string): ShotSegment {
  const segment = plan.segments.find((s) => s.shotId === shotId);
  if (!segment) {
    throw new ShotReplacementError(
      "unknown-shot",
      `shot ${shotId} not found in plan ${plan.episodeId}`,
    );
  }
  return segment;
}

/**
 * Structural diff of two plans over the same episode. Comparison is by
 * shotId (stable identity), not by array position — reflow must not
 * manufacture phantom changes. The episodeId/fps envelope must match.
 */
export function diffPlans(
  before: EpisodicShotPlan,
  after: EpisodicShotPlan,
): CompositionDiff {
  if (before.episodeId !== after.episodeId) {
    throw new ShotReplacementError(
      "incomparable-plans",
      `cannot diff plans for different episodes: ${before.episodeId} vs ${after.episodeId}`,
    );
  }
  if (before.fps !== after.fps) {
    throw new ShotReplacementError(
      "incomparable-plans",
      `cannot diff plans with different fps: ${before.fps} vs ${after.fps}`,
    );
  }
  const beforeIds = before.segments.map((s) => s.shotId);
  const afterIds = after.segments.map((s) => s.shotId);
  if (
    beforeIds.length !== afterIds.length ||
    !beforeIds.every((id, i) => id === afterIds[i])
  ) {
    throw new ShotReplacementError(
      "incomparable-plans",
      "plan segment identities differ — selective replacement never adds/removes shots",
    );
  }

  const beforeById = new Map(before.segments.map((s) => [s.shotId, s]));
  const afterById = new Map(after.segments.map((s) => [s.shotId, s]));

  const layoutBefore = timelineLayout(before);
  const layoutAfter = timelineLayout(after);
  const startBefore = new Map(layoutBefore.map((t) => [t.segment.shotId, t.startFrame]));
  const startAfter = new Map(layoutAfter.map((t) => [t.segment.shotId, t.startFrame]));

  const changed: string[] = [];
  const reflowed: string[] = [];
  const unchanged: string[] = [];

  for (const id of beforeIds) {
    const b = beforeById.get(id)!;
    const a = afterById.get(id)!;
    const same =
      a.durationInFrames === b.durationInFrames &&
      inputsKey(a.inputs) === inputsKey(b.inputs);
    if (!same) {
      changed.push(id);
      continue;
    }
    if (startBefore.get(id) !== startAfter.get(id)) reflowed.push(id);
    else unchanged.push(id);
  }

  const totalBefore = totalDurationFrames(before);
  const totalAfter = totalDurationFrames(after);
  return {
    changedShotIds: changed,
    unchangedShotIds: unchanged,
    reflowedShotIds: reflowed,
    totalDurationBefore: totalBefore,
    totalDurationAfter: totalAfter,
    durationDelta: totalAfter - totalBefore,
  };
}

/**
 * Apply ONE replacement to ONE shot. Every other segment is carried through
 * by reference to its existing object — provably untouched inputs.
 *
 * Trim semantics: the window is in SOURCE frames. `fit-slot` (default) keeps
 * the shot's existing slot duration as the OUTPUT length — the window is
 * fitted to supply exactly that many frames, with the source-fps conversion
 * happening at the render seam (this module is pure, so it records the
 * window and never resamples). `explicit` reflows downstream start frames
 * but changes no other inputs.
 */
export function replaceShot(
  plan: EpisodicShotPlan,
  replacement: ShotReplacement,
): {
  readonly plan: EpisodicShotPlan;
  readonly replaced: ShotSegment;
  readonly diff: CompositionDiff;
} {
  validatePlan(plan);
  if (replacement.shotId.length === 0) {
    throw new ShotReplacementError(
      "invalid-replacement",
      "replacement.shotId must be a non-empty string",
    );
  }
  findSegment(plan, replacement.shotId); // unknown-shot guard before mutation

  if (replacement.durationPolicy === "explicit") {
    const d = replacement.durationInFrames;
    if (!Number.isInteger(d) || (d ?? 0) <= 0) {
      throw new ShotReplacementError(
        "invalid-duration",
        `durationPolicy "explicit" requires a positive integer durationInFrames, got ${String(d)}`,
      );
    }
  }

  const layerKind = replacement.layerKind ?? undefined;
  if (layerKind !== undefined && !isShotLayerKind(layerKind)) {
    throw new ShotReplacementError(
      "invalid-replacement",
      `layerKind must be one of ${SHOT_LAYER_KINDS.join(", ")}, got ${String(layerKind)}`,
    );
  }

  const existing = findSegment(plan, replacement.shotId);
  const assetRef = replacement.assetRef ?? existing.inputs.assetRef;
  const resolvedLayerKind = layerKind ?? existing.inputs.layerKind;
  if (resolvedLayerKind !== "graphics" && (assetRef === undefined || assetRef.length === 0)) {
    throw new ShotReplacementError(
      "invalid-replacement",
      `shot ${replacement.shotId} (${resolvedLayerKind}) requires assetRef — only native graphics render without a canonical asset (spec §22)`,
    );
  }

  // Trim validation on the RESOLVED window.
  const trimIn = replacement.trimInFrames ?? existing.inputs.trimInFrames;
  const trimOut = replacement.trimOutFrames ?? existing.inputs.trimOutFrames;
  if (trimIn !== undefined && (!Number.isInteger(trimIn) || trimIn < 0)) {
    throw new ShotReplacementError(
      "invalid-trim",
      `trimInFrames must be a non-negative integer, got ${String(trimIn)}`,
    );
  }
  if (trimOut !== undefined && (!Number.isInteger(trimOut) || trimOut < 0)) {
    throw new ShotReplacementError(
      "invalid-trim",
      `trimOutFrames must be a non-negative integer, got ${String(trimOut)}`,
    );
  }
  if (trimIn !== undefined && trimOut !== undefined && trimOut <= trimIn) {
    throw new ShotReplacementError(
      "invalid-trim",
      `trim window empty: trimOutFrames (${trimOut}) must exceed trimInFrames (${trimIn})`,
    );
  }

  // Duration policy resolution.
  let durationInFrames = existing.durationInFrames;
  if (replacement.durationPolicy === "explicit") {
    durationInFrames = replacement.durationInFrames as number;
  } else if (
    trimIn !== undefined &&
    trimOut !== undefined &&
    replacement.trimInFrames !== undefined &&
    replacement.trimOutFrames !== undefined &&
    (replacement.trimInFrames !== existing.inputs.trimInFrames ||
      replacement.trimOutFrames !== existing.inputs.trimOutFrames)
  ) {
    // A fully-specified NEW trim window under fit-slot is fitted to the slot:
    // the slot duration governs the OUTPUT length (fps conversion happens at
    // the render seam), so durationInFrames stays the existing slot duration.
    durationInFrames = existing.durationInFrames;
  }

  const inputs: ShotInputs = {
    layerKind: resolvedLayerKind,
    assetRef,
    ...(trimIn !== undefined ? { trimInFrames: trimIn } : {}),
    ...(trimOut !== undefined ? { trimOutFrames: trimOut } : {}),
    ...(replacement.cameraMotion !== undefined
      ? { cameraMotion: replacement.cameraMotion }
      : existing.inputs.cameraMotion !== undefined
        ? { cameraMotion: existing.inputs.cameraMotion }
        : {}),
    ...(replacement.captionRefs !== undefined
      ? { captionRefs: [...replacement.captionRefs] }
      : existing.inputs.captionRefs !== undefined
        ? { captionRefs: [...existing.inputs.captionRefs] }
        : {}),
    ...(replacement.audioRefs !== undefined
      ? { audioRefs: [...replacement.audioRefs] }
      : existing.inputs.audioRefs !== undefined
        ? { audioRefs: [...existing.inputs.audioRefs] }
        : {}),
  };

  const replaced: ShotSegment = {
    ...existing,
    durationInFrames,
    inputs,
  };

  const nextPlan: EpisodicShotPlan = {
    ...plan,
    segments: plan.segments.map((s) => (s.shotId === replacement.shotId ? replaced : s)),
  };

  return {
    plan: nextPlan,
    replaced,
    diff: diffPlans(plan, nextPlan),
  };
}

/**
 * Plan a retry for one failed shot (spec §20). Scope is exactly the named
 * shot — the retry plan exists so callers can PROVE nothing else is queued
 * for regeneration.
 */
export function planRetryShot(
  plan: EpisodicShotPlan,
  shotId: string,
  options: { readonly attempt?: number; readonly reason?: string } = {},
): RetryShotPlan {
  validatePlan(plan);
  findSegment(plan, shotId);
  const attempt = options.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new ShotReplacementError(
      "invalid-replacement",
      `retry attempt must be a positive integer, got ${String(attempt)}`,
    );
  }
  return {
    shotId,
    attempt,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    regeneratesShotIds: [shotId],
    preservedShotIds: plan.segments
      .filter((s) => s.shotId !== shotId)
      .map((s) => s.shotId),
  };
}

/**
 * Apply a planned retry as a replacement: regenerate ONLY the failed shot
 * with a new asset (and optional trim). All other segments pass through.
 */
export function applyRetryShot(
  plan: EpisodicShotPlan,
  retry: RetryShotPlan,
  replacement: Omit<ShotReplacement, "shotId">,
): {
  readonly plan: EpisodicShotPlan;
  readonly replaced: ShotSegment;
  readonly diff: CompositionDiff;
  readonly retry: RetryShotPlan;
} {
  if (retry.regeneratesShotIds.length !== 1 || retry.regeneratesShotIds[0] !== retry.shotId) {
    throw new ShotReplacementError(
      "invalid-replacement",
      `retry plan must regenerate exactly its own shot (${retry.shotId})`,
    );
  }
  const applied = replaceShot(plan, { ...replacement, shotId: retry.shotId });
  return { ...applied, retry };
}
