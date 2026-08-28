/**
 * Rough-cut assembly errors (VID-012).
 *
 * Stable `code` values so scripting and the CLI surface (`mmcs rough-cut`)
 * can branch on failure class without parsing prose (the VID-014
 * FinalRenderError pattern).
 */
export type RoughCutErrorCode =
  | "PLAN_INVALID"
  | "ASSET_MISSING"
  | "RENDER_FAILED"
  | "OUTPUT_INVALID";

export class RoughCutError extends Error {
  readonly code: RoughCutErrorCode;

  constructor(code: RoughCutErrorCode, message: string) {
    super(message);
    this.name = "RoughCutError";
    this.code = code;
  }
}
