import type { SqliteDatabase } from "../../connection/index.js";
import { JOB_STATES } from "../../repositories/jobs/job-states.js";
import { MigrationError } from "../runner.js";
import { assertCanonicalColumns, declaredColumns, tableColumns, tableDdlFor } from "../table-shape.js";
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
 *
 * `0401` is ALSO the one authoritative owner of the `provider_jobs` shape
 * (SKR-006): the Agnes video job store used to self-heal a completely
 * different, `ref`-keyed 7-column table under the same name with
 * `CREATE TABLE IF NOT EXISTS`, so the two orders of arrival were both
 * fatal — migration first → the store threw "no column named ref";
 * self-heal first → this migration's bare `CREATE TABLE` aborted. The
 * migration now adopts that legacy table in place (its rows are copied into
 * the canonical columns — see {@link reconcileProviderJobs}), refuses any
 * shape it does not recognise, and the store is expected to stop creating
 * schema of its own.
 */

/** The one authoritative provider job table name. */
const PROVIDER_JOBS_TABLE = "provider_jobs";
/** Scratch name of an adopted legacy table, dropped once its rows are copied. */
const LEGACY_PROVIDER_JOBS_TABLE = "provider_jobs_legacy_0401";
/**
 * Columns the legacy (Agnes self-healed) table must carry before it can be
 * adopted: a `ref` key alone is not enough, because the copy below reads all
 * seven.
 */
const LEGACY_PROVIDER_JOBS_COLUMNS = [
  "ref",
  "provider",
  "provider_task_id",
  "state",
  "payload",
  "created_at",
  "updated_at",
] as const;
/** Scratch name for reading the canonical column list back out of SQLite. */
const SHAPE_PROBE_TABLE = "__mmcs_shape_probe_0401";

/**
 * Canonical `provider_jobs` DDL as a `%TABLE%` template, so the shape probe
 * introspects the exact declaration {@link providerJobsTableSql} applies —
 * one definition, never two.
 */
const PROVIDER_JOBS_DDL_TEMPLATE = `
CREATE TABLE IF NOT EXISTS %TABLE% (
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
`.trim();

/** The canonical table DDL, for the real table by default. */
export function providerJobsTableSql(table: string = PROVIDER_JOBS_TABLE): string {
  return tableDdlFor(PROVIDER_JOBS_DDL_TEMPLATE, table);
}

/**
 * Indexes for {@link providerJobsTableSql}. `IF NOT EXISTS` is safe here
 * because {@link reconcileProviderJobs} has already proven the table shape:
 * a pre-existing canonical table (ad-hoc creation, or a lost ledger row)
 * legitimately arrives with these indexes.
 */
export const PROVIDER_JOBS_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_jobs_idempotency
  ON provider_jobs (provider, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_jobs_provider_task
  ON provider_jobs (provider, provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_jobs_status ON provider_jobs (status);
`.trim();

/**
 * Legacy archival statuses → the canonical enum. The Agnes store's
 * "ARCHIVING" is the canonical "IN_PROGRESS"; the other three are shared
 * spellings. Anything else is refused before the copy (see
 * {@link assertLegacyRowsAreAdoptable}) rather than coerced: a silently
 * rewritten archival status is a lost audit fact.
 */
const LEGACY_ARCHIVAL_STATUS_MAP: Readonly<Record<string, string>> = {
  PENDING: "PENDING",
  ARCHIVING: "IN_PROGRESS",
  ARCHIVED: "ARCHIVED",
  FAILED: "FAILED",
};

/**
 * Copy every row of the adopted legacy table into the canonical columns.
 *
 * Mapping rules, in the spirit of spec §18/§4 (never invent a fact):
 * - `ref` (the legacy primary key) is the durable job reference, so it
 *   becomes both `id` and `idempotency_key` — the legacy store's
 *   `ON CONFLICT(ref)` dedupe keeps working under the canonical unique index.
 * - `payload` is the whole legacy record, verbatim: it lands in
 *   `request_params` (also the JSON column), so an adopting reader can still
 *   recover every legacy-only field and no legacy byte is dropped.
 * - denormalized columns the legacy table carried (`provider`,
 *   `provider_task_id`, `state` → `status`, `created_at`, `updated_at`) are
 *   copied straight across.
 * - fields the legacy record nested in its JSON payload are lifted out ONLY
 *   when the JSON type matches the column (`json_type` guards): a numeric
 *   cost stored as a string stays NULL instead of being coerced into a
 *   fabricated amount.
 */
const ADOPT_LEGACY_PROVIDER_JOBS_SQL = `
INSERT INTO ${PROVIDER_JOBS_TABLE} (
  id, idempotency_key, request_hash, provider, provider_model, provider_task_id,
  request_params, submitted_at, status, polled_at, result_url, archival_status,
  retry_count, estimated_cost_usd, actual_cost_usd, failure_reason, created_at, updated_at
)
SELECT
  legacy.ref,
  legacy.ref,
  COALESCE(
    CASE json_type(legacy.payload, '$.requestHash') WHEN 'text'
      THEN json_extract(legacy.payload, '$.requestHash') END,
    'legacy-unhashed:' || legacy.ref
  ),
  legacy.provider,
  COALESCE(
    CASE json_type(legacy.payload, '$.model') WHEN 'text'
      THEN json_extract(legacy.payload, '$.model') END,
    'unknown'
  ),
  COALESCE(
    legacy.provider_task_id,
    CASE json_type(legacy.payload, '$.providerJobId') WHEN 'text'
      THEN json_extract(legacy.payload, '$.providerJobId') END
  ),
  legacy.payload,
  CASE json_type(legacy.payload, '$.submittedAt') WHEN 'text'
    THEN json_extract(legacy.payload, '$.submittedAt') END,
  legacy.state,
  CASE json_type(legacy.payload, '$.lastPolledAt') WHEN 'text'
    THEN json_extract(legacy.payload, '$.lastPolledAt') END,
  CASE json_type(legacy.payload, '$.resultUrls[0]') WHEN 'text'
    THEN json_extract(legacy.payload, '$.resultUrls[0]') END,
  COALESCE(
    CASE json_type(legacy.payload, '$.archivalStatus') WHEN 'text' THEN
      CASE json_extract(legacy.payload, '$.archivalStatus')
        ${Object.entries(LEGACY_ARCHIVAL_STATUS_MAP)
          .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
          .join("\n        ")}
      END
    END,
    'PENDING'
  ),
  COALESCE(
    CASE json_type(legacy.payload, '$.retryCount') WHEN 'integer'
      THEN json_extract(legacy.payload, '$.retryCount') END,
    0
  ),
  CASE json_type(legacy.payload, '$.estimatedCostUsd') WHEN 'integer' THEN json_extract(legacy.payload, '$.estimatedCostUsd')
    WHEN 'real' THEN json_extract(legacy.payload, '$.estimatedCostUsd') END,
  CASE json_type(legacy.payload, '$.actualCostUsd') WHEN 'integer' THEN json_extract(legacy.payload, '$.actualCostUsd')
    WHEN 'real' THEN json_extract(legacy.payload, '$.actualCostUsd') END,
  CASE json_type(legacy.payload, '$.failureReason') WHEN 'text'
    THEN json_extract(legacy.payload, '$.failureReason') END,
  legacy.created_at,
  legacy.updated_at
FROM ${LEGACY_PROVIDER_JOBS_TABLE} AS legacy;
`.trim();

/**
 * Reconcile whatever `provider_jobs` already exists, before `up` runs.
 *
 * Three legal states, and a loud failure for everything else:
 * - absent → `up` creates the canonical table;
 * - canonical (ad-hoc creation, or a lost ledger row) → verified column by
 *   column, then `up` no-ops;
 * - the legacy `ref`-keyed table the Agnes store self-healed → renamed
 *   aside, re-created canonically, its rows copied over, scratch table
 *   dropped. This is the state that used to abort the migration.
 */
function reconcileProviderJobs(db: SqliteDatabase): void {
  const columns = tableColumns(db, PROVIDER_JOBS_TABLE);
  if (columns === undefined) {
    return; // absent: `up` creates it
  }
  if (columns.has("ref") && columns.has("id")) {
    throw new MigrationError(
      "0401",
      `existing table ${PROVIDER_JOBS_TABLE} carries BOTH the canonical "id" and the legacy "ref" key — ` +
        `ambiguous identity, refusing to guess which key the callers used; reconcile the table by hand`,
    );
  }
  if (!columns.has("ref")) {
    assertCanonicalColumns({
      migrationId: "0401",
      table: PROVIDER_JOBS_TABLE,
      columns,
      canonical: declaredColumns(db, PROVIDER_JOBS_DDL_TEMPLATE, SHAPE_PROBE_TABLE),
    });
    return;
  }

  assertCanonicalColumns({
    migrationId: "0401",
    table: PROVIDER_JOBS_TABLE,
    columns,
    canonical: new Set(LEGACY_PROVIDER_JOBS_COLUMNS),
  });
  assertLegacyRowsAreAdoptable(db);
  db.exec(`ALTER TABLE ${PROVIDER_JOBS_TABLE} RENAME TO ${LEGACY_PROVIDER_JOBS_TABLE}`);
  db.exec(providerJobsTableSql());
  db.exec(ADOPT_LEGACY_PROVIDER_JOBS_SQL);
  db.exec(`DROP TABLE ${LEGACY_PROVIDER_JOBS_TABLE}`);
}

/**
 * Pre-flight the legacy rows whose values the canonical CHECK constraints
 * could not take verbatim. Each of these aborts the whole migration (the
 * runner's transaction rolls back, so nothing is half-adopted) and names the
 * offending refs, instead of coercing a job into a state it never had:
 * coercing a SUBMITTED job to PLANNED would make a resume scan resubmit the
 * provider task and double-spend (spec §18).
 *
 * The legacy `state` machine is the SAME §18 machine as the canonical
 * `status` enum (imported, not re-listed, so the two cannot drift), so
 * out-of-domain states mean corrupt data, not a mapping gap.
 */
function assertLegacyRowsAreAdoptable(db: SqliteDatabase): void {
  const knownStates = JOB_STATES.map((state) => `'${state}'`).join(", ");

  const badPayload = db.all(
    `SELECT ref FROM ${PROVIDER_JOBS_TABLE} WHERE NOT json_valid(payload) LIMIT 5`,
  );
  if (badPayload.length > 0) {
    throw new MigrationError(
      "0401",
      `legacy ${PROVIDER_JOBS_TABLE} row(s) hold a payload that is not valid JSON ` +
        `(ref(s): ${badPayload.map((row) => String(row["ref"])).join(", ")}); the payload is the audit ` +
        `record and cannot be re-encoded without changing it — repair the row by hand before migrating`,
    );
  }

  const badStates = db.all(
    `SELECT ref, state FROM ${PROVIDER_JOBS_TABLE} WHERE state NOT IN (${knownStates}) LIMIT 5`,
  );
  if (badStates.length > 0) {
    throw new MigrationError(
      "0401",
      `legacy ${PROVIDER_JOBS_TABLE} row(s) carry a state outside the spec §18 machine and cannot be ` +
        `mapped onto the canonical status enum without lying about the job's progress: ` +
        `${badStates.map((row) => `${String(row["ref"])}=${String(row["state"])}`).join(", ")}`,
    );
  }

  const badArchival = db.all(
    `SELECT ref, json_extract(payload, '$.archivalStatus') AS archival_status
       FROM ${PROVIDER_JOBS_TABLE}
      WHERE json_type(payload, '$.archivalStatus') IS NOT NULL
        AND json_type(payload, '$.archivalStatus') <> 'null'
        AND (
          json_type(payload, '$.archivalStatus') <> 'text'
          OR json_extract(payload, '$.archivalStatus') NOT IN (${Object.keys(LEGACY_ARCHIVAL_STATUS_MAP)
            .map((status) => `'${status}'`)
            .join(", ")})
        )
      LIMIT 5`,
  );
  if (badArchival.length > 0) {
    throw new MigrationError(
      "0401",
      `legacy ${PROVIDER_JOBS_TABLE} row(s) carry an archival status the canonical enum cannot express ` +
        `(ref=status: ${badArchival
          .map((row) => `${String(row["ref"])}=${String(row["archival_status"])}`)
          .join(", ")}); map it explicitly before migrating`,
    );
  }
}

export const jobsAssetsMigrations: readonly Migration[] = [
  {
    id: "0401",
    name: "create provider_jobs",
    beforeUp: reconcileProviderJobs,
    up: `${providerJobsTableSql()}

${PROVIDER_JOBS_INDEXES_SQL}`,
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
  -- SKR-011 tenant provenance. Owned here rather than added ad hoc by
  -- @mmcs/media-storage at first use: a column outside the migration history
  -- is one two racing processes can try to add simultaneously.
  ghl_location_id TEXT,
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
