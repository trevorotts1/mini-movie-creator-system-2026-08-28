/**
 * Client seam for the binary fallback upload (spec §17.4 step 4).
 *
 * The fallback orchestrator depends on these interfaces only, so the whole
 * pipeline (download → checksum → decode verify → upload → verify → compare)
 * is testable against a mocked API. The concrete HTTP/ffmpeg adapters plug in
 * here:
 *
 *  - downloadFile    → GET <providerUrl> (temporary provider asset URL), and
 *                      the same shape re-used to download back from GHL for
 *                      the post-upload integrity compare.
 *  - uploadBinary    → POST /medias/upload-file multipart
 *                      (binary part `file`, fields name/parentId/hosted=false)
 *  - verifyUrl       → GET <storageUrl> reachability check
 *  - probe/decode    → ffprobe/ffmpeg local verification (verify.ts)
 */
import type { MediaKind } from "./media-kind.js";

export interface DownloadedFile {
  /** Raw bytes of the downloaded asset. */
  data: Uint8Array;
  /** Content-Type reported by the server, when present. */
  contentType?: string;
}

export interface DownloadRequest {
  url: string;
  /** AbortSignal for bounded fetches. */
  signal?: AbortSignal;
}

export interface BinaryUploadInput {
  /** Deterministic canonical filename (spec §19). */
  name: string;
  /** GHL folder to file into (episode/character folder ID). */
  parentId: string;
  /** Location (sub-account) context. */
  locationId: string;
  /** Raw file bytes. */
  data: Uint8Array;
  /** MIME type for the multipart part. */
  contentType: string;
}

export interface GhlUploadResult {
  /** GHL fileId as returned by POST /medias/upload-file. */
  fileId: string;
  /** Durable GHL storage URL for the uploaded file. */
  url: string;
}

/** Errors that carry a machine-readable reason for callers to branch on. */
export class GhlUploadError extends Error {
  readonly reason:
    | "download-failed"
    | "size-limit"
    | "integrity-failed"
    | "decode-failed"
    | "upload-failed"
    | "url-unreachable"
    | "missing-id-or-url";

  constructor(reason: GhlUploadError["reason"], message: string) {
    super(message);
    this.name = "GhlUploadError";
    this.reason = reason;
  }
}

export interface GhlUploadClient {
  /** Download bytes from a provider temporary URL (or from GHL for compare). */
  downloadFile(request: DownloadRequest): Promise<DownloadedFile>;
  /** Binary multipart upload to GHL; returns fileId + storage URL. */
  uploadBinary(input: BinaryUploadInput): Promise<GhlUploadResult>;
  /** Check the returned storage URL; reachable=true only when served OK. */
  verifyUrl(url: string): Promise<VerifyUrlResult>;
}

export interface VerifyUrlResult {
  reachable: boolean;
  /** HTTP status of the verification request, when made. */
  status?: number;
  /** URL actually served (e.g. after redirect) for the integrity compare. */
  servedUrl?: string;
}

/** Size limits in bytes: 25 MB general / 500 MB video (spec §17.4). */
export const GENERAL_LIMIT_BYTES = 25 * 1024 * 1024;
export const VIDEO_LIMIT_BYTES = 500 * 1024 * 1024;

export function limitForKind(kind: MediaKind): number {
  return kind === "video" ? VIDEO_LIMIT_BYTES : GENERAL_LIMIT_BYTES;
}

/**
 * Shared download helper with expected-size checking. Throws
 * GhlUploadError("download-failed") wrapping any transport error.
 */
export async function downloadBytes(
  client: GhlUploadClient,
  url: string,
  options: { expectedSize?: number; signal?: AbortSignal } = {},
): Promise<DownloadedFile> {
  let downloaded: DownloadedFile;
  try {
    downloaded = await client.downloadFile({ url, signal: options.signal });
  } catch (cause) {
    throw new GhlUploadError(
      "download-failed",
      `Failed to download ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (
    options.expectedSize !== undefined &&
    downloaded.data.byteLength !== options.expectedSize
  ) {
    throw new GhlUploadError(
      "integrity-failed",
      `Downloaded ${downloaded.data.byteLength} bytes, expected ${options.expectedSize}`,
    );
  }
  return downloaded;
}