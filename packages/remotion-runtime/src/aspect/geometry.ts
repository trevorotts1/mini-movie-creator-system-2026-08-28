import { AspectRatio, Canvas, SafeAreaRect, ResolutionTier, RESOLUTION_TIERS } from "./types.js";

/** Renderer ceiling (Remotion max frame dimension). */
export const MAX_CANVAS_EDGE = 16384;

/**
 * Resolution math (spec §32: resolution/safe-area tested).
 *
 * Tier = short edge in pixels. `shortEdge` → 1080p gives 1920x1080 for 16:9 and
 * 1080x1920 for 9:16. Long edge rounds to the nearest even number (avoid odd
 * dimensions in H.264 encoder profiles, keep the rendered frame even-sized).
 *
 * Letterbox ratios (wider than 16:9 or taller than 9:16) do not stretch the short
 * edge: they are letterboxed/center-cropped by the composition layers instead.
 */
export function canvasFor(aspect: AspectRatio, tier: ResolutionTier): Canvas {
  const short = RESOLUTION_TIERS[tier];
  if (!Number.isFinite(short) || short <= 0) {
    throw new Error(`unknown resolution tier "${tier}"`);
  }
  let long =
    aspect.ratio >= 1
      ? short * aspect.ratio
      : short * (1 / aspect.ratio);
  long = Math.round(long / 2) * 2;
  if (long < 2 || long > MAX_CANVAS_EDGE) {
    throw new Error(
      `aspect ratio "${aspect.id}" at tier "${tier}" yields invalid long edge ${long}px (must be within [2, ${MAX_CANVAS_EDGE}])`,
    );
  }
  const width = aspect.ratio >= 1 ? long : short;
  const height = aspect.ratio >= 1 ? short : long;
  return { width, height, aspectRatioId: aspect.id };
}

/**
 * Content safe area: a centered rect with the given fractional inset (0..1) on all
 * sides. Defensive margins keep titles/graphics off edges and out of platform
 * overlays (e.g. 9:16 Reels UI), mirroring the upstream kit's safe-area discipline.
 */
export function safeAreaFor(
  canvas: Canvas,
  options: { fraction?: number } = {},
): SafeAreaRect {
  const fraction = options.fraction ?? 0.1;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 0.5) {
    throw new Error(`safe-area fraction must be in [0, 0.5), got ${fraction}`);
  }
  const insetW = Math.round(canvas.width * fraction);
  const insetH = Math.round(canvas.height * fraction);
  const x = insetW;
  const y = insetH;
  return {
    x,
    y,
    width: Math.max(1, canvas.width - insetW * 2),
    height: Math.max(1, canvas.height - insetH * 2),
    insets: {
      top: insetH,
      right: insetW,
      bottom: insetH,
      left: insetW,
    },
  };
}

/**
 * Bottom-aligned caption/dialogue zone inside the safe area: last 25% of the safe
 * rect height, bottom-aligned, full safe width. 9:16 keeps the same fraction so
 * captions never collide with platform UI (which lives in the top/bottom insets).
 */
export function captionZoneFor(canvas: Canvas, fraction: { safe?: number; zone?: number } = {}): SafeAreaRect {
  const safeForward = fraction.safe ?? 0.1;
  const zoneBack = fraction.zone ?? 0.25;
  if (!Number.isFinite(zoneBack) || zoneBack <= 0 || zoneBack > 1) {
    throw new Error(`caption zone fraction must be in (0, 1], got ${zoneBack}`);
  }
  const safe = safeAreaFor(canvas, { fraction: safeForward });
  const zoneHeight = Math.max(1, Math.round(safe.height * zoneBack));
  const y = safe.y + safe.height - zoneHeight;
  return {
    x: safe.x,
    y,
    width: safe.width,
    height: zoneHeight,
    insets: {
      top: y,
      right: canvas.width - (safe.x + safe.width),
      bottom: canvas.height - (y + zoneHeight),
      left: safe.x,
    },
  };
}

/** True when every pixel dimension is finite integers within renderer limits. */
export function isValidCanvas(canvas: Canvas): boolean {
  return (
    Number.isInteger(canvas.width) &&
    Number.isInteger(canvas.height) &&
    canvas.width > 0 &&
    canvas.height > 0 &&
    canvas.width <= MAX_CANVAS_EDGE &&
    canvas.height <= MAX_CANVAS_EDGE
  );
}
