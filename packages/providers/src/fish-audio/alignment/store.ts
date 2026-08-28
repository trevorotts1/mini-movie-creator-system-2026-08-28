/// <reference types="node" />
/**
 * Alignment store (FISH-006) — durable, file-backed persistence of per-
 * dialogue-asset alignment records.
 *
 * One JSON file per dialogue asset key under `directory/<key>.json`, mirroring
 * the FISH-005 dialogue-cache layout: the alignment for an asset lives beside
 * the asset it belongs to and is addressed by the SAME cache key, so any
 * consumer (FISH-007 caption output, QC subtitle-sync checks) can resolve the
 * timings for a dialogue asset deterministically. Durable, migration-light,
 * consistent with the monorepo's V1 posture (spec §37). Writes are serialized
 * per store instance. Dialogue text is untrusted data — it is stored verbatim
 * and never used to construct paths (the file name is the hex digest key).
 *
 * The store does NOT re-validate a parsed record beyond structural checks —
 * `extractAlignment` is the single validation point at hand-off time.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isCurrentDialogueAssetKey } from "./key.js";
import type {
  FishAlignmentFile,
  FishDialogueAlignment,
} from "./types.js";

/** Injectable filesystem seam for tests. Mirrors the fs subset used. */
export interface FishAlignmentFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
}

const DEFAULT_FS: FishAlignmentFs = fs;

export interface FishAlignmentStoreOptions {
  /** Absolute directory holding `<key>.json` alignment records. */
  directory: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: FishAlignmentFs;
}

export class FishAlignmentStore {
  private readonly dir: string;
  private readonly fsImpl: FishAlignmentFs;
  /** Serializes ALL writes from this instance (process-level safety). */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FishAlignmentStoreOptions) {
    if (!options.directory?.trim()) {
      throw new Error("FishAlignmentStore.directory is required");
    }
    this.dir = options.directory;
    this.fsImpl = options.fs ?? DEFAULT_FS;
  }

  /** Persist an alignment record. One record per asset key; a second save
   * for the same key is an error — regenerate deliberately via
   * `replace` if a re-extraction is intended. */
  async save(alignment: FishDialogueAlignment): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.readByKey(alignment.key);
      if (existing) {
        throw new Error(
          `Alignment already exists for dialogue asset ${alignment.key} — use replace() to re-extract`,
        );
      }
      await this.writeDoc(alignment);
    });
  }

  /** Unconditionally persist an alignment record, overwriting any existing
   * record for the same key (deliberate re-extraction path). */
  async replace(alignment: FishDialogueAlignment): Promise<void> {
    return this.enqueue(async () => {
      await this.writeDoc(alignment);
    });
  }

  /** Get the alignment record for a dialogue asset key, or null. */
  async getByKey(key: string): Promise<FishDialogueAlignment | null> {
    return this.readByKey(key);
  }

  /** True when a record exists for the key. */
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

  private async readByKey(key: string): Promise<FishDialogueAlignment | null> {
    if (!isCurrentDialogueAssetKey(key)) return null;
    try {
      const raw = await this.fsImpl.readFile(this.filePathFor(key), "utf8");
      return parseAlignmentDoc(raw, this.filePathFor(key));
    } catch (err) {
      if (isNodeENOENT(err)) return null;
      throw err;
    }
  }

  /** Atomically write the record: temp file + rename in the same directory. */
  private async writeDoc(alignment: FishDialogueAlignment): Promise<void> {
    const doc: FishAlignmentFile = { formatVersion: 1, alignment };
    const filePath = this.filePathFor(alignment.key);
    await this.fsImpl.mkdir(this.dir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const json = JSON.stringify(doc, null, 2) + "\n";
    await this.fsImpl.writeFile(tmp, json, "utf8");
    const renameImpl = (this.fsImpl as unknown as { rename?: (a: string, b: string) => Promise<void> })
      .rename;
    if (typeof renameImpl === "function") {
      await renameImpl.call(this.fsImpl, tmp, filePath);
    } else {
      await this.fsImpl.writeFile(filePath, json, "utf8");
    }
  }
}

/** Parse + structurally check an on-disk document. */
export function parseAlignmentDoc(raw: string, filePath: string): FishDialogueAlignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Alignment file at ${filePath} is not valid JSON`);
  }
  const doc = parsed as Partial<FishAlignmentFile>;
  if (
    doc?.formatVersion !== 1 ||
    typeof doc.alignment !== "object" ||
    doc.alignment === null ||
    typeof doc.alignment.key !== "string" ||
    !Array.isArray(doc.alignment.words)
  ) {
    throw new Error(
      `Alignment file at ${filePath} is malformed (expected formatVersion 1)`,
    );
  }
  return doc.alignment;
}

function isNodeENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}