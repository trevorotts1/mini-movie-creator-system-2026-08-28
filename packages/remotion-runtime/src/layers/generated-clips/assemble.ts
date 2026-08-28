import type {
  ArchivedClip,
  ArchivedClipResolver,
  PlacedGeneratedClip,
  ShotPlanEntry,
} from "./types.js";
import {
  CLIP_ARCHIVED_STATE,
  GENERATED_VIDEO_ASSET_TYPE,
} from "./types.js";

/**
 * VID-005 — assembles the generated-clip timeline layer.
 *
 * Takes the shot plan (spec §12 shot records) and the archived provider
 * clips (spec §17/§19: GHL-resolved assets), and produces per-shot slot
 * placements on the episodic timeline. Timing follows the upstream frame-QA
 * discipline: `local_f = global_s * fps − sequence_from` (spec §21), so
 * every slot's Remotion `from` frame is `round(inSeconds * fps)` and the
 * shot component reads its own local frames from 0.
 *
 * Missing assets are a hard error naming the shot — a rough cut must never
 * assemble silently with a gap where a generated clip belongs.
 */

/** Thrown when a planned shot has no archived generated clip. */
export class MissingGeneratedClipError extends Error {
  /** Shot that has no archived clip (spec §12 `shot_id`). */
  readonly shotId: string;
  /** Scene of the offending shot, when known. */
  readonly sceneId?: string;

  constructor(shotId: string, sceneId?: string) {
    super(
      `Missing generated clip for shot '${shotId}'` +
        (sceneId ? ` (scene '${sceneId}')` : "") +
        ": no ARCHIVED GENERATED_VIDEO asset resolved via GHL. " +
        "Generate + archive the shot asset before assembling the rough cut.",
    );
    this.name = "MissingGeneratedClipError";
    this.shotId = shotId;
    this.sceneId = sceneId;
  }
}

/** Thrown when a resolved asset exists but is not a safe archived clip. */
export class InvalidGeneratedClipError extends Error {
  readonly shotId: string;
  readonly assetId: string;

  constructor(shotId: string, assetId: string, reason: string) {
    super(
      `Invalid generated clip for shot '${shotId}' (asset '${assetId}'): ${reason}`,
    );
    this.name = "InvalidGeneratedClipError";
    this.shotId = shotId;
    this.assetId = assetId;
  }
}

/** Validate a resolved asset is an archived generated video with a source. */
function assertArchivedClip(shot: ShotPlanEntry, clip: ArchivedClip): void {
  if (
    clip.assetType !== undefined &&
    clip.assetType !== GENERATED_VIDEO_ASSET_TYPE
  ) {
    throw new InvalidGeneratedClipError(
      shot.shotId,
      clip.assetId,
      `asset_type is '${clip.assetType}', expected '${GENERATED_VIDEO_ASSET_TYPE}'`,
    );
  }
  if (
    clip.assetState !== undefined &&
    clip.assetState !== CLIP_ARCHIVED_STATE
  ) {
    throw new InvalidGeneratedClipError(
      shot.shotId,
      clip.assetId,
      `asset_state is '${clip.assetState}', expected '${CLIP_ARCHIVED_STATE}' — ` +
        "temporary provider URLs are never placed on the timeline (spec §17)",
    );
  }
  if (!clip.sourceUrl || clip.sourceUrl.trim().length === 0) {
    throw new InvalidGeneratedClipError(
      shot.shotId,
      clip.assetId,
      "sourceUrl is empty — GHL-resolved durable URL required",
    );
  }
}

/** Assembled layer shape — mirrors {@link GeneratedClipTimeline}. */
export interface AssembledGeneratedClips {
  readonly fps: number;
  readonly shots: readonly ShotPlanEntry[];
  readonly clips: readonly PlacedGeneratedClip[];
  readonly durationSeconds: number;
  readonly durationInFrames: number;
}

/**
 * Assemble the generated-clip layer for one episode/scene plan.
 *
 * - Shots are placed in `sequenceIndex` order (stable for equal indexes —
 *   input order wins); an explicit `inSeconds` overrides the derived start
 *   and the cursor jumps past it, so explicit and derived placements mix.
 * - Each slot's duration is the shot's `targetDurationSeconds` (the slot the
 *   plan reserves), NOT the clip's own length — coverage is reported on the
 *   placed clip so the renderer can loop/hold or trim.
 * - Every shot MUST resolve to an ARCHIVED GENERATED_VIDEO asset, else
 *   {@link MissingGeneratedClipError} names the shot.
 *
 * @param shots the shot plan (subset of the spec §12 record this layer reads)
 * @param resolve archived-clip resolver (DB/GHL-backed in production, mock in tests)
 * @param fps timeline frame rate (upstream shorts use 30)
 */
export async function assembleGeneratedClips(
  shots: readonly ShotPlanEntry[],
  resolve: ArchivedClipResolver,
  fps: number,
): Promise<AssembledGeneratedClips> {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps ${fps}: must be a positive finite number`);
  }

  const placementOrder = shots
    .map((shot, inputIndex) => ({ shot, inputIndex }))
    .sort((a, b) => {
      const bySequence = a.shot.sequenceIndex - b.shot.sequenceIndex;
      return bySequence !== 0 ? bySequence : a.inputIndex - b.inputIndex;
    });

  let cursor = 0;
  const clips: PlacedGeneratedClip[] = [];

  for (const { shot } of placementOrder) {
    const explicit = shot.inSeconds;
    const inSeconds = explicit ?? cursor;

    const resolved = await resolve(shot);
    if (resolved === undefined) {
      throw new MissingGeneratedClipError(shot.shotId, shot.sceneId);
    }
    assertArchivedClip(shot, resolved);

    const durationSeconds = shot.targetDurationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new InvalidGeneratedClipError(
        shot.shotId,
        resolved.assetId,
        `targetDurationSeconds ${durationSeconds} must be a positive finite number`,
      );
    }

    const outSeconds = inSeconds + durationSeconds;
    const fromFrame = Math.round(inSeconds * fps);
    const durationInFrames = Math.max(1, Math.round(durationSeconds * fps));

    const known = resolved.durationSeconds;
    const fullyCovered =
      known === undefined ? true : known + 1e-9 >= durationSeconds;

    clips.push({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      sequenceIndex: shot.sequenceIndex,
      assetId: resolved.assetId,
      sourceUrl: resolved.sourceUrl,
      ghlFileId: resolved.ghlFileId,
      checksum: resolved.checksum,
      provider: resolved.provider,
      providerModel: resolved.providerModel,
      inSeconds,
      outSeconds,
      fromFrame,
      durationInFrames,
      clipFps: resolved.fps ?? fps,
      sourceDurationSeconds: known,
      fullyCovered,
    });

    cursor = Math.max(cursor, outSeconds);
  }

  const durationSeconds = clips.reduce(
    (max, clip) => Math.max(max, clip.outSeconds),
    0,
  );
  const durationInFrames = Math.round(durationSeconds * fps);

  return { fps, shots, clips, durationSeconds, durationInFrames };
}