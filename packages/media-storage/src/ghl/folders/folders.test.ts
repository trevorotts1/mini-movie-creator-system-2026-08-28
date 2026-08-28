import { describe, expect, it, vi } from "vitest";

import {
  GHL_ALT_TYPE_LOCATION,
  GhlFetchTransport,
  GhlFolderApiError,
  GhlFolderResponseError,
  createFolder,
  ensureFolder,
  findFolderByName,
  listFolders,
  type GhlTransport,
  type GhlTransportRequest,
} from "./folders";

const CONFIG = {
  locationId: "loc_123",
  headers: { Authorization: "Bearer test-token", Version: "v3" },
} as const;

/** Recording mock transport: captures requests, replays queued responses. */
function makeTransport(
  responder: (req: GhlTransportRequest) => { status: number; body: unknown },
) {
  const requests: GhlTransportRequest[] = [];
  const transport: GhlTransport = {
    async request<T = unknown>(req: GhlTransportRequest): Promise<{ status: number; body: T }> {
      requests.push(req);
      const res = responder(req);
      return { status: res.status, body: res.body as T };
    },
  };
  return { transport, requests };
}

const ROOT_FOLDER = {
  _id: "folder_root_convert_flow",
  altId: "loc_123",
  altType: "location",
  name: "Convert and Flow",
  parentId: null,
  type: "folder",
};

describe("createFolder (POST /medias/folder)", () => {
  it("sends the exact documented body with altType location and omits parentId at root", async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: { _id: "f_new", altId: "loc_123", altType: "location", name: "Series", parentId: null },
    }));

    const folder = await createFolder(transport, CONFIG, { name: "Series" });

    expect(folder.id).toBe("f_new");
    expect(folder.name).toBe("Series");
    expect(folder.parentId).toBeNull();
    expect(folder.locationId).toBe("loc_123");

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/medias/folder");
    expect(req.body).toEqual({ altId: "loc_123", altType: GHL_ALT_TYPE_LOCATION, name: "Series" });
    expect("parentId" in (req.body as Record<string, unknown>)).toBe(false);
  });

  it("includes parentId when provided for nested creation", async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        _id: "f_child",
        name: "S01E01",
        parentId: "folder_root_convert_flow",
        altId: "loc_123",
      },
    }));

    const folder = await createFolder(transport, CONFIG, {
      name: "S01E01",
      parentId: "folder_root_convert_flow",
    });

    expect(folder.id).toBe("f_child");
    expect(folder.parentId).toBe("folder_root_convert_flow");
    expect(requests[0]!.body).toEqual({
      altId: "loc_123",
      altType: "location",
      name: "S01E01",
      parentId: "folder_root_convert_flow",
    });
  });

  it("normalizes `id` field variant payloads", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { id: "id_variant", name: "X", altId: "loc_123" },
    }));
    const folder = await createFolder(transport, CONFIG, { name: "X" });
    expect(folder.id).toBe("id_variant");
  });

  it("rejects a 2xx response with no folder id (callers must persist a durable ID)", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { altId: "loc_123", altType: "location", name: "NoId" },
    }));
    await expect(createFolder(transport, CONFIG, { name: "NoId" })).rejects.toBeInstanceOf(
      GhlFolderResponseError,
    );
  });

  it("trims whitespace-only names and rejects empty names", async () => {
    const { transport } = makeTransport(() => ({ status: 200, body: {} }));
    await expect(createFolder(transport, CONFIG, { name: "   " })).rejects.toThrowError(
      /non-empty/,
    );
  });

  it("trims surrounding whitespace from names before sending", async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: { _id: "f_t", name: "Trimmed", altId: "loc_123" },
    }));
    await createFolder(transport, CONFIG, { name: "  Trimmed  " });
    expect((requests[0]!.body as { name: string }).name).toBe("Trimmed");
  });

  it("throws GhlFolderApiError on non-2xx without leaking headers or body", async () => {
    const { transport } = makeTransport(() => ({
      status: 401,
      body: { message: "unauthorized" },
    }));
    const err = await createFolder(transport, CONFIG, { name: "X" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhlFolderApiError);
    expect((err as GhlFolderApiError).status).toBe(401);
    expect((err as Error).message).not.toContain("Bearer");
    expect((err as Error).message).not.toContain("test-token");
  });
});

describe("listFolders + findFolderByName (GET /medias/files)", () => {
  it("lists folders with required query params and location context", async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        files: [
          { _id: "f1", name: "Convert and Flow", parentId: null, type: "folder" },
          { _id: "f2", name: "Series", parentId: "f1", type: "folder" },
        ],
        totalItems: 2,
      },
    }));

    const folders = await listFolders(transport, CONFIG, null);

    expect(folders.map((f) => f.name)).toEqual(["Convert and Flow", "Series"]);
    const req = requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/medias/files");
    expect(req.query).toMatchObject({
      altType: "location",
      altId: "loc_123",
      type: "folder",
    });
    expect("parentId" in (req.query ?? {})).toBe(false);
  });

  it("scopes listing to parentId when provided", async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: { files: [], totalItems: 0 },
    }));
    await listFolders(transport, CONFIG, "f1");
    expect(requests[0]!.query?.parentId).toBe("f1");
  });

  it("paginates with offset/limit until totalItems is reached", async () => {
    let call = 0;
    const { transport, requests } = makeTransport(() => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          body: {
            files: [{ _id: "page1_a", name: "A", type: "folder" }],
            totalItems: 3,
          },
        };
      }
      return {
        status: 200,
        body: {
          files: [
            { _id: "page2_b", name: "B", type: "folder" },
            { _id: "page2_c", name: "C", type: "folder" },
          ],
          totalItems: 3,
        },
      };
    });

    const folders = await listFolders(transport, CONFIG, null, 1);

    expect(folders.map((f) => f.id)).toEqual(["page1_a", "page2_b", "page2_c"]);
    expect(requests.map((r) => r.query?.offset)).toEqual(["0", "1"]);
  });

  it("stops paging when a page returns fewer items than the page size", async () => {
    let call = 0;
    const { transport, requests } = makeTransport(() => {
      call += 1;
      return { status: 200, body: { files: [], totalItems: 0 } };
    });
    await listFolders(transport, CONFIG, null);
    expect(call).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("skips non-folder items (files carry url/path) without crashing", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        files: [
          { _id: "file1", name: "shot.mp4", type: "file", url: "https://x/y.mp4" },
          { _id: "dir1", name: "Dir", type: "folder" },
        ],
        totalItems: 2,
      },
    }));
    const folders = await listFolders(transport, CONFIG, null);
    expect(folders.map((f) => f.id)).toEqual(["dir1"]);
  });

  it("finds an existing folder by exact trimmed name (Convert and Flow root)", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        files: [
          { _id: "root", name: "Convert and Flow", parentId: null, type: "folder" },
        ],
        totalItems: 1,
      },
    }));

    const found = await findFolderByName(transport, CONFIG, "Convert and Flow", null);
    expect(found?.id).toBe("root");
    expect(found?.parentId).toBeNull();
  });

  it("returns null when no exact match exists (case-sensitive exact search)", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        files: [{ _id: "root", name: "Convert and Flow", type: "folder" }],
        totalItems: 1,
      },
    }));

    expect(await findFolderByName(transport, CONFIG, "convert and flow", null)).toBeNull();
    expect((await findFolderByName(transport, CONFIG, "Convert and Flow ", null))?.id).toBe("root");
    expect(await findFolderByName(transport, CONFIG, "Other Root", null)).toBeNull();
  });
});

describe("ensureFolder — search-before-create (duplicate-root prevention)", () => {
  it("reuses the existing root folder and creates NOTHING when it already exists", async () => {
    const { transport, requests } = makeTransport((req) => {
      if (req.method === "GET") {
        return {
          status: 200,
          body: {
            files: [
              { _id: "existing_root", name: "Convert and Flow", parentId: null, type: "folder" },
            ],
            totalItems: 1,
          },
        };
      }
      return { status: 200, body: { _id: "should_never_happen", name: "Convert and Flow" } };
    });

    const result = await ensureFolder(transport, CONFIG, { name: "Convert and Flow" });

    expect(result.created).toBe(false);
    expect(result.folder.id).toBe("existing_root");
    // Exactly one call, and it is the LIST, never the POST.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
  });

  it("creates only when the search returns no match", async () => {
    const { transport, requests } = makeTransport((req) => {
      if (req.method === "GET") {
        return { status: 200, body: { files: [], totalItems: 0 } };
      }
      return {
        status: 200,
        body: { _id: "new_root", altId: "loc_123", name: "Convert and Flow", parentId: null },
      };
    });

    const result = await ensureFolder(transport, CONFIG, { name: "Convert and Flow" });

    expect(result.created).toBe(true);
    expect(result.folder.id).toBe("new_root");
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(requests[1]!.path).toBe("/medias/folder");
  });

  it("second ensure with same name reuses the folder the first call created", async () => {
    let stored = false;
    const calls: string[] = [];
    const transport: GhlTransport = {
      async request<T = unknown>(req: GhlTransportRequest): Promise<{ status: number; body: T }> {
        calls.push(`${req.method} ${req.path}`);
        let body: unknown;
        if (req.method === "GET") {
          body = stored
            ? { files: [{ _id: "created_id", name: "Series", type: "folder" }], totalItems: 1 }
            : { files: [], totalItems: 0 };
        } else {
          stored = true;
          body = { _id: "created_id", name: "Series" };
        }
        return { status: 200, body: body as T };
      },
    };

    const first = await ensureFolder(transport, CONFIG, { name: "Series" });
    const second = await ensureFolder(transport, CONFIG, { name: "Series" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.folder.id).toBe(second.folder.id);
    // Exactly one POST across both ensures — no duplicates.
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("nested ensure with parentId never creates a duplicate sibling", async () => {
    const { transport, requests } = makeTransport((req) => {
      if (req.method === "GET") {
        return {
          status: 200,
          body: {
            files: [{ _id: "s01e01", name: "S01E01", parentId: "parent_1", type: "folder" }],
            totalItems: 1,
          },
        };
      }
      return { status: 200, body: { _id: "dup" } };
    });

    const result = await ensureFolder(transport, CONFIG, { name: "S01E01", parentId: "parent_1" });

    expect(result.created).toBe(false);
    expect(result.folder.parentId).toBe("parent_1");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

describe("GhlFetchTransport", () => {
  it("sends prebuilt auth headers + JSON body and parses JSON responses", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://services.leadconnectorhq.com/medias/folder");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
      expect((init?.headers as Record<string, string>)["Version"]).toBe("v3");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return new Response(JSON.stringify({ _id: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = new GhlFetchTransport(CONFIG);
      const res = await transport.request({
        method: "POST",
        path: "/medias/folder",
        body: { altId: "loc_123", altType: "location", name: "T" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ _id: "ok" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds query strings omitting undefined values", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      expect(u.searchParams.get("altId")).toBe("loc_123");
      expect(u.searchParams.get("limit")).toBe("100");
      expect(u.searchParams.has("parentId")).toBe(false);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = new GhlFetchTransport(CONFIG);
      await transport.request({
        method: "GET",
        path: "/medias/files",
        query: { altId: "loc_123", limit: "100", parentId: undefined },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});