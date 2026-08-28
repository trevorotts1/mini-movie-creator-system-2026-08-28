/**
 * Storyboard generator contract for Scene Intelligence — spec §15 ("Image
 * provider registry … storyboard generation select the image model by
 * capability profile"), spec §8 (internal storyboard images are NOT provider
 * input), spec §12 (per-shot specification record feeds the contract), and
 * runbook §25 step 15 ("storyboard, STOP for storyboard approval").
 *
 * A storyboard plan is the PER-SHOT IMAGE-GENERATION CONTRACT: for every
 * shot that needs a storyboard frame it fixes
 *
 *   - which image model generates the frame (selected by capability profile,
 *     never hard-coded to one provider — spec §15);
 *   - which keyframe/reference strategy the frame serves (DIR-012 output
 *     shape, declared structurally);
 *   - the minimum-sufficient reference set (DIR-013 output shape, structural);
 *   - the prompt constraints the prompt compiler must respect (hard max
 *     characters is UNKNOWN → null → never enforced, never guessed);
 *   - output envelope: aspect ratio + resolution tier chosen from the
 *     profile's DOCUMENTED lists (never invent a ratio the model lacks);
 *   - the deterministic internal asset ID and NON_PROVIDER_INPUT stamp
 *     (storyboard frames are planning art, never provider input).
 *
 * NO PAID GENERATION HERE. The plan names an image model and carries a
 * mocked image client port; the only executable path in this task is the
 * mock, and it fails fast if a caller wires anything else (spec gate 4:
 * storyboard approval precedes any paid generation — DIR-015 owns the
 * approval gate, this module never flips approval).
 *
 * Story/script text flowing through these types is UNTRUSTED DATA — stored
 * verbatim into record fields, never parsed, executed, or interpreted as
 * instructions (spec §29).
 */

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Error thrown on invalid storyboard-contract operations. */
export class StoryboardContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryboardContractError";
  }
}

/* ------------------------------------------------------------------ */
/* Mocked image client port (no paid generation in this task)          */
/* ------------------------------------------------------------------ */

/**
 * Structural shape of an image-capable capability profile (CAP-001 registry
 * kind "image"). Declared structurally so this module stays decoupled from
 * the capability-registry package; the caller passes the active profile's
 * relevant slice. UNKNOWN values stay null and are never guessed.
 */
export interface ImageCapabilityProfile {
  readonly provider: string;
  readonly modelId: string;
  /** Documented aspect ratios; null = UNKNOWN (no ratio constraint applied). */
  readonly aspectRatios: readonly string[] | null;
  /** Documented resolution tiers; null = UNKNOWN. */
  readonly resolutions: readonly string[] | null;
  /** Documented reference-image max; null = UNKNOWN (not known to prohibit). */
  readonly maxImages: number | null;
  /** Hard prompt character ceiling; null = UNKNOWN — never enforced. */
  readonly hardMaxCharacters: number | null;
  /** Recommended prompt size; null = UNKNOWN. */
  readonly recommendedMaxCharacters: number | null;
  /** Model accepts multimodal reference packages (multi-image composition). */
  readonly multimodalReferences: boolean;
  /** Provenance tier echoed into the contract; null/absent = not carried. */
  readonly confidence?: "VERIFIED" | "PROVISIONAL" | "UNKNOWN" | null;
  /** True when this profile's kind is "image" (video/voice profiles rejected). */
  readonly imageKind?: boolean | undefined;
}

/**
 * Result the (mocked) image client returns. One record per generated frame;
 * everything here is planning metadata — no provider call happens in this
 * task, so `url` names a local placeholder, never a paid provider artifact.
 */
export interface GeneratedFrameRecord {
  /** Deterministic internal asset ID, e.g. "ASSET_S01E01_SC03_SH04_SB01". */
  assetId: string;
  /** The image model the contract selected (echoed for provenance). */
  modelId: string;
  /** Provider of the selected model. */
  provider: string;
  /** Aspect ratio requested (validated against the profile when documented). */
  aspectRatio: string;
  /** Resolution tier requested (validated against the profile when documented). */
  resolution: string | null;
  /** Local placeholder path for planning only — NEVER a provider URL. */
  url: string;
  /** Final prompt character count as compiled for this frame. */
  promptCharacterCount: number;
  /** Frame marks itself non-provider-input (spec §8). */
  providerInput: false;
}

/**
 * The image client port a storyboard execution layer must satisfy. This
 * task ships ONLY {@link MockImageClient}: real adapters live in
 * `@mmcs/providers` and never get wired here while storyboards are
 * unapproved (gate 4, DIR-015).
 */
export interface StoryboardImageClient {
  readonly kind: "mock" | "real";
  generateFrame(request: {
    prompt: string;
    aspectRatio: string;
    resolution: string | null;
    referenceAssetIds: readonly string[];
  }): Promise<GeneratedFrameRecord>;
}

/**
 * Deterministic mocked image client. Produces a placeholder frame record —
 * no network, no spend, no side effects. Exists so the contract is
 * executable end-to-end in tests without any paid generation.
 */
export class MockImageClient implements StoryboardImageClient {
  readonly kind = "mock" as const;

  async generateFrame(request: {
    prompt: string;
    aspectRatio: string;
    resolution: string | null;
    referenceAssetIds: readonly string[];
  }): Promise<GeneratedFrameRecord> {
    if (typeof request.prompt !== "string") {
      throw new StoryboardContractError("mock client requires a string prompt");
    }
    return {
      assetId: `MOCK_FRAME_${request.referenceAssetIds.length}refs`,
      modelId: "mock-image-model",
      provider: "mock",
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      url: `mock://storyboard/${encodeURIComponent(request.prompt.slice(0, 32))}`,
      promptCharacterCount: [...request.prompt].length,
      providerInput: false,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** Non-provider-input marker (same contract as DIR-011 scene-master). */
export const NON_PROVIDER_INPUT_MARKER = "NON_PROVIDER_INPUT";

/** One planned shot as seen by the storyboard contract. */
export interface StoryboardShotInput {
  /** Stable shot ID, e.g. "SC03-SH04" (DIR-010 output). */
  shotId: string;
  /** Scene the shot belongs to. */
  sceneId: string;
  /** Episode code, e.g. "S01E01" (drives the deterministic asset ID). */
  episodeCode: string;
  /** Camera shot type (establishing, close-up, two-shot…). */
  shotType?: string;
  /** One-line visual intent for the frame. Untrusted text — data only. */
  visualIntent: string;
  /** Canonical character IDs visible in the shot. */
  characters?: readonly string[];
  /** DIR-012 keyframe strategy for this shot. */
  keyframeStrategy:
    | "zero"
    | "one-start"
    | "start-end"
    | "scene-master-refs"
    | "multimodal-package"
    | "zero-keyframes"
    | "one-starting-keyframe"
    | "start-end-keyframes"
    | "scene-master-plus-references"
    | "multimodal-reference-package";
  /** DIR-013 minimum-sufficient reference asset IDs (already selected). */
  referenceAssetIds?: readonly string[];
  /** True when an approved scene-master image exists for the scene. */
  sceneMasterAvailable?: boolean;
}

/**
 * Aspect-ratio policy for the storyboard frames. Storyboards are internal
 * planning art: they default to the PRODUCTION aspect ratio so compositions
 * preview at the delivery framing (spec §23), overridable per call.
 */
export interface StoryboardOptions {
  /** Production aspect ratio, e.g. "16:9" or "9:16". Required. */
  aspectRatio: string;
  /**
   * Preferred resolution tier. Validated against the profile when the
   * profile documents resolutions; when UNKNOWN, kept verbatim but flagged.
   */
  resolution?: string | null;
  /**
   * Frames only for shots that carry visual ambiguity (defaults: every
   * shot gets a frame; a caller may pass a narrower predicate).
   */
  needsFrame?: (shot: StoryboardShotInput) => boolean;
}

/* ------------------------------------------------------------------ */
/* Image-model selection (spec §15)                                    */
/* ------------------------------------------------------------------ */

/**
 * Ordered image-model candidates, best first. Selection walks the list and
 * picks the first model whose documented capability profile satisfies the
 * shot's reference needs; ties and unknowns resolve in list order. Never
 * hard-codes a provider — the caller supplies candidate profiles.
 *
 * A candidate satisfies the shot when:
 *   - it is an IMAGE-kind profile (video/voice profiles never selected);
 *   - its documented maxImages covers the shot's reference count (null =
 *     UNKNOWN = tolerated, "not known to prohibit"; 0 = definite no);
 *   - multimodal-reference shots require `multimodalReferences`.
 */
export function selectImageModel(
  shot: Pick<StoryboardShotInput, "keyframeStrategy" | "referenceAssetIds">,
  candidates: readonly ImageCapabilityProfile[],
): ImageCapabilityProfile {
  if (candidates.length === 0) {
    throw new StoryboardContractError(
      "image-model selection requires at least one candidate profile",
    );
  }
  const referenceCount = shot.referenceAssetIds?.length ?? 0;
  const strategy = shot.keyframeStrategy;
  const needsMultimodal =
    strategy === "multimodal-package" || strategy === "multimodal-reference-package";

  for (const candidate of candidates) {
    if (candidate.imageKind === false) continue; // wrong registry kind
    if (needsMultimodal && !candidate.multimodalReferences) continue;
    if (candidate.maxImages !== null && candidate.maxImages < referenceCount) continue;
    return candidate;
  }

  throw new StoryboardContractError(
    `no candidate image model satisfies the shot contract ` +
      `(strategy=${strategy}, references=${referenceCount}, ` +
      `candidates=${candidates.map((c) => `${c.provider}/${c.modelId}`).join(", ")})`,
  );
}

/* ------------------------------------------------------------------ */
/* Prompt envelope validation                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate a frame prompt against the profile's documented constraints.
 * UNKNOWN limits (null) are NEVER enforced and NEVER guessed (spec §5):
 * a null hardMaxCharacters produces no violation, only a note. Returns the
 * exact character count so the contract records `prompt_character_count`.
 */
export function validateFramePrompt(
  prompt: string,
  profile: Pick<ImageCapabilityProfile, "hardMaxCharacters" | "recommendedMaxCharacters">,
): { characterCount: number; violations: string[]; notes: string[] } {
  if (typeof prompt !== "string") {
    throw new StoryboardContractError("prompt must be a string");
  }
  const characterCount = [...prompt].length;
  const violations: string[] = [];
  const notes: string[] = [];

  if (profile.hardMaxCharacters === null) {
    notes.push(
      "hardMaxCharacters UNKNOWN — no limit enforced; never invented (spec §5)",
    );
  } else if (characterCount > profile.hardMaxCharacters) {
    violations.push(
      `prompt ${characterCount} chars exceeds documented hard max ${profile.hardMaxCharacters}`,
    );
  }

  if (
    profile.recommendedMaxCharacters !== null &&
    characterCount > profile.recommendedMaxCharacters &&
    (profile.hardMaxCharacters === null ||
      characterCount <= profile.hardMaxCharacters)
  ) {
    notes.push(
      `prompt ${characterCount} chars exceeds recommended ${profile.recommendedMaxCharacters} (soft)`,
    );
  }

  return { characterCount, violations, notes };
}

/* ------------------------------------------------------------------ */
/* Output envelope                                                     */
/* ------------------------------------------------------------------ */

/**
 * Choose the frame's aspect ratio + resolution tier from the profile's
 * DOCUMENTED lists. A requested ratio the model does not document is a
 * hard error — never silently map a ratio a model lacks (spec §15: aspect
 * ratios are capability data). When the profile's ratio list is UNKNOWN
 * (null) the request passes through unvalidated with a note.
 */
export function resolveOutputEnvelope(
  requested: { aspectRatio: string; resolution?: string | null },
  profile: Pick<ImageCapabilityProfile, "modelId" | "aspectRatios" | "resolutions">,
): { aspectRatio: string; resolution: string | null; notes: string[] } {
  const notes: string[] = [];
  let aspectRatio = requested.aspectRatio;

  if (profile.aspectRatios !== null) {
    if (!profile.aspectRatios.includes(aspectRatio)) {
      throw new StoryboardContractError(
        `aspect ratio ${aspectRatio} not documented for ${profile.modelId} ` +
          `(documented: ${profile.aspectRatios.join(", ")})`,
      );
    }
  } else {
    notes.push(`aspect ratios UNKNOWN for ${profile.modelId} — passed through unvalidated`);
  }

  let resolution = requested.resolution ?? null;
  if (resolution !== null && profile.resolutions !== null) {
    if (!profile.resolutions.includes(resolution)) {
      throw new StoryboardContractError(
        `resolution ${resolution} not documented for ${profile.modelId} ` +
          `(documented: ${profile.resolutions.join(", ")})`,
      );
    }
  } else if (resolution !== null && profile.resolutions === null) {
    notes.push(`resolutions UNKNOWN for ${profile.modelId} — tier passed through unvalidated`);
  }

  return { aspectRatio, resolution, notes };
}

/* ------------------------------------------------------------------ */
/* Per-shot contract + plan                                            */
/* ------------------------------------------------------------------ */

/** Lifecycle of the storyboard plan (gate 4 lives in DIR-015). */
export type StoryboardApprovalState = "DRAFT" | "APPROVED";

/**
 * The image-generation contract for ONE shot. Deterministic, serializable,
 * provider-independent: it names WHAT must be generated, with WHICH model,
 * under WHICH constraints — and marks the frame NON_PROVIDER_INPUT.
 */
export interface StoryboardShotContract {
  /** Episode code, e.g. "S01E01". */
  episodeCode: string;
  shotId: string;
  sceneId: string;
  /** Deterministic internal asset ID: ASSET_<ep>_<scene>_<shot>_SB01. */
  assetId: string;
  /** Shot type carried for human review. */
  shotType: string | null;
  /** Visual intent for the frame. Untrusted text — data only. */
  visualIntent: string;
  /** Canonical character IDs visible in the frame. */
  characters: string[];
  /** Keyframe/reference strategy this frame serves (DIR-012 taxonomy). */
  keyframeStrategy: StoryboardShotInput["keyframeStrategy"];
  /** Minimum-sufficient reference asset IDs (DIR-013 selection). */
  referenceAssetIds: string[];
  /** Selected image model (spec §15 — by capability profile). */
  imageModel: {
    provider: string;
    modelId: string;
    /** Provenance echo from the profile: confidence tier. */
    confidence: "VERIFIED" | "PROVISIONAL" | "UNKNOWN" | null;
  };
  /** Output envelope the frame requests. */
  output: {
    aspectRatio: string;
    resolution: string | null;
  };
  /** Prompt constraint surface from the profile (null = UNKNOWN). */
  promptConstraints: {
    hardMaxCharacters: number | null;
    recommendedMaxCharacters: number | null;
  };
  /** Prompt the image model receives (compiled by the caller/compiler). */
  prompt: string;
  /** Exact prompt character count ([...prompt].length). */
  promptCharacterCount: number;
  /** Prompt-envelope violations — non-empty means the contract is invalid. */
  promptViolations: string[];
  /** Non-fatal planning notes (UNKNOWN passthroughs, soft-limit hits). */
  notes: string[];
  /** Internal storyboard frames are NEVER provider input (spec §8). */
  providerInput: false;
  usageMarker: typeof NON_PROVIDER_INPUT_MARKER;
}

/** Result of {@link planStoryboard}: the whole episode's frame contracts. */
export interface StoryboardPlan {
  episodeCode: string;
  /** Aspect ratio the plan frames were composed for. */
  aspectRatio: string;
  /** One contract per framed shot, in input order. */
  contracts: readonly StoryboardShotContract[];
  /** Shot IDs skipped (no frame needed under the predicate). */
  skippedShotIds: string[];
  approvalState: StoryboardApprovalState;
  /** The only client this task ships — always "mock" here. */
  imageClientKind: "mock" | "real";
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new StoryboardContractError(`${label} must be non-empty`);
  }
}

/**
 * Deterministic internal asset ID for a storyboard frame.
 * Pattern: ASSET_<EP>_<SCENE>_<SHOT>_SB01 (spec §19 deterministic naming;
 * internal planning frames carry the SB suffix and stay out of provider
 * calls — they are not the durable §19 media assets, which the generation
 * phase mints when paid work is approved).
 */
export function storyboardAssetId(episodeCode: string, shotId: string): string {
  return `ASSET_${episodeCode}_${shotId}_SB01`;
}

/**
 * Build the per-shot image-generation contract for every framed shot.
 *
 * Pure planning — no I/O, no provider call, no spend. The returned plan is
 * DRAFT; only DIR-015's approval gate (storyboard approval, gate 4) may
 * advance it, and nothing here attempts generation: the image client is
 * returned separately as the mocked port for the (later, approved) phase.
 */
export function planStoryboard(
  shots: readonly StoryboardShotInput[],
  imageModels: readonly ImageCapabilityProfile[],
  options: StoryboardOptions,
): StoryboardPlan {
  requireNonEmpty(options.aspectRatio, "options.aspectRatio");
  if (imageModels.length === 0) {
    throw new StoryboardContractError(
      "planStoryboard requires at least one candidate image-model profile",
    );
  }

  const seen = new Set<string>();
  for (const shot of shots) {
    requireNonEmpty(shot.shotId, "shot.shotId");
    requireNonEmpty(shot.sceneId, "shot.sceneId");
    requireNonEmpty(shot.episodeCode, "shot.episodeCode");
    requireNonEmpty(shot.visualIntent, "shot.visualIntent");
    if (seen.has(shot.shotId)) {
      throw new StoryboardContractError(`duplicate shotId "${shot.shotId}"`);
    }
    seen.add(shot.shotId);
  }

  const needsFrame = options.needsFrame ?? (() => true);
  const contracts: StoryboardShotContract[] = [];
  const skippedShotIds: string[] = [];
  const aggregateNotes: string[] = [];

  for (const shot of shots) {
    if (!needsFrame(shot)) {
      skippedShotIds.push(shot.shotId);
      continue;
    }

    const profile = selectImageModel(shot, imageModels);

    const envelope = resolveOutputEnvelope(
      { aspectRatio: options.aspectRatio, resolution: options.resolution ?? null },
      profile,
    );

    const prompt = buildFramePrompt(shot);
    const promptCheck = validateFramePrompt(prompt, profile);
    if (promptCheck.violations.length > 0) {
      throw new StoryboardContractError(
        `prompt contract violation for ${shot.shotId}: ${promptCheck.violations.join("; ")}`,
      );
    }

    const notes = [...envelope.notes, ...promptCheck.notes];

    contracts.push({
      episodeCode: shot.episodeCode,
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      assetId: storyboardAssetId(shot.episodeCode, shot.shotId),
      shotType: shot.shotType ?? null,
      visualIntent: shot.visualIntent,
      characters: [...new Set(shot.characters ?? [])],
      keyframeStrategy: shot.keyframeStrategy,
      referenceAssetIds: [...(shot.referenceAssetIds ?? [])],
      imageModel: {
        provider: profile.provider,
        modelId: profile.modelId,
        confidence: confidenceOf(profile),
      },
      output: {
        aspectRatio: envelope.aspectRatio,
        resolution: envelope.resolution,
      },
      promptConstraints: {
        hardMaxCharacters: profile.hardMaxCharacters,
        recommendedMaxCharacters: profile.recommendedMaxCharacters,
      },
      prompt,
      promptCharacterCount: promptCheck.characterCount,
      promptViolations: promptCheck.violations,
      notes,
      providerInput: false,
      usageMarker: NON_PROVIDER_INPUT_MARKER,
    });
    aggregateNotes.push(...notes);
  }

  return {
    episodeCode: contracts[0]?.episodeCode ?? "",
    aspectRatio: options.aspectRatio,
    contracts,
    skippedShotIds,
    approvalState: "DRAFT",
    imageClientKind: "mock",
  };
}

function confidenceOf(
  profile: ImageCapabilityProfile,
): StoryboardShotContract["imageModel"]["confidence"] {
  return profile.confidence ?? null;
}

/**
 * Compose the frame prompt from structured shot data. Deterministic order;
 * untrusted text fields are interpolated verbatim and never executed.
 * The prompt describes the STILL FRAME the storyboard must establish —
 * composition, characters, camera, and intent — not a video request.
 */
export function buildFramePrompt(shot: StoryboardShotInput): string {
  const parts: string[] = [];
  parts.push(`Storyboard frame for ${shot.shotId}`);
  if (shot.shotType) parts.push(`Shot type: ${shot.shotType}`);
  parts.push(`Visual intent: ${shot.visualIntent}`);
  const characters = [...new Set(shot.characters ?? [])];
  if (characters.length > 0) {
    parts.push(`Characters in frame: ${characters.join(", ")}`);
  }
  const refs = shot.referenceAssetIds ?? [];
  if (refs.length > 0) {
    parts.push(`Reference images: ${refs.join(", ")}`);
  }
  return parts.join(". ");
}

/* ------------------------------------------------------------------ */
/* Mocked generation (the only executable client in this task)         */
/* ------------------------------------------------------------------ */

/**
 * Execute the frame contracts against the MOCKED image client. Refuses a
 * real client outright — no paid generation in this task (acceptance), and
 * refuses anything but a DRAFT-then-mock path. Returns one record per
 * contract, in contract order.
 */
export async function generateStoryboardFrames(
  plan: StoryboardPlan,
  client: StoryboardImageClient,
): Promise<GeneratedFrameRecord[]> {
  if (client.kind !== "mock") {
    throw new StoryboardContractError(
      "storyboard generation in this task accepts only the mocked image client — " +
        "paid generation happens after storyboard approval (gate 4, DIR-015)",
    );
  }
  if (plan.approvalState !== "DRAFT") {
    throw new StoryboardContractError(
      "plan must be DRAFT for mocked generation; approved plans proceed to the real pipeline",
    );
  }

  const records: GeneratedFrameRecord[] = [];
  for (const contract of plan.contracts) {
    const record = await client.generateFrame({
      prompt: contract.prompt,
      aspectRatio: contract.output.aspectRatio,
      resolution: contract.output.resolution,
      referenceAssetIds: contract.referenceAssetIds,
    });
    records.push({
      ...record,
      assetId: contract.assetId,
      modelId: contract.imageModel.modelId,
      provider: contract.imageModel.provider,
      providerInput: false,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* NON_PROVIDER_INPUT guard (mirrors DIR-011 contract)                 */
/* ------------------------------------------------------------------ */

/**
 * Marker-bearing record shape for the runtime guard: `usageMarker` is a
 * plain string so foreign records can be classified by the marker alone
 * (same contract as DIR-011 scene-master).
 */
export interface ProviderEligibilityProbe {
  providerInput: boolean;
  usageMarker: string;
}

/**
 * True only when an image record may reach a provider. Storyboard frames
 * are stamped NON_PROVIDER_INPUT at construction, so this is always false
 * for them; the marker is authoritative over any other field (spec §8).
 */
export function isProviderEligibleFrame(frame: ProviderEligibilityProbe): boolean {
  if (frame.usageMarker === NON_PROVIDER_INPUT_MARKER) return false;
  return frame.providerInput === true;
}

/** Throw if a storyboard frame is about to be handed to a provider. */
export function assertNotProviderInput(
  frame: Pick<StoryboardShotContract, "assetId" | "providerInput" | "usageMarker">,
): void {
  if (!isProviderEligibleFrame(frame)) return;
  throw new StoryboardContractError(
    `storyboard frame ${frame.assetId} is internal planning art and must never be sent to a provider (spec §8)`,
  );
}