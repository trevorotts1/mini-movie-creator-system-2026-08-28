/**
 * Graphics composition — turns a shot plan + graphics items into the ordered
 * per-shot graphics stack that the episodic composition mounts under the
 * footage layer. Pure data; the view components consume this unchanged.
 *
 * Composition rules (spec §21/§22, native graphics visual source type):
 * - per-shot items bound via shotId ride that shot's frame window;
 * - absolute items (frameFrom/frameTo) span the episode timeline;
 * - z-order: overlays(40) > lowerThirds(30) > progressBar(25) > titles(20) >
 *   subtitles(15) > kickers(10); credits(50) and logos(60) always on top;
 * - no two items of the same anchor+kind overlap on the timeline (warning —
 *   the later item wins render order; this is a data bug upstream).
 */

import { graphicsBounds, resolveItems, safeNumber, type ResolvedGraphicsItem } from "./layout.js";
import type { FrameSize, GraphicsItemSpec, SafeArea, ShotPlanRef } from "./types.js";

/** Default 1080x1920@30 canvas (upstream shorts geometry). */
export const DEFAULT_FRAME: FrameSize = { width: 1080, height: 1920, fps: 30 };

/** Default safe area (brand.md §6): 150 top / 500 bottom / 160 right / 60 left. */
export const DEFAULT_SAFE_AREA: SafeArea = { top: 150, right: 160, bottom: 500, left: 60 };

/** Composition input. */
export interface GraphicsPlanInput {
  shots?: readonly ShotPlanRef[];
  items: readonly GraphicsItemSpec[];
  frame?: FrameSize;
  safeArea?: SafeArea;
}

/** Composition output — ordered stack + diagnostics. */
export interface GraphicsStack {
  /** items sorted by zIndex (ascending), then by resolved start frame */
  items: ResolvedGraphicsItem[];
  /** whole-set frame bounds (from <= to; {0,0} when empty) */
  bounds: { from: number; to: number };
  /** non-fatal data problems: unknown shotId bindings, timeline overlaps */
  warnings: string[];
}

/** Find shots whose ranges overlap on the same anchor+kind pair. */
function findOverlaps(
  items: readonly ResolvedGraphicsItem[],
): string[] {
  const warnings: string[] = [];
  const buckets = new Map<string, ResolvedGraphicsItem[]>();
  for (const it of items) {
    const key = `${it.spec.kind}@${it.anchor}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(it);
    buckets.set(key, bucket);
  }
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => a.range.frameFrom - b.range.frameFrom);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue; // unreachable under the loop bounds
      if (cur.range.frameFrom < prev.range.frameTo) {
        warnings.push(
          `overlap: ${cur.spec.id} starts at ${cur.range.frameFrom} before ${prev.spec.id} ends at ${prev.range.frameTo} (${key})`,
        );
      }
    }
  }
  return warnings;
}

/** Unknown-shot bindings (item names a shot the plan does not have). */
function findUnknownShots(
  specs: readonly GraphicsItemSpec[],
  shots: readonly ShotPlanRef[],
): string[] {
  const ids = new Set(shots.map((s) => s.shotId));
  const warnings: string[] = [];
  for (const spec of specs) {
    if (spec.shotId && !ids.has(spec.shotId)) {
      warnings.push(`unknown shotId "${spec.shotId}" on item ${spec.id} — item resolves standalone`);
    }
  }
  return warnings;
}

/**
 * Compose the graphics stack for an episode (or a scene — same inputs, a
 * filtered plan). Pure: no DOM, no Remotion imports.
 */
export function composeGraphics(input: GraphicsPlanInput): GraphicsStack {
  const frame: FrameSize = input.frame ?? DEFAULT_FRAME;
  const shots = input.shots ?? [];
  const warnings: string[] = [];

  // Guard the frame: non-positive fps/size collapses to the default canvas.
  const safeFrame: FrameSize = {
    width: safeNumber(frame.width, DEFAULT_FRAME.width) <= 0 ? DEFAULT_FRAME.width : frame.width,
    height: safeNumber(frame.height, DEFAULT_FRAME.height) <= 0 ? DEFAULT_FRAME.height : frame.height,
    fps: safeNumber(frame.fps, DEFAULT_FRAME.fps) <= 0 ? DEFAULT_FRAME.fps : frame.fps,
  };

  warnings.push(...findUnknownShots(input.items, shots));
  const items = resolveItems(input.items, shots, safeFrame);
  warnings.push(...findOverlaps(items));
  items.sort((a, b) => a.zIndex - b.zIndex || a.range.frameFrom - b.range.frameFrom);

  return { items, bounds: graphicsBounds(items), warnings };
}

/**
 * Per-shot slice: the graphics items visible during a given shot's window
 * (items bound to that shot, plus absolute items overlapping its range).
 * Rough cut (VID-012) mounts this under each shot composition.
 */
export function graphicsForShot(
  stack: GraphicsStack,
  shot: ShotPlanRef,
): ResolvedGraphicsItem[] {
  return stack.items.filter((it) => {
    if (it.spec.shotId) return it.spec.shotId === shot.shotId;
    return it.range.frameFrom < shot.frameOut && it.range.frameTo > shot.frameIn;
  });
}

/**
 * Episode-level group: items visible at a given absolute frame, ordered
 * bottom-to-top (zIndex ascending). Deterministic tie-break by item id.
 */
export function graphicsAtFrame(
  stack: GraphicsStack,
  frame: number,
): ResolvedGraphicsItem[] {
  return stack.items
    .filter((it) => frame >= it.range.frameFrom && frame < it.range.frameTo)
    .sort((a, b) => a.zIndex - b.zIndex || a.spec.id.localeCompare(b.spec.id));
}