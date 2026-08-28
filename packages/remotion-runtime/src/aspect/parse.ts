import { AspectPlanError, AspectRatio } from "./types.js";

/**
 * Parse a "W:H" ratio string into an {@link AspectRatio}.
 * Accepts presets ("16:9", "9:16") and custom "W:H" (e.g. "2.35:1").
 * Rejects zero/negative/NaN parts, mixed character pairs ("16x9"), decimals (>3dp),
 * and anything that is not exactly "W:H".
 */
export function parseAspectRatio(input: string): AspectRatio {
  const raw = (input ?? "").trim().slice(0, 64);
  const match = /^(\d+)(?:\.(\d{1,3}))?\s*:\s*(\d+)(?:\.(\d{1,3}))?$/.exec(raw);
  if (!match) {
    throw new AspectPlanError(
      `Invalid aspect ratio "${input}": expected "W:H" (e.g. "16:9", "9:16", "2.35:1")`,
    );
  }
  const w = Number(`${match[1] ?? "0"}${match[2] ? `.${match[2]}` : ""}`);
  const h = Number(`${match[3] ?? "0"}${match[4] ? `.${match[4]}` : ""}`);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new AspectPlanError(
      `Invalid aspect ratio "${input}": width and height must be positive`,
    );
  }
  const id = formatRatioId(w, h);
  return {
    id,
    widthUnits: w,
    heightUnits: h,
    ratio: w / h,
  };
}

/** Canonical "W:H" string: strip the fractional part when it is exact. */
export function formatRatioId(w: number, h: number): string {
  const clean = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
  return `${clean(w)}:${clean(h)}`;
}
