/**
 * KIE-008 — capture temporary provider URLs immediately on
 * GENERATED_TEMPORARY, then trigger the GHL archival handoff.
 *
 * Contract (runbook §21, §14.4; spec §36 "original_provider_url",
 * "provider_url_expiration"):
 * - Capture runs the moment a poll lands on GENERATED_TEMPORARY, so the
 *   provider URL is persisted BEFORE anything else could lose it.
 * - Capture is idempotent: re-running on the same record (restart, retry,
 *   duplicate poll) neither duplicates URL records nor double-triggers the
 *   handoff for an already-triggered URL.
 * - Never regenerates: a URL that fails to capture throws, and the caller
 *   surfaces the error instead of resubmitting (archival owns failure paths).
 * - Expiration is persisted when the provider states one. Kie states NO TTL
 *   for result URLs (verified 2026-08-28) → undefined means unknown, never an
 *   invented number (runbook §26.3/§26.4).
 */

import type {
  TempUrlArchivalHandoff,
  TempUrlCapturerOptions,
  TempUrlRecord,
  TempUrlStore,
} from "./types.js";

function defaultNow(): string {
  return new Date().toISOString();
}

/** True when `value` is a plausible ISO-8601 timestamp. */
function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
  );
}

/** True when `value` is an http(s) URL. */
function isHttpUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("http://") || value.startsWith("https://"))
  );
}

/**
 * Exception thrown when provider results cannot be captured. Distinct from
 * handoff failures: a capture failure means the temporary URL was NEVER
 * persisted — a dangerous state that must surface (never silently archived).
 */
export class TempUrlCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TempUrlCaptureError";
  }
}

export interface CaptureOptions {
  /**
   * Provider-stated expiration timestamp (ISO-8601) when the adapter knows
   * one (e.g. a `resultJson.expiresAt` field). Omit when the provider states
   * none — Kie's schema does (UNKNOWN, never invented; no TTL is treated as
   * "archive immediately, don't wait").
   */
  expiresAt?: string;
  /** Provider model label, for provenance. */
  providerModel?: string;
  /** Provider task ID, for provenance. */
  providerTaskId?: string;
}

/**
 * Capture every URL of a GENERATED_TEMPORARY task record into the store.
 *
 * Behavior per URL:
 * - Already captured (store has the key) → keep the existing record; the
 *   handoff is re-armed only when it was never triggered and never failed.
 * - Not yet captured → persist the URL + expiration immediately, then
 *   trigger the archival handoff.
 *
 * The store write happens BEFORE the handoff trigger, so a crash between the
 * two leaves a persisted URL that resume can re-arm (restart-at-
 * GENERATED_TEMPORARY rule: archive the known URL, never regenerate).
 */
export class TempUrlCapturer {
  private readonly now: () => string;

  constructor(
    private readonly store: TempUrlStore,
    private readonly handoff: TempUrlArchivalHandoff,
    options: TempUrlCapturerOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
  }

  /**
   * Create a stable record key for one URL of one job ref.
   * Same inputs → same key → idempotent re-capture.
   */
  static urlKey(ref: string, url: string): string {
    return `${ref}::${url}`;
  }

  /** Record shape for one URL of a GENERATED_TEMPORARY result set. */
  static buildRecord(
    ref: string,
    url: string,
    capturedAt: string,
    options: CaptureOptions = {},
  ): TempUrlRecord {
    if (!isHttpUrl(url)) {
      throw new TempUrlCaptureError(
        `Cannot capture non-http(s) result value for "${ref}": ${String(url).slice(0, 80)}`,
      );
    }
    if (options.expiresAt !== undefined && !isIsoTimestamp(options.expiresAt)) {
      throw new TempUrlCaptureError(
        `Provider expiration for "${ref}" is not ISO-8601: ${options.expiresAt}`,
      );
    }
    return {
      key: TempUrlCapturer.urlKey(ref, url),
      ref,
      url,
      expiresAt: options.expiresAt,
      providerModel: options.providerModel,
      providerTaskId: options.providerTaskId,
      state: "GENERATED_TEMPORARY",
      capturedAt,
      handoffStatus: "PENDING",
    };
  }

  /**
   * Capture all URLs of a GENERATED_TEMPORARY record and trigger the
   * archival handoff for each. Returns the persisted records (one per URL).
   * Throws {@link TempUrlCaptureError} when the record is not
   * GENERATED_TEMPORARY or carries no result URLs.
   */
  async capture(
    record: { ref: string; state: string; resultUrls?: string[] | undefined },
    options: CaptureOptions = {},
  ): Promise<TempUrlRecord[]> {
    if (record.state !== "GENERATED_TEMPORARY") {
      throw new TempUrlCaptureError(
        `Temp-URL capture only applies to GENERATED_TEMPORARY, got "${record.state}" for "${record.ref}"`,
      );
    }
    const urls = record.resultUrls ?? [];
    if (urls.length === 0) {
      throw new TempUrlCaptureError(
        `GENERATED_TEMPORARY record "${record.ref}" has no result URLs to capture`,
      );
    }

    const capturedAt = this.now();
    const records: TempUrlRecord[] = [];
    for (const url of urls) {
      if (!isHttpUrl(url)) {
        throw new TempUrlCaptureError(
          `Provider returned a non-http(s) result URL for "${record.ref}": ${String(url).slice(0, 80)}`,
        );
      }
      const key = TempUrlCapturer.urlKey(record.ref, url);
      const existing = await this.store.load(key);
      if (existing) {
        // Already captured (restart/retry). Re-arm only if it never got off
        // the ground; never re-trigger a URL already handed off.
        if (existing.handoffStatus === "PENDING") {
          const rearmed: TempUrlRecord = {
            ...existing,
            handoffTriggeredAt: this.now(),
            handoffStatus: "TRIGGERED",
          };
          await this.store.save(rearmed);
          records.push(await this.triggerArchival(rearmed));
        } else {
          records.push(existing);
        }
        continue;
      }

      // Store BEFORE handoff: a crash after this point leaves the URL durable
      // so restart can re-arm it (never regenerate — runbook §21).
      const fresh = TempUrlCapturer.buildRecord(record.ref, url, capturedAt, {
        expiresAt: options.expiresAt,
        providerModel: options.providerModel,
        providerTaskId: options.providerTaskId,
      });
      await this.store.save(fresh);
      const handedOff: TempUrlRecord = {
        ...fresh,
        handoffTriggeredAt: this.now(),
        handoffStatus: "TRIGGERED",
      };
      await this.store.save(handedOff);
      records.push(await this.triggerArchival(handedOff));
    }
    return records;
  }

  /**
   * Trigger the archival handoff for one captured URL. A handoff failure is
   * recorded on the record (handoffStatus FAILED + redacted error) so the
   * recovery layer (GHL-012) can retry the KNOWN URL later — the record was
   * already persisted, so nothing is lost and nothing is regenerated.
   * Returns the record as finally persisted (FAILED snapshot on failure) so
   * callers observe the true end state, not the pre-handoff TRIGGERED one.
   */
  private async triggerArchival(record: TempUrlRecord): Promise<TempUrlRecord> {
    try {
      const result = await this.handoff.archive({
        ref: record.ref,
        url: record.url,
        expiresAt: record.expiresAt,
        providerModel: record.providerModel,
        providerTaskId: record.providerTaskId,
        capturedAt: record.capturedAt,
      });
      if (result.accepted) return record;
      const failed: TempUrlRecord = {
        ...record,
        handoffStatus: "FAILED",
        handoffErrorAt: this.now(),
        handoffError: result.error ?? "archival handoff not accepted",
      };
      await this.store.save(failed);
      return failed;
    } catch (error) {
      // Never let a handoff transport error throw past capture: the URL is
      // persisted; the failure is recorded for the archival layer to retry.
      const message = error instanceof Error ? error.message : String(error);
      const failed: TempUrlRecord = {
        ...record,
        handoffStatus: "FAILED",
        handoffErrorAt: this.now(),
        handoffError: message,
      };
      await this.store.save(failed);
      return failed;
    }
  }
}

/**
 * Reducer for the KIE-002 runner's final record: append captured URL
 * metadata onto the Kie task record so downstream layers (and the
 * restart-at-GENERATED_TEMPORARY path) see the persisted expiration without
 * re-querying the temp-url store.
 */
export function captureIntoKieRecord(
  taskRecord: { ref: string; resultUrls?: string[]; state: string },
  captured: readonly TempUrlRecord[],
): {
  resultUrls?: string[];
  providerUrlExpirations?: Partial<Record<string, string>>;
} {
  const byUrl = new Map<string, TempUrlRecord>();
  for (const record of captured) byUrl.set(record.url, record);
  const urls = (taskRecord.resultUrls ?? []).filter((url) => byUrl.has(url));
  const expirations: Partial<Record<string, string>> = {};
  for (const record of captured) {
    if (record.expiresAt !== undefined) expirations[record.url] = record.expiresAt;
  }
  return {
    resultUrls: urls,
    providerUrlExpirations: Object.keys(expirations).length > 0 ? expirations : undefined,
  };
}
