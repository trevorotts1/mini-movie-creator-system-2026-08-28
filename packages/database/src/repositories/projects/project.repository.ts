import type { CreateProjectInput, Project, ProjectKind, ProjectStatus, UpdateProjectPatch } from "./types.js";
import type { SqliteDatabase } from "../../connection/index.js";
import { SchemaRepository, ValidationError, newId } from "./schema-repository.js";

const KINDS: readonly ProjectKind[] = ["series", "standalone"];
const STATUSES: readonly ProjectStatus[] = ["active", "archived"];
const NAME_MAX = 256;
const RATIO_MAX = 32;

export class SqliteProjectRepository extends SchemaRepository {
  readonly name = "projects";

  constructor(db: SqliteDatabase) {
    super(db);
  }

  create(input: CreateProjectInput): Project {
    const name = this.requireText("name", input.name, NAME_MAX);
    const kind = input.kind ?? "series";
    if (!KINDS.includes(kind)) {
      throw new ValidationError("kind", `must be one of ${KINDS.join(", ")}`);
    }
    const status = input.status ?? "active";
    if (!STATUSES.includes(status)) {
      throw new ValidationError("status", `must be one of ${STATUSES.join(", ")}`);
    }
    const aspectRatio = this.requireAspectRatio("aspectRatio", input.aspectRatio, "16:9");
    const now = new Date().toISOString();
    const project: Project = {
      id: newId("proj"),
      name,
      kind,
      status,
      aspectRatio,
      ghlFolderId: input.ghlFolderId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, kind, status, aspect_ratio, ghl_folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.kind,
        project.status,
        project.aspectRatio,
        project.ghlFolderId,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  findById(id: string): Project | undefined {
    return this.mapRow<Project, Project>(
      this.db.get("SELECT * FROM projects WHERE id = ?", id),
      mapProjectRow,
    );
  }

  update(id: string, patch: UpdateProjectPatch): Project | undefined {
    const existing = this.findById(id);
    if (existing === undefined) {
      return undefined;
    }
    const name = patch.name !== undefined ? this.requireText("name", patch.name, NAME_MAX) : existing.name;
    const status = patch.status ?? existing.status;
    if (!STATUSES.includes(status)) {
      throw new ValidationError("status", `must be one of ${STATUSES.join(", ")}`);
    }
    const aspectRatio =
      patch.aspectRatio !== undefined
        ? this.requireAspectRatio("aspectRatio", patch.aspectRatio, existing.aspectRatio)
        : existing.aspectRatio;
    const ghlFolderId = patch.ghlFolderId !== undefined ? patch.ghlFolderId : existing.ghlFolderId;
    this.db
      .prepare(
        `UPDATE projects SET name = ?, status = ?, aspect_ratio = ?, ghl_folder_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, status, aspectRatio, ghlFolderId, new Date().toISOString(), id);
    return this.findById(id);
  }

  setAspectRatio(id: string, aspectRatio: string): Project | undefined {
    return this.update(id, { aspectRatio });
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes) > 0;
  }

  list(): Project[] {
    return this.db.all("SELECT * FROM projects ORDER BY created_at, id").map(mapProjectRow);
  }
}

function mapProjectRow(row: Record<string, unknown>): Project {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    kind: row["kind"] === "standalone" ? "standalone" : "series",
    status: row["status"] === "archived" ? "archived" : "active",
    aspectRatio: String(row["aspect_ratio"]),
    ghlFolderId: row["ghl_folder_id"] === null ? null : String(row["ghl_folder_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}