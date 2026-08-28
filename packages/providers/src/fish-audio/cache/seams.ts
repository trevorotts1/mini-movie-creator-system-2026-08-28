/**
 * Seams shared inside the cache package: the key-function type and the
 * re-export of the current-format validator, so `cache.ts` depends on a
 * narrow seam instead of the whole key module.
 */
export { isCurrentKeyFormat, dialogueCacheKey } from "./key.js";
import type { FishDialogueRequest } from "./types.js";

/** The cache-key function (injectable shape; default: dialogueCacheKey). */
export type DialogueCacheKeyFn = (request: FishDialogueRequest) => string;