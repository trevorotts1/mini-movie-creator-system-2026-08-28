/**
 * @mmcs/database — SQLite connection, migration framework, repository
 * contracts (spec §25). Driver is Node's built-in `node:sqlite`; the
 * `SqliteDatabase` seam keeps repositories portable to PostgreSQL later.
 */
export {
  SQLITE_CONNECTION_DEFAULTS,
  connectSqlite,
  type PreparedStatement,
  type SqliteDatabase,
  type SqliteConnectOptions,
  type SqlOutputValue,
  type SqlValue,
} from "./connection/index.js";

export {
  MIGRATIONS,
  MIGRATIONS_TABLE,
  CREATE_MIGRATIONS_TABLE_SQL,
  MigrationError,
  appliedMigrationIds,
  baselineMigrations,
  jobsAssetsMigrations,
  projectSchemaMigrations,
  migrate,
  sortMigrations,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
  type MigrationRecord,
} from "./migrations/index.js";

export {
  ASSET_MANIFEST_FIELDS,
  ARCHIVAL_STATUSES,
  BaseRepository,
  JOB_SAFETY_FIELDS,
  JOB_STATES,
  JOB_STATE_ORDER,
  AssetRepository,
  JobStateTransitionError,
  ProviderJobRepository,
  SqliteProjectRepository,
  SqliteSeriesRepository,
  SqliteEpisodeRepository,
  formatEpisodeCode,
  isLegalJobTransition,
  type ArchivalStatus,
  type AssetManifest,
  type AssetManifestField,
  type AssetPatch,
  type CrudRepository,
  type ProviderJob,
  type ProviderJobInput,
  type ProviderJobPatch,
  type ProviderJobState,
  type Repository,
  type RowMapper,
} from "./repositories/index.js";

export {
  isValidAspectRatio,
  ValidationError as SchemaValidationError,
  type Project,
  type ProjectKind,
  type ProjectStatus,
  type ProjectRepository,
  type CreateProjectInput,
  type UpdateProjectPatch,
  type Series,
  type SeriesRepository,
  type CreateSeriesInput,
  type UpdateSeriesPatch,
  type Episode,
  type EpisodeStatus,
  type EpisodeRepository,
  type CreateEpisodeInput,
  type UpdateEpisodePatch,
} from "./repositories/projects/index.js";
