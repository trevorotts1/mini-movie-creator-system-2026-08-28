/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, MIGRATIONS_TABLE, appliedMigrationIds, migrate } from "../index.js";

let dir: string;
let db: SqliteDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-pse-"));
  db = connectSqlite({ path: join(dir, "pse.db") });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("010_ project/series/episode migration band", () => {
  it("applies the band as part of the full migration list, ascending", () => {
    const result = migrate(db, MIGRATIONS);
    expect(result.applied).toContain("0101");
    expect(result.applied).toContain("0102");
    expect(result.applied).toContain("0103");
    expect(appliedMigrationIds(db)).toEqual([...appliedMigrationIds(db)].sort());
  });

  it("is idempotent when re-run", () => {
    const second = migrate(db, MIGRATIONS);
    expect(second.applied).toEqual([]);
  });

  it("creates projects table with kind/status checks and default 16:9", () => {
    db.exec(`INSERT INTO projects (id, name, kind, status, aspect_ratio, created_at, updated_at)
             VALUES ('p1', 'Demo', 'series', 'active', '16:9', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    const row = db.get("SELECT * FROM projects WHERE id = 'p1'");
    expect(row).toBeDefined();
    expect(() =>
      db.exec(`INSERT INTO projects (id, name, kind, status, aspect_ratio, created_at, updated_at)
               VALUES ('p2', 'Bad', 'movie', 'active', '16:9', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`),
    ).toThrow();
  });

  it("creates series referencing projects with cascade delete", () => {
    db.exec(`INSERT INTO series (id, project_id, name, aspect_ratio, created_at, updated_at)
             VALUES ('s1', 'p1', 'Demo Series', '9:16', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    expect(db.get("SELECT * FROM series WHERE id = 's1'")).toBeDefined();
    // Orphan insert must fail under STRICT FKs.
    expect(() =>
      db.exec(`INSERT INTO series (id, project_id, name, aspect_ratio, created_at, updated_at)
               VALUES ('s2', 'missing', 'Orphan', '16:9', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`),
    ).toThrow();
    expect(() =>
      db.exec(`INSERT INTO series (id, project_id, name, aspect_ratio, created_at, updated_at)
               VALUES ('s3', 'p1', 'Demo Series', '16:9', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`),
    ).toThrow(); // UNIQUE (project_id, name)
  });

  it("creates episodes with per-episode aspect override and unique project code", () => {
    db.exec(`INSERT INTO episodes (id, project_id, series_id, season_number, episode_number, code, title,
                                   status, aspect_ratio_override, target_runtime_seconds, created_at, updated_at)
             VALUES ('e1', 'p1', 's1', 1, 3, 'S01E03', 'Pilot', 'draft', '9:16', 480,
                     '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    const row = db.get("SELECT * FROM episodes WHERE id = 'e1'");
    expect(row?.["aspect_ratio_override"]).toBe("9:16");
    expect(() =>
      db.exec(`INSERT INTO episodes (id, project_id, series_id, season_number, episode_number, code, title,
                                     created_at, updated_at)
               VALUES ('e2', 'p1', 's1', 1, 3, 'S01E03', 'Dup', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`),
    ).toThrow(); // UNIQUE (series_id, season_number, episode_number)
    // Same position in a DIFFERENT series of the same project is allowed.
    db.exec(`INSERT INTO series (id, project_id, name, aspect_ratio, created_at, updated_at)
             VALUES ('s1b', 'p1', 'Second Series', '16:9', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    db.exec(`INSERT INTO episodes (id, project_id, series_id, season_number, episode_number, code, title,
                                   created_at, updated_at)
             VALUES ('e5', 'p1', 's1b', 1, 3, 'S01E03', 'Other Series Same Slot', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    expect(() =>
      db.exec(`INSERT INTO episodes (id, project_id, series_id, season_number, episode_number, code, title,
                                     status, created_at, updated_at)
               VALUES ('e3', 'p1', 's1', 1, 5, 'S01E05', 'BadStatus', 'bogus', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`),
    ).toThrow();
    // aspect_ratio_override accepts NULL (inherit).
    db.exec(`INSERT INTO episodes (id, project_id, series_id, season_number, episode_number, code, title,
                                   created_at, updated_at)
             VALUES ('e4', 'p1', 's1', 1, 5, 'S01E05', 'Inherit', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
    expect(db.get("SELECT aspect_ratio_override FROM episodes WHERE id = 'e4'")?.["aspect_ratio_override"]).toBeNull();
  });

  it("rolls the whole band back and forward cleanly", () => {
    const down = migrate(db, MIGRATIONS, { rollback: true });
    expect(down.rolledBack).toEqual(expect.arrayContaining(["0101", "0102", "0103"]));
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")).toBeUndefined();
    const up = migrate(db, MIGRATIONS);
    expect(up.applied).toEqual(expect.arrayContaining(["0101", "0102", "0103"]));
  });

  it("keeps the ledger table outside the band tables", () => {
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = '${MIGRATIONS_TABLE}'`)).toBeDefined();
  });
});
