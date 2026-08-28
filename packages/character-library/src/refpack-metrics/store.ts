/**
 * Reference-pack metrics — persistence + historical success queries (spec §8).
 *
 * The store records, per generated clip, exactly which reference assets were
 * used and whether the clip was ACCEPTED or REJECTED. From those records it
 * answers the query DIR-013 needs: historical success rate per character /
 * model / reference combination — as a single-reference rate (how often has
 * using reference X with model M on character C produced an accepted clip)
 * and as a whole-pack rate (how often has this exact reference pack
 * succeeded), including per-pack outcome breakdowns.
 *
 * Durable, migration-light JSON-file storage consistent with the monorepo's
 * V1 posture (spec §37); the shape mirrors the character-library sibling
 * stores so a later repository swap (SQLite) is mechanical. All writes
 * serialize behind a process-level queue; the file is written atomically.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isClipOutcome,
  type ClipOutcome,
  type RecordedOutcome,
  type RecordedOutcomeInput,
} from "./types.js";

/** The on-disk document shape. Versioned so the format can evolve. */
export interface RefpackMetricsFile {
  formatVersion: 1;
  /** Outcomes keyed by their assigned id (stringified) — insertion ordered. */
  outcomes: Record<string, RecordedOutcome>;
  /** dedupeKey -> assigned outcome id (survives restarts). */
  dedupeIndex: Record<string, number>;
  nextId: number;
}

/** Injectable filesystem seam for tests; mirrors the fs subset used. */
export interface RefpackMetricsFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
}

const DEFAULT_FS: RefpackMetricsFs = fs as unknown as RefpackMetricsFs;

export interface RefpackMetricsStoreOptions {
  /** Absolute path of the JSON file backing the store. */
  filePath: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: RefpackMetricsFs;
  /** Injectable clock for occurredAt stamps (tests). */
  now?: () => Date;
}

/** Historical success rate for one combination slice. */
export interface SuccessRate {
  /** Outcome records contributing to this rate. */
  samples: number;
  /** Records with outcome ACCEPTED. */
  accepted: number;
  /** Records with outcome REJECTED. */
  rejected: number;
  /** accepted / samples in [0,1]; null when no samples (never conflate
   * "no history" with "always fails" — the planner treats null as neutral). */
  rate: number | null;
}

/** Success rate for one reference asset within a character/model context. */
export interface ReferenceSuccess extends SuccessRate {
  /** The reference asset ID (spec §9/§19 linkage). */
  referenceId: string;
}

/** Success rate for one exact reference pack (ordered ID list). */
export interface PackSuccess extends SuccessRate {
  /** The pack as recorded: reference asset IDs in provider-passed order. */
  referenceIds: string[];
}

const EMPTY_RATE: SuccessRate = { samples: 0, accepted: 0, rejected: 0, rate: null };

function rateFrom(samples: number, accepted: number): SuccessRate {
  return {
    samples,
    accepted,
    rejected: samples - accepted,
    rate: samples > 0 ? accepted / samples : null,
  };
}

export class RefpackMetricsStore {
  private readonly filePath: string;
  private readonly fsImpl: RefpackMetricsFs;
  private readonly now: () => Date;
  /** Process-level write lock: every read-modify-write runs serialized. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RefpackMetricsStoreOptions) {
    if (!options.filePath?.trim()) {
      throw new Error("RefpackMetricsStore.filePath is required");
    }
    this.filePath = options.filePath;
    this.fsImpl = options.fs ?? DEFAULT_FS;
    this.now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ writes

  /** Record one clip outcome with the reference pack that produced it.
   * Returns the persisted record. With a `dedupeKey`, re-recording the same
   * key is a no-op returning the original record (job retries / replay). */
  async record(input: RecordedOutcomeInput): Promise<RecordedOutcome> {
    return this.enqueue(async () => {
      assertValidInput(input);
      const doc = await this.readDoc();
      if (input.dedupeKey !== undefined) {
        const existingId = doc.dedupeIndex[input.dedupeKey];
        if (existingId !== undefined) {
          const existing = doc.outcomes[String(existingId)];
          if (existing) return existing;
        }
      }
      const id = doc.nextId;
      const record: RecordedOutcome = {
        id,
        characterId: input.characterId,
        model: input.model,
        referenceIds: [...input.referenceIds],
        outcome: input.outcome,
        shotId: input.shotId ?? null,
        jobId: input.jobId ?? null,
        reason: input.reason ?? null,
        occurredAt: normalizeTimestamp(input.occurredAt ?? this.now().toISOString()),
      };
      doc.outcomes[String(id)] = record;
      if (input.dedupeKey !== undefined) {
        doc.dedupeIndex[input.dedupeKey] = id;
      }
      doc.nextId = id + 1;
      await this.writeDoc(doc);
      return record;
    });
  }

  /** Record a bulk batch of outcomes in one write. Dedupe keys apply per
   * entry; duplicates within the batch resolve to the first entry. */
  async recordMany(inputs: readonly RecordedOutcomeInput[]): Promise<RecordedOutcome[]> {
    return this.enqueue(async () => {
      const doc = await this.readDoc();
      const out: RecordedOutcome[] = [];
      for (const input of inputs) {
        assertValidInput(input);
        if (input.dedupeKey !== undefined) {
          const existingId = doc.dedupeIndex[input.dedupeKey];
          if (existingId !== undefined) {
            const existing = doc.outcomes[String(existingId)];
            if (existing) {
              out.push(existing);
              continue;
            }
          }
        }
        const id = doc.nextId;
        const record: RecordedOutcome = {
          id,
          characterId: input.characterId,
          model: input.model,
          referenceIds: [...input.referenceIds],
          outcome: input.outcome,
          shotId: input.shotId ?? null,
          jobId: input.jobId ?? null,
          reason: input.reason ?? null,
          occurredAt: normalizeTimestamp(input.occurredAt ?? this.now().toISOString()),
        };
        doc.outcomes[String(id)] = record;
        if (input.dedupeKey !== undefined) {
          doc.dedupeIndex[input.dedupeKey] = id;
        }
        doc.nextId = id + 1;
        out.push(record);
      }
      await this.writeDoc(doc);
      return out;
    });
  }

  // ------------------------------------------------------------------- reads

  /** One outcome by id, or undefined. */
  async get(id: number): Promise<RecordedOutcome | undefined> {
    const doc = await this.readDoc();
    return doc.outcomes[String(id)];
  }

  /** All outcomes in insertion order. */
  async list(): Promise<RecordedOutcome[]> {
    const doc = await this.readDoc();
    return Object.values(doc.outcomes);
  }

  /** Outcomes for one character (any model/reference), insertion order. */
  async listForCharacter(characterId: string): Promise<RecordedOutcome[]> {
    const all = await this.list();
    return all.filter((o) => o.characterId === characterId);
  }

  /** Historical success rate per character / model / reference combination —
   * the DIR-013 "model-specific historical success" term. Each entry counts
   * the clips for that character+model in which the reference appeared, and
   * how many of those clips were accepted. Rate is null with zero samples. */
  async successRateByReference(
    characterId: string,
    model: string,
  ): Promise<ReferenceSuccess[]> {
    const doc = await this.readDoc();
    const totals = new Map<string, { samples: number; accepted: number }>();
    for (const outcome of Object.values(doc.outcomes)) {
      if (outcome.characterId !== characterId || outcome.model !== model) continue;
      for (const refId of outcome.referenceIds) {
        const entry = totals.get(refId) ?? { samples: 0, accepted: 0 };
        entry.samples += 1;
        if (outcome.outcome === "ACCEPTED") entry.accepted += 1;
        totals.set(refId, entry);
      }
    }
    return [...totals.entries()]
      .map(([referenceId, t]) => ({ referenceId, ...rateFrom(t.samples, t.accepted) }))
      .sort((a, b) => a.referenceId.localeCompare(b.referenceId));
  }

  /** Success rate for one specific character / model / reference combination.
   * When `at` is supplied, only outcomes recorded at or before that instant
   * count (planner decision-time queries must not see the future). */
  async successRateForReference(
    characterId: string,
    model: string,
    referenceId: string,
    at?: string,
  ): Promise<SuccessRate> {
    const doc = await this.readDoc();
    let samples = 0;
    let accepted = 0;
    for (const outcome of Object.values(doc.outcomes)) {
      if (outcome.characterId !== characterId || outcome.model !== model) continue;
      if (!outcome.referenceIds.includes(referenceId)) continue;
      if (at !== undefined && outcome.occurredAt > at) continue;
      samples += 1;
      if (outcome.outcome === "ACCEPTED") accepted += 1;
    }
    return samples > 0 ? rateFrom(samples, accepted) : { ...EMPTY_RATE };
  }

  /** Success rate for one exact reference pack (order-insensitive for
   * matching — the same set of references is the same pack). Rate null with
   * zero samples; also returns the accepted/rejected split for reporting. */
  async successRateForPack(
    characterId: string,
    model: string,
    referenceIds: readonly string[],
  ): Promise<PackSuccess> {
    const doc = await this.readDoc();
    const wanted = new Set(referenceIds);
    let samples = 0;
    let accepted = 0;
    let matchedIds: string[] = [];
    for (const outcome of Object.values(doc.outcomes)) {
      if (outcome.characterId !== characterId || outcome.model !== model) continue;
      if (!sameSet(outcome.referenceIds, wanted)) continue;
      samples += 1;
      matchedIds = outcome.referenceIds;
      if (outcome.outcome === "ACCEPTED") accepted += 1;
    }
    return {
      referenceIds: matchedIds.length > 0 ? matchedIds : [...referenceIds],
      ...rateFrom(samples, accepted),
    };
  }

  /** Success rates for every distinct pack seen for a character/model,
   * ordered by sample count descending (best-known packs first for ties by
   * insertion order). The "best reference packs for recurring
   * characters/models" view. */
  async successRateByPack(
    characterId: string,
    model: string,
  ): Promise<PackSuccess[]> {
    const doc = await this.readDoc();
    const groups = new Map<string, { ids: string[]; samples: number; accepted: number }>();
    for (const outcome of Object.values(doc.outcomes)) {
      if (outcome.characterId !== characterId || outcome.model !== model) continue;
      const key = packKey(outcome.referenceIds);
      const entry = groups.get(key) ?? {
        ids: outcome.referenceIds,
        samples: 0,
        accepted: 0,
      };
      entry.samples += 1;
      if (outcome.outcome === "ACCEPTED") entry.accepted += 1;
      groups.set(key, entry);
    }
    return [...groups.values()]
      .map((g) => ({ referenceIds: g.ids, ...rateFrom(g.samples, g.accepted) }))
      .sort((a, b) => b.samples - a.samples);
  }

  /** Outcomes for one shot (repair-loop queries: which pack failed here). */
  async listForShot(shotId: string): Promise<RecordedOutcome[]> {
    const all = await this.list();
    return all.filter((o) => o.shotId === shotId);
  }

  // ---------------------------------------------------------------- internals

  /** Serialize a read-modify-write behind the process-level queue. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Read the store file; a missing file is an empty store (not an error). */
  private async readDoc(): Promise<RefpackMetricsFile> {
    try {
      const raw = await this.fsImpl.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RefpackMetricsFile>;
      if (
        parsed?.formatVersion !== 1 ||
        typeof parsed.outcomes !== "object" ||
        parsed.outcomes === null ||
        Array.isArray(parsed.outcomes) ||
        typeof parsed.dedupeIndex !== "object" ||
        parsed.dedupeIndex === null ||
        Array.isArray(parsed.dedupeIndex) ||
        typeof parsed.nextId !== "number" ||
        !Number.isInteger(parsed.nextId) ||
        parsed.nextId < 1
      ) {
        throw new Error(
          `Refpack metrics store at ${this.filePath} is malformed (expected formatVersion 1)`,
        );
      }
      validateOutcomeRows(parsed.outcomes, this.filePath);
      return {
        formatVersion: 1,
        outcomes: parsed.outcomes,
        dedupeIndex: parsed.dedupeIndex,
        nextId: parsed.nextId,
      };
    } catch (err) {
      if (isNodeENOENT(err)) {
        return { formatVersion: 1, outcomes: {}, dedupeIndex: {}, nextId: 1 };
      }
      throw err;
    }
  }

  /** Atomically write the store: temp file + rename in the same directory. */
  private async writeDoc(doc: RefpackMetricsFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.fsImpl.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await this.fsImpl.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    await this.fsImpl.rename(tmp, this.filePath);
  }
}

/** Order-insensitive pack identity: sorted, joined. */
function packKey(referenceIds: readonly string[]): string {
  return [...referenceIds].sort().join(" ");
}

function sameSet(a: readonly string[], b: ReadonlySet<string>): boolean {
  if (a.length !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Row-level validation: a corrupt outcome row silently skews the success
 * rates DIR-013 consumes, so fail loudly instead of returning bad numbers. */
function validateOutcomeRows(
  outcomes: Record<string, RecordedOutcome>,
  filePath: string,
): void {
  const fail = (why: string): never => {
    throw new Error(`Refpack metrics store at ${filePath} is malformed: ${why}`);
  };
  for (const [key, row] of Object.entries(outcomes)) {
    if (!/^\d+$/.test(key) || typeof row !== "object" || row === null) fail("bad outcome key");
    if (typeof row.id !== "number" || String(row.id) !== key) fail(`outcome ${key}: id mismatch`);
    if (typeof row.characterId !== "string" || row.characterId.length === 0) {
      fail(`outcome ${key}: bad characterId`);
    }
    if (typeof row.model !== "string" || row.model.length === 0) {
      fail(`outcome ${key}: bad model`);
    }
    if (!Array.isArray(row.referenceIds)) fail(`outcome ${key}: bad referenceIds`);
    for (const refId of row.referenceIds) {
      if (typeof refId !== "string" || refId.length === 0) {
        fail(`outcome ${key}: bad referenceIds entry`);
      }
    }
    if (!isClipOutcome(row.outcome)) fail(`outcome ${key}: bad outcome`);
    if (typeof row.occurredAt !== "string" || Number.isNaN(Date.parse(row.occurredAt))) {
      fail(`outcome ${key}: bad occurredAt`);
    }
  }
}

function assertValidInput(input: RecordedOutcomeInput): void {
  if (!input.characterId?.trim()) {
    throw new Error("characterId must be a non-empty string");
  }
  if (!input.model?.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (!Array.isArray(input.referenceIds)) {
    throw new Error("referenceIds must be an array of reference asset IDs");
  }
  for (const refId of input.referenceIds) {
    if (typeof refId !== "string" || refId.trim().length === 0) {
      throw new Error("referenceIds entries must be non-empty strings");
    }
  }
  if (!isClipOutcome(input.outcome)) {
    throw new Error(
      `outcome must be one of ACCEPTED | REJECTED, got: ${String(input.outcome)}`,
    );
  }
}

/** Normalize a caller-supplied or clock timestamp to a comparable instant.
 * Mixed-offset strings (e.g. "…-05:00" vs "…Z") break plain string comparison
 * in `at` cutoff queries ("-" < "Z" sorts offsets wrong), so every stored
 * occurredAt is forced to a UTC ISO 8601 instant. */
function normalizeTimestamp(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("occurredAt must be a non-empty ISO 8601 string");
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`occurredAt is not a valid ISO 8601 instant, got: ${value}`);
  }
  return new Date(ms).toISOString();
}

function isNodeENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}