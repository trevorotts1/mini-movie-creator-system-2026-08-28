/**
 * Credit-roll layout — deterministic scroll math for end credits.
 * Pure functions: the view layer translates rows by the returned offsets.
 */

import { clamp } from "./layout.js";
import type { FrameSize } from "./types.js";

/** One credit row: a role + one or more names. */
export interface CreditRow {
  role: string;
  names: string[];
}

/** Credits block spec. */
export interface CreditsSpec {
  /** episode title shown above the credits */
  title?: string;
  rows: CreditRow[];
  /** total credit scroll duration in frames (default 300 = 10s @30fps) */
  durationFrames?: number;
}

/** Layout output for the credit roll at one frame. */
export interface CreditsLayout {
  /** vertical offset in px applied to the rows container at this frame */
  scrollY: number;
  /** total content height in px */
  contentHeight: number;
  /** index of the first visible row (>= 0, clamped) */
  firstVisible: number;
  /** rows fully scrolled past — count only, for progress checks */
  visibleCount: number;
  /** 0..1 completion of the scroll */
  progress: number;
  /** true when the roll has fully finished (progress >= 1) */
  finished: boolean;
}

/** Row layout constants, 1080-wide canvas units (scaled like fonts). */
export const CREDITS_ROW = {
  height: 120,
  gap: 24,
  titleBlock: 200,
  bottomPad: 240,
} as const;

/**
 * Content height: title block + rows + bottom pad, all in canvas px.
 * Guarded: non-finite row height math collapses to title-only.
 */
export function creditsContentHeight(rows: readonly CreditRow[], frame: Pick<FrameSize, "width">): number {
  // Guarded scale: a degenerate width (0/NaN) would poison every downstream
  // pixel number (contentHeight -> travel -> scrollY) with NaN.
  const rawScale = frame.width / 1080;
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const rowsH = rows.length * (CREDITS_ROW.height + CREDITS_ROW.gap);
  const total = CREDITS_ROW.titleBlock + rowsH + CREDITS_ROW.bottomPad;
  if (!Number.isFinite(total) || total <= 0) return Math.round(CREDITS_ROW.titleBlock * scale);
  return Math.round(total * scale);
}

/** Local spec extension: scroll starts this many frames after frame 0. */
export interface CreditsTimeline extends CreditsSpec {
  /** absolute episode-timeline frame the roll begins (default 0) */
  startFrame?: number;
}

/**
 * Deterministic credit scroll at a given absolute frame.
 * - rows container starts fully below the viewport and ends fully above it;
 * - translateY goes from +viewport (all rows below) to -contentHeight (all
 *   rows above): credits scroll upward, standard movie convention;
 * - linear scroll on purpose: easing on a credit roll reads as a hiccup.
 * Deterministic: same inputs, same offset.
 */
export function creditsScrollAt(
  frame: number,
  spec: CreditsTimeline,
  frameSize: FrameSize,
): CreditsLayout {
  const dur = Math.max(1, Math.round(spec.durationFrames ?? 300));
  const start = Math.max(0, Math.round(spec.startFrame ?? 0));
  // Guarded viewport: height is a raw consumer value — degenerate (0/NaN)
  // collapses to the 1080-canvas reference height rather than poisoning
  // travel/scrollY with NaN.
  const rawViewport = frameSize.height;
  const viewport = Number.isFinite(rawViewport) && rawViewport > 0 ? rawViewport : 1920;
  const contentH = creditsContentHeight(spec.rows, frameSize);
  const travel = contentH + viewport; // total px traveled upward
  const p = clamp((frame - start) / dur, 0, 1);
  const scrollY = Math.round(viewport - travel * p);

  // First row fully above the viewport top: walk the title block, then rows.
  // Guarded: a degenerate width (0/NaN) collapses the scale to 1 instead of
  // propagating NaN through the division into firstVisible.
  const rawScale = frameSize.width / 1080;
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const rowPitch = (CREDITS_ROW.height + CREDITS_ROW.gap) * scale;
  const rawFirst = Math.floor((-scrollY - CREDITS_ROW.titleBlock * scale) / rowPitch);
  const firstVisible = clamp(
    Number.isFinite(rawFirst) ? rawFirst : 0,
    0,
    spec.rows.length,
  );

  return {
    scrollY,
    contentHeight: contentH,
    firstVisible,
    visibleCount: Math.max(0, spec.rows.length - firstVisible),
    progress: p,
    finished: p >= 1,
  };
}