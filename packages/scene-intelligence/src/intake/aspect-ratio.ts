/**
 * Aspect-ratio validation, shared shape with the CORE-004 repositories
 * (`isValidAspectRatio` in `@mmcs/database`): "w:h", numeric dimensions,
 * decimals allowed for cinematic ratios (e.g. "2.39:1"), positive and
 * bounded. Duplicated here rather than imported so the intake module stays
 * dependency-light; the two implementations are kept shape-compatible by
 * tests in both packages (spec §23: custom ratios are validated data, not a
 * CHECK constraint).
 */

/** An aspect-ratio string like "16:9", "9:16", "2.39:1". */
export const ASPECT_RATIO_MAX_LENGTH = 32;

const DIMENSION_PATTERN = /^\d{1,5}(\.\d{1,3})?$/;

/** True when `value` is a well-formed, positive aspect ratio string. */
export function isValidAspectRatio(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ASPECT_RATIO_MAX_LENGTH) {
    return false;
  }
  const parts = value.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [width, height] = parts as [string, string];
  return (
    DIMENSION_PATTERN.test(width) &&
    DIMENSION_PATTERN.test(height) &&
    Number(width) > 0 &&
    Number(height) > 0
  );
}