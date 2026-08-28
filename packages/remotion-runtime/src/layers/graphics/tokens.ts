/**
 * Graphics-layer brand tokens, mirroring remotion/src/brand.ts + brand.md so
 * the packages layer stays in-step with the upstream brand contract without
 * importing from the (separately-owned, upstream-kit) remotion project.
 */

/** Brand palette (brand.md §2, exact hex). */
export const GRAPHICS_COLORS = {
  accent: "#6366F1", // indigo — primary
  accent2: "#9b7cc4", // violet — secondary
  signal: "#4db8a8", // teal — success
  signalAlt: "#4ecdc4", // teal-green
  warn: "#f5d76e", // yellow — attention
  danger: "#e8879f", // pink — contrast/error
  ink: "#1a1a2e", // primary text on light
  muted: "#6b6b7b", // secondary text
  paper: "#fffef7", // light surface
  cream: "#faf8f5", // alt light band
  // dark UI scale (GitHub-ink) — default treatment when no background is
  // supplied by the upstream shot
  d900: "#0d1117",
  d800: "#161b22",
  d600: "#30363d",
  d400: "#8b949e",
  d300: "#c9d1d9",
} as const;

export type GraphicsColor = keyof typeof GRAPHICS_COLORS;

/** Signature gradient (indigo → violet → teal), used for dividers/bars. */
export const GRAPHICS_GRADIENT = `linear-gradient(120deg, ${GRAPHICS_COLORS.accent}, ${GRAPHICS_COLORS.accent2}, ${GRAPHICS_COLORS.signal})`;

/** Radius scale (brand.md §4): ~14px cards, fully-rounded pills. */
export const GRAPHICS_RADIUS = {
  card: 14,
  panel: 14,
  pill: 999,
} as const;

/** Soft shadows only — never hard offset shadows (brand.md §4). */
export const GRAPHICS_SHADOW = {
  soft: "0 8px 32px rgba(26,26,46,0.10)",
  card: "0 10px 40px rgba(26,26,46,0.08)",
} as const;

/** Brand animation defaults (brand.md §5, in frames at 30fps). */
export const GRAPHICS_TIMING_DEFAULTS = {
  inDur: 7,
  outDur: 6,
  stagger: 3,
  rise: 24,
  fall: 14,
} as const;

/**
 * Kind default settings: anchor, brand color, z-order, and base font size in
 * 1080-unit canvas space. zIndex: overlays sit above text; credits and logos
 * always on top. Keyed by GraphicsKind — every kind MUST have a default row
 * (the types test enforces coverage).
 */
export const KIND_DEFAULTS: Record<
  import("./types.js").GraphicsKind,
  { anchor: string; color: string; zIndex: number; fontSize: number; label: string }
> = {
  title: { anchor: "top-center", color: "#ffffff", zIndex: 20, fontSize: 92, label: "Title" },
  kicker: { anchor: "top-center", color: GRAPHICS_COLORS.warn, zIndex: 10, fontSize: 30, label: "Kicker" },
  subtitle: { anchor: "top-center", color: "rgba(255,255,255,0.82)", zIndex: 15, fontSize: 40, label: "Subtitle" },
  lowerThird: { anchor: "lower-third", color: "#ffffff", zIndex: 30, fontSize: 56, label: "Lower third" },
  overlay: { anchor: "center", color: "#ffffff", zIndex: 40, fontSize: 44, label: "Overlay" },
  credit: { anchor: "bottom", color: GRAPHICS_COLORS.muted, zIndex: 50, fontSize: 34, label: "Credits" },
  logo: { anchor: "watermark", color: "#ffffff", zIndex: 60, fontSize: 24, label: "Logo" },
  progressBar: { anchor: "bottom", color: GRAPHICS_COLORS.accent, zIndex: 25, fontSize: 0, label: "Progress bar" },
};

/** Brand typography roles (brand.md §3) — names only, fonts load upstream. */
export const GRAPHICS_FONTS = {
  display: "Space Grotesk",
  body: "Inter",
  mono: "JetBrains Mono",
} as const;