import { AspectPlanError, Canvas } from "./types.js";

/**
 * Letterbox/crop policy for source assets that do not match the episode canvas
 * (spec §23: "Both 16:9 and 9:16 rough cuts must render" — the same source must
 * place safely into either canvas without stretching).
 *
 * - `letterbox` (contain): scale to fit INSIDE the canvas, center it, pad the
 *   leftover axis with bars. Preserves the whole source frame. Orientation
 *   mismatches (landscape source on a 9:16 canvas) letterbox; a landscape source
 *   on its own axis (4:3 on 16:9) pillarboxes. Never stretches.
 * - `crop` (cover): scale to FILL the canvas and center-crop the overflow.
 *   Fills every pixel; loses edges. Default-off because it discards content.
 */

export type FitMode = "letterbox" | "crop";

/** Placement of one source rect inside the episode canvas, render-ready. */
export interface FitTransform {
  mode: FitMode;
  /** Uniform scale factor applied to the source (in canvas px per source px). */
  scale: number;
  /** Top-left of the scaled source inside the canvas, px (may be negative in crop mode). */
  x: number;
  /** Top-left y of the scaled source inside the canvas, px. */
  y: number;
  /** Scaled source size: scale * source dims. In crop mode this exceeds the canvas. */
  width: number;
  /** Scaled source height. */
  height: number;
  /** Letterbox bars: pad on each axis, 0 when the source fills that axis. */
  padding: { top: number; right: number; bottom: number; left: number };
  /** Letterbox alias: true when any padding is non-zero. */
  hasBars: boolean;
}

/**
 * Compute the placement for one source asset on the episode canvas.
 * Names the mismatch (no bars + no crop + identical ratio) so callers can
 * fast-path assets that already match.
 */
export function fitSourceToCanvas(
  source: { width: number; height: number },
  canvas: Canvas,
  mode: FitMode = "letterbox",
): FitTransform {
  if (
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    throw new AspectPlanError(
      `invalid source dimensions ${source.width}x${source.height}: must be positive`,
    );
  }
  if (mode !== "letterbox" && mode !== "crop") {
    throw new AspectPlanError(`invalid fit mode "${mode}": expected "letterbox" or "crop"`);
  }

  const scaleX = canvas.width / source.width;
  const scaleY = canvas.height / source.height;
  const scale = mode === "letterbox" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const x = Math.round((canvas.width - width) / 2);
  const y = Math.round((canvas.height - height) / 2);

  const padding = {
    top: Math.max(0, y),
    right: Math.max(0, canvas.width - (x + width)),
    bottom: Math.max(0, canvas.height - (y + height)),
    left: Math.max(0, x),
  };

  return {
    mode,
    scale,
    x,
    y,
    width,
    height,
    padding,
    hasBars: padding.top > 0 || padding.right > 0 || padding.bottom > 0 || padding.left > 0,
  };
}

/** True when the source already matches the canvas ratio (no bars, no crop). */
export function sourceMatchesCanvas(
  source: { width: number; height: number },
  canvas: Canvas,
  tolerance = 0.01,
): boolean {
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
    return false;
  }
  const sourceRatio = source.width / source.height;
  const canvasRatio = canvas.width / canvas.height;
  return Math.abs(sourceRatio - canvasRatio) / canvasRatio <= tolerance;
}
