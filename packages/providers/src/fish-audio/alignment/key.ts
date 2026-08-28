/// <reference types="node" />
/**
 * Dialogue asset key validation for the alignment store (FISH-006).
 *
 * Alignment records are keyed by the FISH-005 dialogue cache key
 * (`fsh1:<64 hex chars>`). The key is the ONLY string that ever becomes a
 * file path, so it is validated strictly: `fsh1:` prefix + exactly 64
 * lowercase hex chars. Untrusted dialogue text can never reach a path.
 */
import { FISH_CACHE_KEY_VERSION } from "./cache-key-consts.js";

/**
 * True when `key` is a current-format dialogue asset key:
 * `fsh1:` followed by 64 lowercase hex chars (sha256 hex digest).
 */
export function isCurrentDialogueAssetKey(key: string): boolean {
  if (!key.startsWith(`${FISH_CACHE_KEY_VERSION}:`)) return false;
  const hex = key.slice(FISH_CACHE_KEY_VERSION.length + 1);
  return /^[0-9a-f]{64}$/.test(hex);
}