/**
 * GHL-005 tests — hosted URL ingest (`POST /medias/upload-file`, hosted=true).
 * All HTTP is mocked; no real GHL calls, no credentials.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GhlIngestError,
  archiveHostedUrl,
  buildCanonicalName,
  buildMultipartBody,
  nameFromUrl,
  parseUploadResponse,
  verifyUrlReachable,
  type GhlUploadHttp,
  type HostedIngestRequest,
  type UrlProbeResponse,
} from "./index.js";

/** Recording mock multipart transport. */
function makeHttp(
  responder: (path: string, body: FormData) => unknown,
): GhlUploadHttp & { calls: Array<{ path: string; body: FormData }> } {
  const calls: Array<{ path: string; body: FormData }> = [];
  const fn = (async (path: string, body: FormData) => {
    calls.push({ path, body });
    return responder(path, body);
  }) as GhlUploadHttp & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function okProbe(
  url = "https://files.example.com/ok.mp4",
  status = 200,
): { probe: (probed: string) => Promise<UrlProbeResponse>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    probe: async (probed: string) => {
      urls.push(probed);
      return { ok: true, status };
    },
  };
}

function baseRequest(overrides: Partial<HostedIngestRequest> = {}): HostedIngestRequest {
  return {
    fileUrl: "https://cdn.provider.com/tmp/clip-abc.mp4",
    name: "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
    parentId: "folder-episode-06",
    altId: "LOC123",
    ...overrides,
  };
}

describe("buildCanonicalName — deterministic canonical naming (spec §48)", () => {
  it("builds the spec's canonical episode-shot name deterministically", () => {
    const name = buildCanonicalName([
      "S01E03",
      "SC04",
      "SH07",
      "monica closeup",
      "agnes25",
      "v03.MP4",
    ]);
    expect(name).toBe("S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4");
  });

  it("is deterministic — same parts, same name, no timestamps/randomness", () => {
    const parts = ["char", "monica", "face 3q", "v02.png"] as const;
    expect(buildCanonicalName(parts)).toBe(buildCanonicalName(parts));
  });

  it("sanitizes spaces, slashes, traversal and control chars", () => {
    const name = buildCanonicalName(["../../etc/passwd.sh"]);
    expect(name).toBe("passwd.sh");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    const weird = buildCanonicalName(["a b\tc\nd", "e/f.g"]);
    // Last path segment wins: "e/f" collapses to "f", extension preserved.
    expect(weird).toBe("f.g");
    expect(weird).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("lowercases the extension and keeps only the last one", () => {
    expect(buildCanonicalName(["clip", "v1.MP4"])).toBe("clip_v1.mp4");
    expect(buildCanonicalName(["shot.mp4.mp4"])).toBe("shot.mp4.mp4");
    expect(buildCanonicalName(["shot.tar.gz"])).toBe("shot.tar.gz");
  });

  it("no extension when parts carry none", () => {
    expect(buildCanonicalName(["monica", "master"])).toBe("monica_master");
  });

  it("drops null/undefined/empty parts", () => {
    expect(buildCanonicalName(["a", null, undefined, "", "b.png"])).toBe("a_b.png");
  });

  it("caps length preserving extension", () => {
    const long = `${"x".repeat(250)}.mp4`;
    const name = buildCanonicalName([long], { maxLength: 60 });
    expect(name.length).toBe(60);
    expect(name.endsWith(".mp4")).toBe(true);
  });

  it("rejects parts that sanitize to empty", () => {
    expect(() => buildCanonicalName(["///"])).toThrow(TypeError);
    expect(() => buildCanonicalName([])).toThrow(TypeError);
    expect(() => buildCanonicalName([null, undefined])).toThrow(TypeError);
  });

  it("numbers are accepted as parts", () => {
    expect(buildCanonicalName(["S01E", 3, "SH", 7, "clip.mp4"])).toBe(
      "S01E_3_SH_7_clip.mp4",
    );
  });
});

describe("nameFromUrl", () => {
  it("extracts the final path segment decoded", () => {
    expect(nameFromUrl("https://cdn.x/tmp/my%20clip.png")).toBe("my clip.png");
    expect(nameFromUrl("https://cdn.x/a/b/clip-abc.mp4?sig=1")).toBe("clip-abc.mp4");
  });

  it("returns undefined for bare hosts or unparseable input", () => {
    expect(nameFromUrl("https://cdn.x/")).toBeUndefined();
    expect(nameFromUrl("not a url")).toBeUndefined();
  });
});

describe("parseUploadResponse — fileId + storage URL variants", () => {
  it("parses the standard shape", () => {
    const parsed = parseUploadResponse({
      fileId: "F123",
      url: "https://files.ghl.com/F123.mp4",
    });
    expect(parsed).toEqual({
      fileId: "F123",
      url: "https://files.ghl.com/F123.mp4",
    });
  });

  it("accepts id/_id/mediaId and mediaUrl/fileUrl/link variants", () => {
    expect(parseUploadResponse({ id: "A", mediaUrl: "u" })).toEqual({
      fileId: "A",
      url: "u",
    });
    expect(parseUploadResponse({ _id: "B", fileUrl: "u" })).toEqual({
      fileId: "B",
      url: "u",
    });
    expect(parseUploadResponse({ mediaId: "C", link: "u" })).toEqual({
      fileId: "C",
      url: "u",
    });
  });

  it("unwraps nested data/file/media objects", () => {
    expect(
      parseUploadResponse({ data: { fileId: "N1", url: "u" } }),
    ).toMatchObject({ fileId: "N1", url: "u" });
    expect(parseUploadResponse({ file: { id: "N2", url: "u" } })).toMatchObject({
      fileId: "N2",
      url: "u",
    });
    expect(
      parseUploadResponse({ media: { _id: "N3", mediaUrl: "u" } }),
    ).toMatchObject({ fileId: "N3", url: "u" });
  });

  it("accepts a bare-ID string body (deployment variant)", () => {
    expect(parseUploadResponse("F9")).toEqual({ fileId: "F9" });
  });

  it("throws on missing fileId or malformed bodies", () => {
    expect(() => parseUploadResponse({ url: "u" })).toThrow(TypeError);
    expect(() => parseUploadResponse(null)).toThrow(TypeError);
    expect(() => parseUploadResponse(42)).toThrow(TypeError);
    expect(() => parseUploadResponse("")).toThrow(TypeError);
  });

  it("fileId without url parses (caller falls back)", () => {
    expect(parseUploadResponse({ fileId: "F1" })).toEqual({ fileId: "F1" });
  });
});

describe("buildMultipartBody — exact POST /medias/upload-file contract", () => {
  it("sets hosted=true, fileUrl, name, parentId and location context", () => {
    const form = buildMultipartBody(
      {
        fileUrl: "https://cdn.provider.com/x.mp4",
        name: "shot.mp4",
        parentId: "folder-1",
        altId: "LOC1",
      },
      "shot.mp4",
    );
    expect(form.get("hosted")).toBe("true");
    expect(form.get("fileUrl")).toBe("https://cdn.provider.com/x.mp4");
    expect(form.get("name")).toBe("shot.mp4");
    expect(form.get("parentId")).toBe("folder-1");
    expect(form.get("altId")).toBe("LOC1");
    expect(form.get("altType")).toBe("location");
  });

  it("omits altId/altType when no location context given", () => {
    const form = buildMultipartBody(
      { fileUrl: "https://x/y.png", name: "y.png", parentId: "P" },
      "y.png",
    );
    expect(form.get("altId")).toBeNull();
    expect(form.get("altType")).toBeNull();
  });
});

describe("verifyUrlReachable", () => {
  it("true only for 2xx responses", async () => {
    const probe = async () => ({ ok: true, status: 200 });
    expect(await verifyUrlReachable("https://x/y", { probe })).toBe(true);
    const probe201 = async () => ({ ok: true, status: 201 });
    expect(await verifyUrlReachable("https://x/y", { probe: probe201 })).toBe(true);
    const probe404 = async () => ({ ok: false, status: 404 });
    expect(await verifyUrlReachable("https://x/y", { probe: probe404 })).toBe(false);
  });

  it("network error counts as unreachable, never throws", async () => {
    const probe = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await verifyUrlReachable("https://x/y", { probe })).toBe(false);
  });

  it("passes a timeout signal and HEAD method by default", async () => {
    const seen: Array<{ method?: string; signal?: AbortSignal }> = [];
    const probe = async (
      _url: string,
      init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
    ) => {
      seen.push({ method: init?.method, signal: init?.signal });
      return { ok: true, status: 200 };
    };
    await verifyUrlReachable("https://x/y", { probe });
    expect(seen[0]?.method).toBe("HEAD");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("supports GET for HEAD-averse CDNs", async () => {
    let method: string | undefined;
    const probe = async (
      _url: string,
      init?: { method?: "HEAD" | "GET" },
    ) => {
      method = init?.method;
      return { ok: true, status: 200 };
    };
    await verifyUrlReachable("https://x/y", { probe, method: "GET" });
    expect(method).toBe("GET");
  });
});

describe("archiveHostedUrl — happy path (acceptance)", () => {
  it("POSTs multipart hosted=true + fileUrl + canonical name + parentId; ARCHIVED only after reachable URL verified", async () => {
    const storageUrl = "https://files.ghl.com/media/F123.mp4";
    const http = makeHttp(() => ({ fileId: "F123", url: storageUrl }));
    const { probe, urls } = okProbe(storageUrl);
    const result = await archiveHostedUrl(http, baseRequest(), { probe });

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.path).toBe("/medias/upload-file");
    const body = http.calls[0]?.body as FormData;
    expect(body.get("hosted")).toBe("true");
    expect(body.get("fileUrl")).toBe("https://cdn.provider.com/tmp/clip-abc.mp4");
    expect(body.get("name")).toBe(
      "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
    );
    expect(body.get("parentId")).toBe("folder-episode-06");
    expect(body.get("altId")).toBe("LOC123");
    expect(body.get("altType")).toBe("location");

    expect(result).toEqual({
      status: "ARCHIVED",
      fileId: "F123",
      url: storageUrl,
      name: "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
      raw: { fileId: "F123", url: storageUrl },
    });
    // Reachability was probed against the returned storage URL before ARCHIVED.
    expect(urls).toEqual([storageUrl]);
  });

  it("is deterministic: identical request twice → identical canonical name", async () => {
    const storageUrl = "https://files.ghl.com/m.mp4";
    const http1 = makeHttp(() => ({ fileId: "F", url: storageUrl }));
    const http2 = makeHttp(() => ({ fileId: "F", url: storageUrl }));
    const probe = async () => ({ ok: true, status: 200 });
    const r1 = await archiveHostedUrl(http1, baseRequest(), { probe });
    const r2 = await archiveHostedUrl(http2, baseRequest(), { probe });
    expect(r1.name).toBe(r2.name);
    const n1 = http1.calls[0]?.body.get("name");
    expect(n1).toBe(http2.calls[0]?.body.get("name"));
  });

  it("derives the canonical name from the fileUrl basename when name is a raw URL", async () => {
    const http = makeHttp(() => ({ fileId: "F", url: "https://s/x.png" }));
    const probe = async () => ({ ok: true, status: 200 });
    const result = await archiveHostedUrl(
      http,
      {
        fileUrl: "https://cdn.provider.com/gen/character monica%20face.png",
        name: nameFromUrl("https://cdn.provider.com/gen/character monica%20face.png") ?? "",
        parentId: "P",
      },
      { probe },
    );
    expect(result.name).toBe("character_monica_face.png");
  });
});

describe("archiveHostedUrl — failure paths (GHL-006 fallback signals)", () => {
  it("INVALID_FILE_URL before any HTTP call for non-http schemes", async () => {
    const http = makeHttp(() => ({}));
    await expect(
      archiveHostedUrl(
        http,
        baseRequest({ fileUrl: "file:///etc/passwd" }),
        { probe: okProbe().probe },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILE_URL" });
    await expect(
      archiveHostedUrl(
        http,
        baseRequest({ fileUrl: "javascript:alert(1)" }),
        { probe: okProbe().probe },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILE_URL" });
    await expect(
      archiveHostedUrl(
        http,
        baseRequest({ fileUrl: "not-a-url" }),
        { probe: okProbe().probe },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILE_URL" });
    expect(http.calls).toHaveLength(0);
  });

  it("MISSING_URL when response carries fileId but no storage URL (fallback signal)", async () => {
    const http = makeHttp(() => ({ fileId: "F77" }));
    const { probe, urls } = okProbe();
    await expect(archiveHostedUrl(http, baseRequest(), { probe })).rejects.toMatchObject({
      name: "GhlIngestError",
      code: "MISSING_URL",
      fileId: "F77",
    });
    expect(urls).toHaveLength(0);
  });

  it("UNREACHABLE — probe fails → no ARCHIVED, error carries fileId + url for fallback", async () => {
    const storageUrl = "https://files.ghl.com/gone.mp4";
    const http = makeHttp(() => ({ fileId: "F88", url: storageUrl }));
    const probe = async () => ({ ok: false, status: 403 });
    await expect(archiveHostedUrl(http, baseRequest(), { probe })).rejects.toMatchObject({
      code: "UNREACHABLE",
      fileId: "F88",
      url: storageUrl,
    });
    const probeThrows = async () => {
      throw new Error("timeout");
    };
    await expect(
      archiveHostedUrl(http, baseRequest(), { probe: probeThrows }),
    ).rejects.toMatchObject({ code: "UNREACHABLE", fileId: "F88" });
  });

  it("non-2xx API failure propagates as the transport's error (caller decides fallback)", async () => {
    const http = makeHttp(() => {
      throw new Error("401 unauthorized");
    });
    await expect(
      archiveHostedUrl(http, baseRequest(), { probe: okProbe().probe }),
    ).rejects.toThrow("401 unauthorized");
  });
});

describe("transport contract", () => {
  it("invokes exactly /medias/upload-file", async () => {
    const http = makeHttp(() => ({ fileId: "F", url: "https://s/u" }));
    await archiveHostedUrl(http, baseRequest(), { probe: okProbe().probe });
    expect(http.calls.every((c) => c.path === "/medias/upload-file")).toBe(true);
  });

  it("never places auth material — the injected transport owns headers", async () => {
    const http = makeHttp(() => ({ fileId: "F", url: "https://s/u" }));
    await archiveHostedUrl(http, baseRequest(), { probe: okProbe().probe });
    const body = http.calls[0]?.body as FormData;
    for (const key of ["authorization", "token", "apiKey"]) {
      expect(body.get(key)).toBeNull();
    }
  });
});

describe("GhlIngestError shape", () => {
  it("carries code + context without auth material", () => {
    const err = new GhlIngestError("UNREACHABLE", "probe failed", {
      fileId: "F1",
      url: "https://u",
    });
    expect(err.name).toBe("GhlIngestError");
    expect(err.code).toBe("UNREACHABLE");
    expect(err.fileId).toBe("F1");
    expect(err.url).toBe("https://u");
    expect(err.message).toContain("UNREACHABLE");
  });

  it("probeStatus is preserved when the probe observed an HTTP status", async () => {
    const http = makeHttp(() => ({ fileId: "F", url: "https://s/u" }));
    const probe = async () => ({ ok: false, status: 500 });
    const err = await archiveHostedUrl(http, baseRequest(), { probe }).catch(
      (e: unknown) => e as GhlIngestError,
    );
    expect(err).toBeInstanceOf(GhlIngestError);
    expect((err as GhlIngestError).url).toBe("https://s/u");
  });
});