import type { Migration } from "../types.js";

/**
 * Baseline band `000_` (CORE-003). V1 keeps the ledger-only baseline: no
 * product tables ship here — projects/series/episodes land in band `010_`
 * (CORE-004), characters in `020_` (CORE-005), scenes/shots in `030_`
 * (CORE-006), provider jobs/assets in `040_` (CORE-007). The migration
 * framework itself needs no product tables, so the baseline is empty and
 * every later band is a pure addition.
 */
export const baselineMigrations: readonly Migration[] = [];