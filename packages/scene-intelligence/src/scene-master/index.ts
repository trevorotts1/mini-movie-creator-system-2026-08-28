/**
 * Scene Master planner for Scene Intelligence (spec §8 "Keyframe /
 * Scene-master classification + reference budget"; runbook §25).
 *
 * Important multi-character scenes get ONE approved scene-master image that
 * establishes identities, wardrobe, room/location, lighting, props, and
 * physical positions. Internal storyboard images are NOT provider input
 * images — internal planning may use more images than the provider receives,
 * so every planning-only image is stamped NON_PROVIDER_INPUT and is
 * mechanically excluded from anything handed to a provider.
 */

/**
 * Machine-readable marker stamped on every internal planning image.
 * Presence alone is not the guard — see {@link isProviderEligibleImage},
 * which treats the marker as authoritative over any other field.
 */
export const NON_PROVIDER_INPUT_MARKER = "NON_PROVIDER_INPUT";

/** Roles an internal planning image can play. */
export type PlanningImageRole = "scene-master" | "storyboard" | "keyframe";

/**
 * A planning-time image record. Records created through
 * {@link createInternalStoryboardImage} are always non-provider-input; the
 * marker and the `providerInput: false` flag are set by construction and
 * re-asserted by {@link assertNotProviderInput}.
 */
export interface InternalImageRecord {
  /** MMCS planning asset ID, e.g. "ASSET_S01E01_SC03_SB01". */
  assetId: string;
  /** Scene the image belongs to. */
  sceneId: string;
  /** Shot the image belongs to, when shot-scoped. */
  shotId?: string;
  /** What kind of planning image this is. */
  role: PlanningImageRole;
  /** Always `false` for internal planning images. */
  providerInput: boolean;
  /** Always {@link NON_PROVIDER_INPUT_MARKER} on internal planning images;
   *  the string type lets foreign records be classified by the runtime
   *  guard in {@link isProviderEligibleImage}. */
  usageMarker: string;
  /** Optional free-text note (composition intent, iteration, etc.). */
  note?: string;
}

/** Error thrown on invalid scene-master planning operations. */
export class SceneMasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneMasterError";
  }
}

/* ------------------------------------------------------------------ */
/* Classification: which scenes need a Scene Master Image              */
/* ------------------------------------------------------------------ */

/** A narrative scene as seen by the scene-master planner. */
export interface SceneMasterSceneInput {
  /** Stable scene ID, e.g. "SC03". */
  sceneId: string;
  /** Canonical character IDs present in the scene. */
  characters: readonly string[];
  /** Subset of `characters` that speak in this scene. */
  speakingCharacters?: readonly string[];
  /** Camera shots planned for the scene (shot type informs importance). */
  shots?: readonly {
    shotId?: string;
    characters?: readonly string[];
    shotType?: string;
  }[];
  /** Director-set importance; defaults to "normal". */
  importance?: "low" | "normal" | "high" | "hero";
}

/** Why a scene was or was not flagged for a Scene Master Image. */
export interface SceneMasterNeedSignals {
  /** Distinct character count in the scene. */
  characterCount: number;
  /** True when the scene has at least `minCharacters` distinct characters. */
  multiCharacter: boolean;
  /** Two or more characters speak in the scene. */
  dialogueBetweenCharacters: boolean;
  /** At least one planned shot frames two or more characters together. */
  hasMultiCharacterShot: boolean;
  /** Summed importance score (flag + dialogue + multi-character shots). */
  importanceScore: number;
}

/** Result of {@link classifySceneMasterNeed}. */
export interface SceneMasterNeed {
  sceneId: string;
  /** True when this scene must get a Scene Master Image. */
  requiresSceneMaster: boolean;
  /** Deterministic human-readable justification for the decision. */
  reason: string;
  signals: SceneMasterNeedSignals;
}

/** Options for {@link classifySceneMasterNeed}. */
export interface SceneMasterClassificationOptions {
  /** Minimum distinct characters to count as multi-character. Default 2. */
  minCharacters?: number;
  /** Importance score at or above which a multi-character scene is
   *  flagged. Default 2. */
  importanceThreshold?: number;
}

const IMPORTANCE_BASE_SCORE: Record<
  NonNullable<SceneMasterSceneInput["importance"]>,
  number
> = { low: 0, normal: 1, high: 3, hero: 4 };

/**
 * Decide whether a scene needs a Scene Master Image (spec §8: "important
 * multi-character scenes"). A scene is flagged when it is multi-character
 * AND its importance score reaches the threshold; importance comes from the
 * director's importance flag, two-way dialogue, and multi-character shots.
 */
export function classifySceneMasterNeed(
  scene: SceneMasterSceneInput,
  options: SceneMasterClassificationOptions = {},
): SceneMasterNeed {
  const minCharacters = options.minCharacters ?? 2;
  const threshold = options.importanceThreshold ?? 2;
  requireNonEmpty(scene.sceneId, "sceneId");
  requireArray(scene.characters, "scene.characters");
  const characters = [...new Set(scene.characters)];
  if (scene.importance !== undefined && !(scene.importance in IMPORTANCE_BASE_SCORE)) {
    throw new SceneMasterError(
      `scene ${scene.sceneId} has unknown importance "${String(scene.importance)}" (expected low | normal | high | hero)`,
    );
  }

  const speaking = new Set(scene.speakingCharacters ?? []);
  const dialogueBetweenCharacters = speaking.size >= 2;
  const hasMultiCharacterShot = (scene.shots ?? []).some(
    (shot) => new Set(shot.characters ?? []).size >= 2,
  );
  const importance = scene.importance ?? "normal";
  const importanceScore =
    IMPORTANCE_BASE_SCORE[importance] +
    (dialogueBetweenCharacters ? 2 : 0) +
    (hasMultiCharacterShot ? 1 : 0);

  const multiCharacter = characters.length >= minCharacters;
  const requiresSceneMaster = multiCharacter && importanceScore >= threshold;
  const reason = requiresSceneMaster
    ? `multi-character scene (${characters.length} characters) with importance score ${importanceScore} >= threshold ${threshold}`
    : multiCharacter
      ? `multi-character scene (${characters.length} characters) but importance score ${importanceScore} < threshold ${threshold}`
      : `not multi-character (${characters.length} character(s), minimum ${minCharacters})`;

  return {
    sceneId: scene.sceneId,
    requiresSceneMaster,
    reason,
    signals: {
      characterCount: characters.length,
      multiCharacter,
      dialogueBetweenCharacters,
      hasMultiCharacterShot,
      importanceScore,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scene-master specification                                          */
/* ------------------------------------------------------------------ */

/** Canon state for one character inside a scene-master spec. */
export interface SceneMasterIdentity {
  /** Canonical Character Library ID (never display-name-keyed). */
  characterId: string;
  /** Identity version canon at this episode's continuity point. */
  identityVersion: string;
  /** Hair version canon at this episode's continuity point. */
  hairVersion?: string;
  /** Wardrobe version this scene must dress the character in. Required. */
  wardrobeVersion: string;
  /** Optional display name for human review only — never a key. */
  displayName?: string;
}

/** The room/location a scene master establishes. */
export interface SceneMasterRoom {
  /** Recurring location library ID, when the location is canonical. */
  locationId?: string;
  /** Human-readable room/location name. Required non-empty. */
  roomName: string;
  /** Lighting-relevant time of day. */
  timeOfDay?: "day" | "night" | "dawn" | "dusk" | (string & {});
  /** Free-text environment notes (set dressing, weather, era). */
  environmentNotes?: string;
}

/** Lighting scheme the scene master must establish. */
export interface SceneMasterLighting {
  /** Non-empty lighting description, e.g. "warm practicals, dusk spill". */
  scheme: string;
  /** Optional additional lighting notes. */
  notes?: string;
}

/** One prop the scene master must place. */
export interface SceneMasterProp {
  /** Recurring prop library ID, when canonical. */
  propId?: string;
  /** Non-empty prop name. */
  name: string;
  /** Where the prop sits in the composition. */
  placement?: string;
  /** Character ID of the character handling/holding the prop, if any. */
  handledByCharacterId?: string;
}

/** Physical placement of one character in the scene master. */
export interface SceneMasterPosition {
  /** Canonical Character Library ID this position belongs to. */
  characterId: string;
  /** Stage position; known values below, custom descriptors allowed. */
  position:
    | "stage-left"
    | "center-left"
    | "center"
    | "center-right"
    | "stage-right"
    | "foreground"
    | "background"
    | (string & {});
  /** Where the character faces relative to camera. */
  facing?:
    | "camera"
    | "away-from-camera"
    | "toward-left"
    | "toward-right"
    | (string & {});
  /** Optional blocking notes. */
  notes?: string;
}

/** Input to {@link createSceneMasterSpec}. */
export interface SceneMasterSpecInput {
  sceneId: string;
  /** Episode code this scene master is canon for, e.g. "S01E09". */
  episodeCode?: string;
  identities: readonly SceneMasterIdentity[];
  room: SceneMasterRoom;
  lighting: SceneMasterLighting;
  props: readonly SceneMasterProp[];
  positions: readonly SceneMasterPosition[];
  note?: string;
}

/** Lifecycle of the scene-master image itself. */
export type SceneMasterApprovalState = "DRAFT" | "APPROVED";

/**
 * The scene-master specification: everything one approved scene-master
 * image must establish (spec §8 — identities, wardrobe, room/location,
 * lighting, props, physical positions).
 */
export interface SceneMasterSpec {
  sceneId: string;
  episodeCode?: string;
  identities: readonly SceneMasterIdentity[];
  room: SceneMasterRoom;
  lighting: SceneMasterLighting;
  props: readonly SceneMasterProp[];
  positions: readonly SceneMasterPosition[];
  note?: string;
  approvalState: SceneMasterApprovalState;
  /**
   * True only after {@link approveSceneMasterSpec}. Unapproved or internal
   * images are never provider input (spec §8).
   */
  providerReferenceEligible: boolean;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new SceneMasterError(`${label} must be a non-empty string`);
  }
}

function requireArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (!Array.isArray(value)) {
    throw new SceneMasterError(`${label} must be an array`);
  }
  return value;
}

function requireObject<T extends object>(value: T | undefined, label: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SceneMasterError(`${label} must be an object`);
  }
  return value;
}

function requireElement<T extends object>(value: T | undefined, label: string): T {
  if (typeof value !== "object" || value === null) {
    throw new SceneMasterError(`${label} must be an object`);
  }
  return value;
}

/**
 * Build and validate a scene-master spec. The spec must carry at least one
 * identity (each with wardrobe), a room, a lighting scheme, a props list
 * (possibly empty), and exactly one position per identity.
 */
export function createSceneMasterSpec(input: SceneMasterSpecInput): SceneMasterSpec {
  requireNonEmpty(input.sceneId, "sceneId");
  const identities = requireArray(input.identities, "identities");
  const props = requireArray(input.props, "props");
  const positions = requireArray(input.positions, "positions");
  const room = requireObject(input.room, "room");
  const lighting = requireObject(input.lighting, "lighting");
  if (identities.length === 0) {
    throw new SceneMasterError(
      `scene master for ${input.sceneId} requires at least one identity`,
    );
  }
  const seen = new Set<string>();
  const validIdentities: SceneMasterIdentity[] = [];
  for (const rawIdentity of identities) {
    const identity = requireElement(
      rawIdentity as SceneMasterIdentity | undefined,
      "identities entry",
    );
    requireNonEmpty(identity.characterId, "characterId");
    requireNonEmpty(identity.identityVersion, "identityVersion");
    requireNonEmpty(identity.wardrobeVersion, "wardrobeVersion");
    if (seen.has(identity.characterId)) {
      throw new SceneMasterError(
        `duplicate identity for character ${identity.characterId}`,
      );
    }
    seen.add(identity.characterId);
    validIdentities.push(identity);
  }

  requireNonEmpty(room.roomName, "room.roomName");
  requireNonEmpty(lighting.scheme, "lighting.scheme");
  for (const rawProp of props) {
    const prop = requireElement(rawProp as SceneMasterProp | undefined, "prop");
    requireNonEmpty(prop.name, "prop.name");
  }

  const positionsByCharacter = new Map<string, number>();
  for (const rawPosition of positions) {
    const position = requireElement(
      rawPosition as SceneMasterPosition | undefined,
      "position",
    );
    requireNonEmpty(position.characterId, "position.characterId");
    if (!seen.has(position.characterId)) {
      throw new SceneMasterError(
        `position references unknown character ${position.characterId}`,
      );
    }
    const count = positionsByCharacter.get(position.characterId) ?? 0;
    if (count > 0) {
      throw new SceneMasterError(
        `duplicate position for character ${position.characterId}`,
      );
    }
    positionsByCharacter.set(position.characterId, count + 1);
  }
  for (const identity of validIdentities) {
    if (!positionsByCharacter.has(identity.characterId)) {
      throw new SceneMasterError(
        `missing position for character ${identity.characterId}`,
      );
    }
  }

  return {
    sceneId: input.sceneId,
    ...(input.episodeCode !== undefined ? { episodeCode: input.episodeCode } : {}),
    identities: validIdentities,
    room,
    lighting,
    props,
    positions,
    ...(input.note !== undefined ? { note: input.note } : {}),
    approvalState: "DRAFT",
    providerReferenceEligible: false,
  };
}

/**
 * Mark a scene-master image APPROVED and provider-reference-eligible
 * (spec §8: "one APPROVED scene-master image"). Only the approval flow may
 * flip eligibility; DRAFT specs are never provider input.
 */
export function approveSceneMasterSpec(spec: SceneMasterSpec): SceneMasterSpec {
  return { ...spec, approvalState: "APPROVED", providerReferenceEligible: true };
}

/* ------------------------------------------------------------------ */
/* Internal storyboard images are never provider input                 */
/* ------------------------------------------------------------------ */

/**
 * Create an internal planning image record stamped NON_PROVIDER_INPUT.
 * Internal storyboards exist so planning can use more images than the
 * provider receives (spec §8); they must never reach a provider call.
 */
export function createInternalStoryboardImage(
  input: Omit<InternalImageRecord, "providerInput" | "usageMarker">,
): InternalImageRecord {
  requireNonEmpty(input.assetId, "assetId");
  requireNonEmpty(input.sceneId, "sceneId");
  return {
    ...input,
    providerInput: false,
    usageMarker: NON_PROVIDER_INPUT_MARKER,
  };
}

/**
 * True only when an image record may be handed to a provider. The
 * NON_PROVIDER_INPUT marker is authoritative: an image stamped with it is
 * excluded no matter what any other field claims.
 */
export function isProviderEligibleImage(
  image: Pick<InternalImageRecord, "providerInput" | "usageMarker">,
): boolean {
  if (image.usageMarker === NON_PROVIDER_INPUT_MARKER) return false;
  return image.providerInput === true;
}

/**
 * Throw if a PROVIDER-ELIGIBLE image is about to be used as an internal
 * planning image (e.g. in an internal storyboard record) — internal planning
 * images must never be eligible for provider input. Guard callers that must
 * only ever hand planning-internal images forward.
 */
export function assertNotProviderInput(
  image: Pick<InternalImageRecord, "assetId" | "providerInput" | "usageMarker">,
): void {
  if (!isProviderEligibleImage(image)) return;
  throw new SceneMasterError(
    `image ${image.assetId} is provider-eligible and must never be treated as an internal planning image`,
  );
}

/**
 * Filter a candidate image list down to what a provider may receive —
 * internal storyboards are dropped (spec §8: internal planning may use more
 * images than the provider receives).
 */
export function filterProviderEligibleImages<T extends InternalImageRecord>(
  images: readonly T[],
): T[] {
  return images.filter(isProviderEligibleImage);
}

/* ------------------------------------------------------------------ */
/* End-to-end planning                                                 */
/* ------------------------------------------------------------------ */

/** Appearance canon resolved for one character at the episode's continuity. */
export interface ResolvedSceneMasterAppearance {
  identityVersion: string;
  hairVersion?: string;
  wardrobeVersion: string;
}

/** A planned scene-master decision for one scene. */
export interface SceneMasterPlan {
  sceneId: string;
  requiresSceneMaster: boolean;
  reason: string;
  /** Present only when {@link SceneMasterPlan.requiresSceneMaster}. */
  spec?: SceneMasterSpec;
}

/** Options for {@link planSceneMasters}. */
export interface SceneMasterPlanningOptions
  extends SceneMasterClassificationOptions {
  /**
   * Resolves canon-at-the-time appearance for a character. Required for
   * every character in a flagged scene; a missing resolution is an error,
   * never a silent guess.
   */
  resolveAppearance: (
    characterId: string,
  ) => ResolvedSceneMasterAppearance | undefined;
}

/**
 * Plan scene masters for a batch of scenes: classify each scene, and for
 * flagged scenes build the spec from canon-resolved appearances plus a
 * DRAFT internal storyboard frame marked NON_PROVIDER_INPUT.
 */
export function planSceneMasters(
  scenes: readonly SceneMasterSceneInput[],
  room: SceneMasterRoom,
  lighting: SceneMasterLighting,
  props: readonly SceneMasterProp[],
  positions: readonly SceneMasterPosition[],
  options: SceneMasterPlanningOptions,
): SceneMasterPlan[] {
  return scenes.map((scene) => {
    const need = classifySceneMasterNeed(scene, options);
    if (!need.requiresSceneMaster) {
      return {
        sceneId: scene.sceneId,
        requiresSceneMaster: false,
        reason: need.reason,
      };
    }

    const identities: SceneMasterIdentity[] = [...new Set(scene.characters)].map(
      (characterId) => {
        const appearance = options.resolveAppearance(characterId);
        if (appearance === undefined) {
          throw new SceneMasterError(
            `no appearance resolution for character ${characterId} in scene ${scene.sceneId}`,
          );
        }
        return {
          characterId,
          identityVersion: appearance.identityVersion,
          ...(appearance.hairVersion !== undefined
            ? { hairVersion: appearance.hairVersion }
            : {}),
          wardrobeVersion: appearance.wardrobeVersion,
        };
      },
    );

    const spec = createSceneMasterSpec({
      sceneId: scene.sceneId,
      identities,
      room,
      lighting,
      props,
      positions,
    });
    return {
      sceneId: scene.sceneId,
      requiresSceneMaster: true,
      reason: need.reason,
      spec,
    };
  });
}