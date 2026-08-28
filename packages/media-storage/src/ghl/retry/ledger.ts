/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Archival idempotency ledger (MMCS task GHL-011).
 *
 * Spec §35.3: "Never regenerate expensive media merely because archival
 * failed." Spec §38: "Never submit duplicate paid generation because context
 * was lost."
 *
 * The danger with retrying a GHL upload is the lost-success race: attempt 1
 * reaches GHL, the file lands, but the HTTP response is lost (connection
 * reset mid-response). A naive retry uploads the file a second time —
 * duplicate GHL file. This ledger closes that window:
 *
 * - Before the first attempt, the caller RESERVES a key derived from a
 *   canonical request hash (scope + destination + canonical filename +
 *   checksum). Same archival target always maps to the same key.
 * - The outcome (fileId/url) is persisted atomically (temp file + fsync +
 *   rename) once known. A crash mid-write leaves either no entry or a
 *   complete one — never a half-written one.
 * - Any later call with the same key returns the RECORDED outcome without
 *   re-invoking the upload, so a retry after a lost success response reuses
 *   the first upload instead of creating a duplicate.
 * - Concurrent same-key calls in one process serialize via an in-process
 *   promise chain (one execution wins, the rest observe its record).
 *
 * Cross-process safety: the atomic reserve/record writes keep the ledger
 * consistent on disk; two processes racing the same key could both see "no
 * record" and both upload. The caller MUST therefore also pass a provider-
 * side idempotency signal where available (the deterministic canonical
 * filename, spec §35.3) so a rare cross-process double upload stays
 * detectable. Within one MMCS process — the only process that drives
 * archival — the in-process lock serializes fully.
 */

export interface ArchivalLedgerRecord<T = unknown> {
  key: string;
  scope: string;
  /** sha-256 over {scope, request}; the key is derived from it. */
  requestHash: string;
  /** ISO timestamp of when the record first appeared. */
  createdAt: string;
  /** "reserved" while the operation is in flight; "completed" once durable. */
  state: "reserved" | "completed";
  result: T | null;
  serializationError?: string;
}

export class ArchivalLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivalLedgerError";
  }
}

/** sha-256 hex of a canonical JSON rendering — key-order stable. */
function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function assertSafeKey(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ArchivalLedgerError(`invalid archival idempotency key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Derive the ledger key for one archival request. Pure + deterministic. */
export function archivalKey(scope: string, request: unknown): string {
  if (!scope || /[^A-Za-z0-9_-]/.test(scope)) {
    throw new ArchivalLedgerError(`invalid archival scope: ${JSON.stringify(scope)}`);
  }
  return assertSafeKey(`${scope}-${stableHash({ scope, request })}`);
}

/**
 * Directory-backed idempotency ledger for GHL archival operations.
 * One instance per archival root; `dir` lives under the MMCS state directory.
 */
export class ArchivalLedger {
  readonly dir: string;

  constructor(dir: string) {
    if (!dir || dir.trim() === "") {
      throw new ArchivalLedgerError("archival ledger dir is required");
    }
    this.dir = dir;
  }

  private recordPath(key: string): string {
    return join(this.dir, `${assertSafeKey(key)}.json`);
  }

  async get<T>(key: string): Promise<ArchivalLedgerRecord<T> | null> {
    let raw: string;
    try {
      raw = await readFile(this.recordPath(key), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ArchivalLedgerRecord<T>;
      if (parsed === null || typeof parsed !== "object" || typeof parsed.key !== "string") {
        return null;
      }
      return parsed;
    } catch {
      // Corrupt entry (should not happen thanks to atomic writes) — treat as
      // absent so the operation can run again rather than wedging forever.
      return null;
    }
  }

  /** Persist a record atomically: temp file → fsync → rename. */
  async put<T>(record: ArchivalLedgerRecord<T>): Promise<void> {
    assertSafeKey(record.key);
    await mkdir(dirname(this.recordPath(record.key)), { recursive: true });
    const finalPath = this.recordPath(record.key);
    const tempPath = `${finalPath}.tmp-${stableHash({ key: record.key, at: process.hrtime.bigint().toString() }).slice(0, 16)}`;
    const payload = JSON.stringify(record, null, 2);
    await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx" });
    const fh = await open(tempPath, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tempPath, finalPath);
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }
  }

  /**
   * Reserve the key. Returns the existing record when one is already present
   * (duplicate archival attempt), otherwise writes a fresh reservation.
   */
  async reserve<T>(key: string, scope: string, requestHash: string): Promise<{
    record: ArchivalLedgerRecord<T>;
    created: boolean;
  }> {
    const existing = await this.get<T>(key);
    if (existing) return { record: existing, created: false };
    const fresh: ArchivalLedgerRecord<T> = {
      key,
      scope,
      requestHash,
      createdAt: new Date().toISOString(),
      state: "reserved",
      result: null,
    };
    await this.put(fresh);
    return { record: fresh, created: true };
  }

  /** Overwrite a reservation with the durable completed outcome. */
  async complete<T>(key: string, result: T): Promise<ArchivalLedgerRecord<T>> {
    const existing = await this.get<T>(key);
    if (!existing) {
      throw new ArchivalLedgerError(`cannot complete unknown archival key ${key}`);
    }
    const record: ArchivalLedgerRecord<T> = { ...existing, state: "completed", result: result ?? null };
    try {
      JSON.stringify(record.result ?? null);
    } catch (err) {
      record.result = null;
      record.serializationError =
        err instanceof Error ? err.message : "result is not JSON-serializable";
    }
    await this.put(record);
    return record;
  }

  /** Release a reservation after a definitively failed attempt (testing/admin). */
  async release(key: string): Promise<void> {
    await rm(this.recordPath(key), { force: true });
  }

  /**
   * Remove temp-file litter from a process that died between temp-file
   * creation and rename. Safe to run at startup.
   */
  async sweepTempFiles(): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (entry.includes(".tmp-")) {
        await rm(join(this.dir, entry), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private locks = new Map<string, Promise<unknown>>();

  /** Serialize concurrent same-key operations within this process. */
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Run one archival attempt under the same-key in-process lock. `fn` is the
   * single network attempt; the ledger records its outcome. Used by
   * `withArchivalIdempotency` — exposed for direct use when a caller manages
   * the reserve/complete lifecycle itself.
   */
  runLocked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.lock(key, fn);
  }
}

/** Stable request hash for a ledger key (exposed for record inspection). */
export function archivalRequestHash(scope: string, request: unknown): string {
  return stableHash({ scope, request });
}