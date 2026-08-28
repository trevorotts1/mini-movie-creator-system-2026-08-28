/// <reference types="node" />
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, readJsonFile } from "./atomic-write.js";
import { requestHash } from "./request-hash.js";

/**
 * Once-only execution guard over a directory-backed idempotency ledger.
 *
 * Contract:
 * - First call for a key executes `fn` and records the serialized result.
 * - Any later call with the same key returns the recorded original result
 *   without re-executing `fn` (duplicate submit → original result).
 * - A crash after execution but before the result record lands is safe: the
 *   record write is atomic (temp+rename), so the ledger never contains a
 *   half-written entry. On restart the key is absent and the operation
 *   re-runs — callers must make `fn` itself safe to retry (e.g. submit with
 *   a provider-side idempotency key derived from the same hash).
 *
 * Results are JSON-serializable. `undefined` is normalized to `null`.
 */

export interface IdempotencyRecord<T = unknown> {
  key: string;
  scope: string;
  /** sha-256 request hash the key was derived from. */
  requestHash: string;
  createdAt: string;
  result: T | null;
  /** Set when the recorded value was rejected as non-serializable. */
  serializationError?: string;
}

export interface ExecuteOptions {
  /** Extra string mixed into the key, e.g. a provider task ID. */
  suffix?: string;
}

export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export class IdempotencyStore {
  readonly dir: string;

  constructor(dir: string) {
    if (!dir || dir.trim() === "") {
      throw new IdempotencyError("idempotency store dir is required");
    }
    this.dir = dir;
  }

  /**
   * Deterministic key for a scope + request payload (canonical request hash),
   * optionally suffixed. Same inputs always produce the same key.
   */
  keyFor(scope: string, request: unknown, opts?: ExecuteOptions): string {
    const base = requestHash(scope, request);
    const suffix = opts?.suffix ? `-${requestHash(scope, { suffix: opts.suffix }, { length: 16 })}` : "";
    return `${scope}-${base}${suffix}`;
  }

  private recordPath(key: string): string {
    // Keys are sha-256-derived hex + safe scope chars; still, never let a key
    // traverse directories.
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new IdempotencyError(`invalid idempotency key: ${JSON.stringify(key)}`);
    }
    return join(this.dir, `${key}.json`);
  }

  async get<T>(key: string): Promise<IdempotencyRecord<T> | null> {
    const { value, defaulted } = await readJsonFile<IdempotencyRecord<T> | null>(
      this.recordPath(key),
      null,
    );
    return defaulted ? null : value;
  }

  /** Execute `fn` once per key; later calls return the original recorded result. */
  async execute<T>(
    scope: string,
    request: unknown,
    fn: () => Promise<T>,
    opts?: ExecuteOptions,
  ): Promise<{ record: IdempotencyRecord<T>; reused: boolean }> {
    const key = this.keyFor(scope, request, opts);
    const existing = await this.get<T>(key);
    if (existing) {
      return { record: existing, reused: true };
    }
    const result = await fn();
    const record: IdempotencyRecord<T> = {
      key,
      scope,
      requestHash: requestHash(scope, request),
      createdAt: new Date().toISOString(),
      result,
    };
    // Normalize BEFORE returning: non-serializable results become null with a
    // serializationError marker, so the once-only guarantee (later calls get
    // a defined recorded outcome) still holds.
    try {
      JSON.stringify(record.result ?? null);
    } catch (err) {
      record.result = null;
      record.serializationError =
        err instanceof Error ? err.message : "result is not JSON-serializable";
    }
    await this.put(record);
    return { record, reused: false };
  }

  /**
   * Persist a record atomically. Non-JSON-serializable results are replaced
   * with a null result plus a serializationError marker so the once-only
   * guarantee still holds for the next call.
   */
  async put<T>(record: IdempotencyRecord<T>): Promise<void> {
    const toStore: IdempotencyRecord<unknown> = { ...record, result: record.result ?? null };
    try {
      JSON.stringify(toStore.result);
    } catch (err) {
      toStore.result = null;
      toStore.serializationError =
        err instanceof Error ? err.message : "result is not JSON-serializable";
    }
    await mkdir(this.dir, { recursive: true });
    await atomicWriteJson(this.recordPath(toStore.key), toStore);
  }

  /**
   * Crash-recovery sweep: delete temp-file litter left by a process that died
   * between temp-file creation and rename. Safe to run at startup.
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
      if (entry.endsWith(".tmp")) {
        await rm(join(this.dir, entry), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * In-process lock so concurrent executes with the same key in one process
   * run `fn` exactly once. Cross-process safety comes from the atomic record
   * write plus caller-side provider idempotency keys.
   */
  private locks = new Map<string, Promise<unknown>>();

  lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Chain onto the previous waiter for this key so same-key callers
    // serialize. The settled tail stays as the chain base (bounded: one
    // resolved promise per key, not per call).
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

  /** Same as execute, but serializes concurrent same-key calls in-process. */
  async executeLocked<T>(
    scope: string,
    request: unknown,
    fn: () => Promise<T>,
    opts?: ExecuteOptions,
  ): Promise<{ record: IdempotencyRecord<T>; reused: boolean }> {
    const key = this.keyFor(scope, request, opts);
    return this.lock(key, () => this.execute(scope, request, fn, opts));
  }

  /** Remove a stored record (testing/admin). */
  async delete(key: string): Promise<void> {
    await rm(this.recordPath(key), { force: true });
  }
}

export interface OnceOnlyResult<T> {
  value: T;
  /** True when the original execution's result was reused (duplicate submit). */
  reused: boolean;
}

/**
 * Convenience wrapper: run `fn` once per (scope, request); duplicates get the
 * original result back with `reused: true`.
 */
export async function onceOnly<T>(
  store: IdempotencyStore,
  scope: string,
  request: unknown,
  fn: () => Promise<T>,
  opts?: ExecuteOptions,
): Promise<OnceOnlyResult<T>> {
  const { record, reused } = await store.executeLocked(scope, request, fn, opts);
  if (record.serializationError && reused) {
    // The original execution ran but its result could not be represented;
    // a duplicate must not silently mistake null for the real result.
    throw new IdempotencyError(
      `recorded result for key ${record.key} is not serializable: ${record.serializationError}`,
    );
  }
  return { value: record.result as T, reused };
}