/**
 * VID-005 — generated clip layer: provider-independent contracts.
 *
 * A "generated clip" is a provider-generated video asset that has been
 * durably archived (spec §17 GHL MediaStore) — i.e. the asset row carries a
 * persistent GHL URL/file ID, never a temporary provider URL. This layer
 * consumes archived clips and places them on the episodic timeline per the
 * shot plan (spec §12 shot specification record; spec §21 Remotion owns
 * timeline/clips).
 *
 * The layer is deliberately provider-independent and does NOT import the
 * database repositories directly: callers (rough-cut assembly, VID-012) wire
 * an `ArchivedClipResolver` backed by the CORE-007 AssetRepository
 * (`ghl_url` → `sourceUrl`, `asset_state = 'ARCHIVED'`), keeping this module
 * pure and mockable.
 */

/**
 * Durable archived clip record — the layer's view of a spec §19 asset
 * manifest row that has reached the ARCHIVED state via GHL.
 */
export interface ArchivedClip {
  /** Durable business ID of the asset (spec §19 `asset_id`). */
  readonly assetId: string;
  /**
   * GHL-resolved durable source — permanent GHL storage URL, or a local
   * cached copy path. Never a temporary provider URL. Used verbatim as the
   * Remotion media source.
   */
  readonly sourceUrl: string;
  /** GHL media file ID (spec §17/§19 `ghl_file_id`); provenance only. */
  readonly ghlFileId?: string;
  /** Optional integrity checksum; carries through for downstream QA. */
  readonly checksum?: string;
  /** Generation provider (spec §19 `provider`), for the production report. */
  readonly provider?: string;
  /** Generation model as called (spec §19 `provider_model`). */
  readonly providerModel?: string;
  /** Asset state (spec §19 `asset_state`); must be `ARCHIVED`. */
  readonly assetState?: string;
  /** Asset type (spec §19 `asset_type`); must be `GENERATED_VIDEO`. */
  readonly assetType?: string;
  /** Known clip length in seconds; optional — provider may not report it. */
  readonly durationSeconds?: number;
  /** Clip's own frame rate, if distinguishable from the timeline fps. */
  readonly fps?: number;
  /** Pixel dimensions, when known. */
  readonly width?: number;
  readonly height?: number;
}

/** Asset state a clip must have reached before it may be placed (spec §18). */
export const CLIP_ARCHIVED_STATE = "ARCHIVED";

/** Asset type for generated provider video clips (spec §19, §22 type 1). */
export const GENERATED_VIDEO_ASSET_TYPE = "GENERATED_VIDEO";

/**
 * One shot of the plan to place on the timeline (spec §12 — the fields this
 * layer actually needs; the full record lives in the CORE-006 shots table).
 */
export interface ShotPlanEntry {
  /** Shot business ID (`S01E03_SC04_SH07` style) — named in every error. */
  readonly shotId: string;
  readonly sceneId?: string;
  /** Position within the scene/episode; placement order follows this. */
  readonly sequenceIndex: number;
  /** Slot length in seconds — the timeline time this shot occupies. */
  readonly targetDurationSeconds: number;
  /** Asset planned for this shot; the resolver is keyed by it, if known. */
  readonly assetId?: string;
  /**
   * Explicit global timeline start (seconds). Default: derived by ordering —
   * each shot starts where the previous one ends.
   */
  readonly inSeconds?: number;
}

/** A clip resolved and placed at its timeline slot. */
export interface PlacedGeneratedClip {
  /** Slot placement data (shot identity + ordering). */
  readonly shotId: string;
  readonly sceneId?: string;
  readonly sequenceIndex: number;
  /** The archived asset backing this slot. */
  readonly assetId: string;
  /** GHL-resolved durable source, used verbatim as the media URI. */
  readonly sourceUrl: string;
  readonly ghlFileId?: string;
  readonly checksum?: string;
  readonly provider?: string;
  readonly providerModel?: string;
  /** Global timeline start of the slot, seconds (inclusive). */
  readonly inSeconds: number;
  /** Global timeline end of the slot, seconds (exclusive). */
  readonly outSeconds: number;
  /** Remotion `<Sequence from>` value = round(inSeconds * fps). */
  readonly fromFrame: number;
  /** Slot length in frames (per shot plan, not clip length). */
  readonly durationInFrames: number;
  /** Clip's own fps, when reported; timeline fps otherwise. */
  readonly clipFps: number;
  /** Reported clip length, when known. */
  readonly sourceDurationSeconds?: number;
  /**
   * True when the reported clip length does NOT cover the slot: shorter
   * leaves a hold-tail (renderer loops/holds), longer must be trimmed.
   * Unknown clip length is treated as exact coverage (ffprobe/VID-015 owns
   * authoritative media duration).
   */
  readonly fullyCovered: boolean;
}

/** Complete assembled clip layer for one episode/sequence. */
export interface GeneratedClipTimeline {
  /** Timeline frame rate used for all frame math. */
  readonly fps: number;
  readonly shots: readonly ShotPlanEntry[];
  readonly clips: readonly PlacedGeneratedClip[];
  /** Total timeline length, seconds (sum of shot slots). */
  readonly durationSeconds: number;
  readonly durationInFrames: number;
}

/**
 * Resolves the archived clip for a planned shot.
 *
 * Callers wire a database-backed implementation (CORE-007 AssetRepository:
 * `findByShot`/`findById` + GHL URL resolution). The layer stays agnostic.
 */
export type ArchivedClipResolver = (
  shot: ShotPlanEntry,
) => ArchivedClip | undefined | Promise<ArchivedClip | undefined>;
