/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { MIGRATIONS, migrate } from "../../migrations/index.js";
import { SqliteEpisodeRepository, SqliteProjectRepository, SqliteSeriesRepository } from "./index.js";
import { formatEpisodeCode } from "../episodes/episode.repository.js";
import type { Episode } from "./types.js";

let dir: string;
let db: SqliteDatabase;
let projects: SqliteProjectRepository;
let series: SqliteSeriesRepository;
let episodes: SqliteEpisodeRepository;
let projectId: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-repo-projects-"));
  db = connectSqlite({ path: join(dir, "repos.db") });
  migrate(db, MIGRATIONS);
  projects = new SqliteProjectRepository(db);
  series = new SqliteSeriesRepository(db);
  episodes = new SqliteEpisodeRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteProjectRepository", () => {
  it("creates with spec §23 default 16:9 aspect ratio", () => {
    const project = projects.create({ name: "Chess Chronicles" });
    projectId = project.id;
    expect(project.aspectRatio).toBe("16:9");
    expect(project.kind).toBe("series");
    expect(project.status).toBe("active");
    expect(project.id.startsWith("proj_")).toBe(true);
    expect(projects.findById(projectId)).toEqual(project);
  });

  it("creates a standalone project with custom ratio and GHL folder", () => {
    const p = projects.create({ name: "One-Off Short", kind: "standalone", aspectRatio: "9:16", ghlFolderId: "ghl-1" });
    expect(p.kind).toBe("standalone");
    expect(p.aspectRatio).toBe("9:16");
    expect(p.ghlFolderId).toBe("ghl-1");
  });

  it("updates name, status, aspect ratio, and clears ghl id", () => {
    const updated = projects.update(projectId, { name: "Chess Chronicles II", status: "archived", ghlFolderId: null });
    expect(updated?.name).toBe("Chess Chronicles II");
    expect(updated?.status).toBe("archived");
    expect(updated?.ghlFolderId).toBeNull();
    const ratio = projects.setAspectRatio(projectId, "2.39:1");
    expect(ratio?.aspectRatio).toBe("2.39:1");
    projects.setAspectRatio(projectId, "16:9");
  });

  it("rejects invalid input", () => {
    expect(() => projects.create({ name: "" })).toThrow();
    expect(() => projects.create({ name: "x", aspectRatio: "wide" })).toThrow(/aspect ratio/i);
    expect(() => projects.create({ name: "x", kind: "feature" as never })).toThrow(/kind/);
    expect(projects.update("nope", { name: "ghost" })).toBeUndefined();
  });

  it("lists and deletes", () => {
    expect(projects.list().length).toBeGreaterThanOrEqual(2);
    const p = projects.create({ name: "Temp" });
    expect(projects.delete(p.id)).toBe(true);
    expect(projects.delete(p.id)).toBe(false);
  });
});

describe("SqliteSeriesRepository", () => {
  it("creates under a project and lists by project", () => {
    const s = series.create({ projectId, name: "Season Master", aspectRatio: "16:9" });
    expect(s.id.startsWith("ser_")).toBe(true);
    expect(series.findById(s.id)).toEqual(s);
    expect(series.listByProject(projectId).map((x) => x.name)).toContain("Season Master");
    expect(series.listByProject("ghost")).toEqual([]);
  });

  it("rejects orphaned or invalid rows", () => {
    expect(() => series.create({ projectId: "missing", name: "Orphan" })).toThrow();
    expect(() => series.create({ projectId, name: "   " })).toThrow();
    // duplicate name within the same project hits UNIQUE constraint
    series.create({ projectId, name: "Unique Name" });
    expect(() => series.create({ projectId, name: "Unique Name" })).toThrow();
  });

  it("updates aspect ratio via setAspectRatio", () => {
    const s = series.create({ projectId, name: "Ratio Target" });
    const updated = series.setAspectRatio(s.id, "9:16");
    expect(updated?.aspectRatio).toBe("9:16");
  });
});

describe("SqliteEpisodeRepository", () => {
  let seriesId: string;

  beforeAll(() => {
    seriesId = series.create({ projectId, name: "Episode Parent" }).id;
  });

  it("creates with derived S01E03 code and NULL override by default", () => {
    const e = episodes.create({ projectId, seriesId, seasonNumber: 1, episodeNumber: 3, title: "The Opening" });
    expect(e.code).toBe("S01E03");
    expect(e.aspectRatioOverride).toBeNull();
    expect(e.status).toBe("draft");
    expect(episodes.findById(e.id)).toEqual(e);
  });

  it("rejects a projectId that does not match the series' own project", () => {
    const other = projects.create({ name: "Other Project" });
    expect(() =>
      episodes.create({ projectId: other.id, seriesId, seasonNumber: 1, episodeNumber: 30, title: "Cross-Wired" }),
    ).toThrow(/project/);
    // Unknown series must fail loudly too, not silently orphan.
    expect(() =>
      episodes.create({ projectId, seriesId: "ser_ghost", seasonNumber: 1, episodeNumber: 31, title: "Ghost" }),
    ).toThrow(/series/);
  });

  it("stores an explicit null aspectRatioOverride as NULL inherit, not the default", () => {
    const e = episodes.create({
      projectId,
      seriesId,
      seasonNumber: 1,
      episodeNumber: 32,
      title: "Explicit Null",
      aspectRatioOverride: null,
    });
    expect(e.aspectRatioOverride).toBeNull();
  });

  it("formats deterministic codes across season boundaries", () => {
    expect(formatEpisodeCode(1, 3)).toBe("S01E03");
    expect(formatEpisodeCode(12, 345)).toBe("S12E345");
  });

  it("rejects zero/negative season or episode numbers", () => {
    expect(() => episodes.create({ projectId, seriesId, seasonNumber: 0, episodeNumber: 1, title: "x" })).toThrow(/seasonNumber/);
    expect(() => episodes.create({ projectId, seriesId, seasonNumber: 1, episodeNumber: -2, title: "x" })).toThrow(/episodeNumber/);
    expect(() => episodes.create({ projectId, seriesId, seasonNumber: 1, episodeNumber: 1, title: "", aspectRatioOverride: "bad" })).toThrow();
  });

  it("supports the per-episode aspect-ratio override (spec §23)", () => {
    const e = episodes.create({
      projectId,
      seriesId,
      seasonNumber: 1,
      episodeNumber: 4,
      title: "Vertical Cut",
      aspectRatioOverride: "9:16",
    });
    expect(e.aspectRatioOverride).toBe("9:16");
    const cleared = episodes.setAspectRatioOverride(e.id, null);
    expect(cleared?.aspectRatioOverride).toBeNull();
    const overridden = episodes.setAspectRatioOverride(e.id, "1:1");
    expect(overridden?.aspectRatioOverride).toBe("1:1");
  });

  it("falls back to series aspect ratio when no override (effectiveAspectRatio)", () => {
    const s = series.create({ projectId, name: "Ratio Series", aspectRatio: "2.39:1" });
    const e = episodes.create({ projectId, seriesId: s.id, seasonNumber: 2, episodeNumber: 1, title: "Inherit" });
    expect(episodes.effectiveAspectRatio(e.id)).toBe("2.39:1");
    episodes.setAspectRatioOverride(e.id, "9:16");
    expect(episodes.effectiveAspectRatio(e.id)).toBe("9:16");
    episodes.setAspectRatioOverride(e.id, null);
    expect(episodes.effectiveAspectRatio(e.id)).toBe("2.39:1");
    expect(episodes.effectiveAspectRatio("ghost")).toBeUndefined();
  });

  it("updates status and target runtime", () => {
    const e = episodes.create({ projectId, seriesId, seasonNumber: 3, episodeNumber: 1, title: "Runtime" });
    const updated = episodes.update(e.id, { status: "final", targetRuntimeSeconds: 720 });
    expect(updated?.status).toBe("final");
    expect(updated?.targetRuntimeSeconds).toBe(720);
    expect(() => episodes.update(e.id, { status: "bogus" as never })).toThrow(/status/);
  });

  it("lists by series, season, and project in deterministic order", () => {
    const s = series.create({ projectId, name: "List Series" });
    episodes.create({ projectId, seriesId: s.id, seasonNumber: 1, episodeNumber: 2, title: "B" });
    episodes.create({ projectId, seriesId: s.id, seasonNumber: 1, episodeNumber: 1, title: "A" });
    episodes.create({ projectId, seriesId: s.id, seasonNumber: 2, episodeNumber: 1, title: "C" });
    const all = episodes.listBySeries(s.id);
    expect(all.map((x) => x.title)).toEqual(["A", "B", "C"]);
    const season1 = episodes.listBySeries(s.id, 1);
    expect(season1.map((x) => x.title)).toEqual(["A", "B"]);
    const projectList = episodes.listByProject(projectId);
    expect(projectList.length).toBeGreaterThanOrEqual(5);
    expect(episodes.listByProject("ghost")).toEqual([]);
  });

  it("cascade deletes episodes and series when the project is deleted", () => {
    const p = projects.create({ name: "Cascade" });
    const s = series.create({ projectId: p.id, name: "Cascade Series" });
    episodes.create({ projectId: p.id, seriesId: s.id, seasonNumber: 1, episodeNumber: 1, title: "Cascade Ep" });
    projects.delete(p.id);
    expect(series.findById(s.id)).toBeUndefined();
    expect(episodes.listByProject(p.id)).toEqual([]);
  });

  it("keeps domain objects plain (no driver-row prototype)", () => {
    const e = episodes.list()[0];
    expect(e).toBeDefined();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    expect(Object.keys(e as Episode)).not.toContain("aspect_ratio_override");
  });
});