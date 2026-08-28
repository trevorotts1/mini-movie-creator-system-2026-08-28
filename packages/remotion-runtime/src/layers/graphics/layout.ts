/**
 * Graphics layout + timing math — pure functions (no React, no Remotion).
 * Every graphics item on the timeline resolves to a ResolvedGraphicsItem
 * carrying: resolved absolute frame range, safe-area bounds in canvas units,
 * rounded/guarded layout numbers, and a per-frame opacity/translate envelope
 * following the brand motion language (fade+rise in, fade+fall out).
 */

import { KIND_DEFAULTS, GRAPHICS_TIMING_DEFAULTS } from "./tokens.js";
import type { Anchor, FrameSize, GraphicsItemSpec, GraphicsTiming, SafeArea, ShotPlanRef } from "./types.js";

/** Reference canvas the font sizes are authored in (upstream shorts canvas). */
export const REFERENCE_WIDTH = 1080;

/** Default graphics hold length (frames) when nothing binds the end. */
export const DEFAULT_HOLD_FRAMES = 120;

/** Backstop for untrusted input: never let math emit NaN/Infinity/bigint. */
export function safeNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

/** Clamp helper. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scale 1080-authored font size to the actual canvas width. */
export function scaleToCanvas(fontSize: number, frame: Pick<FrameSize, "width">): number {
  return (fontSize * frame.width) / REFERENCE_WIDTH;
}

/**
 * Anchor-point blocks in canvas units. Blocks respect the safe area: nothing
 * critical goes in the bottom margin (YouTube UI) or side rails.
 */
export function anchorBlock(
  anchor: Anchor,
  frame: FrameSize,
  safe: SafeArea,
): { x: number; y: number; align: "left" | "center" | "right" } {
  const w = frame.width;
  const h = frame.height;
  switch (anchor) {
    case "top-center":
      return { x: w / 2, y: safe.top + 60, align: "center" };
    case "center":
      return { x: w / 2, y: h / 2, align: "center" };
    case "lower-third":
      // Above the bottom safe margin (safe.bottom measured from bottom edge).
      return { x: safe.left + 56, y: h - safe.bottom - 24, align: "left" };
    case "badge":
      return { x: w - safe.right - 32, y: safe.top + 8, align: "right" };
    case "watermark":
      return { x: w - safe.right - 16, y: h - safe.bottom - 16, align: "right" };
    case "bottom":
      return { x: w / 2, y: h - safe.bottom - 6, align: "center" };
    case "full":
      return { x: 0, y: 0, align: "left" };
  }
}

/** Resolve an item's absolute frame range from the plan or its own bounds. */
export interface ResolvedRange {
  frameFrom: number;
  frameTo: number;
  /** frames from true start before entry begins */
  inAt: number;
  /** frames from true start before exit begins */
  outAt: number;
}

/** Resolve absolute frame range + entry/exit anchor times for an item. */
export function resolveRange(
  spec: GraphicsItemSpec,
  shot: ShotPlanRef | undefined,
): ResolvedRange {
  const offset = safeNumber(spec.offsetIn, 0);
  let frameFrom: number;
  let shotEnd: number;
  if (shot) {
    frameFrom = shot.frameIn + offset;
    shotEnd = shot.frameOut;
  } else {
    frameFrom = safeNumber(spec.frameFrom, 0);
    shotEnd = safeNumber(spec.frameTo, frameFrom + DEFAULT_HOLD_FRAMES);
  }
  const timing = resolveTiming(spec.timing);
  // Entry begins at the item start; exit begins outDur frames before the end.
  return {
    frameFrom,
    frameTo: Math.max(frameFrom + 1, shotEnd),
    inAt: frameFrom,
    outAt: Math.max(frameFrom + timing.inDur + 1, shotEnd - timing.outDur),
  };
}

/** Full timing defaults with per-item overrides. */
export function resolveTiming(timing?: GraphicsTiming): Required<GraphicsTiming> {
  const d = GRAPHICS_TIMING_DEFAULTS;
  return {
    inDur: safeNumber(timing?.inDur, d.inDur),
    outDur: safeNumber(timing?.outDur, d.outDur),
    stagger: safeNumber(timing?.stagger, d.stagger),
    rise: safeNumber(timing?.rise, d.rise),
    fall: safeNumber(timing?.fall, d.fall),
  };
}

/** Kind configuration with per-item overrides, guarded. */
export function resolveKindConfig(spec: GraphicsItemSpec): {
  anchor: Anchor;
  color: string;
  zIndex: number;
  fontSize: number;
} {
  // KIND_DEFAULTS is a total Record over GraphicsKind, so the lookup always
  // hits; the ?? title fallback guards hand-cast bad kinds from callers.
  const kd = KIND_DEFAULTS[spec.kind] ?? KIND_DEFAULTS.title;
  return {
    anchor: (spec.anchor ?? kd.anchor) as Anchor,
    color: spec.accentColor ?? kd.color,
    zIndex: safeNumber(spec.zIndex, kd.zIndex),
    fontSize: safeNumber(spec.fontSize, kd.fontSize),
  };
}

/** Item z-order: exact zIndex falls back to the kind's default. */
export function composeZ(spec: GraphicsItemSpec): number {
  return resolveKindConfig(spec).zIndex;
}

/**
 * Per-frame opaque/translate envelope in frames. Returns opacity in [0,1],
 * translateY in px (positive = below rest), and a phase label:
 * - "hidden": before entry or after exit
 * - "entering": fade + rise (brand: ~7 frames, ease-out)
 * - "holding": fully composed
 * - "exiting": fade + fall (a touch faster than entry)
 * Linear ramps; the view layer applies the brand bezier per phase.
 */
export interface FrameEnvelope {
  opacity: number;
  translateY: number;
  phase: "hidden" | "entering" | "holding" | "exiting";
}

export function envelopeAt(
  frame: number,
  range: ResolvedRange,
  timing: Required<GraphicsTiming>,
): FrameEnvelope {
  if (frame >= range.outAt && frame < range.frameTo) {
    return exitEnvelope(frame, range, timing);
  }
  if (frame >= range.frameTo) {
    return { opacity: 0, translateY: timing.fall, phase: "hidden" };
  }
  if (frame < range.inAt) {
    return { opacity: 0, translateY: timing.rise, phase: "hidden" };
  }
  const elapsed = frame - range.inAt;
  if (elapsed < timing.inDur) {
    const p = progress(elapsed, 0, timing.inDur);
    return { opacity: easeOutCubic(p), translateY: (1 - easeOutCubic(p)) * timing.rise, phase: "entering" };
  }
  return { opacity: 1, translateY: 0, phase: "holding" };
}

/** Linear progress of t within [a, b], clamped to [0,1]. */
export function progress(t: number, a: number, b: number): number {
  if (b <= a) return 1;
  return clamp((t - a) / (b - a), 0, 1);
}

/** Ease-out cubic — calm brand entry (no overshoot). */
export function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

/** Ease-in cubic — exit tail. */
export function easeInCubic(p: number): number {
  return p * p * p;
}

/** Exit tail with ease-in (fade + fall). */
export function exitEnvelope(frame: number, range: ResolvedRange, timing: Required<GraphicsTiming>): FrameEnvelope {
  if (frame < range.outAt) return { opacity: 1, translateY: 0, phase: "holding" };
  const p = progress(frame, range.outAt, range.frameTo);
  return { opacity: 1 - easeInCubic(p), translateY: timing.fall * easeInCubic(p), phase: "exiting" };
}

/** Text lines from an item spec (untrusted strings carried verbatim). */
export function linesOf(spec: GraphicsItemSpec): string[] {
  const text = spec.text;
  if (text === undefined || text === null) return [];
  return Array.isArray(text) ? text.filter((l) => typeof l === "string") : [String(text)];
}

/**
 * Guarded line-transform for the per-line stagger: line i starts i*stagger
 * frames after the item. Returns per-line envelope; empty for no text.
 */
export function lineEnvelopes(
  frame: number,
  range: ResolvedRange,
  timing: Required<GraphicsTiming>,
  count: number,
): FrameEnvelope[] {
  const out: FrameEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    const shift = i * timing.stagger;
    const shiftedRange: ResolvedRange = {
      ...range,
      inAt: range.inAt + shift,
      // keep exit aligned to the item end
      outAt: range.outAt,
    };
    out.push(envelopeAt(frame, shiftedRange, timing));
  }
  return out;
}

/** Fully-resolved graphics item — what the views render. */
export interface ResolvedGraphicsItem {
  spec: GraphicsItemSpec;
  shot: ShotPlanRef | undefined;
  range: ResolvedRange;
  timing: Required<GraphicsTiming>;
  anchor: Anchor;
  color: string;
  zIndex: number;
  fontSizeScaled: number;
  lines: string[];
}

/**
 * Bind a list of GraphicsItemSpec to the shot plan and resolve everything the
 * views need. Shot plan lookup is by shotId; items whose shotId names an
 * unknown shot resolve standalone (frameFrom/frameTo) — the validator flags
 * them instead of throwing.
 */
export function resolveItems(
  specs: readonly GraphicsItemSpec[],
  shots: readonly ShotPlanRef[],
  frame: FrameSize,
): ResolvedGraphicsItem[] {
  const byId = new Map(shots.map((s) => [s.shotId, s]));
  return specs.map((spec) => {
    const shot = spec.shotId ? byId.get(spec.shotId) : undefined;
    const range = resolveRange(spec, shot);
    const timing = resolveTiming(spec.timing);
    const cfg = resolveKindConfig(spec);
    const lines = linesOf(spec);
    return {
      spec,
      shot,
      range,
      timing,
      anchor: cfg.anchor,
      color: cfg.color,
      zIndex: cfg.zIndex,
      fontSizeScaled: scaleToCanvas(cfg.fontSize, frame),
      lines,
    };
  });
}

/** Frame bounds for the whole graphics set — for rough cut overlays. */
export function graphicsBounds(items: readonly ResolvedGraphicsItem[]): { from: number; to: number } {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    from = Math.min(from, it.range.frameFrom);
    to = Math.max(to, it.range.frameTo);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { from: 0, to: 0 };
  return { from, to };
}
