/**
 * Voice-profile persistence — JSON-file backed store, one profile per character.
 *
 * Durable, migration-light storage consistent with the monorepo's V1 posture
 * (spec §37: lightweight durable DB; repositories designed so a server-DB swap
 * is practical later). The store serializes ALL writes; concurrent calls from
 * one process are safe. One profile per character ID — the binding is permanent
 * (spec §30: recurring characters never randomly change voices); creating a
 * second profile for the same character is an error, updates are the path.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createVoiceProfile,
  updateVoiceProfile,
  isProductionReady,
  type FishVoiceProfile,
  type FishVoiceProfileCreateInput,
  type FishVoiceProfileUpdateInput,
} from "./profile.js";

/** Result of listing: profiles keyed by character ID. */
export type FishVoiceProfileMap = Record<string, FishVoiceProfile>;

/** The on-disk document shape. Versioned so the format can evolve. */
export interface FishVoiceProfileFile {
  formatVersion: 1;
  profiles: FishVoiceProfileMap;
}

/** Injectable filesystem seam for tests. Mirrors the subset of
 * `fs.promises` the store uses. */
export interface FishVoiceProfileFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
}

const DEFAULT_FS: FishVoiceProfileFs = fs;

export interface FishVoiceProfileStoreOptions {
  /** Absolute path of the JSON file backing the store. */
  filePath: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: FishVoiceProfileFs;
  /** Injectable clock for updatedAt stamps (tests). */
  now?: () => Date;
}

/** JSON-file-backed store of canonical character voice profiles. */
export class FishVoiceProfileStore {
  private readonly filePath: string;
  private readonly fsImpl: FishVoiceProfileFs;
  private readonly now: () => Date;
  /** Process-level write lock: every read-modify-write runs serialized. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FishVoiceProfileStoreOptions) {
    if (!options.filePath?.trim()) {
      throw new Error("FishVoiceProfileStore.filePath is required");
    }
    this.filePath = options.filePath;
    this.fsImpl = options.fs ?? DEFAULT_FS;
    this.now = options.now ?? (() => new Date());
  }

  /** Create + persist a new profile bound to `characterId`. Rejects when a
   * profile already exists for that character (one voice per character). */
  async create(
    characterId: string,
    input: FishVoiceProfileCreateInput = {},
  ): Promise<FishVoiceProfile> {
    return this.enqueue(async () => {
      const doc = await this.readDoc();
      if (doc.profiles[characterId]) {
        throw new Error(
          `A voice profile already exists for character ${characterId} — update it instead (one voice per character)`,
        );
      }
      const profile = withClock(createVoiceProfile(characterId, input), this.now);
      doc.profiles[characterId] = profile;
      await this.writeDoc(doc);
      return profile;
    });
  }

  /** Get one profile by character ID, or undefined. */
  async get(characterId: string): Promise<FishVoiceProfile | undefined> {
    const doc = await this.readDoc();
    return doc.profiles[characterId];
  }

  /** List all profiles. Order: insertion order of the underlying file. */
  async list(): Promise<FishVoiceProfile[]> {
    const doc = await this.readDoc();
    return Object.values(doc.profiles);
  }

  /** List profiles bound to any of the given character IDs (deduped). */
  async listForCharacters(characterIds: readonly string[]): Promise<FishVoiceProfile[]> {
    const doc = await this.readDoc();
    const out: FishVoiceProfile[] = [];
    for (const id of characterIds) {
      const p = doc.profiles[id];
      if (p) out.push(p);
    }
    return out;
  }

  /** Apply an update to the profile bound to `characterId`. Throws when no
   * profile exists. Returns the updated profile (new object). */
  async update(
    characterId: string,
    patch: FishVoiceProfileUpdateInput,
  ): Promise<FishVoiceProfile> {
    return this.enqueue(async () => {
      const doc = await this.readDoc();
      const existing = doc.profiles[characterId];
      if (!existing) {
        throw new Error(`No voice profile exists for character ${characterId}`);
      }
      const updated = withClock(updateVoiceProfile(existing, patch), this.now, existing);
      doc.profiles[characterId] = updated;
      await this.writeDoc(doc);
      return updated;
    });
  }

  /** Record a test-sample result on the profile. */
  async recordTestSample(
    characterId: string,
    result: { status: "pending" | "generated" | "approved" | "rejected"; assetId?: string },
  ): Promise<FishVoiceProfile> {
    return this.update(characterId, {
      testSampleStatus: result.status,
      ...(result.assetId !== undefined ? { testSampleAssetId: result.assetId } : {}),
    });
  }

  /** True when the profile for `characterId` exists, is approved, and its test
   * sample is approved — the gate before auto-reuse in synthesis planning. */
  async isProductionReady(characterId: string): Promise<boolean> {
    const profile = await this.get(characterId);
    return profile !== undefined && isProductionReady(profile);
  }

  // ---------------------------------------------------------------- internals

  /** Serialize a read-modify-write behind the process-level queue. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Read the store file; a missing file is an empty store (not an error). */
  private async readDoc(): Promise<FishVoiceProfileFile> {
    try {
      const raw = await this.fsImpl.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FishVoiceProfileFile>;
      if (parsed?.formatVersion !== 1 || typeof parsed.profiles !== "object" || parsed.profiles === null) {
        throw new Error(
          `Voice profile store at ${this.filePath} is malformed (expected formatVersion 1)`,
        );
      }
      return { formatVersion: 1, profiles: parsed.profiles };
    } catch (err) {
      if (isNodeENOENT(err)) {
        return { formatVersion: 1, profiles: {} };
      }
      throw err;
    }
  }

  /** Atomically write the store: temp file + rename in the same directory. */
  private async writeDoc(doc: FishVoiceProfileFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.fsImpl.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await this.fsImpl.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    // rename is atomic on POSIX; fall back to direct write semantics only via
    // the injected fs in tests (which provides rename through fs default).
    const renameImpl = (this.fsImpl as unknown as { rename?: (a: string, b: string) => Promise<void> }).rename;
    if (typeof renameImpl === "function") {
      await renameImpl.call(this.fsImpl, tmp, this.filePath);
    } else {
      await this.fsImpl.writeFile(this.filePath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    }
  }
}

/** Stamp updatedAt/createdAt with the store's injected clock (tests) while
 * preserving the validation module's defaults in production. */
function withClock(
  profile: FishVoiceProfile,
  now: () => Date,
  previous?: FishVoiceProfile,
): FishVoiceProfile {
  const stamp = now().toISOString();
  if (previous) {
    return profile.updatedAt === previous.updatedAt ? { ...profile, updatedAt: stamp } : profile;
  }
  return { ...profile, createdAt: stamp, updatedAt: stamp };
}

function isNodeENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}