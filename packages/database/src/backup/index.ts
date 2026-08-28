/**
 * MMCS database backup/export (CORE-015, spec §25).
 *
 * Owns the `.mmcsbak` archive format, the export/restore operations over
 * the `SqliteDatabase` seam, and the per-table fingerprint (row count +
 * SHA-256) that proves a restore is faithful. The CLI verb
 * (`mmcs backup export` / `mmcs backup restore`) lives in
 * `apps/cli/src/commands/backup/` and consumes this module.
 */
export {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  ensureBackupExtension,
  exportBackup,
  readBackupManifest,
  restoreBackup,
  type BackupEnvelope,
  type BackupExportResult,
  type BackupManifest,
  type BackupRestoreResult,
} from "./backup.js";

export {
  compareFingerprints,
  fingerprintDatabase,
  fingerprintTable,
  type DatabaseFingerprint,
  type FingerprintMismatch,
  type TableFingerprint,
} from "./fingerprint.js";