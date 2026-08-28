/**
 * GHL-010 tests — episode folder ensure + persistence (spec §17).
 * All HTTP is mocked via the seam; SQLite runs in-memory; no credentials.
 */
import { describe, expect, it } from "vitest";
import { connectSqlite, migrate, MIGRATIONS } from "@mmcs/database";
import {
  EPISODE_SUBFOLDERS,
  EPISODE_SUBFOLDER_KEYS,
  EpisodeFolderEnsurer,
  EpisodeFolderStore,
  seasonFolderName,
  type CreateFolderInput,
  type EpisodeFolderIds,
  type EpisodeFolderRecord,
  type EpisodeFolderRequest,
  type EpisodeFoldersClient,
  type FindFoldersQuery,
  type GhlFolder,
} from "./index.js";

/** In-memory GHL folder state + recording client (search-before-create proof). */
class RecordingClient implements EpisodeFoldersClient {
  readonly searches: FindFoldersQuery[] = [];
  readonly creates: CreateFolderInput[] = [];
  readonly folders = new Map<string, { id: string; name: string; parentId?: string }>();
  private nextId = 1;

  /** Pre-seed an existing folder (simulates a prior run / GHL-004 tree). */
  seed(name: string, parentId?: string): GhlFolder {
    const id = `fld_${this.nextId++}`;
    this.folders.set(id, { id, name, parentId });
    return { id, name, parentId };
  }

  /** Replay another client's creates into this one (same IDs by name). */
  replayFrom(other: RecordingClient): void {
    const idMap = new Map<string, string>();
    for (const create of other.creates) {
      const created = this.seed(create.name, create.parentId);
      idMap.set(create.name, created.id);
    }
    // Rebind parent IDs from run-1 IDs to this store's IDs.
    const nameOf = new Map<string, string>();
    for (const [name, id] of idMap) nameOf.set(id, name);
    for (const [id, folder] of this.folders) {
      void id;
      if (folder.parentId === undefined) continue;
      const parentName = nameOf.get(folder.parentId);
      if (parentName === undefined) continue;
      const mapped = idMap.get(parentName);
      if (mapped !== undefined) folder.parentId = mapped;
    }
  }

  idByName(name: string): string {
    for (const f of this.folders.values()) {
      if (f.name === name) return f.id;
    }
    throw new Error(`no folder named "${name}" in mock store`);
  }

  async findFolders(query: FindFoldersQuery): Promise<GhlFolder[]> {
    this.searches.push({ ...query });
    const out: GhlFolder[] = [];
    for (const f of this.folders.values()) {
      if (f.name !== query.name) continue;
      if ((f.parentId ?? undefined) !== (query.parentId ?? undefined)) continue;
      out.push({ ...f });
    }
    return out;
  }

  async createFolder(input: CreateFolderInput): Promise<GhlFolder> {
    this.creates.push({ ...input });
    return this.seed(input.name, input.parentId);
  }

  get createCount(): number {
    return this.creates.length;
  }
}

function makeEnsurer() {
  const db = connectSqlite({ path: ":memory:" });
  migrate(db, MIGRATIONS);
  const client = new RecordingClient();
  const store = new EpisodeFolderStore(db);
  const ensurer = new EpisodeFolderEnsurer({ client, store });
  return { db, client, store, ensurer };
}

/** Fresh SQLite (as after a restart) — new store, empty records. */
function freshStore(): { store: EpisodeFolderStore; dispose: () => void } {
  const db = connectSqlite({ path: ":memory:" });
  migrate(db, MIGRATIONS);
  return { store: new EpisodeFolderStore(db), dispose: () => void db };
}

const baseRequest: EpisodeFolderRequest = {
  locationId: "loc_1",
  seriesId: "ser_1",
  episodeId: "ep_1",
  seriesName: "Harbor Lights",
  seasonNumber: 1,
  episodeNumber: 1,
  title: "Pilot",
};


/** Narrow a flat record to the ID-set view for comparisons. */
function toIds(record: EpisodeFolderRecord): EpisodeFolderIds {
  const { episodeId: _e, seriesId: _s, locationId: _l, createdAt: _c, updatedAt: _u, ...ids } = record;
  void _e; void _s; void _l; void _c; void _u;
  return ids;
}

describe("GHL-010 — episode folder creation + persistence", () => {
  it("creates Series/<Name>/Season 01/S01E01 - <Title>/ with all 9 subfolders and persists every ID", async () => {
    const { client, store, ensurer } = makeEnsurer();

    const result = await ensurer.ensure(baseRequest);

    // Structural acceptance: root + Series + series + season + episode + 9
    // subfolders = 14 creates on empty state.
    expect(result.createdCount).toBe(14);
    expect(result.ids.episodeName).toBe("S01E01 - Pilot");

    // All nine subfolder IDs present, non-empty, and distinct.
    for (const key of EPISODE_SUBFOLDER_KEYS) {
      expect(typeof result.ids[key]).toBe("string");
      expect((result.ids[key] as string).length).toBeGreaterThan(0);
    }
    const subIds = EPISODE_SUBFOLDER_KEYS.map((k) => result.ids[k]);
    expect(new Set(subIds).size).toBe(9);

    // The record round-trips every ID through SQLite.
    const record = store.findByEpisodeId("ep_1");
    expect(record).toBeDefined();
    expect(record?.episode).toBe(result.ids.episode);
    expect(record?.episodeName).toBe("S01E01 - Pilot");
    expect(record?.seriesId).toBe("ser_1");
    expect(record?.locationId).toBe("loc_1");
    for (const key of EPISODE_SUBFOLDER_KEYS) {
      expect(record?.[key]).toBe(result.ids[key]);
    }

    // Creates happened in §17 order: spine first, then subfolders.
    const createdNames = client.creates.map((c) => c.name);
    expect(createdNames).toEqual([
      "Convert and Flow",
      "Series",
      "Harbor Lights",
      "Season 01",
      "S01E01 - Pilot",
      ...EPISODE_SUBFOLDERS,
    ]);
  });

  it("parents each level correctly (spine chain + subfolders under the episode folder)", async () => {
    const { client, ensurer } = makeEnsurer();
    const result = await ensurer.ensure(baseRequest);

    expect(result.ids.root).toBe(client.idByName("Convert and Flow"));
    expect(result.ids.seriesNode).toBe(client.idByName("Series"));
    expect(result.ids.series).toBe(client.idByName("Harbor Lights"));
    expect(result.ids.season).toBe(client.idByName("Season 01"));
    expect(result.ids.episode).toBe(client.idByName("S01E01 - Pilot"));

    // Subfolders were created under the episode folder ID.
    for (const sub of EPISODE_SUBFOLDERS) {
      const create = client.creates.find((c) => c.name === sub);
      expect(create, sub).toBeDefined();
      expect(create?.parentId).toBe(result.ids.episode);
    }
    // Episode folder under the season folder.
    const episodeCreate = client.creates.find((c) => c.name === "S01E01 - Pilot");
    expect(episodeCreate?.parentId).toBe(result.ids.season);
  });

  it("respects the per-episode folderNameOverride verbatim", async () => {
    const { store, ensurer } = makeEnsurer();
    const result = await ensurer.ensure({
      ...baseRequest,
      folderNameOverride: "S01E01 - The Lighthouse (Director's Cut)",
    });
    expect(result.ids.episodeName).toBe("S01E01 - The Lighthouse (Director's Cut)");
    const record = store.findByEpisodeId("ep_1");
    expect(record?.episodeName).toBe("S01E01 - The Lighthouse (Director's Cut)");
  });

  it("idempotent re-run against populated GHL state: zero creates, same IDs (restart simulation)", async () => {
    const first = makeEnsurer();
    const run1 = await first.ensurer.ensure(baseRequest);
    expect(run1.createdCount).toBe(14);

    // Simulate restart: new SQLite (records gone), SAME populated GHL state.
    const client2 = new RecordingClient();
    client2.replayFrom(first.client);
    const { store: store2, dispose } = freshStore();
    try {
      const ensurer2 = new EpisodeFolderEnsurer({ client: client2, store: store2 });
      const run2 = await ensurer2.ensure(baseRequest);

      // Every level found by search; ZERO folders created.
      expect(run2.createdCount).toBe(0);
      expect(run2.reused).toBe(true);
      expect(client2.createCount).toBe(0);
      expect(client2.searches.length).toBeGreaterThan(0);

      // Adopted IDs match run 1's persisted IDs exactly.
      expect(run2.ids).toEqual(run1.ids);
      const record2 = store2.findByEpisodeId("ep_1");
      expect(record2 && toIds(record2)).toEqual(run1.ids);
    } finally {
      dispose();
    }
  });

  it("idempotent re-run with warm record: zero API calls, same IDs, later title change ignored", async () => {
    const { client, ensurer } = makeEnsurer();
    const first = await ensurer.ensure(baseRequest);
    const searchesAfterFirst = client.searches.length;
    const createsAfterFirst = client.createCount;

    // Title changed upstream — the persisted record stays authoritative.
    const second = await ensurer.ensure({ ...baseRequest, title: "Pilot (retitled)" });

    expect(second.createdCount).toBe(0);
    expect(second.reused).toBe(true);
    expect(second.ids).toEqual(first.ids);
    expect(client.searches.length).toBe(searchesAfterFirst); // zero new searches
    expect(client.createCount).toBe(createsAfterFirst); // zero new creates
  });

  it("episode folder name is zero-padded per season/episode", async () => {
    const { store, ensurer } = makeEnsurer();
    const result = await ensurer.ensure({
      ...baseRequest,
      seasonNumber: 2,
      episodeNumber: 7,
      title: "Night Tide",
    });
    expect(result.ids.episodeName).toBe("S02E07 - Night Tide");
    expect(seasonFolderName(2)).toBe("Season 02");
    expect(store.findByEpisodeId("ep_1")?.episodeName).toBe("S02E07 - Night Tide");
  });

  it("drives end-to-end from CORE-004 rows (project → series → episode → ensure → ghlFolderId back-fill)", async () => {
    const { db, ensurer, store } = makeEnsurer();
    const { SqliteProjectRepository, SqliteSeriesRepository, SqliteEpisodeRepository } =
      await import("@mmcs/database");
    const projects = new SqliteProjectRepository(db);
    const series = new SqliteSeriesRepository(db);
    const episodes = new SqliteEpisodeRepository(db);
    const project = projects.create({ name: "Harbor Lights Universe" });
    const ser = series.create({ projectId: project.id, name: "Harbor Lights" });
    const ep = episodes.create({
      projectId: project.id,
      seriesId: ser.id,
      seasonNumber: 1,
      episodeNumber: 1,
      title: "Pilot",
    });

    const result = await ensurer.ensure({
      locationId: "loc_1",
      seriesId: ser.id,
      episodeId: ep.id,
      seriesName: ser.name,
      seasonNumber: ep.seasonNumber,
      episodeNumber: ep.episodeNumber,
      title: ep.title,
    });

    // Persist the episode folder ID back on the episode row (CORE-004 column).
    const updated = episodes.update(ep.id, { ghlFolderId: result.ids.episode });
    expect(updated?.ghlFolderId).toBe(result.ids.episode);
    expect(store.findByEpisodeId(ep.id)?.episodeName).toBe("S01E01 - Pilot");
  });

  it("two episodes of one series share the spine (one root/Series/series folder set)", async () => {
    const { client, ensurer } = makeEnsurer();
    await ensurer.ensure(baseRequest);
    const ep2: EpisodeFolderRequest = {
      ...baseRequest,
      episodeId: "ep_2",
      episodeNumber: 2,
      title: "Undertow",
    };
    const result2 = await ensurer.ensure(ep2);

    // Same season (shared "Season 01") + episode + 9 subfolders = 10 new.
    expect(result2.createdCount).toBe(10);
    expect(result2.ids.root).toBe(client.idByName("Convert and Flow"));
    expect(result2.ids.series).toBe(client.idByName("Harbor Lights"));
    expect(result2.ids.episode).toBe(client.idByName("S01E02 - Undertow"));
    // One shared spine in the mock store.
    const rootCount = [...client.folders.values()].filter((f) => f.name === "Convert and Flow").length;
    expect(rootCount).toBe(1);
  });

  it("rejects invalid input before any API call", async () => {
    const { client, ensurer } = makeEnsurer();
    await expect(ensurer.ensure({ ...baseRequest, seasonNumber: 0 })).rejects.toThrow(/seasonNumber/);
    await expect(ensurer.ensure({ ...baseRequest, episodeNumber: 100 })).rejects.toThrow(/episodeNumber/);
    await expect(ensurer.ensure({ ...baseRequest, seriesName: "  " })).rejects.toThrow(/seriesName/);
    await expect(ensurer.ensure({ ...baseRequest, title: "" })).rejects.toThrow(/title/);
    expect(client.searches).toHaveLength(0);
    expect(client.creates).toHaveLength(0);
  });

  it("refuses re-ensure under a different location than the persisted record", async () => {
    const { ensurer } = makeEnsurer();
    await ensurer.ensure(baseRequest);
    await expect(ensurer.ensure({ ...baseRequest, locationId: "loc_OTHER" })).rejects.toThrow(
      /refusing re-ensure/,
    );
  });

  it("adopts a pre-seeded spine via rootFolderId and creates only missing levels", async () => {
    const { client, ensurer } = makeEnsurer();
    // GHL-004 tree already ran: root + Series exist at the location.
    const root = client.seed("Convert and Flow");
    const seriesNode = client.seed("Series", root.id);
    client.seed("Harbor Lights", seriesNode.id);
    client.seed("Season 01", client.idByName("Harbor Lights"));

    const result = await ensurer.ensure({ ...baseRequest, rootFolderId: root.id });

    // Only the episode folder + its 9 subfolders are new.
    expect(result.createdCount).toBe(10);
    expect(result.ids.root).toBe(root.id);
    expect(result.ids.seriesNode).toBe(seriesNode.id);
    expect(result.ids.series).toBe(client.idByName("Harbor Lights"));
    expect(result.ids.episode).toBe(client.idByName("S01E01 - Pilot"));
    expect(client.creates.every((c) => c.name !== "Convert and Flow")).toBe(true);
  });

  it("search-before-create: every create of a new level is preceded by a matching search", async () => {
    const { client, ensurer } = makeEnsurer();
    await ensurer.ensure(baseRequest);
    expect(client.searches.length).toBeGreaterThanOrEqual(client.creates.length);
    // Each created (name, parentId) pair had a search with the same pair first.
    for (const create of client.creates) {
      const matchingSearch = client.searches.find(
        (s) => s.name === create.name && (s.parentId ?? undefined) === (create.parentId ?? undefined),
      );
      expect(matchingSearch, `search before create: ${create.name}`).toBeDefined();
    }
  });
});
