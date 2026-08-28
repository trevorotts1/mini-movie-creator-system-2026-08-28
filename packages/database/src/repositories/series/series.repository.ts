import type { SqliteDatabase } from "../../connection/index.js";
import { SchemaRepository, ValidationError, newId } from "../projects/schema-repository.js";
import type { CreateSeriesInput, Series, UpdateSeriesPatch } from "./types.js";

const NAME_MAX = 256;

export class SqliteSeriesRepository extends SchemaRepository {
  readonly name = "series";

  constructor(db: SqliteDatabase) {
    super(db);
  }

  create(input: CreateSeriesInput): Series {
    const name = this.requireText("name", input.name, NAME_MAX);
    const aspectRatio = this.requireAspectRatio("aspectRatio", input.aspectRatio, "16:9");
    if (typeof input.projectId !== "string" || input.projectId.length === 0) {
      throw new ValidationError("projectId", "must be a non-empty string");
    }
    const now = new Date().toISOString();
    const series: Series = {
      id: newId("ser"),
      projectId: input.projectId,
      name,
      aspectRatio,
      ghlFolderId: input.ghlFolderId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO series (id, project_id, name, aspect_ratio, ghl_folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        series.id,
        series.projectId,
        series.name,
        series.aspectRatio,
        series.ghlFolderId,
        series.createdAt,
        series.updatedAt,
      );
    return series;
  }

  findById(id: string): Series | undefined {
    return this.mapRow<Series, Series>(this.db.get("SELECT * FROM series WHERE id = ?", id), mapSeriesRow);
  }

  update(id: string, patch: UpdateSeriesPatch): Series | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    const name = patch.name !== undefined ? this.requireText("name", patch.name, NAME_MAX) : existing.name;
    const aspectRatio =
      patch.aspectRatio !== undefined
        ? this.requireAspectRatio("aspectRatio", patch.aspectRatio, existing.aspectRatio)
        : existing.aspectRatio;
    const ghlFolderId = patch.ghlFolderId !== undefined ? patch.ghlFolderId : existing.ghlFolderId;
    this.db
      .prepare(`UPDATE series SET name = ?, aspect_ratio = ?, ghl_folder_id = ?, updated_at = ? WHERE id = ?`)
      .run(name, aspectRatio, ghlFolderId, new Date().toISOString(), id);
    return this.findById(id);
  }

  setAspectRatio(id: string, aspectRatio: string): Series | undefined {
    return this.update(id, { aspectRatio });
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM series WHERE id = ?").run(id).changes) > 0;
  }

  list(): Series[] {
    return this.db.all("SELECT * FROM series ORDER BY created_at, id").map(mapSeriesRow);
  }

  listByProject(projectId: string): Series[] {
    return this.db
      .all("SELECT * FROM series WHERE project_id = ? ORDER BY created_at, id", projectId)
      .map(mapSeriesRow);
  }
}

function mapSeriesRow(row: Record<string, unknown>): Series {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    name: String(row["name"]),
    aspectRatio: String(row["aspect_ratio"]),
    ghlFolderId: row["ghl_folder_id"] === null ? null : String(row["ghl_folder_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}