import type { Migration } from "../types.js";

/**
 * Band `040_` (CORE-007): provider jobs + asset manifest (spec §18, §19).
 *
 * Two migrations: `0401` creates `provider_jobs` (the durable record that
 * must exist BEFORE polling a provider task, so a restart resumes polling
 * instead of resubmitting), `0402` creates `assets` (every media asset has
 * a durable DB row whose columns are exactly the spec §19 manifest fields).
 *
 * References to projects/episodes/scenes/shots/characters are plain TEXT
 * soft references on purpose: those tables live in sibling bands (`010_`–
 * `030_`) that may apply independently of this one, and hard foreign keys
 * across bands would make band 040 un-appliable on its own. Enforcing the
 * references is the repositories'/callers' job; the columns keep the ids
 * stable for a later PostgreSQL migration (spec §25).
 */
export const jobsAssetsMigrations: readonly Migration[] = [
  {
    id: "0401",
    name: "create provider_jobs",
    up: `
CREATE TABLE provider_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  provider_task_id TEXT,
  request_params TEXT NOT NULL,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (
    status IN (
      'PLANNED',
      'BUDGET_RESERVED',
      'SUBMITTING',
      'SUBMITTED',
      'GENERATING',
      'GENERATED_TEMPORARY',
      'ARCHIVING',
      'ARCHIVED',
      'QC_PENDING',
      'QC_FIXING',
      'APPROVED',
      'REJECTED'
    )
  ),
  polled_at TEXT,
  result_url TEXT,
  archival_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    archival_status IN ('PENDING', 'IN_PROGRESS', 'ARCHIVED', 'FAILED', 'SKIPPED')
  ),
  retry_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  budget_reserved_at TEXT,
  budget_released_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_provider_jobs_idempotency
  ON provider_jobs (provider, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_provider_jobs_provider_task
  ON provider_jobs (provider, provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX idx_provider_jobs_status ON provider_jobs (status);
`.trim(),
    down: `
DROP INDEX IF EXISTS idx_provider_jobs_status;
DROP INDEX IF EXISTS idx_provider_jobs_provider_task;
DROP INDEX IF EXISTS idx_provider_jobs_idempotency;
DROP TABLE provider_jobs;
`.trim(),
  },
  {
    id: "0402",
    name: "create assets",
    up: `
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  series_id TEXT,
  episode_id TEXT,
  scene_id TEXT,
  shot_id TEXT,
  character_id TEXT,
  character_version TEXT,
  asset_type TEXT NOT NULL,
  asset_state TEXT NOT NULL CHECK (
    asset_state IN ('DRAFT', 'REVIEW', 'APPROVED', 'CANONICAL', 'RETIRED', 'REJECTED')
  ),
  provider TEXT,
  provider_model TEXT,
  provider_task_id TEXT,
  original_provider_url TEXT,
  provider_url_expiration TEXT,
  ghl_file_id TEXT,
  ghl_folder_id TEXT,
  ghl_url TEXT,
  checksum TEXT,
  local_path TEXT,
  prompt TEXT,
  prompt_character_count INTEGER,
  references_used TEXT,
  generation_settings TEXT,
  cost REAL,
  generation_seconds REAL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  approval_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    approval_state IN ('PENDING', 'APPROVED', 'REJECTED')
  ),
  qc_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    qc_state IN ('PENDING', 'PASSED', 'FAILED', 'FIXING')
  )
) STRICT;

CREATE INDEX idx_assets_series ON assets (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_assets_episode ON assets (episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX idx_assets_scene ON assets (scene_id) WHERE scene_id IS NOT NULL;
CREATE INDEX idx_assets_shot ON assets (shot_id) WHERE shot_id IS NOT NULL;
CREATE INDEX idx_assets_character ON assets (character_id) WHERE character_id IS NOT NULL;
CREATE INDEX idx_assets_provider_task
  ON assets (provider_task_id) WHERE provider_task_id IS NOT NULL;
`.trim(),
    down: `
DROP INDEX IF EXISTS idx_assets_provider_task;
DROP INDEX IF EXISTS idx_assets_character;
DROP INDEX IF EXISTS idx_assets_scene;
DROP INDEX IF EXISTS idx_assets_episode;
DROP INDEX IF EXISTS idx_assets_series;
DROP TABLE assets;
`.trim(),
  },
];