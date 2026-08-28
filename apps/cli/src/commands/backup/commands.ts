// `mmcs backup export` + `mmcs backup restore` command wiring (spec §24/§25,
// CORE-015).
//
// Owns only this directory (apps/cli/src/commands/backup/). The CLI entry
// (src/index.ts, CORE-011's) gains the real verbs via CommandSpec overrides
// merged over the stubs at integration (see apps/cli/src/dispatch/registry.ts
// — mergeSpecs); that file is NOT owned by CORE-015.
//
// The commands:
//   1. parse the documented options (no permissive unknown flags — the CLI
//      surface is scriptable and predictable, spec §24);
//   2. run the pure orchestration over injected ports — every filesystem /
//      database operation lives in the ports, nothing I/O at module scope;
//   3. emit one JSON line under `--json` for scripting, human lines otherwise;
//   4. honor the documented exit codes: 0 success, 1 rejection (missing
//      database, corrupt archive, verification failure), 2 usage error.
//
// Exit codes mirror the engine contract in @mmcs/database backup: a restore
// that does NOT pass the full row-count + checksum comparison is reported as
// a failure (exit 1), never as a silent success.

/** Command-spec shape for the CORE-011 dispatcher (mergeSpecs). */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const BACKUP_GROUP = "storage";

export const BACKUP_EXPORT_SPEC: CommandSpec = {
  name: "backup export",
  description:
    "Export the MMCS database to a restorable .mmcsbak archive (spec §25)",
  group: BACKUP_GROUP,
};

export const BACKUP_RESTORE_SPEC: CommandSpec = {
  name: "backup restore",
  description:
    "Restore a .mmcsbak archive into an empty database and verify counts+checksums",
  group: BACKUP_GROUP,
};

export const USAGE_BACKUP = [
  "Usage: mmcs backup export --db <path> --out <archive>",
  "       mmcs backup restore --archive <archive> --db <path> [--overwrite]",
  "",
  "Export snapshots the live (WAL-safe) database into ONE .mmcsbak file",
  "carrying a manifest: schema version, migration ledger, and per-table",
  "row counts + SHA-256 checksums (spec §25).",
  "",
  "Restore materializes the snapshot into an EMPTY database file and",
  "verifies the full row-count + checksum comparison — a restore that",
  "does not match is reported as a failure, never a silent success.",
  "",
  "Options (export):",
  "  --db <path>      path to the SQLite database (default: state/mmcs.db)",
  "  --out <archive>  archive path (.mmcsbak appended when missing)",
  "",
  "Options (restore):",
  "  --archive <archive>  the .mmcsbak archive to restore",
  "  --db <path>          target database file (must not exist without --force)",
  "  --force              overwrite an existing target database",
  "  --json               emit the result as one JSON line for scripting",
].join("\n");

/** Parsed long-option set shared by both verbs. */
export interface BackupOptions {
  readonly db?: string;
  readonly out?: string;
  readonly archive?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  /** True when an option was malformed (missing value / unknown flag). */
  readonly parseError?: string;
}

const VALUE_OPTIONS = new Set(["db", "out", "archive"]);

/**
 * Parse `argv` (already stripped of the verb words) into options. Unknown
 * flags are a usage error — never permissive (spec §24).
 */
export function parseBackupOptions(argv: readonly string[]): BackupOptions {
  const out: {
    db?: string;
    out?: string;
    archive?: string;
    force?: boolean;
    json?: boolean;
    parseError?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--force") {
      out.force = true;
      continue;
    }
    if (!token.startsWith("--")) {
      out.parseError = `unexpected argument: ${token}`;
      return out;
    }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (!VALUE_OPTIONS.has(name)) {
      out.parseError = `unknown option: --${name}`;
      return out;
    }
    if (value === undefined || value.startsWith("--")) {
      out.parseError = `option --${name} requires a value`;
      return out;
    }
    i++;
    if (name === "db") out.db = value;
    else if (name === "out") out.out = value;
    else if (name === "archive") out.archive = value;
  }
  return out;
}

/**
 * Ports over the durable world — injected by the CLI bootstrap at
 * integration. No filesystem or database access in this module itself.
 */
export interface BackupPorts {
  /** Export the database at `dbPath` to `outputPath`. */
  export(options: { readonly dbPath: string; readonly outputPath: string }): Promise<BackupExportResultLike>;
  /** Restore `archivePath` into `databasePath`. */
  restore(options: {
    readonly archivePath: string;
    readonly databasePath: string;
    readonly overwrite?: boolean;
  }): BackupRestoreResultLike;
  /** True when the database file exists (pre-flight for export). */
  databaseExists(dbPath: string): boolean;
  /** True when the archive file exists (pre-flight for restore). */
  archiveExists(archivePath: string): boolean;
}

/** Structural subset of @mmcs/database BackupExportResult — do not diverge. */
export interface BackupExportResultLike {
  readonly archivePath: string;
  readonly manifest: {
    readonly schemaVersion: string | null;
    readonly migrations: readonly string[];
    readonly tables: readonly { readonly table: string; readonly count: number; readonly sha256: string }[];
  };
  readonly archiveBytes: number;
}

/** Structural subset of @mmcs/database BackupRestoreResult — do not diverge. */
export interface BackupRestoreResultLike {
  readonly databasePath: string;
  readonly manifest: {
    readonly schemaVersion: string | null;
    readonly tables: readonly { readonly table: string; readonly count: number; readonly sha256: string }[];
  };
  readonly verified: boolean;
  readonly mismatches: readonly string[];
}

export interface BackupCommandResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
  json?: unknown;
}

/**
 * Execute `mmcs backup export`. Pure orchestration over injected ports.
 */
export async function runBackupExport(
  rawOptions: readonly string[],
  ports: BackupPorts,
): Promise<BackupCommandResult> {
  const options = parseBackupOptions(rawOptions);
  if (options.parseError !== undefined) {
    return {
      exitCode: 2,
      lines: [`[mmcs] backup export: ${options.parseError}`, USAGE_BACKUP],
    };
  }
  const dbPath = options.db ?? "state/mmcs.db";
  const outputPath = options.out;
  if (outputPath === undefined) {
    return { exitCode: 2, lines: [`[mmcs] backup export: --out is required`, USAGE_BACKUP] };
  }
  if (!ports.databaseExists(dbPath)) {
    return {
      exitCode: 1,
      lines: [`[mmcs] backup export: database not found: ${dbPath}`],
    };
  }

  let result: BackupExportResultLike;
  try {
    result = await ports.export({ dbPath, outputPath });
  } catch (err) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] backup export: failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const rowCount = result.manifest.tables.reduce((sum, t) => sum + t.count, 0);
  const lines = [
    `[mmcs] backup export: wrote ${result.archivePath} (${result.archiveBytes} bytes, schema ${result.manifest.schemaVersion ?? "none"}, ${result.manifest.tables.length} tables, ${rowCount} rows)`,
  ];
  const json = {
    archivePath: result.archivePath,
    archiveBytes: result.archiveBytes,
    schemaVersion: result.manifest.schemaVersion,
    migrations: result.manifest.migrations.length,
    tables: result.manifest.tables.length,
    rows: rowCount,
  };
  if (options.json) lines.push(JSON.stringify(json));
  return { exitCode: 0, lines, json };
}

/**
 * Execute `mmcs backup restore`. The restore's own verification (row counts
 * + checksums) decides the exit code: a failed comparison is exit 1.
 */
export function runBackupRestore(
  rawOptions: readonly string[],
  ports: BackupPorts,
): BackupCommandResult {
  const options = parseBackupOptions(rawOptions);
  if (options.parseError !== undefined) {
    return {
      exitCode: 2,
      lines: [`[mmcs] backup restore: ${options.parseError}`, USAGE_BACKUP],
    };
  }
  const archivePath = options.archive;
  const dbPath = options.db;
  if (archivePath === undefined || dbPath === undefined) {
    return {
      exitCode: 2,
      lines: [`[mmcs] backup restore: --archive and --db are required`, USAGE_BACKUP],
    };
  }
  if (!ports.archiveExists(archivePath)) {
    return {
      exitCode: 1,
      lines: [`[mmcs] backup restore: archive not found: ${archivePath}`],
    };
  }

  let result: BackupRestoreResultLike;
  try {
    result = ports.restore({
      archivePath,
      databasePath: dbPath,
      overwrite: options.force ?? false,
    });
  } catch (err) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] backup restore: failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (!result.verified) {
    return {
      exitCode: 1,
      lines: [
        `[mmcs] backup restore: VERIFICATION FAILED for ${result.databasePath}:`,
        ...result.mismatches.map((m) => `  - ${m}`),
      ],
    };
  }

  const rowCount = result.manifest.tables.reduce((sum, t) => sum + t.count, 0);
  const lines = [
    `[mmcs] backup restore: restored ${result.databasePath} (schema ${result.manifest.schemaVersion ?? "none"}, ${result.manifest.tables.length} tables, ${rowCount} rows) — row-count + checksum verification PASSED`,
  ];
  const json = {
    databasePath: result.databasePath,
    schemaVersion: result.manifest.schemaVersion,
    tables: result.manifest.tables.length,
    rows: rowCount,
    verified: true,
  };
  if (options.json) lines.push(JSON.stringify(json));
  return { exitCode: 0, lines, json };
}

/**
 * Wire the real handlers for the CORE-011 dispatcher (mergeSpecs).
 *
 * The dispatcher's wire() calls handlers as `handler(args, {})` — the
 * option VALUES never reach a plain object. When the integration registers
 * the flags on the commander subcommand, the dispatcher's action still
 * receives the Command instance as its last positional; those handlers read
 * the parsed values off that instance (`getOptionValue`). When it does not
 * (current CORE-011 wire), the flags never reach the handler either way, so
 * the handlers fall back to the documented defaults — the run* functions
 * remain the flag-accepting contract for programmatic/tested use.
 */
export function makeBackupHandlers(ports: BackupPorts): Record<string, (args: Record<string, string>, options: Record<string, unknown>) => void | Promise<void>> {
  const emit = (result: BackupCommandResult): void => {
    const stream = result.exitCode === 0 ? process.stdout : process.stderr;
    stream.write(result.lines.join("\n") + "\n");
  };
  /** Extract option values from a commander Command instance when present. */
  const readOptions = (options: Record<string, unknown>): string[] => {
    const getValue = (options as { getOptionValue?: (k: string) => unknown }).getOptionValue;
    if (typeof getValue !== "function") return [];
    const tokens: string[] = [];
    const push = (flag: string, v: unknown): void => {
      if (v === true) tokens.push(`--${flag}`);
      else if (typeof v === "string") tokens.push(`--${flag}`, v);
    };
    push("db", getValue.call(options, "db"));
    push("out", getValue.call(options, "out"));
    push("archive", getValue.call(options, "archive"));
    push("force", getValue.call(options, "force"));
    push("json", getValue.call(options, "json"));
    return tokens;
  };
  return {
    "backup export": (_args, options) => {
      runBackupExport(readOptions(options), ports)
        .then((result) => {
          emit(result);
          if (result.exitCode !== 0) {
            throw new Error(`backup export failed (exit ${result.exitCode})`);
          }
        })
        .catch((err: unknown) => {
          // The handler is invoked fire-and-forget by the dispatcher's wire()
          // (`void handler(...)`) — an async throw here would surface as an
          // unhandled promise rejection with a raw stack instead of the
          // command's clean failure. Record the exit code so the process
          // terminates non-zero, mirroring the synchronous restore handler.
          process.exitCode = 1;
          process.stderr.write(
            `[mmcs] backup export: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    },
    "backup restore": (_args, options) => {
      const result = runBackupRestore(readOptions(options), ports);
      emit(result);
      if (result.exitCode !== 0) {
        throw new Error(`backup restore failed (exit ${result.exitCode})`);
      }
    },
  };
}