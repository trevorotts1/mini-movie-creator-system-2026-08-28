/**
 * Asset lifecycle states for the Character Library (spec §9 "Asset states":
 * DRAFT → REVIEW → APPROVED → CANONICAL → RETIRED, plus REJECTED).
 *
 * Kept local to appearance-versions so the module stays self-contained;
 * the library-wide asset-state module (CHAR-002/CHAR-005 territory) can
 * re-export or supersede this later.
 */

export type AssetState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

/** Ordered forward transition path; REJECTED is terminal-off-path. */
const FORWARD_ORDER: readonly AssetState[] = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
];

/** True when `from` may legally transition to `to` under spec §9. */
export function isLegalAssetTransition(from: AssetState, to: AssetState): boolean {
  const fromIndex = FORWARD_ORDER.indexOf(from);
  const toIndex = FORWARD_ORDER.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex >= fromIndex;
}

/** Transition `state` forward one legal step; throws on an illegal move. */
export function advanceAssetState(state: AssetState): AssetState {
  const index = FORWARD_ORDER.indexOf(state);
  if (index === -1 || index === FORWARD_ORDER.length - 1) {
    throw new Error(`asset state ${state} has no forward transition`);
  }
  return FORWARD_ORDER[index + 1] ?? "RETIRED";
}