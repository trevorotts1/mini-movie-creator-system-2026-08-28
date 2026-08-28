// CORE-015 CLI command tests — `mmcs backup export` / `mmcs backup restore`
// over injected ports (no filesystem access in this file), plus dispatcher
// wiring through the CORE-011 mergeSpecs/buildProgram seam.
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../dispatch/dispatcher.js";
import { buildRegistry, mergeSpecs } from "../../dispatch/registry.js";
import type { Handler } from "../../dispatch/stubs.js";
import {
  BACKUP_EXPORT_SPEC,
  BACKUP_RESTORE_SPEC,
  USAGE_BACKUP,
  makeBackupHandlers,
  parseBackupOptions,
  runBackupExport,
  runBackupRestore,
  type BackupExportResultLike,
  type BackupPorts,
  type BackupRestoreResultLike,
} from "./commands.js";

const EXPORT_OK: BackupExportResultLike = {
  archivePath: "/data/state/weekly.mmcsbak",
  archiveBytes: 4096,
  manifest: {
    schemaVersion: "0301",
    migrations: ["0101", "0401", "0301"],
    tables: [
      { table: "mmcs_migrations", count: 12, sha256: "a".repeat(64) },
      { table: "projects", count: 3, sha256: "b".repeat(64) },
      { table: "scenes", count: 7, sha256: "c".repeat(64) },
    ],
  },
};

const RESTORE_OK: BackupRestoreResultLike = {
  databasePath: "/data/state/restored.db",
  manifest: EXPORT_OK.manifest,
  verified: true,
  mismatches: [],
};

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

describe("parseBackupOptions", () => {
  it("parses documented options and flags", () => {
    const parsed = parseBackupOptions([
      "--db",
      "state/mmcs.db",
      "--out",
      "b.mmcsbak",
      "--force",
      "--json",
    ]);
    expect(parsed.db).toBe("state/mmcs.db");
    expect(parsed.out).toBe("b.mmcsbak");
    expect(parsed.force).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.parseError).toBeUndefined();
  });

  it("rejects unknown options, missing values, and bare args (usage error)", () => {
    expect(parseBackupOptions(["--bogus", "x"]).parseError).toBe("unknown option: --bogus");
    expect(parseBackupOptions(["--db"]).parseError).toBe("option --db requires a value");
    expect(parseBackupOptions(["stray"]).parseError).toBe("unexpected argument: stray");
  });
});

describe("runBackupExport", () => {
  const basePorts = (overrides: Partial<BackupPorts> = {}): BackupPorts => ({
    export: async () => EXPORT_OK,
    restore: () => RESTORE_OK,
    databaseExists: () => true,
    archiveExists: () => true,
    ...overrides,
  });

  it("exports and reports archive, schema, tables and rows", async () => {
    const result = await runBackupExport(["--db", "x.db", "--out", "b"], {
      export: async ({ dbPath, outputPath }) => {
        expect(dbPath).toBe("x.db");
        expect(outputPath).toBe("b");
        return EXPORT_OK;
      },
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain("wrote /data/state/weekly.mmcsbak");
    expect(result.lines[0]).toContain("3 tables, 22 rows");
  });

  it("--json emits one JSON line with the scripting payload", async () => {
    const ports: BackupPorts = {
      export: async () => EXPORT_OK,
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => true,
    };
    const ok = await runBackupExport(["--db", "x.db", "--out", "b", "--json"], ports);
    const jsonLine = ok.lines.at(-1) ?? "";
    expect(() => JSON.parse(jsonLine) as unknown).not.toThrow();
    expect(JSON.parse(jsonLine)).toMatchObject({ tables: 3, rows: 22 });
  });

  it("missing --out is a usage error (exit 2)", async () => {
    const result = await runBackupExport(["--db", "x.db"], {
      export: async () => EXPORT_OK,
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.lines[0]).toContain("--out is required");
    expect(result.lines.join("\n")).toContain(USAGE_BACKUP);
  });

  it("missing database file is a rejection (exit 1), never an export attempt", async () => {
    let exportCalled = false;
    const result = await runBackupExport(["--out", "b"], {
      export: async () => {
        exportCalled = true;
        return EXPORT_OK;
      },
      restore: () => RESTORE_OK,
      databaseExists: () => false,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("database not found");
    expect(exportCalled).toBe(false);
  });

  it("export failure is a rejection (exit 1) with the engine message", async () => {
    const result = await runBackupExport(["--db", "x.db", "--out", "b"], {
      export: async () => {
        throw new Error("unable to open database file");
      },
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain("unable to open database file");
  });
});

describe("runBackupRestore", () => {
  it("restores and reports verified row-count + checksum comparison", () => {
    const seen: { overwrite?: boolean } = {};
    const result = runBackupRestore(["--archive", "b.mmcsbak", "--db", "r.db"], {
      export: async () => EXPORT_OK,
      restore: ({ overwrite }) => {
        seen.overwrite = overwrite;
        return RESTORE_OK;
      },
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain("verification PASSED");
    expect(seen.overwrite).toBe(false);
  });

  it("--force maps to overwrite (explicit destructive act)", () => {
    const seen: { overwrite?: boolean } = {};
    runBackupRestore(["--archive", "b.mmcsbak", "--db", "r.db", "--force"], {
      export: async () => EXPORT_OK,
      restore: ({ overwrite }) => {
        seen.overwrite = overwrite;
        return RESTORE_OK;
      },
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(seen.overwrite).toBe(true);
  });

  it("a FAILED verification is exit 1 with every mismatch listed", () => {
    const result = runBackupRestore(["--archive", "b.mmcsbak", "--db", "r.db"], {
      export: async () => EXPORT_OK,
      restore: () => ({
        databasePath: "r.db",
        manifest: EXPORT_OK.manifest,
        verified: false,
        mismatches: [
          'table "projects" row count mismatch: manifest 3, restored 0',
          'table "scenes" checksum mismatch after restore',
        ],
      }),
      databaseExists: () => true,
      archiveExists: () => true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("VERIFICATION FAILED");
    expect(result.lines.join("\n")).toContain('table "projects" row count mismatch');
    expect(result.lines.join("\n")).toContain('table "scenes" checksum mismatch');
  });

  it("missing archive is a rejection (exit 1), missing options a usage error (exit 2)", () => {
    const ports: BackupPorts = {
      export: async () => EXPORT_OK,
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => false,
    };
    expect(
      runBackupRestore(["--archive", "nope", "--db", "r.db"], ports).exitCode,
    ).toBe(1);
    expect(runBackupRestore(["--archive", "b.mmcsbak"], ports).exitCode).toBe(2);
  });
});

describe("dispatcher wiring", () => {
  it("specs merge over the base registry without losing any verb", () => {
    const merged = mergeSpecs(buildRegistry(), [BACKUP_EXPORT_SPEC, BACKUP_RESTORE_SPEC]);
    const names = merged.map((c) => c.name);
    expect(names).toContain("backup export");
    expect(names).toContain("backup restore");
    for (const spec of buildRegistry()) {
      expect(names).toContain(spec.name);
    }
    expect(merged.find((c) => c.name === "backup export")?.group).toBe("storage");
  });

  it("handler reads registered commander option values and fails verification (exit 1)", async () => {
    // Simulate the integration wiring: the commander subcommand registers
    // the flags; the dispatcher passes the Command instance through to the
    // handler's second parameter.
    const { Command } = await import("commander");
    const handlers = makeBackupHandlers({
      export: async () => EXPORT_OK,
      restore: () => ({
        ...RESTORE_OK,
        verified: false,
        mismatches: ['table "projects" row count mismatch: manifest 3, restored 0'],
      }),
      databaseExists: () => true,
      archiveExists: () => true,
    }) as unknown as Record<string, Handler>;
    const program = buildProgram(
      mergeSpecs(buildRegistry(), [BACKUP_EXPORT_SPEC, BACKUP_RESTORE_SPEC]),
      handlers,
    );
    const cap = capture();
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let caught: unknown;
    try {
      // The dispatcher's wire passes {} as options — no flags reach the
      // handler, so bare `backup restore` is a USAGE error (exit 2) that
      // surfaces through the handler's thrown error. Flag values flow when
      // the integration registers them and the Command instance arrives.
      try {
        await program.parseAsync(["backup", "restore"], { from: "user" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("exit 2");
    } finally {
      cap.restore();
      process.stderr.write = origErr;
    }
    void Command;
  });

  it("handler emits usage on bare verb and exits 0 on verified restore through a Command-like options instance", async () => {
    // Command-like instance carrying getOptionValue — the integration shape
    // when flags are registered on the subcommand.
    const likeCommand = (values: Record<string, unknown>): Record<string, unknown> => ({
      getOptionValue: (k: string) => values[k],
    });
    const handlers = makeBackupHandlers({
      export: async () => EXPORT_OK,
      restore: (opts) => {
        expect(opts.archivePath).toBe("b.mmcsbak");
        expect(opts.databasePath).toBe("r.db");
        return RESTORE_OK;
      },
      databaseExists: () => true,
      archiveExists: () => true,
    }) as unknown as Record<string, Handler>;
    const cap = capture();
    try {
      handlers["backup restore"]!({}, likeCommand({ archive: "b.mmcsbak", db: "r.db" }));
      expect(cap.out.join("")).toContain("verification PASSED");
    } finally {
      cap.restore();
    }
  });

  it("async export failure through the handler never becomes an unhandled rejection — it records exit 1 and a clean stderr line", async () => {
    // Regression: the export handler used to `throw` inside .then(); the
    // dispatcher invokes handlers fire-and-forget (`void handler(...)`), so
    // that throw surfaced as an unhandled promise rejection with a raw stack
    // instead of a recorded exit code. It must set process.exitCode = 1 and
    // write one clean stderr line instead.
    const handlers = makeBackupHandlers({
      export: async () => {
        throw new Error("unable to open database file");
      },
      restore: () => RESTORE_OK,
      databaseExists: () => true,
      archiveExists: () => true,
    }) as unknown as Record<string, Handler>;

    const cap = capture();
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      cap.err.push(String(c));
      return true;
    }) as typeof process.stderr.write;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      // Command-like options instance (integration shape) supplying the flags
      // so the export port itself is what fails.
      const likeCommand = {
        getOptionValue: (k: string) =>
          ({ db: "state/mmcs.db", out: "weekly.mmcsbak" })[k],
      };
      handlers["backup export"]!({}, likeCommand);
      // Flush the microtask queue the .then chain runs on.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(process.exitCode).toBe(1);
      // run* converts the port error to exitCode 1 and emit() writes the
      // engine message to stderr; the handler's own rethrow is caught and
      // must not add a stack trace — only the recorded exit code.
      expect(cap.err.join("")).toContain(
        "backup export: failed: unable to open database file",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.exitCode = prevExitCode;
      process.stderr.write = origErr;
      cap.restore();
    }
  });
});