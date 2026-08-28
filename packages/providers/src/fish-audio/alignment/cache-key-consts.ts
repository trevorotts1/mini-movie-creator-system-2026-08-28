/**
 * Local copy of the FISH-005 cache-key version constant.
 *
 * The alignment store validates keys against the dialogue cache key format
 * but does NOT import the cache module itself (no cross-task dependency;
 * FISH-005 may not be merged when this lands). If FISH-005's key version ever
 * changes, this constant and the validation must move together — the two
 * stores must address the same assets with the same keys.
 */
export const FISH_CACHE_KEY_VERSION = "fsh1";