/**
 * Shot planner — DIR-010 (spec §7, §12).
 *
 * Breaks a narrative scene into camera shots by dialogue / emotional / action
 * beats, keeps every shot inside the selected video model's duration limits,
 * and emits one provider-independent Shot Specification Record per shot
 * (spec §12 fields). Runbook §24 chain: DIR-009 scene-parser → DIR-010 shot
 * planner → DIR-012/DIR-013 keyframe/reference planners → prompt compilation.
 *
 * Inputs are structural (PlannedScene + VideoModelConstraints) so the
 * planner is decoupled from the parser implementation and from the
 * capability-registry package; `constraintsFromCapabilityProfile` adapts a
 * registry profile at the call site.
 *
 * Story/dialogue text is UNTRUSTED DATA (spec §29): carried verbatim into
 * record fields, never parsed for instructions.
 */

import {
  estimateBeatDurationSeconds,
  desiredShotCount,
  estimateSceneDurationSeconds,
} from "./beat-estimator.js";
import { cameraForBeat } from "./camera-grammar.js";
import { estimateShotCost } from "./cost-estimator.js";
import { planDurations } from "./duration-planner.js";
import {
  ShotPlannerValidationError,
  type PlannedScene,
  type SceneBeat,
  type ShotSpecificationRecord,
  type PlannedSceneShots,
  type VideoModelConstraints,
  type ShotCharacterVersion,
} from "./types.js";

export { planShotSequence } from "./sequence.js";
export * from "./types.js";
export * from "./beat-estimator.js";
export * from "./camera-grammar.js";
export * from "./cost-estimator.js";
export * from "./duration-planner.js";
export * from "./fixtures.js";

/** Default routing (spec §13): Agnes Flash preferred, Agnes regular fallback. */
const DEFAULT_PREFERRED_MODEL = "agnes-video-2.5-flash";
const DEFAULT_FALLBACK_MODEL = "agnes-video-2.5";

/** Keyframe defaults by beat type (preliminary; DIR-012 refines per shot). */
const KEYFRAME_DEFAULTS: Readonly<
  Record<SceneBeat["type"], ShotSpecificationRecord["keyframe_strategy"]>
> = Object.freeze({
  establishing: "zero-keyframes",
  dialogue: "scene-master-references",
  reaction: "start-keyframe",
  emotional: "start-end-keyframes",
  action: "scene-master-references",
  insert: "start-keyframe",
});

export interface PlanSceneShotsOptions {
  /** Selected video model constraints (duration window + pricing). */
  readonly model: VideoModelConstraints;
  /**
   * Fallback provider/model recorded on every shot (spec §12 fallback fields;
   * spec §13 default routing when omitted).
   */
  readonly fallback?: { readonly provider: string; readonly modelId: string };
  /**
   * Shot id prefix (defaults to the scene id). Final ids are
   * `<prefix>_SH<NN>` with zero-padded two-digit sequence.
   */
  readonly shotIdPrefix?: string;
}

/**
 * Plan one narrative scene into camera shots.
 *
 * Order of operations (spec §7): estimate beat durations → derive the
 * desired shot count from scene duration → fit the count to the model's
 * duration window → assign beats to shots proportionally by duration →
 * populate the full Shot Specification Record per shot.
 */
export function planSceneShots(
  scene: PlannedScene,
  options: PlanSceneShotsOptions,
): PlannedSceneShots {
  validateScene(scene);
  const warnings: string[] = [];
  if (options.shotIdPrefix !== undefined) {
    validateShotIdPrefix(options.shotIdPrefix, scene.sceneId);
  }

  const sceneDuration = round1(
    scene.durationSeconds > 0
      ? scene.durationSeconds
      : estimateSceneDurationSeconds(scene.beats),
  );
  if (sceneDuration <= 0) {
    throw new ShotPlannerValidationError(
      `scene ${scene.sceneId} has no positive duration and no estimable beats`,
    );
  }

  const desired = desiredShotCount(sceneDuration);
  // Every shot needs at least one beat — never emit a shot with an empty
  // beat group (that would leave lead camera/dialogue/action undefined).
  const beatCount = scene.beats.length;
  const clampedToBeats = Math.min(desired, beatCount);
  if (clampedToBeats < desired) {
    warnings.push(
      `scene ${scene.sceneId} has ${beatCount} beats but a ${desired}-shot pace target — shot count clamped to ${clampedToBeats} (add beats or raise durationHintSeconds to get more shots)`,
    );
  }
  const assignment = planDurations(sceneDuration, clampedToBeats, options.model);
  if (assignment.shotCount > beatCount) {
    // The model window forced more shots than there are beats (e.g. 45s in a
    // 12s-max window needs ≥4 shots but the scene has 3). Fail loudly with an
    // actionable message rather than emit empty-beat shots.
    throw new ShotPlannerValidationError(
      `scene ${scene.sceneId} has ${beatCount} beats but model ${options.model.modelId} window ${options.model.minDurationSeconds}–${options.model.maxDurationSeconds}s requires ${assignment.shotCount} shots to cover ${sceneDuration}s — add beats or pick a model with a wider window`,
    );
  }
  if (assignment.usedUnknownLimits) {
    warnings.push(
      `model ${options.model.modelId} duration limits UNKNOWN (null) — treated as unconstrained; verify against the capability registry before generation`,
    );
  }

  const shots = buildShots(scene, assignment.durations, options, warnings);

  return {
    sceneId: scene.sceneId,
    modelId: options.model.modelId,
    shots,
    warnings,
  };
}

/** Plan a whole episode: scenes in order → per-scene shot plans. */
export function planEpisodeShots(
  scenes: readonly PlannedScene[],
  options: PlanSceneShotsOptions,
): PlannedSceneShots[] {
  return scenes.map((scene) => planSceneShots(scene, options));
}

function buildShots(
  scene: PlannedScene,
  durations: readonly number[],
  options: PlanSceneShotsOptions,
  warnings: string[],
): ShotSpecificationRecord[] {
  const prefix = options.shotIdPrefix ?? scene.sceneId;
  const beatDurations = scene.beats.map((b) => estimateBeatDurationSeconds(b));
  const totalBeat = beatDurations.reduce((s, d) => s + d, 0);
  // Proportional beat coverage: shot i takes beats weighting its slice of the
  // scene. Every beat lands in exactly one shot (beats may be coarsened into
  // a shared shot; a long beat spanning its shot's full window is fine).
  const shotWeight = durations.map((d) => d / durations.reduce((s, x) => s + x, 0));

  // Greedy assignment: walk beats, fill each shot until its proportional
  // share of beat-duration is consumed; guarantee ≥1 beat per shot and that
  // no beat is dropped.
  const beatGroups: SceneBeat[][] = durations.map(() => []);
  const sharePerShot = shotWeight.map((w) => w * totalBeat);
  let beatIdx = 0;
  for (let shotIdx = 0; shotIdx < durations.length; shotIdx += 1) {
    let consumed = 0;
    const remainingShots = durations.length - shotIdx;
    const remainingBeats = scene.beats.length - beatIdx;
    const group = beatGroups[shotIdx] as SceneBeat[];
    const share = sharePerShot[shotIdx] as number;
    // Reserve one beat per remaining shot so no shot is left empty.
    const canTake = Math.max(0, remainingBeats - (remainingShots - 1));
    while (
      beatIdx < scene.beats.length &&
      group.length < Math.max(1, canTake) &&
      (consumed < share || group.length === 0)
    ) {
      const beat = scene.beats[beatIdx] as SceneBeat;
      group.push(beat);
      consumed += beatDurations[beatIdx] ?? 0;
      beatIdx += 1;
    }
  }
  // Determinism guard: any beats left (rounding edge) join the final shot.
  const finalGroup = beatGroups[beatGroups.length - 1] as SceneBeat[];
  while (beatIdx < scene.beats.length) {
    finalGroup.push(scene.beats[beatIdx] as SceneBeat);
    beatIdx += 1;
  }

  const characterVersionByKey = new Map<string, ShotCharacterVersion>();
  for (const c of scene.characters) {
    characterVersionByKey.set(c.characterId, {
      characterId: c.characterId,
      identityVersion: c.identityVersion,
      hairVersion: c.hairVersion,
      wardrobeVersion: scene.wardrobe?.[c.characterId] ?? c.wardrobeVersion,
    });
  }

  const occurrenceByType = new Map<string, number>();
  const fallback = options.fallback ?? {
    provider: DEFAULT_FALLBACK_MODEL.split("-")[0] as string,
    modelId: DEFAULT_FALLBACK_MODEL,
  };
  const preferredProvider = options.model.provider;

  return durations.map((targetDuration, index) => {
    const group = beatGroups[index] as SceneBeat[];
    const lead = group[0] as SceneBeat;
    const seen = occurrenceByType.get(lead.type) ?? 0;
    occurrenceByType.set(lead.type, seen + 1);
    const camera = cameraForBeat(lead, seen);

    const characters = orderedUnique(group.flatMap((b) => [...b.characters]));
    const dialogue = group.flatMap((b) => [...(b.dialogue ?? [])]);
    const props = orderedUnique([
      ...group.flatMap((b) => [...(b.props ?? [])]),
      ...(index === 0 ? (scene.props ?? []) : []),
    ]);
    const emotion = pickEmotion(group);
    const action = group
      .map((b) => b.description.trim())
      .filter((d) => d.length > 0)
      .join(" Then, ");

    const characterVersions = characters
      .map((id) => characterVersionByKey.get(id))
      .filter((v): v is ShotCharacterVersion => v !== undefined);

    const shotId = `${prefix}_SH${String(index + 1).padStart(2, "0")}`;
    const startState =
      index === 0
        ? `Scene start — ${scene.location}${scene.timeOfDay ? `, ${scene.timeOfDay}` : ""}`
        : `Continue from ${prefix}_SH${String(index).padStart(2, "0")} end state`;
    const endState =
      index === durations.length - 1
        ? `Scene end — ${describeEnd(group, lead)}`
        : `Hands off to ${prefix}_SH${String(index + 2).padStart(2, "0")}`;

    const wardrobe: Record<string, string> = {};
    for (const c of scene.characters) {
      const version =
        scene.wardrobe?.[c.characterId] ?? c.wardrobeVersion ?? null;
      if (version) wardrobe[c.characterId] = version;
    }

    const estimatedCost = estimateShotCost(targetDuration, options.model);
    if (estimatedCost === null && options.model.pricing !== undefined) {
      warnings.push(
        `shot ${shotId}: estimated_cost UNKNOWN (pricing unit/amount null or not per-second)`,
      );
    }

    const record: ShotSpecificationRecord = {
      shot_id: shotId,
      scene_id: scene.sceneId,
      sequence_index: index + 1,
      target_duration: targetDuration,
      characters,
      character_versions: characterVersions,
      location: scene.location,
      wardrobe,
      props,
      dialogue,
      action: action.length > 0 ? action : lead.description,
      emotion,
      camera_angle: camera.camera_angle,
      camera_motion: camera.camera_motion,
      lens_style: camera.lens_style,
      lighting: scene.lighting ?? "natural",
      start_state: startState,
      end_state: endState,
      continuity_requirements: buildContinuity(scene, characters, index),
      reference_assets: [],
      keyframe_strategy: KEYFRAME_DEFAULTS[lead.type] ?? "zero-keyframes",
      preferred_provider: preferredProvider,
      fallback_provider: fallback.provider,
      prompt_source: `beat:${group.map((b) => b.id).join("+")}`,
      prompt_compiled: null,
      prompt_character_count: null,
      estimated_cost: estimatedCost,
      approval_status: "PENDING_STORYBOARD",
      generation_status: "PLANNED",
      qc_status: "NOT_RUN",
      preferred_model: options.model.modelId,
      fallback_model: fallback.modelId,
      source_beat_ids: group.map((b) => b.id),
    };
    return record;
  });
}

function pickEmotion(group: readonly SceneBeat[]): string {
  for (const b of group) {
    if (b.emotion && b.emotion.trim().length > 0) return b.emotion;
  }
  return "neutral";
}

function buildContinuity(
  scene: PlannedScene,
  characters: readonly string[],
  index: number,
): string[] {
  const reqs: string[] = [];
  reqs.push(`location continuity: ${scene.location}`);
  if (scene.timeOfDay) reqs.push(`time-of-day continuity: ${scene.timeOfDay}`);
  if (scene.lighting) reqs.push(`lighting continuity: ${scene.lighting}`);
  for (const id of characters) {
    const wardrobe = scene.wardrobe?.[id];
    const char = scene.characters.find((c) => c.characterId === id);
    const w = wardrobe ?? char?.wardrobeVersion;
    if (w) reqs.push(`${id} wardrobe: ${w}`);
    if (char?.hairVersion) reqs.push(`${id} hair: ${char.hairVersion}`);
  }
  if (index > 0) {
    reqs.push("match neighboring shot appearance and set dressing");
  }
  return reqs;
}

function describeEnd(group: readonly SceneBeat[], lead: SceneBeat): string {
  const lastWithText = [...group]
    .reverse()
    .find((b) => b.description.trim().length > 0);
  return lastWithText ? lastWithText.description : lead.description;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].filter((v) => v.length > 0);
}

function validateScene(scene: PlannedScene): void {
  if (!scene.sceneId || scene.sceneId.trim().length === 0) {
    throw new ShotPlannerValidationError("scene id must be a non-empty string");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(scene.sceneId)) {
    throw new ShotPlannerValidationError(
      `scene id "${scene.sceneId}" must be filename-safe ([A-Za-z0-9_-]) for deterministic shot ids`,
    );
  }
  if (!Array.isArray(scene.beats) || scene.beats.length === 0) {
    throw new ShotPlannerValidationError(`scene ${scene.sceneId} has no beats`);
  }
  if (scene.durationSeconds !== undefined) {
    if (!Number.isFinite(scene.durationSeconds)) {
      throw new ShotPlannerValidationError(
        `scene ${scene.sceneId} durationSeconds must be a finite number, got ${scene.durationSeconds}`,
      );
    }
    if (scene.durationSeconds < 0) {
      throw new ShotPlannerValidationError(
        `scene ${scene.sceneId} durationSeconds must not be negative`,
      );
    }
  }
}

/**
 * Shot ids feed asset naming (spec §19) — the prefix must be as
 * filename-safe as the scene id it defaults from.
 */
function validateShotIdPrefix(prefix: string, sceneId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new ShotPlannerValidationError(
      `shotIdPrefix "${prefix}" must be filename-safe ([A-Za-z0-9_-]) for deterministic shot ids`,
    );
  }
  if (prefix.length > 200) {
    throw new ShotPlannerValidationError(
      `shotIdPrefix for scene ${sceneId} exceeds 200 characters`,
    );
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}