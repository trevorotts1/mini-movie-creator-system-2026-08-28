/// <reference types="node" />
import { describe, it, expect, beforeEach } from "vitest";
import {
  BinaryFallbackUploader,
  GhlUploadError,
  sha256Hex,
  contentTypeForName,
  limitForKind,
  GENERAL_LIMIT_BYTES,
  VIDEO_LIMIT_BYTES,
  type BinaryFallbackInput,
  type BinaryUploadInput,
  type DownloadedFile,
  type DownloadRequest,
  type GhlUploadClient,
  type GhlUploadResult,
  type MediaKind,
  type MediaVerifier,
  type ProbeResult,
  type VerifyUrlResult,
} from "./upload.js";

/**
 * Mocked GHL client + provider URL, recording every call in order. Mirrors
 * the spec §17.4 fallback: download → checksum → verify → upload → verify
 * returned ID/URL → integrity compare → ARCHIVED.
 */
class RecordingUploadClient implements GhlUploadClient {
  readonly calls: Array<
    | { kind: "download"; url: string }
    | { kind: "upload"; input: BinaryUploadInput }
    | { kind: "verifyUrl"; url: string }
  > = [];

  /** Provider URL → bytes served on first download. */
  providerAssets = new Map<string, Uint8Array>();
  /** GHL storage URL → bytes served on the integrity re-download. */
  storedAssets = new Map<string, Uint8Array>();
  /** Storage URL assigned on upload; when null, upload omits url (error case). */
  serveUploaded = true;
  reachable = true;
  uploadError: Error | null = null;
  downloadError: Error | null = null;
  nextId = 1;

  async downloadFile(request: DownloadRequest): Promise<DownloadedFile> {
    this.calls.push({ kind: "download", url: request.url });
    if (this.downloadError) throw this.downloadError;
    const provider = this.providerAssets.get(request.url);
    if (provider) return { data: provider, contentType: "application/octet-stream" };
    const stored = this.storedAssets.get(request.url);
    if (stored) return { data: stored, contentType: "video/mp4" };
    throw new Error(`no asset for ${request.url}`);
  }

  async uploadBinary(input: BinaryUploadInput): Promise<GhlUploadResult> {
    this.calls.push({ kind: "upload", input });
    if (this.uploadError) throw this.uploadError;
    const fileId = `file_${this.nextId++}`;
    const url = `https://files.gohighlevel.test/${fileId}/${input.name}`;
    if (this.serveUploaded) this.storedAssets.set(url, input.data);
    return { fileId, url };
  }

  async verifyUrl(url: string): Promise<VerifyUrlResult> {
    this.calls.push({ kind: "verifyUrl", url });
    return { reachable: this.reachable, status: this.reachable ? 200 : 404 };
  }

  get uploadCalls(): Array<{ kind: "upload"; input: BinaryUploadInput }> {
    return this.calls.filter(
      (c): c is { kind: "upload"; input: BinaryUploadInput } => c.kind === "upload",
    );
  }
}

/** Verifier fake that records calls and can be made to fail. */
class FakeVerifier implements MediaVerifier {
  readonly verified: Array<{ path: string; kind: MediaKind }> = [];
  fail = false;

  async verify(filePath: string, kind: MediaKind): Promise<ProbeResult> {
    this.verified.push({ path: filePath, kind });
    if (this.fail) {
      throw new Error("decode failed: invalid data");
    }
    return { format: "mock", streams: kind === "video" ? [{ codecType: "video" }] : [] };
  }
}

/** Minimal real bytes for a verifiable "video" (fake verifier doesn't parse). */
function bytes(n: number, fill = 0xab): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function makeInput(
  providerUrl: string,
  data: Uint8Array,
  overrides: Partial<BinaryFallbackInput> = {},
): BinaryFallbackInput {
  return {
    providerUrl,
    name: "S01E01_SC01_SH01_monica_closeup_agnes25_v01.mp4",
    parentId: "folder_episode_1",
    locationId: "loc-1",
    kind: "video",
    ...overrides,
  };
}

describe("BinaryFallbackUploader — spec §17.4 full fallback sequence", () => {
  let client: RecordingUploadClient;
  let verifier: FakeVerifier;
  const providerUrl = "https://temp.provider.test/asset/abc123.mp4";
  const data = bytes(1024);

  beforeEach(() => {
    client = new RecordingUploadClient();
    verifier = new FakeVerifier();
    client.providerAssets.set(providerUrl, data);
  });

  it("downloads → verifies → uploads → verifies URL → integrity-compares → ARCHIVED", async () => {
    const uploader = new BinaryFallbackUploader({ client, verifier });

    const result = await uploader.archive(
      makeInput(providerUrl, data),
    );

    expect(result.state).toBe("ARCHIVED");
    expect(result.fileId).toMatch(/^file_\d+$/);
    expect(result.url).toContain("files.gohighlevel.test");
    expect(result.sourceChecksum).toBe(sha256Hex(data));
    expect(result.verifiedChecksum).toBe(result.sourceChecksum);
    expect(result.bytes).toBe(data.byteLength);
    expect(result.kind).toBe("video");
  });

  it("calls in order: download, decode-verify, upload, verifyUrl, re-download", async () => {
    const uploader = new BinaryFallbackUploader({ client, verifier });
    await uploader.archive(makeInput(providerUrl, data));

    const kinds = client.calls.map((c) => c.kind);
    // download (provider) → upload → verifyUrl → download (integrity compare)
    expect(kinds).toEqual(["download", "upload", "verifyUrl", "download"]);
    expect(verifier.verified).toHaveLength(1);
    expect(verifier.verified[0]!.kind).toBe("video");
    // Local decode-verify ran against a real temp file on disk.
    expect(verifier.verified[0]!.path.endsWith(".mp4")).toBe(true);
  });

  it("uploads the exact downloaded bytes with correct multipart fields", async () => {
    const uploader = new BinaryFallbackUploader({ client, verifier });
    await uploader.archive(makeInput(providerUrl, data));

    const upload = client.uploadCalls[0]!.input;
    expect(upload.data).toEqual(data);
    expect(upload.parentId).toBe("folder_episode_1");
    expect(upload.locationId).toBe("loc-1");
    expect(upload.name).toBe("S01E01_SC01_SH01_monica_closeup_agnes25_v01.mp4");
    expect(upload.contentType).toBe("video/mp4");
  });

  it("integrity compare re-downloads from the returned GHL URL and hashes match", async () => {
    const uploader = new BinaryFallbackUploader({ client, verifier });
    const result = await uploader.archive(makeInput(providerUrl, data));

    const downloads = client.calls.filter((c) => c.kind === "download");
    const last = downloads[downloads.length - 1];
    expect(last && "url" in last ? last.url : undefined).toBe(result.url);
    // The served-back bytes are what GHL stored (identical in the mock).
    expect(result.verifiedChecksum).toBe(sha256Hex(data));
  });
});

describe("BinaryFallbackUploader — failure paths (never mark ARCHIVED)", () => {
  let client: RecordingUploadClient;
  let verifier: FakeVerifier;
  const providerUrl = "https://temp.provider.test/asset/abc123.mp4";
  const data = bytes(512);

  beforeEach(() => {
    client = new RecordingUploadClient();
    verifier = new FakeVerifier();
    client.providerAssets.set(providerUrl, data);
  });

  it("download failure → GhlUploadError download-failed, no upload attempted", async () => {
    client.downloadError = new Error("403 expired URL");
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toMatchObject({
      name: "GhlUploadError",
      reason: "download-failed",
    });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("decode verification failure → no upload attempted", async () => {
    verifier.fail = true;
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toThrow(
      /decode failed/,
    );
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("upload transport failure → GhlUploadError upload-failed", async () => {
    client.uploadError = new Error("500 server error");
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toMatchObject({
      reason: "upload-failed",
    });
  });

  it("upload response missing fileId or url → missing-id-or-url, no URL verification", async () => {
    client.serveUploaded = true;
    const broken = new RecordingUploadClient();
    broken.providerAssets.set(providerUrl, data);
    broken.uploadBinary = async () => ({ fileId: "", url: "" });
    const uploader = new BinaryFallbackUploader({ client: broken, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toMatchObject({
      reason: "missing-id-or-url",
    });
    expect(broken.calls.some((c) => c.kind === "verifyUrl")).toBe(false);
  });

  it("unreachable returned URL → url-unreachable, ARCHIVED never reached", async () => {
    client.reachable = false;
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toMatchObject({
      reason: "url-unreachable",
    });
  });

  it("checksum mismatch after upload → integrity-failed", async () => {
    // Serve back corrupted bytes on the integrity re-download.
    client.uploadBinary = async (input) => {
      const url = `https://files.gohighlevel.test/corrupt/${input.name}`;
      client.calls.push({ kind: "upload", input });
      client.storedAssets.set(url, bytes(input.data.byteLength, 0x00)); // different bytes
      return { fileId: "file_corrupt", url };
    };
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(providerUrl, data))).rejects.toMatchObject({
      reason: "integrity-failed",
    });
  });
});

describe("BinaryFallbackUploader — size limits (25 MB general / 500 MB video)", () => {
  let client: RecordingUploadClient;
  let verifier: FakeVerifier;

  beforeEach(() => {
    client = new RecordingUploadClient();
    verifier = new FakeVerifier();
  });

  it("rejects a general file over 25 MB BEFORE upload", async () => {
    const url = "https://temp.provider.test/big.png";
    const tooBig = bytes(GENERAL_LIMIT_BYTES + 1);
    client.providerAssets.set(url, tooBig);
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(
      uploader.archive(
        makeInput(url, tooBig, {
          kind: "image",
          name: "monica_master.png",
        }),
      ),
    ).rejects.toMatchObject({ reason: "size-limit" });
    expect(client.uploadCalls).toHaveLength(0);
    expect(verifier.verified).toHaveLength(0);
  });

  it("rejects a video over 500 MB BEFORE upload", async () => {
    const url = "https://temp.provider.test/huge.mp4";
    // 500 MB + 1 byte. Allocate lazily via a subarray view to avoid a real
    // half-gig buffer in tests: the limit check only reads byteLength.
    const huge = new Uint8Array(VIDEO_LIMIT_BYTES + 1);
    client.providerAssets.set(url, huge);
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(url, huge))).rejects.toMatchObject({
      reason: "size-limit",
    });
    expect(client.uploadCalls).toHaveLength(0);
  });

  it("accepts a video exactly at 500 MB (limit is inclusive) up to upload call", async () => {
    const url = "https://temp.provider.test/exact.mp4";
    const exact = new Uint8Array(VIDEO_LIMIT_BYTES);
    client.providerAssets.set(url, exact);
    const uploader = new BinaryFallbackUploader({ client, verifier });

    const result = await uploader.archive(makeInput(url, exact));
    expect(result.state).toBe("ARCHIVED");
    expect(client.uploadCalls).toHaveLength(1);
  }, 30000);

  it("rejects at the exact boundary before decode-verify or upload", async () => {
    const url = "https://temp.provider.test/over.mp4";
    const over = new Uint8Array(VIDEO_LIMIT_BYTES + 1);
    client.providerAssets.set(url, over);
    const uploader = new BinaryFallbackUploader({ client, verifier });

    await expect(uploader.archive(makeInput(url, over))).rejects.toMatchObject({
      reason: "size-limit",
    });
    // Rejection is pre-upload AND pre-verify (no temp file, no GHL call).
    expect(verifier.verified).toHaveLength(0);
    expect(client.calls.some((c) => c.kind === "upload")).toBe(false);
  });

  it("limitForKind maps video → 500 MB, everything else → 25 MB", () => {
    expect(limitForKind("video")).toBe(VIDEO_LIMIT_BYTES);
    expect(limitForKind("image")).toBe(GENERAL_LIMIT_BYTES);
    expect(limitForKind("audio")).toBe(GENERAL_LIMIT_BYTES);
    expect(limitForKind("generic")).toBe(GENERAL_LIMIT_BYTES);
    expect(VIDEO_LIMIT_BYTES).toBe(500 * 1024 * 1024);
    expect(GENERAL_LIMIT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("checksum + content-type helpers", () => {
  it("sha256Hex matches known digest", () => {
    // echo -n "abc" | shasum -a 256
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("contentTypeForName maps canonical extensions; unknown → octet-stream", () => {
    expect(contentTypeForName("S01E01_SC01_SH01_clip.mp4")).toBe("video/mp4");
    expect(contentTypeForName("monica_face_3q_master_v02.png")).toBe("image/png");
    expect(contentTypeForName("voice_monica_v1.mp3")).toBe("audio/mpeg");
    expect(contentTypeForName("no-extension")).toBe("application/octet-stream");
    expect(contentTypeForName("weird.unusual")).toBe("application/octet-stream");
  });
});