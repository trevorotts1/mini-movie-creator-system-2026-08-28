/**
 * Graphics layer types — native Remotion graphics composable per shot plan.
 *
 * The engine never binds creative intent to one provider (spec §12); a shot
 * plan is a list of ShotPlanRef entries (the spec §12 ShotSpecificationRecord
 * subset the graphics layer needs) plus a list of GraphicsItemSpec entries
 * describing which titles / overlays / credits / lower thirds appear when.
 *
 * Story/script text is UNTRUSTED DATA (spec §29): it is carried here as plain
 * strings only and must always be rendered as React text children — never
 * interpreted, never injected as markup, never executed.
 */

/** All native graphics items the layer can place on a shot. */
export type GraphicsKind =
  | "title"
  | "kicker"
  | "subtitle"
  | "lowerThird"
  | "overlay"
  | "credit"
  | "logo"
  | "progressBar";

/** Canvas geometry. Frame counts are absolute episode-timeline frames. */
export interface FrameSize {
  width: number;
  height: number;
  fps: number;
}

/**
 * Where an item sits on the canvas, resolved against the safe area:
 * - "top-center": hook headline area (titles/kickers)
 * - "center":       mid-frame card/panel (overlays)
 * - "lower-third":  name card above the bottom safe margin
 * - "badge":        top-right corner (small callout)
 * - "watermark":    bottom-right corner (logo, always-worn branding)
 * - "bottom":       full-width strip above the bottom safe margin (progress)
 * - "full":         whole canvas (full-frame overlay)
 */
export type Anchor =
  | "top-center"
  | "center"
  | "lower-third"
  | "badge"
  | "watermark"
  | "bottom"
  | "full";

/** Margin box the layer keeps all graphics inside. */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Entry/exit motion, all in frames.
 * Brand motion language (brand.md §5): calm fade + rise on entry (~7 frames,
 * ease-out, no overshoot), fade + fall on exit, 3–4 frames between lines.
 */
export interface GraphicsTiming {
  /** entry ramp length in frames (default 7) */
  inDur?: number;
  /** exit ramp length in frames (default 6 — exits a touch faster than entries) */
  outDur?: number;
  /** frames between successive lines (default 3) */
  stagger?: number;
  /** entry rise in px (default 24) */
  rise?: number;
  /** exit fall in px (default 14) */
  fall?: number;
}

/**
 * Declarative description of one native graphics item on the episode timeline.
 * Bound to a shot via shotId, or to absolute frames via frameFrom/frameTo.
 */
export interface GraphicsItemSpec {
  /** stable item id (also used in error messages) */
  id: string;
  kind: GraphicsKind;
  /** bind to a shot in the plan; frame range resolved from the shot */
  shotId?: string;
  /** absolute episode-timeline start frame (ignored when shotId is set) */
  frameFrom?: number;
  /** absolute episode-timeline end frame; defaults to shot end / +120 frames */
  frameTo?: number;
  /** frames after shot start when shotId is set (default 0) */
  offsetIn?: number;
  /** main text: one string, or one string per line */
  text?: string | string[];
  /** secondary line (lower-third role line / subtitle) */
  subtext?: string;
  /** override the kind's default brand accent color */
  accentColor?: string;
  anchor?: Anchor;
  /** higher = on top. Defaults by kind priority. */
  zIndex?: number;
  timing?: GraphicsTiming;
  /** font size in 1080-wide canvas units; auto-scaled to the frame size */
  fontSize?: number;
  /** overlay card content when kind is "overlay" */
  panel?: { title?: string; body?: string; progress?: number };
}

/**
 * The slice of a shot plan (spec §12) the graphics layer consumes. Values are
 * absolute episode-timeline frames. Consumer types may be structurally wider.
 */
export interface ShotPlanRef {
  shotId: string;
  sceneId?: string;
  sequenceIndex?: number;
  frameIn: number;
  frameOut: number;
}
