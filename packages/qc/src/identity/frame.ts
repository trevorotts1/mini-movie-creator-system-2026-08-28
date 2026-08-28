/**
 * Frame extraction seam for identity QC — QC-002.
 *
 * Spec §20: video-capable multimodal models review video directly; otherwise
 * FFmpeg extracts representative frames for image-vision QC. QC-005 (route)
 * decides direct-vs-frames; VID-016 owns the actual FFmpeg extraction. This
 * module is the QC-side contract for consuming its output: it validates that
 * a frame extraction result is well-formed before it is compared against a
 * canonical identity asset, and derives the image reference the vision
 * adapter receives.
 *
 * Pure — performs no FFmpeg I/O. The extraction itself is injected.
 */

import type { AssetDimensions } from "@mmcs/character-library/identity-asset/types";
import type { ExtractedFrame, VisionImage } from "./identity";

/** Minimal FFmpeg frame-extraction result as VID-016 produces it. */
export interface FrameExtraction {
  /** Provider-resolvable frame reference (path/URL/data URI). */
  source: string;
  /** Frame MIME type (e.g. "image/png", "image/jpeg"). */
  mimeType: string;
  /** Frame position in the source clip, seconds (>= 0). */
  timestampSeconds: number;
  /** Pixel dimensions of the extracted frame. */
  dimensions: AssetDimensions;
}

/** Checkpoint manifest, shot identity, extraction result → frame under test. */
export interface FrameExtractionInput {
  /** Spec §12 shot_id the frame was extracted from. */
  shotId: string;
  /** The extraction result (from VID-016's FFmpeg pass). */
  extraction: FrameExtraction;
}

/**
 * Validate an extraction result and lift it into the QC `ExtractedFrame`
 * the identity comparison consumes. Throws on every malformed field —
 * a bad extraction must fail loudly, never degrade into a QC pass.
 */
export function toExtractedFrame(input: FrameExtractionInput): ExtractedFrame {
  if (typeof input.shotId !== "string" || input.shotId.length === 0) {
    throw new Error("shotId must be a non-empty string");
  }
  const extraction = input.extraction;
  if (typeof extraction.source !== "string" || extraction.source.length === 0) {
    throw new Error("extraction.source must be a non-empty frame reference");
  }
  if (typeof extraction.mimeType !== "string" || !extraction.mimeType.startsWith("image/")) {
    throw new Error(
      `extraction.mimeType must be an image/* MIME type, got: ${String(extraction.mimeType)}`,
    );
  }
  if (
    typeof extraction.timestampSeconds !== "number" ||
    !Number.isFinite(extraction.timestampSeconds) ||
    extraction.timestampSeconds < 0
  ) {
    throw new Error(
      `extraction.timestampSeconds must be a non-negative finite number, got: ${String(extraction.timestampSeconds)}`,
    );
  }
  const { dimensions } = extraction;
  if (
    !dimensions ||
    !Number.isInteger(dimensions.width) || dimensions.width <= 0 ||
    !Number.isInteger(dimensions.height) || dimensions.height <= 0
  ) {
    throw new Error(
      `extraction.dimensions must be positive integer pixel dimensions, got: ${JSON.stringify(dimensions)}`,
    );
  }
  const image: VisionImage = {
    source: extraction.source,
    mimeType: extraction.mimeType,
    data: extraction.source,
  };
  return {
    image,
    shotId: input.shotId,
    timestampSeconds: extraction.timestampSeconds,
    dimensions: { ...dimensions },
  };
}