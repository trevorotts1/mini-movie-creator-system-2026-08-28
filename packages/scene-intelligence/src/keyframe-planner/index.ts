/**
 * Keyframe planner for Scene Intelligence — spec §8 ("Keyframe /
 * Scene-master classification + reference budget") and runbook §25 step 13
 * ("decide 0/1/2 keyframes or multimodal reference package per shot").
 *
 * Every shot gets EXACTLY ONE keyframe strategy, chosen from five mutually
 * exclusive strategies:
 *
 *   zero                — no keyframes; text-to-video acceptable
 *   one-start           — one starting keyframe (exact start identity/composition)
 *   start-end           — start + end keyframes (exact start and exact end)
 *   scene-master-refs   — approved scene master image + allowed references
 *                         (multi-character continuity where the model permits)
 *   multimodal-package  — multimodal reference package (complex scenes, only
 *                         where the model supports it)
 *
 * The same shot can change strategies when the selected model's capability
 * profile changes (spec §8 acceptance): a transition shot on a model with no
 * frame anchoring classifies as `zero`, while the same shot on a model with
 * first/last-frame support classifies as `start-end`.
 *
 * Capability values mirror the Model Capability Registry `references` block
 * (CAP-001 schema: references.firstFrame / lastFrame / firstLastFrame /
 * multimodalReferences / maxImages). This module keeps its own structural
 * subset so the planner stays dependency-free; the caller passes the active
 * profile values straight through. UNKNOWN (null) is never treated as
 * supported — only as "not known to prohibit" — and is never guessed.
 */

/* ------------------------------------------------------------------ */
/* Strategies                                                          */
/* ------------------------------------------------------------------ */

/** The five mutually exclusive keyframe strategies (spec §8). */
export const KEYFRAME_STRATEGIES = [
  "zero",
  "one-start",
  "start-end",
  "scene-master-refs",
  "multimodal-package",
] as const;

export type KeyframeStrategy = (typeof KEYFRAME_STRATEGIES)[number];

/** First/last-frame anchor count per strategy. */
const KEYFRAME_COUNT_BY_STRATEGY: Readonly<Record<KeyframeStrategy, 0 | 1 | 2>> = {
  zero: 0,
  "one-start": 1,
  "start-end": 2,
  "scene-master-refs": 0,
  "multimodal-package": 0,
};

/** Narrow a runtime string to a known strategy, or false. */
export function isKeyframeStrategy(value: unknown): value is KeyframeStrategy {
  return typeof value === "string" && KEYFRAME_STRATEGIES.includes(value as KeyframeStrategy);
}

/** Error thrown on invalid keyframe-planning operations. */
export class KeyframePlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyframePlannerError";
  }
}

/* ------------------------------------------------------------------ */
/* Inputs and the capability profile                                   */
/* ------------------------------------------------------------------ */

/** A shot as seen by the keyframe planner. */
export interface ShotKeyframeInput {
  /** Stable shot ID, e.g. "SC03-SH04". */
  shotId: string;
  /** Scene the shot belongs to. */
  sceneId: string;
  /** Canonical character IDs visible in the shot (duplicates ignored). */
  characters?: readonly string[];
  /** Camera shot type, used for the decision reason and signals. */
  shotType?: string;
  /** True when the exact start composition must be preserved (continuity/
   *  match cut, exact start identity). Default false. */
  needsExactStart?: boolean;
  /** True when the exact end composition must be preserved (precise
   *  transition to the next shot). End anchoring implies a start anchor. */
  needsExactEnd?: boolean;
  /** True when the scene is compositionally complex (action, many props/
   *  elements, staging that a single prompt would not hold). */
  complexScene?: boolean;
  /** True when an APPROVED scene-master image exists for the scene
   *  (DIR-011 output). Internal planning images are never provider input. */
  sceneMasterAvailable?: boolean;
}

/**
 * Model capability subset relevant to keyframe/reference strategies, mapped
 * from the Model Capability Registry `references` block (CAP-001):
 * references.firstFrame, lastFrame, firstLastFrame, multimodalReferences,
 * maxImages. `maxImages: null` means UNKNOWN — tolerated, never assumed.
 */
export interface KeyframeCapabilityProfile {
  /** Model accepts a starting (first-frame) image. */
  firstFrame: boolean;
  /** Model accepts an ending (last-frame) image. */
  lastFrame: boolean;
  /** Model accepts first and last frame in one call (keyframe mode). */
  firstLastFrame: boolean;
  /** Model accepts multimodal reference packages (mixed reference input). */
  multimodalReferences: boolean;
  /** Maximum input images the model accepts; null = unknown. */
  maxImages: number | null;
}

/* ------------------------------------------------------------------ */
/* Decision                                                            */
/* ------------------------------------------------------------------ */

/** Classifier signals behind a keyframe decision (read-only report). */
export interface KeyframeSignals {
  /** Two or more distinct canonical characters visible in the shot. */
  multiCharacter: boolean;
  /** Shot must preserve its exact start composition. */
  needsStart: boolean;
  /** Shot must preserve its exact end composition (implies start anchor). */
  needsEnd: boolean;
  /** Model supports a first-frame anchor (profile.firstFrame). */
  startSupported: boolean;
  /** Model supports a last-frame anchor on its own (profile.lastFrame). */
  endSupported: boolean;
  /** Model supports first+last frame anchoring in one call. */
  bothFramesSupported: boolean;
  /** Model can receive at least one input image (maxImages not 0). */
  imageRefsSupported: boolean;
  /** Multi-character continuity via a scene master was judged applicable. */
  sceneMasterApplicable: boolean;
  /** Multimodal reference package was judged applicable. */
  multimodalApplicable: boolean;
}

/** Classification result for ONE shot — exactly one strategy. */
export interface KeyframeDecision {
  shotId: string;
  /** The single strategy chosen for this shot (mutually exclusive by
   *  construction; see {@link classifyShotKeyframes}). */
  strategy: KeyframeStrategy;
  /** First/last-frame anchor count: 0, 1, or 2. Scene-master and multimodal
   *  packages are reference images, not frame anchors, so they count 0. */
  keyframeCount: 0 | 1 | 2;
  /** Deterministic human-readable justification for the decision. */
  reason: string;
  /** Capability shortfalls that downgraded what the shot asked for. */
  downgraded: readonly string[];
  signals: KeyframeSignals;
}

/** Full plan for a shot sequence against one capability profile. */
export interface KeyframePlan {
  /** Free-text label of the profile used (e.g. the model ID). */
  modelLabel: string;
  /** Decision per shot, in input order. */
  decisions: readonly KeyframeDecision[];
  /** Same decisions keyed by shotId for O(1) lookup. */
  byShot: Readonly<Record<string, KeyframeDecision>>;
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const TWO_CHARACTER_MIN = 2;

function uniqueCharacters(characters: readonly string[] | undefined): readonly string[] {
  return characters ? [...new Set(characters)] : [];
}

/**
 * Classify ONE shot into exactly one of the five keyframe strategies.
 *
 * Ordered precedence (first match wins, spec §8 prose order, documented here
 * so re-classification stays deterministic):
 *
 *   1. start-end — exact start AND exact end required and the model anchors
 *      first+last frames (`firstLastFrame`, or `firstFrame` and `lastFrame`).
 *      Frame anchoring supersedes scene-master/multimodal continuity.
 *   2. one-start — exact start required (end-only requests imply a start
 *      anchor) and the model anchors a first frame.
 *   3. scene-master-refs — multi-character shot with an approved scene
 *      master and a model that accepts image references. A precomposed
 *      approved scene master beats many portraits (spec §8).
 *   4. multimodal-package — compositionally complex scene and the model
 *      supports multimodal references.
 *   5. zero — everything else; text-to-video acceptable.
 *
 * When a requirement cannot be met (e.g. exact end requested but the model
 * has no last-frame support) the planner downgrades, never invents: the
 * strategy falls to the next applicable rule and the shortfall is recorded
 * in `downgraded`.
 *
 * `maxImages === null` (UNKNOWN) is treated as "not known to prohibit", while
 * `maxImages === 0` is a definite no-reference-capability.
 */
export function classifyShotKeyframes(
  input: ShotKeyframeInput,
  profile: KeyframeCapabilityProfile,
): KeyframeDecision {
  const characters = uniqueCharacters(input.characters);
  const multiCharacter = characters.length >= TWO_CHARACTER_MIN;
  const needsEnd = input.needsExactEnd === true;
  const needsStart = input.needsExactStart === true || needsEnd;

  const startSupported = profile.firstFrame;
  const endSupported = profile.lastFrame;
  const bothFramesSupported = profile.firstLastFrame || (startSupported && endSupported);
  const imageRefsSupported = profile.maxImages === null || profile.maxImages >= 1;
  const sceneMasterApplicable =
    multiCharacter && input.sceneMasterAvailable === true && imageRefsSupported;
  const multimodalApplicable =
    input.complexScene === true &&
    profile.multimodalReferences &&
    imageRefsSupported;

  const downgraded: string[] = [];

  let strategy: KeyframeStrategy;
  let reason: string;

  if (needsStart && needsEnd && bothFramesSupported) {
    strategy = "start-end";
    reason =
      "exact start and exact end composition required; model anchors first+last frames";
    if (sceneMasterApplicable) {
      reason += " (frame anchoring supersedes scene-master continuity)";
    }
  } else if (needsStart && startSupported) {
    strategy = "one-start";
    reason = "exact start composition required; model anchors first frame";
    if (needsEnd) {
      downgraded.push("exact end dropped: model has no last-frame anchoring");
      reason += "; end keyframe dropped (no last-frame support)";
    }
  } else if (sceneMasterApplicable) {
    strategy = "scene-master-refs";
    reason = `${characters.length}-character continuity: approved scene master + allowed references`;
    if (profile.maxImages !== null && profile.maxImages < 2) {
      downgraded.push(
        `single image slot (${profile.maxImages}): scene master only, no additional identity refs`,
      );
      reason += "; single image slot: scene master only";
    }
    if (needsStart && !startSupported) {
      downgraded.push("exact start dropped: model has no first-frame anchoring; scene master anchors identity instead");
      reason += "; start anchor unavailable — scene master carries identity";
    }
  } else if (multimodalApplicable) {
    strategy = "multimodal-package";
    reason = "compositionally complex scene; model supports multimodal reference package";
    if (profile.maxImages !== null && profile.maxImages < 2) {
      downgraded.push(
        `single image slot (${profile.maxImages}): package limited to one reference image`,
      );
      reason += "; limited to one reference image";
    }
    if (needsStart && !startSupported) {
      downgraded.push(
        "exact start dropped: model has no first-frame anchoring; package references approximate composition",
      );
    }
  } else {
    strategy = "zero";
    reason = "text-to-video acceptable: no keyframe or reference requirement";
    if (needsEnd && !bothFramesSupported) {
      downgraded.push(
        "exact start/end dropped: model has no frame anchoring; text-to-video accepts composition drift",
      );
    } else if (needsStart && !startSupported) {
      downgraded.push(
        "exact start dropped: model has no first-frame anchoring; text-to-video accepts composition drift",
      );
    }
    if (input.complexScene === true && !profile.multimodalReferences) {
      downgraded.push(
        "complexity noted but model lacks multimodal references; text-to-video may not hold composition",
      );
    }
  }

  return {
    shotId: input.shotId,
    strategy,
    keyframeCount: KEYFRAME_COUNT_BY_STRATEGY[strategy],
    reason,
    downgraded,
    signals: {
      multiCharacter,
      needsStart,
      needsEnd,
      startSupported,
      endSupported,
      bothFramesSupported,
      imageRefsSupported,
      sceneMasterApplicable,
      multimodalApplicable,
    },
  };
}

/**
 * Plan keyframes for a whole shot sequence against one capability profile.
 * Each shot yields exactly one decision (see {@link classifyShotKeyframes});
 * duplicate shotIds and empty shotIds are rejected.
 */
export function planKeyframes(
  shots: readonly ShotKeyframeInput[],
  profile: KeyframeCapabilityProfile,
  options?: { modelLabel?: string },
): KeyframePlan {
  const seen = new Set<string>();
  const decisions: KeyframeDecision[] = [];
  const byShot: Record<string, KeyframeDecision> = {};

  for (const shot of shots) {
    if (!shot.shotId) {
      throw new KeyframePlannerError("shot planning requires a non-empty shotId");
    }
    if (seen.has(shot.shotId)) {
      throw new KeyframePlannerError(`duplicate shotId "${shot.shotId}"`);
    }
    seen.add(shot.shotId);
    const decision = classifyShotKeyframes(shot, profile);
    decisions.push(decision);
    byShot[shot.shotId] = decision;
  }

  return {
    modelLabel: options?.modelLabel ?? "unnamed profile",
    decisions,
    byShot,
  };
}
