/// <reference types="node" />
/**
 * Dialogue asset key validation for the caption store (FISH-007).
 *
 * Caption tracks are keyed by the FISH-005 dialogue cache key
 * (`fsh1:<64 hex chars>`), the SAME key the FISH-006 alignment store uses.
 * The key is the ONLY string that ever becomes a file path, so it is
 * validated strictly: `fsh1:` prefix + exactly 64 lowercase hex chars.
 * Untrusted dialogue text can never reach a path.
 *
 * Local copy of the FISH-005/006 key constant + validation (no cross-task
 * dependency; the cache/alignment packages may not be merged when this
 * lands). If the key format ever changes, all three copies must move
 * together — the stores must address the same assets with the same keys.
 */
export const FISH_CACHE_KEY_VERSION = "fsh1";

/**
 * True when `key` is a current-format dialogue asset key:
 * `fsh1:` followed by 64 lowercase hex chars (sha256 hex digest).
 */
export function isCurrentDialogueAssetKey(key: string): boolean {
  if (!key.startsWith(`${FISH_CACHE_KEY_VERSION}:`)) return false;
  const hex = key.slice(FISH_CACHE_KEY_VERSION.length + 1);
  return /^[0-9a-f]{64}$/.test(hex);
}