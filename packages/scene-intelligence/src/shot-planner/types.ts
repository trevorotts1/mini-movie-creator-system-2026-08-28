/**
 * Shot planner types — DIR-010 (spec §7, §12).
 *
 * The planner consumes narrative scenes (the DIR-009 scene-parser output
 * shape, declared here structurally so the shot planner stays decoupled from
 * the parser's implementation) and produces one provider-independent Shot
 * Specification Record per shot (spec §12).
 *
 * Story/script text flowing through these types is UNTRUSTED DATA — it is
 * stored verbatim into record fields and never parsed, executed, or
 * interpreted as instructions (spec §29).
 */

/** Beat classification driving camera grammar and shot decomposition. */
export const BEAT_TYPES = [
  "establishing",
  "dialogue",
  "reaction",
  "emotional",
  "action",
  "insert",
] as const;

export type BeatType = (typeof BEAT_TYPES)[number];

/** One line of dialogue attached to a beat. Untrusted text — data only. */
export interface DialogueLine {
  readonly characterId: string;
  readonly text: string;
}

/**
 * One narrative beat inside a scene. `durationHintSeconds` is optional; the
 * planner estimates from dialogue length / beat type when absent.
 */
export interface SceneBeat {
  readonly id: string;
  readonly type: BeatType;
  /** Action/emotional description. Untrusted text — data only. */
  readonly description: string;
  readonly characters: readonly string[];
  readonly dialogue?: readonly DialogueLine[];
  readonly emotion?: string;
  readonly durationHintSeconds?: number;
  readonly props?: readonly string[];
}

/** Scene-level character reference resolved to Character Library IDs (spec §9). */
export interface SceneCharacterRef {
  readonly characterId: string;
  readonly identityVersion: string;
  readonly hairVersion?: string;
  readonly wardrobeVersion?: string;
}

/**
 * A planned narrative scene: the input unit of shot planning. 45-second
 * scenes typically decompose into 5–8 shots (spec §7).
 */
export interface PlannedScene {
  readonly sceneId: string;
  readonly title?: string;
  /** Location master ID (recurring location library, spec §11). */
  readonly location: string;
  readonly characters: readonly SceneCharacterRef[];
  readonly durationSeconds: number;
  readonly beats: readonly SceneBeat[];
  readonly lighting?: string;
  /** Per-character wardrobe version override, keyed by characterId. */
  readonly wardrobe?: Readonly<Record<string, string>>;
  readonly props?: readonly string[];
  readonly timeOfDay?: string;
}

/**
 * Selected-model duration constraints. Deliberately structural (no import of
 * the capability-registry package): the caller passes the registry profile's
 * relevant slice, or `constraintsFromCapabilityProfile` adapts a full profile.
 * `null` limits mean UNKNOWN — never invented (spec §5) — and are treated as
 * unconstrained with a warning.
 */
export interface VideoModelConstraints {
  readonly provider: string;
  readonly modelId: string;
  readonly minDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  /** Pricing slice used for estimated_cost; null/absent → cost UNKNOWN. */
  readonly pricing?: {
    readonly unit: string | null;
    readonly amount: number | null;
    readonly currency: string;
  } | null;
}

/** Minimal structural shape of a capability-registry media profile. */
export interface CapabilityProfileShape {
  readonly provider: string;
  readonly modelId: string;
  readonly output?:
    | {
        readonly minDurationSeconds?: number | null;
        readonly maxDurationSeconds: number | null;
      }
    | null;
  readonly pricing?: VideoModelConstraints["pricing"];
}

/**
 * Adapter from a capability-registry media profile (or any structurally
 * compatible object) to the planner's model constraints. Preserves null
 * (UNKNOWN) duration values untouched.
 */
export function constraintsFromCapabilityProfile(
  profile: CapabilityProfileShape,
): VideoModelConstraints {
  return {
    provider: profile.provider,
    modelId: profile.modelId,
    minDurationSeconds: profile.output?.minDurationSeconds ?? null,
    maxDurationSeconds: profile.output?.maxDurationSeconds ?? null,
    pricing: profile.pricing ?? null,
  };
}

/** Keyframe strategies (spec §8). The planner sets a preliminary default;
 * DIR-012 keyframe-planner refines per shot. */
export const KEYFRAME_STRATEGIES = [
  "zero-keyframes",
  "start-keyframe",
  "start-end-keyframes",
  "scene-master-references",
  "multimodal-reference-package",
] as const;

export type KeyframeStrategy = (typeof KEYFRAME_STRATEGIES)[number];

/** Storyboard approval (Gate 4) gates every shot at PLANNED time. */
export type ShotApprovalStatus = "PENDING_STORYBOARD";

/** Job state machine start (spec §18). */
export type ShotGenerationStatus = "PLANNED";

/** QC has not run at planning time. */
export type ShotQcStatus = "NOT_RUN";

/** Character version slice carried per shot (spec §12 character_versions). */
export interface ShotCharacterVersion {
  readonly characterId: string;
  readonly identityVersion: string;
  readonly hairVersion?: string;
  readonly wardrobeVersion?: string;
}

/**
 * Shot Specification Record — the required fields of spec §12. Creative
 * intent is provider-independent; provider request compilation happens later
 * in the prompt-compilers package (prompt_compiled stays null at planning
 * time) and reference/keyframe strategy are refined by DIR-012/DIR-013.
 */
export interface ShotSpecificationRecord {
  shot_id: string;
  scene_id: string;
  sequence_index: number;
  target_duration: number;
  characters: string[];
  character_versions: ShotCharacterVersion[];
  location: string;
  wardrobe: Record<string, string>;
  props: string[];
  dialogue: DialogueLine[];
  action: string;
  emotion: string;
  camera_angle: string;
  camera_motion: string;
  lens_style: string;
  lighting: string;
  start_state: string;
  end_state: string;
  continuity_requirements: string[];
  reference_assets: string[];
  keyframe_strategy: KeyframeStrategy;
  preferred_provider: string;
  fallback_provider: string;
  prompt_source: string;
  prompt_compiled: string | null;
  prompt_character_count: number | null;
  estimated_cost: number | null;
  approval_status: ShotApprovalStatus;
  generation_status: ShotGenerationStatus;
  qc_status: ShotQcStatus;
  /** Non-§12 extras: exact model ids behind the provider fields. */
  preferred_model: string;
  fallback_model: string | null;
  /** Beat ids this shot was planned from (split/merge aware). */
  source_beat_ids: string[];
}

/** Camera grammar assignment per shot (spec §7 camera grammar input). */
export interface ShotCameraPlan {
  readonly camera_angle: string;
  readonly camera_motion: string;
  readonly lens_style: string;
}

/** Result of planning one scene. */
export interface PlannedSceneShots {
  readonly sceneId: string;
  readonly modelId: string;
  readonly shots: ShotSpecificationRecord[];
  /** Non-fatal planning notes: UNKNOWN limits, count-target tradeoffs. */
  readonly warnings: string[];
}

/** Thrown on invalid planner input (bad scene duration, empty scene id…). */
export class ShotPlannerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShotPlannerValidationError";
  }
}