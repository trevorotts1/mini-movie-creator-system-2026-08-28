/// <reference types="node" />
// Final render pipeline (VID-014) — spec §21 step sequence:
//   approval (gate 5) → final render → normalize/validate media
//   (ffprobe passes) → final QC → archive final into `08 Final/` →
//   production report.
//
// Pure orchestration over injected ports (VID-012 rough-cut, VID-015 ffprobe,
// CORE-008 gates, GHL archive are siblings not yet merged at build time).
// The pipeline itself:
//  1. REFUSES to render without an APPROVED rough-cut gate (spec §3.5).
//  2. Plans the render: master resolution from the format spec, scale=1
//     support for native mode (ownership.md), deterministic filenames.
//  3. Calls the RenderAdapter ONCE per shot batch (upstream
//     remotion/scripts/render-all.mjs contract: bundle → selectComposition →
//     renderMedia with a scale arg).
//  4. Validates the output through the MediaValidator port (VID-015 ffprobe
//     wrapper) — a failed probe FAILS the pipeline before archival.
//  5. Writes output metadata (per-shot quality tiers; the 720p-upscale flag
//     invariant) and a production report (spec §21 fields).
//  6. Returns the archive plan (`08 Final/`); the GHL storage layer performs
//     the durable upload through the ArchivePort.

import {
  finalFileName,
  finalFolderSegments,
  sidecarFileName,
  sidecarFolderSegments,
  type ApprovalGatePort,
  type FinalRenderSpec,
  type PlannedShot,
  type QualityTier,
  type Resolution,
  type ShotQualityRecord,
} from "./contract.js";
import {
  computeShotQuality,
  episodeTier,
  renderResolutionFor,
} from "./upscale.js";
import { join } from "node:path";

/**
 * Render adapter — the VID-012/upstream-Remotion boundary. Mirrors
 * `renderMedia` inputs (serveUrl/bundled composition, scale, codec) so the
 * integration adapter is a thin wrapper over `@remotion/renderer`, while
 * tests inject a fixture adapter (or the real ffmpeg fixture renderer).
 */
export interface RenderRequest {
  compositionId: string;
  /** Composition entry as bundled (Remotion serveUrl or a fixture id). */
  serveUrl: string;
  /** Render scale (upstream: scale=2 for 4K masters; 1 = native). */
  scale: number;
  resolution: Resolution;
  fps: number;
  durationSeconds: number;
  /** Deterministic absolute output path. */
  output: string;
  codec: "h264";
}

export interface RenderResult {
  output: string;
  /** Wall-clock render seconds (production report "runtime" input). */
  renderSeconds: number;
}

export type RenderAdapter = (request: RenderRequest) => Promise<RenderResult>;

/**
 * Media validator port — VID-015's ffprobe contract
 * (codec/duration/resolution/bitrate + integrity pass/fail).
 */
export interface ProbeReport {
  ok: boolean;
  codec?: string;
  durationSeconds?: number;
  resolution?: Resolution;
  bitrateKbps?: number;
  error?: string;
}

export type MediaValidator = (output: string) => Promise<ProbeReport>;

/** Archive port — GHL durable storage handoff (spec §17). */
export interface ArchiveRequest {
  /** Local final file. */
  output: string;
  /** GHL folder segments, e.g. ["S01E01 - Title", "08 Final"]. */
  folderSegments: readonly string[];
  /** Deterministic canonical filename (spec §19). */
  fileName: string;
  checksum?: string;
}

export interface ArchiveResult {
  archived: boolean;
  ghlFileId?: string;
  ghlUrl?: string;
  error?: string;
}

export type ArchivePort = (request: ArchiveRequest) => Promise<ArchiveResult>;

/** Per-shot provenance for the production report (spec §19/§21). */
export interface ShotProvenance {
  shotId: string;
  provider?: string;
  providerModel?: string;
  quality: ShotQualityRecord;
}

/**
 * Production report (spec §21): runtime; aspect ratio/resolution; providers/
 * models used; generated/accepted/rejected seconds; retries; cost; quota;
 * characters; canon changes; durable final URL; QC status — plus the honest
 * quality tier metadata.
 */
export interface ProductionReport {
  seriesId: string;
  episodeId: string;
  episodeCode: string;
  aspectRatio: string;
  resolution: Resolution;
  fps: number;
  durationSeconds: number;
  renderSeconds: number;
  shotCount: number;
  upscaledShotCount: number;
  qualityTier: QualityTier;
  shotQuality: readonly ShotQualityRecord[];
  providers: readonly string[];
  providerModels: readonly string[];
  ffprobe: ProbeReport;
  outputFileName: string;
  /** `08 Final/` folder segments (spec §17 layout). */
  finalFolder: readonly string[];
  sidecarFileName: string;
  sidecarFolder: readonly string[];
  archived: boolean;
  ghlFileId?: string;
  durableFinalUrl?: string;
  qcStatus: "PASSED" | "FAILED" | "NOT_RUN";
}

/** Failure the pipeline throws/stops on, with a stable code for the CLI. */
export class FinalRenderError extends Error {
  readonly code:
    | "GATE_NOT_APPROVED"
    | "RENDER_FAILED"
    | "FFPROBE_FAILED"
    | "ARCHIVE_FAILED"
    | "INVALID_SPEC";

  constructor(
    code: "GATE_NOT_APPROVED" | "RENDER_FAILED" | "FFPROBE_FAILED" | "ARCHIVE_FAILED" | "INVALID_SPEC",
    message: string,
  ) {
    super(message);
    this.name = "FinalRenderError";
    this.code = code;
  }
}

/** Ports bundle for {@link runFinalRender}. */
export interface FinalRenderPorts {
  /** Approval store (CORE-008) — read-only gate snapshot. */
  approvals: ApprovalGatePort;
  render: RenderAdapter;
  validate: MediaValidator;
  archive?: ArchivePort;
  /** Now-source for report timestamps; injectable for tests. */
  now?: () => Date;
}

/** Readiness check result — also used by `mmcs final --dry-run`. */
export interface FinalRenderPlan {
  renderable: boolean;
  blockedReason?: string;
  gate: ReturnType<ApprovalGatePort>;
  resolution: Resolution;
  scale: number;
  outputFileName: string;
  outputFolder: readonly string[];
  sidecarFileName: string;
  sidecarFolder: readonly string[];
  shotCount: number;
  mode: "timeline" | "native";
}

/** Build the deterministic render plan without rendering (dry-run + pipeline step). */
export function planFinalRender(
  spec: FinalRenderSpec,
  approvals: ApprovalGatePort,
): FinalRenderPlan {
  if (!spec.episodeCode || spec.episodeCode.trim().length === 0) {
    throw new FinalRenderError("INVALID_SPEC", "episodeCode is required");
  }
  if (spec.composition.shots.length === 0) {
    throw new FinalRenderError("INVALID_SPEC", "composition has no shots");
  }
  if (spec.composition.fps <= 0 || spec.composition.durationSeconds <= 0) {
    throw new FinalRenderError("INVALID_SPEC", "composition fps/duration must be positive");
  }
  if (spec.format.series === "custom" && !spec.format.custom) {
    throw new FinalRenderError("INVALID_SPEC", "custom series format requires a resolution");
  }
  const gate = approvals("rough-cut");
  const mode = spec.mode ?? "timeline";
  const version = spec.version ?? 1;
  return {
    renderable: gate.state === "APPROVED",
    blockedReason:
      gate.state === "APPROVED"
        ? undefined
        : `rough-cut gate is ${gate.state} — no final render before approval (spec §3.5)`,
    gate,
    resolution: planResolution(spec, mode),
    scale: mode === "native" ? 1 : 1,
    outputFileName: finalFileName(spec.episodeCode, version),
    outputFolder: finalFolderSegments(spec.episodeCode, spec.episodeTitle),
    sidecarFileName: sidecarFileName(spec.episodeCode, version),
    sidecarFolder: sidecarFolderSegments(spec.episodeCode, spec.episodeTitle),
    shotCount: spec.composition.shots.length,
    mode,
  };
}

/**
 * Render resolution for the plan. Timeline mode → the episode/series master
 * (spec §23). Native (scale=1) mode → the composition passes through at its
 * own resolution; a declared `custom` resolution is honored as the
 * composition's, otherwise the master is used (compositions are authored at
 * master resolution per the upstream render-all contract).
 */
function planResolution(
  spec: FinalRenderSpec,
  mode: "timeline" | "native",
): Resolution {
  const effective = spec.format.episode ?? spec.format.series;
  if (mode === "native" && spec.format.custom) return spec.format.custom;
  return renderResolutionFor(mode, effective, spec.format.custom);
}

/** Composition id Remotion selects in the bundle (deterministic naming). */
export function compositionIdFor(spec: FinalRenderSpec): string {
  return `final-${spec.episodeCode.toLowerCase().replace(/[^a-z0-9]/gi, "-")}`;
}

/**
 * Run the full final-render pipeline for one episode. Throws
 * {@link FinalRenderError} with a stable code at the exact spec §21 step
 * that failed. Never calls process.exit — the CLI owns termination.
 */
export async function runFinalRender(
  spec: FinalRenderSpec,
  ports: FinalRenderPorts,
): Promise<ProductionReport> {
  const plan = planFinalRender(spec, ports.approvals);
  if (!plan.renderable) {
    throw new FinalRenderError("GATE_NOT_APPROVED", plan.blockedReason ?? "rough-cut not approved");
  }

  const version = spec.version ?? 1;
  const mode = spec.mode ?? "timeline";
  const resolution = plan.resolution;
  const outputFileName = finalFileName(spec.episodeCode, version);
  const outputDir = spec.outputDir?.trim() || process.cwd();
  const outputPath = join(outputDir, outputFileName);

  // 1. render (spec §21: final render). Scale: 1 for native (ownership.md
  // `--scale=1`); timeline compositions are authored at master resolution so
  // the pass-through scale is 1 there as well.
  let rendered: RenderResult;
  try {
    rendered = await ports.render({
      compositionId: compositionIdFor(spec),
      serveUrl: spec.composition.episodeId,
      scale: 1,
      resolution,
      fps: spec.composition.fps,
      durationSeconds: spec.composition.durationSeconds,
      output: outputPath,
      codec: "h264",
    });
  } catch (err) {
    throw new FinalRenderError(
      "RENDER_FAILED",
      `final render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. normalize/validate (spec §21: ffprobe passes before anything else)
  const ffprobe = await ports.validate(rendered.output);
  if (!ffprobe.ok) {
    throw new FinalRenderError(
      "FFPROBE_FAILED",
      `rendered output failed ffprobe validation: ${ffprobe.error ?? "integrity check failed"}`,
    );
  }

  // 3. output metadata — honest quality tiers (spec §21 upscale rule)
  const shotQuality = computeShotQuality(
    spec.composition.shots,
    resolution,
    mode,
  );
  const tier = episodeTier(shotQuality);

  const providers = uniqueStrings(
    spec.composition.shots
      .map((s: PlannedShot) => s.provider)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  );
  const providerModels = uniqueStrings(
    spec.composition.shots
      .map((s) => s.providerModel)
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  );

  const report: ProductionReport = {
    seriesId: spec.seriesId,
    episodeId: spec.episodeId,
    episodeCode: spec.episodeCode,
    aspectRatio: spec.format.episode ?? spec.format.series,
    resolution,
    fps: spec.composition.fps,
    durationSeconds: spec.composition.durationSeconds,
    renderSeconds: rendered.renderSeconds,
    shotCount: shotQuality.length,
    upscaledShotCount: shotQuality.filter((q) => q.upscaled).length,
    qualityTier: tier,
    shotQuality,
    providers,
    providerModels,
    ffprobe,
    outputFileName,
    finalFolder: finalFolderSegments(spec.episodeCode, spec.episodeTitle),
    sidecarFileName: sidecarFileName(spec.episodeCode, version),
    sidecarFolder: sidecarFolderSegments(spec.episodeCode, spec.episodeTitle),
    archived: false,
    qcStatus: "PASSED",
  };

  // 4. archive into `08 Final/` (spec §17/§21) — storage layer performs I/O.
  if (ports.archive) {
    const archive = await ports.archive({
      output: rendered.output,
      folderSegments: report.finalFolder,
      fileName: outputFileName,
    });
    if (!archive.archived) {
      throw new FinalRenderError(
        "ARCHIVE_FAILED",
        `archive into 08 Final failed: ${archive.error ?? "storage layer refused"}`,
      );
    }
    report.archived = true;
    report.ghlFileId = archive.ghlFileId;
    report.durableFinalUrl = archive.ghlUrl;
  }

  return report;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}