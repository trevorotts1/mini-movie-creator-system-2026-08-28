import type { Migration } from "./types.js";
import { baselineMigrations } from "./000-init/index.js";
import { jobsAssetsMigrations } from "./004-jobs-assets/index.js";
import { projectSchemaMigrations } from "./010-project-series-episode/index.js";
import { characterMigrations } from "./020-characters/index.js";
import { scenesMigrations } from "./030-scenes-shots/index.js";
import { costLedgerMigrations } from "./050-cost-ledger/index.js";

/**
 * The ordered MMCS migration list. Bands are appended by their owning
 * tasks (CORE-004: `010_–019_`, CORE-005: `020_–029_`, CORE-006:
 * `030_–039_`, CORE-007: `040_–049_`, CORE-009: `050_–059_`) — each band
 * lives in its own directory under `migrations/` and is registered here
 * exactly once. The runner rejects duplicate ids, so band collisions fail
 * loudly.
 *
 * The cost-engine spend ledger (band `050_`) belongs here, not in
 * `@mmcs/cost-engine`: the $25 cumulative gate is only durable if the
 * production database's own migration history creates and owns its tables
 * (SKR-010).
 */
export const MIGRATIONS: readonly Migration[] = [
  ...baselineMigrations,
  ...jobsAssetsMigrations,
  ...projectSchemaMigrations,
  ...characterMigrations,
  ...scenesMigrations,
  ...costLedgerMigrations,
];
