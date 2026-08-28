/// <reference types="node" />
/**
 * Dialogue cache (FISH-005) — durable, file-backed store of synthesized
 * dialogue assets keyed by request hash.
 *
 * Runbook §30: "Dialogue generated as separate durable asset so replacing a
 * video clip does not force voice regeneration." Runbook §24: "dialogue
 * generation/cache/idempotency". This module is the mechanism for both: the
 * FIRST `getOrSynthesize` call for a text+voice+model request synthesizes and
 * stores; EVERY later call with the same request returns the SAME stored
 * bytes without a synthesis call. Replacing a video clip re-resolves dialogue
 * from the cache — the voice is never regenerated and never re-billed.
 *
 * Storage: one JSON file per key under `directory/<key>.json` (audio
 * base64-encoded inside). Durable, migration-light, consistent with the
 * monorepo's V1 posture (spec §37). Writes are serialized per store instance;
 * the synthesizer is serialized per key so two concurrent calls for the same
 * dialogue never double-synthesize (single-flight). Story text is untrusted
 * data — it is stored verbatim and hashed; it is never executed and never
 * used to build file paths (the key is a hex digest).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { dialogueCacheKey, isCurrentKeyFormat, type DialogueCacheKeyFn } from "./seams.js";
import type {
  FishDialogueCacheEntry,
  FishDialogueCacheFile,
  FishDialogueRequest,
} from "./types.js";

/** Injectable filesystem seam (tests). Mirrors the fs subset the cache uses. */
export interface FishDialogueCacheFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
}

const DEFAULT_FS: FishDialogueCacheFs = fs;

/** Async factory that synthesizes audio for a request. The cache calls this
 * AT MOST ONCE per key (single-flight); it receives the resolved request. */
export type DialogueSynthesizer = (
  request: FishDialogueRequest,
  key: string,
) => Promise<{ audio: ArrayBuffer; model: string }>;

export interface FishDialogueCacheOptions {
  /** Absolute directory holding `<key>.json` entries. */
  directory: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: FishDialogueCacheFs;
  /** Injectable clock for `createdAt` stamps (tests). */
  now?: () => Date;
}

export class FishDialogueCache {
  private readonly dir: string;
  private readonly fsImpl: FishDialogueCacheFs;
  private readonly now: () => Date;
  /** Serializes ALL writes from this instance (process-level safety). */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** Single-flight per key: in-flight getOrSynthesize promises. */
  private readonly inflight = new Map<string, Promise<FishDialogueCacheEntry>>();

  constructor(options: FishDialogueCacheOptions) {
    if (!options.directory?.trim()) {
      throw new Error("FishDialogueCache.directory is required");
    }
    this.dir = options.directory;
    this.fsImpl = options.fs ?? DEFAULT_FS;
    this.now = options.now ?? (() => new Date());
  }

  /** Look up a cached entry without synthesizing. */
  async get(request: FishDialogueRequest): Promise<FishDialogueCacheEntry | null> {
    const key = this.keyOf(request);
    return this.getByKey(key);
  }

  /** Look up by explicit key (loader seam for other packages). */
  async getByKey(key: string): Promise<FishDialogueCacheEntry | null> {
    if (!isCurrentKeyFormat(key)) return null;
    const raw = await this.readEntryFile(this.filePathFor(key));
    return raw;
  }

  /**
   * Idempotent resolve: return the cached asset for `request`, synthesizing
   * and storing it exactly once when absent. Concurrent calls for the same
   * request share one synthesis (single-flight). The synthesizer result is
   * persisted BEFORE the promise resolves (crash-safe: a crash after
   * synthesis but before persist simply re-synthesizes next time — it never
   * returns audio that was not durably recorded).
   */
  async getOrSynthesize(
    request: FishDialogueRequest,
    synthesize: DialogueSynthesizer,
  ): Promise<FishDialogueCacheEntry> {
    const key = this.keyOf(request);
    const existing = await this.getByKey(key);
    if (existing) return existing;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const job = (async () => {
      const fresh = await this.getByKey(key);
      if (fresh) return fresh;
      const synthesized = await synthesize(request, key);
      const entry = this.buildEntry(key, request, synthesized);
      await this.put(entry);
      return entry;
    })().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, job);
    return job;
  }

  /** Store an entry (overwrites same-key content; key collision is the identity). */
  async put(entry: FishDialogueCacheEntry): Promise<void> {
    if (!isCurrentKeyFormat(entry.key)) {
      throw new Error(`FishDialogueCache.put: invalid key format: ${entry.key}`);
    }
    const write = this.writeQueue.then(() =>
      this.persist(this.filePathFor(entry.key), entry),
    );
    // Keep the chain alive even if a write rejects.
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  /** All keys currently on disk (best-effort; unreadable files skipped). */
  async keys(): Promise<string[]> {
    let names: string[];
    try {
      names = await this.fsImplReadDir();
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .filter(isCurrentKeyFormat)
      .sort();
  }

  /** Delete one entry. Returns true when a file was removed. */
  async delete(key: string): Promise<boolean> {
    if (!isCurrentKeyFormat(key)) return false;
    const p = this.filePathFor(key);
    try {
      const raw = await this.fsImpl.readFile(p, "utf8");
      JSON.parse(raw); // only delete valid entries
      const write = this.writeQueue.then(async () => {
        await (this.fsImpl as FishDialogueCacheFs & {
          rm?: (p: string) => Promise<void>;
        }).rm?.(p);
        // Fall back to truncate-delete for seams without rm.
        if ((this.fsImpl as { rm?: unknown }).rm === undefined) {
          await this.fsImpl.writeFile(p, "", "utf8");
        }
      });
      this.writeQueue = write.catch(() => undefined);
      await write;
      return true;
    } catch {
      return false;
    }
  }

  /** The key for a request — exposed so callers can log/persist determinism. */
  keyOf(request: FishDialogueRequest): string {
    return this.keyFn(request);
  }

  private readonly keyFn: DialogueCacheKeyFn = (req) => dialogueCacheKey(req);

  private filePathFor(key: string): string {
    // key is a validated `fsh1:<64 hex>` — safe to embed in a path.
    return path.join(this.dir, `${key}.json`);
  }

  private buildEntry(
    key: string,
    request: FishDialogueRequest,
    synthesized: { audio: ArrayBuffer; model: string },
  ): FishDialogueCacheEntry {
    return {
      key,
      request: structuredClone(request),
      audio: synthesized.audio,
      audioByteLength: synthesized.audio.byteLength,
      model: synthesized.model,
      createdAt: this.now().toISOString(),
      origin: "synthesized",
    };
  }

  private async persist(filePath: string, entry: FishDialogueCacheEntry): Promise<void> {
    const { audio, ...rest } = entry;
    const doc: FishDialogueCacheFile = {
      formatVersion: 1,
      entry: structuredClone(rest),
      audioBase64: Buffer.from(audio).toString("base64"),
    };
    await this.fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await this.fsImpl.writeFile(filePath, JSON.stringify(doc), "utf8");
  }

  private async readEntryFile(filePath: string): Promise<FishDialogueCacheEntry | null> {
    let raw: string;
    try {
      raw = await this.fsImpl.readFile(filePath, "utf8");
    } catch {
      return null; // miss (or unreadable = miss)
    }
    try {
      const doc = JSON.parse(raw) as FishDialogueCacheFile;
      if (doc.formatVersion !== 1) return null;
      const audio = Uint8Array.from(Buffer.from(doc.audioBase64, "base64")).buffer;
      return { ...doc.entry, audio, origin: "synthesized" };
    } catch {
      return null; // corrupt entry counts as a miss, never a crash
    }
  }

  private fsImplReadDir(): Promise<string[]> {
    const impl = this.fsImpl as FishDialogueCacheFs & {
      readdir?: (p: string) => Promise<string[]>;
    };
    if (!impl.readdir) return Promise.reject(new Error("no readdir on fs seam"));
    return impl.readdir(this.dir);
  }
}