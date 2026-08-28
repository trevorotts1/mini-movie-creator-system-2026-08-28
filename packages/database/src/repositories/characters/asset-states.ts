/**
 * Asset approval lifecycle shared by canonical character-library assets
 * (spec §9 "Asset states": DRAFT → REVIEW → APPROVED → CANONICAL → RETIRED,
 * plus REJECTED). Mirrors the in-memory module in
 * `@mmcs/character-library` so the database layer stays the single
 * enforcement point for persisted rows.
 */

export type AssetApprovalState =
  | "DRAFT"
  | "REVIEW"
  | "APPROVED"
  | "CANONICAL"
  | "RETIRED"
  | "REJECTED";

export const ASSET_APPROVAL_STATES: readonly AssetApprovalState[] = [
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "CANONICAL",
  "RETIRED",
  "REJECTED",
];