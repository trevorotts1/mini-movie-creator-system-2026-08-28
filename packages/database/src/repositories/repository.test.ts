/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseRepository, type CrudRepository } from "./index.js";
import { connectSqlite, type SqliteDatabase } from "../connection/index.js";

interface Widget {
  id: number;
  label: string;
}
type WidgetPatch = Partial<Pick<Widget, "label">>;

class WidgetRepository extends BaseRepository implements CrudRepository<number, Widget, WidgetPatch> {
  readonly name = "widgets";

  create(entity: Widget): Widget {
    this.db.prepare("INSERT INTO widgets (id, label) VALUES (?, ?)").run(entity.id, entity.label);
    return entity;
  }

  findById(id: number): Widget | undefined {
    return this.mapRow<Widget, Widget>(
      this.db.get("SELECT id, label FROM widgets WHERE id = ?", id),
      (row) => ({ id: Number(row["id"]), label: String(row["label"]) }),
    );
  }

  update(id: number, patch: WidgetPatch): Widget | undefined {
    if (patch.label !== undefined) {
      this.db.prepare("UPDATE widgets SET label = ? WHERE id = ?").run(patch.label, id);
    }
    return this.findById(id);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM widgets WHERE id = ?").run(id).changes) > 0;
  }

  list(): Widget[] {
    return this.db.all("SELECT id, label FROM widgets ORDER BY id").map((row) => ({
      id: Number(row["id"]),
      label: String(row["label"]),
    }));
  }
}

let dir: string;
let db: SqliteDatabase;
let widgets: WidgetRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-repo-"));
  db = connectSqlite({ path: join(dir, "repo.db") });
  db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;");
  widgets = new WidgetRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("repository base contract", () => {
  it("exposes a name for registry wiring", () => {
    expect(widgets.name).toBe("widgets");
  });

  it("supports the CRUD surface", () => {
    widgets.create({ id: 1, label: "one" });
    expect(widgets.findById(1)).toEqual({ id: 1, label: "one" });
    expect(widgets.update(1, { label: "uno" })).toEqual({ id: 1, label: "uno" });
    expect(widgets.list()).toEqual([{ id: 1, label: "uno" }]);
    expect(widgets.delete(1)).toBe(true);
    expect(widgets.delete(1)).toBe(false);
    expect(widgets.findById(1)).toBeUndefined();
    expect(widgets.update(404, { label: "ghost" })).toBeUndefined();
  });

  it("maps missing rows to undefined via mapRow", () => {
    expect(widgets.findById(999)).toBeUndefined();
  });

  it("keeps domain types free of raw driver rows", () => {
    widgets.create({ id: 2, label: "two" });
    const found = widgets.findById(2);
    // Domain object shape, not an [Object: null prototype] driver row.
    expect(found).toBeTypeOf("object");
    expect(Object.getPrototypeOf(found)).toBe(Object.prototype);
  });
});
