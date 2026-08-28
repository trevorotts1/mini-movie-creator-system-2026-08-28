/**
 * Rough cut assembly (VID-012, spec §21/§23/§32).
 *
 * Plan → deterministic frame timeline → preview MP4 → ffprobe gate.
 */
export * from "./types.js";
export * from "./errors.js";
export {
  DEFAULT_FPS,
  DEFAULT_TEMP_MUSIC_GAIN_DB,
  assembleRoughCut,
  framesForSeconds,
  resolutionForFormat,
  roughCutFileName,
  validateRoughCutPlan,
} from "./assemble.js";
export {
  ffprobeValidateRoughCut,
  makeFfmpegFixtureAdapter,
  planRoughCutRender,
  renderRoughCut,
} from "./render.js";
export type {
  RoughCutProbeReport,
  RoughCutRenderAdapter,
  RoughCutRenderRequest,
  RoughCutRenderResult,
  RoughCutResult,
} from "./render.js";
export {
  ROUGH_CUT_SPEC,
  USAGE_ROUGH_CUT,
  executeRoughCut,
  formatRoughCutLines,
  parseRoughCutArgs,
} from "./cli.js";
export type {
  CommandSpec,
  RoughCutCliOptions,
  RoughCutCliResult,
} from "./cli.js";
