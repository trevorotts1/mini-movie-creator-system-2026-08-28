/// <reference types="node" />
// Independent §12 verification: the spec's own field list, parsed here as
// literal text, must be a subset of the live table columns. Deliberately
// does NOT import SHOT_SPEC_FIELDS — if that constant drifts from the
// spec this test fails instead of passing in lockstep with it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, "../../../../../spec.md");
const SECTION_12 = "## 12. SHOT SPECIFICATION RECORD";

/** Extracts the §12 backticked field names straight from spec.md. */
function specFieldNames(): string[] {
  const spec = readFileSync(SPEC_PATH, "utf8");
  const start = spec.indexOf(SECTION_12);
  if (start < 0) {
    throw new Error("spec.md §12 not found");
  }
  const section = spec.slice(start, spec.indexOf("## 13.", start));
  return [...section.matchAll(/`([a-z_]+[a-z_/]*)`/g)]
    .map((m) => (m[1] ?? "").replace("/", "_")) // spec writes `lens/style`; the column is `lens_style`
    .filter((name) => name.length > 0 && name !== "13.");
}

let dir: string;
let db: SqliteDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-schema-"));
  db = connectSqlite({ path: join(dir, "schema.db") });
  migrate(db, MIGRATIONS);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spec §12 contract — independent introspection", () => {
  it("spec.md itself yields the 30 required field names", () => {
    const fields = specFieldNames();
    expect(fields).toHaveLength(30);
    expect(fields[0]).toBe("shot_id");
    expect(fields.at(-1)).toBe("qc_status");
  });

  it("every spec §12 field exists as a shots column (live PRAGMA introspection)", () => {
    const columns = db.all("PRAGMA table_info(shots)").map((row) => String(row["name"]));
    const missing = specFieldNames().filter((field) => !columns.includes(field));
    expect(missing).toEqual([]);
  });

  it("scenes and shot_references tables exist after MIGRATIONS", () => {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r["name"]));
    expect(tables).toContain("scenes");
    expect(tables).toContain("shots");
    expect(tables).toContain("shot_references");
  });
});