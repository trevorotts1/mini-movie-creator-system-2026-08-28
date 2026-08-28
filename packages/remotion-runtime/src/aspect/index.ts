/**
 * MMCS aspect-ratio module (spec §23 OUTPUT FORMATS).
 *
 * Owns the master-output-format math: parse "W:H" ids, resolve series-level
 * defaults with per-episode overrides, compute pixel canvases from resolution
 * tiers, and derive content safe areas + caption zones. Feeds the episodic
 * composition registry (VID-002) and rough cut (VID-012) so 16:9 and 9:16 cut
 * from the same plan (acceptance §32).
 */

export * from "./types.js";
export * from "./parse.js";
export * from "./geometry.js";
export * from "./plan.js";
export * from "./fit.js";
export * from "./composition.js";
