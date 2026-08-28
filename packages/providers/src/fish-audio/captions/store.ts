/// <reference types="node" />
/**
 * Caption track store (FISH-007) — durable, file-backed persistence of
 * per-dialogue-asset caption tracks.
 *
 * One JSON file per dialogue asset key under `directory/<key>.json`,
 * mirroring the FISH-005 dialogue-cache and FISH-006 alignment-store
 * layouts: the caption track for an asset lives beside the assets it
 * belongs to and is addressed by the SAME cache key, so VID-004 (and QC
 * subtitle-sync checks) resolve it deterministically. Writes are serialized
 * per store instance. Dialogue text is untrusted data — stored verbatim,
 * never used to construct paths (the file name is the hex digest key).
 *
 * The store does NOT re-validate a parsed track beyond structural checks —
 * `buildCaptionTrack` is the single validation point at build time.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isCurrentDialogueAssetKey } from "./key.js";
import type { CaptionTrackFile } from "./file.js";
import type { CaptionTrack } from "./types.js";

/** Injectable filesystem seam for tests. Mirrors the fs subset used. */
export interface CaptionTrackFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
}

const DEFAULT_FS: CaptionTrackFs = fs;

export interface CaptionTrackStoreOptions {
  /** Absolute directory holding `<key>.json` caption tracks. */
  directory: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: CaptionTrackFs;
}

export class CaptionTrackStore {
  private readonly dir: string;
  private readonly fsImpl: CaptionTrackFs;
  /** Serializes ALL writes from this instance (process-level safety). */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: CaptionTrackStoreOptions) {
    if (!options.directory?.trim()) {
      throw new Error("CaptionTrackStore.directory is required");
    }
    this.dir = options.directory;
    this.fsImpl = options.fs ?? DEFAULT_FS;
  }

  /** Persist a caption track. One track per asset key; a second save for
   * the same key is an error — regenerate deliberately via `replace()` if a
   * rebuild is intended. */
  async save(track: CaptionTrack): Promise<void> {
    return this.enqueue(async () => {
      if (!track.sourceKey) {
        throw new Error(
          "CaptionTrack.sourceKey is required to persist a track (build from a keyed source)",
        );
      }
      const existing = await this.readByKey(track.sourceKey);
      if (existing) {
        throw new Error(
          `Caption track already exists for dialogue asset ${track.sourceKey} — use replace() to rebuild`,
        );
      }
      await this.writeDoc(track.sourceKey, track);
    });
  }

  /** Unconditionally persist a caption track, overwriting any existing
   * track for the same key (deliberate rebuild path). */
  async replace(track: CaptionTrack): Promise<void> {
    return this.enqueue(async () => {
      if (!track.sourceKey) {
        throw new Error(
          "CaptionTrack.sourceKey is required to persist a track (build from a keyed source)",
        );
      }
      await this.writeDoc(track.sourceKey, track);
    });
  }

  /** Get the caption track for a dialogue asset key, or null. */
  async getByKey(key: string): Promise<CaptionTrack | null> {
    return this.readByKey(key);
  }

  /** True when a track exists for the key. */
  async has(key: string): Promise<boolean> {
    return (await this.getByKey(key)) !== null;
  }

  // ---------------------------------------------------------------- internals

  /** Serialize a read-modify-write behind the process-level queue. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job, job);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  /** Path of the document for `key`. The key is validated before it ever
   * touches a path — untrusted text can never become a path component. */
  private filePathFor(key: string): string {
    if (!isCurrentDialogueAssetKey(key)) {
      throw new Error(`Not a valid dialogue asset key: ${JSON.stringify(key)}`);
    }
    return path.join(this.dir, `${key}.json`);
  }

  private async readByKey(key: string): Promise<CaptionTrack | null> {
    if (!isCurrentDialogueAssetKey(key)) return null;
    let filePath: string;
    try {
      filePath = this.filePathFor(key);
    } catch {
      return null;
    }
    try {
      const raw = await this.fsImpl.readFile(filePath, "utf8");
      return parseCaptionTrackDoc(raw, filePath);
    } catch (err) {
      if (isNodeENOENT(err)) return null;
      throw err;
    }
  }

  /** Atomically write the track: temp file + rename in the same directory. */
  private async writeDoc(key: string, track: CaptionTrack): Promise<void> {
    const doc: CaptionTrackFile = { formatVersion: 1, track };
    const filePath = this.filePathFor(key);
    await this.fsImpl.mkdir(this.dir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const json = JSON.stringify(doc, null, 2) + "\n";
    await this.fsImpl.writeFile(tmp, json, "utf8");
    await this.fsImpl.rename(tmp, filePath);
  }
}

/** Parse + structurally check an on-disk document. */
export function parseCaptionTrackDoc(
  raw: string,
  filePath: string,
): CaptionTrack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Caption track file at ${filePath} is not valid JSON`);
  }
  const doc = parsed as Partial<CaptionTrackFile>;
  if (
    doc?.formatVersion !== 1 ||
    typeof doc.track !== "object" ||
    doc.track === null ||
    typeof doc.track.text !== "string" ||
    !Array.isArray(doc.track.cues)
  ) {
    throw new Error(
      `Caption track file at ${filePath} is malformed (expected formatVersion 1)`,
    );
  }
  return doc.track;
}

function isNodeENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}