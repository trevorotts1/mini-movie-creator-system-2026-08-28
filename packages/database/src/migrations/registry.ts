import type { Migration } from "./types.js";
import { baselineMigrations } from "./000-init/index.js";
import { jobsAssetsMigrations } from "./004-jobs-assets/index.js";

/**
 * The ordered MMCS migration list. Bands are appended by their owning
 * tasks (CORE-004: `010_–019_`, CORE-005: `020_–029_`, CORE-006:
 * `030_–039_`, CORE-007: `040_–049_`) — each band lives in its own
 * directory under `migrations/` and is registered here exactly once.
 * The runner rejects duplicate ids, so band collisions fail loudly.
 */
export const MIGRATIONS: readonly Migration[] = [...baselineMigrations, ...jobsAssetsMigrations];