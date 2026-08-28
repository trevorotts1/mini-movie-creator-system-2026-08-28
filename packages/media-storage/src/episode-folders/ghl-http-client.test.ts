/**
 * GHL-010 tests — concrete GhlHttpEpisodeFoldersClient adapter.
 * Transport is mocked; asserts exact endpoint paths, query params, POST body
 * shape, and fail-loud behavior on malformed responses. No credentials.
 */
import { describe, expect, it } from "vitest";
import { GhlHttpEpisodeFoldersClient, type EpisodeFoldersHttp } from "./ghl-http-client.js";
import type { EpisodeFoldersClient } from "./index.js";

interface Call {
  path: string;
  query: Record<string, string>;
  init?: { method?: string; body?: unknown };
}

function makeHttp(responder: (call: Call) => unknown): EpisodeFoldersHttp & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (path: string, query: Record<string, string>, init?: { method?: string; body?: unknown }) => {
    const call: Call = { path, query, init };
    calls.push(call);
    return responder(call);
  }) as EpisodeFoldersHttp & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

describe("GhlHttpEpisodeFoldersClient", () => {
  it("searches GET /medias/files with location context + folder type and filters exact name", async () => {
    const http = makeHttp(() => ({
      files: [
        { id: "f1", name: "Harbor Lights", parentId: "season9", type: "folder" },
        { id: "f2", name: "Harbor Lights II", parentId: "season9", type: "folder" }, // partial match excluded
        { id: "f3", name: "Harbor Lights", parentId: "other-parent", type: "folder" }, // different parent excluded
        { id: "f4", name: "shot.png", parentId: "season9", type: "file" }, // wrong type excluded
      ],
      total: 4,
    }));
    const client: EpisodeFoldersClient = new GhlHttpEpisodeFoldersClient(http);

    const found = await client.findFolders({
      altId: "loc_1",
      altType: "location",
      name: "Harbor Lights",
      parentId: "season9",
    });

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.path).toBe("/medias/files");
    expect(http.calls[0]?.query).toMatchObject({
      altType: "location",
      altId: "loc_1",
      parentId: "season9",
      type: "folder",
    });
    expect(found).toEqual([{ id: "f1", name: "Harbor Lights", parentId: "season9" }]);
  });

  it("returns empty (not an error) when the search finds nothing", async () => {
    const http = makeHttp(() => ({ files: [], total: 0 }));
    const client = new GhlHttpEpisodeFoldersClient(http);
    const found = await client.findFolders({ altId: "loc_1", altType: "location", name: "Missing" });
    expect(found).toEqual([]);
  });

  it("creates via POST /medias/folder with the spec §17 body and returns the persisted ID", async () => {
    const http = makeHttp(() => ({ id: "fld_new", name: "S01E01 - Pilot", parentId: "season9" }));
    const client = new GhlHttpEpisodeFoldersClient(http);

    const created = await client.createFolder({
      altId: "loc_1",
      altType: "location",
      name: "S01E01 - Pilot",
      parentId: "season9",
    });

    expect(created).toEqual({ id: "fld_new", name: "S01E01 - Pilot", parentId: "season9" });
    const call = http.calls[0];
    expect(call?.path).toBe("/medias/folder");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.body).toEqual({
      altId: "loc_1",
      altType: "location",
      name: "S01E01 - Pilot",
      parentId: "season9",
    });
  });

  it("omits parentId from the POST body when creating at location root", async () => {
    const http = makeHttp(() => ({ id: "fld_root", name: "Convert and Flow" }));
    const client = new GhlHttpEpisodeFoldersClient(http);
    await client.createFolder({ altId: "loc_1", altType: "location", name: "Convert and Flow" });
    const body = http.calls[0]?.init?.body as Record<string, unknown>;
    expect("parentId" in body).toBe(false);
  });

  it("fails loud on a malformed create response instead of persisting a bogus ID", async () => {
    const http = makeHttp(() => ({ ok: true }));
    const client = new GhlHttpEpisodeFoldersClient(http);
    await expect(
      client.createFolder({ altId: "loc_1", altType: "location", name: "X" }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});
