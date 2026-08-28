/**
 * GHL-002 tests — list/search media (`GET /medias/files`).
 * All HTTP is mocked; no real GHL calls, no credentials.
 */
import { describe, expect, it } from "vitest";
import {
  GhlMediaApiError,
  GhlMediaListTruncatedError,
  findFolderByName,
  findFolderPath,
  listMedia,
  listMediaPage,
  normalizeMediaEntry,
  parseMediaListResponse,
  type GhlHttp,
} from "./index.js";

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
): Record<string, unknown> {
  return { id, name, parentId, type: "folder", altType: "location", altId: "loc1" };
}

function file(
  id: string,
  name: string = id,
  parentId: string | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    parentId,
    type: "file",
    url: `https://files.benefitsfromsunnysideups.com/${id}`,
    path: `/${name}`,
    mimeType: "image/png",
    size: 1234,
    altType: "location",
    altId: "loc1",
    ...extra,
  };
}

/** Recording mock transport. */
function makeHttp(
  responder: (path: string, query: Record<string, string>) => unknown,
): GhlHttp & { calls: Array<{ path: string; query: Record<string, string> }> } {
  const calls: Array<{ path: string; query: Record<string, string> }> = [];
  const fn = (async (path: string, query: Record<string, string>) => {
    calls.push({ path, query });
    return responder(path, query);
  }) as GhlHttp & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("parseMediaListResponse / normalizeMediaEntry", () => {
  it("parses full object entries", () => {
    const parsed = parseMediaListResponse({
      files: [folder("f1", "Convert and Flow"), file("m1", "shot.png")],
      total: 2,
    });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      id: "f1",
      name: "Convert and Flow",
      type: "folder",
      parentId: null,
    });
    expect(parsed.entries[1]).toMatchObject({ id: "m1", type: "file" });
    expect(parsed.total).toBe(2);
  });

  it("normalizes bare-ID string entries (deployment variant)", () => {
    const entry = normalizeMediaEntry("abc123");
    expect(entry).toEqual({ id: "abc123", type: "unknown" });
  });

  it("accepts _id field variant and null parentId", () => {
    const entry = normalizeMediaEntry({
      _id: "xyz",
      type: "file",
      parentId: null,
      mimetype: "video/mp4",
    });
    expect(entry.id).toBe("xyz");
    expect(entry.parentId).toBeNull();
    expect(entry.mimeType).toBe("video/mp4");
  });

  it("rejects malformed responses", () => {
    expect(() => parseMediaListResponse(null)).toThrow(TypeError);
    expect(() => parseMediaListResponse({})).toThrow(TypeError);
    expect(() => parseMediaListResponse({ files: 5 })).toThrow(TypeError);
  });
});

describe("listMediaPage", () => {
  it("sends location context with altType=location and altId", async () => {
    const http = makeHttp(() => ({ files: [] }));
    await listMediaPage(http, { altId: "LOC123" });
    const firstCall = http.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.path).toBe("/medias/files");
    expect(firstCall?.query.altType).toBe("location");
    expect(firstCall?.query.altId).toBe("LOC123");
    expect(firstCall?.query.limit).toBe("100");
  });

  it("passes parentId, type, query, sort and offset through", async () => {
    const http = makeHttp(() => ({ files: [] }));
    await listMediaPage(http, {
      altId: "L",
      parentId: "P1",
      type: "folder",
      query: "conv",
      sortBy: "name",
      sortOrder: "desc",
      offset: 50,
      limit: 25,
    });
    expect(http.calls[0]).toBeDefined();
    const q = http.calls[0]?.query ?? {};
    expect(q).toMatchObject({
      parentId: "P1",
      type: "folder",
      query: "conv",
      sortBy: "name",
      sortOrder: "desc",
      offset: "50",
      limit: "25",
    });
  });

  it("marks hasMore from response flag", async () => {
    const http = makeHttp(() => ({ files: [file("a")], hasMore: false }));
    const page = await listMediaPage(http, { altId: "L", limit: 10 });
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeUndefined();
  });

  it("marks hasMore true for a full page", async () => {
    const files = Array.from({ length: 3 }, (_, i) => file(`m${i}`));
    const http = makeHttp(() => ({ files }));
    const page = await listMediaPage(http, { altId: "L", limit: 3 });
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(3);
  });

  it("throws GhlMediaApiError without leaking auth context", async () => {
    const http = makeHttp(() => {
      throw new GhlMediaApiError(401, "unauthorized");
    });
    await expect(listMediaPage(http, { altId: "L" })).rejects.toMatchObject({
      name: "GhlMediaApiError",
      status: 401,
    });
  });

  it("computes nextOffset by entries received, not requested limit", async () => {
    // Two full pages of 2 with limit 2: nextOffset must advance by entries
    // received (2, then 4) — offset accounting stays exact across pages.
    const page1 = [file("a"), file("b")];
    const page2 = [file("c"), file("d")];
    const http = makeHttp((_path, q) =>
      q.offset === "2" ? { files: page2, total: 4 } : { files: page1 },
    );
    const pageA = await listMediaPage(http, { altId: "L", limit: 2 });
    expect(pageA.nextOffset).toBe(2);
    const pageB = await listMediaPage(http, { altId: "L", limit: 2, offset: 2 });
    expect(pageB.nextOffset).toBe(4);
    expect(http.calls.map((c) => c.query.offset)).toEqual([undefined, "2"]);
  });
});

describe("listMedia pagination (client-side paging)", () => {
  it("follows pages until a short page and concatenates", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => file(`p1-${i}`));
    const page2 = [file("p2-0")];
    const http = makeHttp((_path, q) =>
      q.offset === "2" ? { files: page2, total: 3 } : { files: page1 },
    );
    const result = await listMedia(http, { altId: "L", limit: 2 });
    expect(result.entries.map((e) => e.id)).toEqual(["p1-0", "p1-1", "p2-0"]);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("stops when response reports hasMore=false", async () => {
    const http = makeHttp(() => ({ files: [file("only")], hasMore: false }));
    const result = await listMedia(http, { altId: "L", limit: 5 });
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("stops when total reached", async () => {
    const http = makeHttp(() => ({ files: [file("a"), file("b")], total: 4 }));
    const result = await listMedia(http, { altId: "L", limit: 2 });
    expect(result.entries).toHaveLength(4);
  });

  it("respects maxPages and reports truncated", async () => {
    const http = makeHttp(() => ({
      files: [file("x"), file("y")],
      total: 100,
    }));
    const result = await listMedia(http, { altId: "L", limit: 2, maxPages: 2 });
    expect(result.entries).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it("reports truncated when maxPages hit without a server total", async () => {
    // Regression: cap hit with no `total` from the server previously reported
    // truncated:false — a false "listing complete" claim. Must be true.
    const http = makeHttp(() => ({ files: [file("x"), file("y")] }));
    const result = await listMedia(http, { altId: "L", limit: 2, maxPages: 2 });
    expect(result.entries).toHaveLength(4);
    expect(result.total).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("supports server-side fetchAll in one request", async () => {
    const http = makeHttp(() => ({
      files: [file("a"), file("b"), file("c")],
      total: 3,
    }));
    const result = await listMedia(http, {
      altId: "L",
      fetchAll: true,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.query.fetchAll).toBe("true");
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("empty listing terminates immediately", async () => {
    const http = makeHttp(() => ({ files: [], total: 0 }));
    const result = await listMedia(http, { altId: "L" });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("findFolderByName — exact-name folder resolution", () => {
  it('finds "Convert and Flow" by exact name (acceptance test)', async () => {
    const root = folder("root-1", "Convert and Flow");
    const http = makeHttp(() => ({ files: [root, folder("root-2", "Other")] }));
    const hit = await findFolderByName(http, "Convert and Flow", { altId: "LOC1" });
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("root-1");
    expect(hit?.name).toBe("Convert and Flow");
    expect(http.calls[0]?.query.type).toBe("folder");
    expect(http.calls[0]?.query.altType).toBe("location");
  });

  it("matches EXACTLY — no case folding, no substring, no trim", async () => {
    const http = makeHttp(() => ({
      files: [
        folder("a", "convert and flow"),
        folder("b", "Convert and Flow 2"),
        folder("c", " Convert and Flow"),
        folder("d", "CONVERT AND FLOW"),
      ],
    }));
    const hit = await findFolderByName(http, "Convert and Flow", { altId: "L" });
    expect(hit).toBeNull();
  });

  it("returns null when folder absent", async () => {
    const http = makeHttp(() => ({ files: [folder("x", "Other")] }));
    expect(await findFolderByName(http, "Convert and Flow", { altId: "L" })).toBeNull();
  });

  it("keeps paging for a match beyond the first page", async () => {
    const pageOne = Array.from({ length: 2 }, (_, i) => folder(`p1-${i}`, `f${i}`));
    const pageTwo = [folder("target", "Convert and Flow")];
    const http = makeHttp((_path, q) =>
      q.offset === "2" ? { files: pageTwo } : { files: pageOne },
    );
    const hit = await findFolderByName(http, "Convert and Flow", {
      altId: "L",
      limit: 2,
    });
    expect(hit?.id).toBe("target");
  });

  it("scopes by parentId when given", async () => {
    const http = makeHttp(() => ({ files: [folder("child", "Series")] }));
    await findFolderByName(http, "Series", { altId: "L", parentId: "root-1" });
    expect(http.calls[0]?.query.parentId).toBe("root-1");
  });

  it("caps paging — throws GhlMediaListTruncatedError instead of false null", async () => {
    // Server keeps returning full pages without hasMore:false. Pre-fix this
    // looped forever; a silent null would make callers create a duplicate root.
    const http = makeHttp((_path, q) => ({
      files: [folder(`f-${q.offset ?? 0}`, `folder-${q.offset ?? 0}`)],
    }));
    await expect(
      findFolderByName(http, "Convert and Flow", { altId: "L", limit: 1 }),
    ).rejects.toMatchObject({
      name: "GhlMediaListTruncatedError",
      maxPages: 100,
      folderName: "Convert and Flow",
    });
    // 1 page per iteration, capped at 100.
    expect(http.calls).toHaveLength(100);
  });
});

describe("findFolderPath — nested resolution", () => {
  it("resolves Convert and Flow / Series / <name> segment by segment", async () => {
    const http = makeHttp((_path, q) => {
      const parent = q.parentId;
      if (parent === undefined)
        return { files: [folder("cf", "Convert and Flow")] };
      if (parent === "cf") return { files: [folder("series", "Series")] };
      if (parent === "series")
        return { files: [folder("ep1", "S01E01 - Pilot")] };
      return { files: [] };
    });
    const hit = await findFolderPath(
      http,
      ["Convert and Flow", "Series", "S01E01 - Pilot"],
      { altId: "L" },
    );
    expect(hit?.id).toBe("ep1");
  });

  it("returns null when an intermediate segment is missing", async () => {
    const http = makeHttp((_path, q) =>
      q.parentId === undefined ? { files: [folder("cf", "Convert and Flow")] } : { files: [] },
    );
    const hit = await findFolderPath(http, ["Convert and Flow", "Missing"], {
      altId: "L",
    });
    expect(hit).toBeNull();
  });
});

describe("transport contract", () => {
  it("invokes exactly the /medias/files path", async () => {
    const http = makeHttp(() => ({ files: [] }));
    await listMedia(http, { altId: "L" });
    expect(http.calls.every((c) => c.path === "/medias/files")).toBe(true);
  });

  it("GhlMediaApiError carries status and body for callers", () => {
    const err = new GhlMediaApiError(429, "rate limited");
    expect(err.status).toBe(429);
    expect(err.body).toBe("rate limited");
  });
});