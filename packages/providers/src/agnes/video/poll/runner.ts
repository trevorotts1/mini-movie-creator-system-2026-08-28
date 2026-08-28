/**
 * AGN-005 — Agnes video poll-only runner with resume.
 *
 * Job-safety contract (spec §18):
 * - The provider task ID is persisted BEFORE polling begins (by the submit
 *   layer, AGN-004). THIS MODULE NEVER SUBMITS — it has no create endpoint
 *   and no request parameter; it only polls a record that already exists.
 * - Restart at SUBMITTED/GENERATING → resume polling the existing job; never
 *   resubmit; never double-spend. Concretely: a record whose state is
 *   SUBMITTED or GENERATING is polled by its persisted retrieval key, and
 *   `ensurePollable` never calls the client's create path (it does not
 *   exist on the poll-only port).
 * - Restart at GENERATED_TEMPORARY → the record already holds the provider
 *   URL + expiration; `ensurePollable` returns it untouched so the caller
 *   can archive the known URL immediately (spec §18) — never regenerate
 *   because a prior process died after completion.
 *
 * Idempotency: the poll layer is safe to run repeatedly by construction
 * (polling is read-only against the provider; the store is the single record
 * of truth). The submit layer (AGN-004) layers CORE-013 once-only primitives
 * on top for the submit call itself.
 */

import type {
  AgnesPipelineState,
  AgnesPollRunOptions,
  AgnesPollRunnerOptions,
  AgnesVideoClient,
  AgnesVideoTaskRecord,
  AgnesVideoTaskStore,
} from "./types.js";
import { isAgnesPollTerminal } from "./types.js";
import { mapAgnesToPipelineState } from "./status.js";

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600_000;

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error thrown when the poll loop exhausts its deadline while in flight. */
export class AgnesPollTimeoutError extends Error {
  constructor(
    public readonly ref: string,
    public readonly providerTaskId: string,
    public readonly lastState: AgnesPipelineState,
  ) {
    super(
      `Agnes video task "${ref}" (${providerTaskId}) did not reach a terminal state before deadline; last state ${lastState}`,
    );
    this.name = "AgnesPollTimeoutError";
  }
}

/**
 * Poll-only Agnes video runner: resolve a record to a pollable state, then
 * bounded-poll the persisted provider job to a terminal state.
 */
export class AgnesVideoPollRunner {
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: AgnesVideoClient,
    private readonly store: AgnesVideoTaskStore,
    options: AgnesPollRunnerOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Resolve any persisted record to a pollable state WITHOUT ever touching a
   * submit endpoint:
   * - GENERATED_TEMPORARY / REJECTED → returned untouched (already terminal;
   *   the caller archives the known URL or handles the failure).
   * - SUBMITTED / GENERATING with a retrieval key → returned as-is (resume
   *   polls the existing provider job).
   * - SUBMITTED stage hole (SUBMITTING) → promoted to SUBMITTED so polling
   *   can resume; the persisted providerTaskId is what gets polled. If a
   *   record somehow exists with no providerTaskId, this throws rather than
   *   silently resubmitting (double spend) — the submit layer must go first.
   */
  async ensurePollable(ref: string): Promise<AgnesVideoTaskRecord> {
    const record = await this.store.load(ref);
    if (!record) {
      throw new Error(
        `Agnes video task "${ref}" has no persisted record; refusing to create one (poll layer never submits)`,
      );
    }
    if (isAgnesPollTerminal(record.state)) {
      return record;
    }
    if (!this.retrievalKey(record)) {
      throw new Error(
        `Agnes video task "${ref}" has no persisted providerTaskId; refusing to poll (would resubmit — use the submit layer first)`,
      );
    }
    if (record.state === "SUBMITTING") {
      const promoted: AgnesVideoTaskRecord = {
        ...record,
        state: "SUBMITTED",
        updatedAt: this.now(),
      };
      await this.store.save(promoted);
      return promoted;
    }
    return record;
  }

  /**
   * Poll one round for `ref` (by its persisted retrieval key) and update the
   * store. Terminal states are written once and short-circuit. Never
   * resubmits: a record without a persisted key throws.
   */
  async pollOnce(ref: string): Promise<AgnesVideoTaskRecord> {
    const record = await this.ensurePollable(ref);
    if (isAgnesPollTerminal(record.state)) {
      return record;
    }
    const key = this.retrievalKey(record);
    if (!key) {
      throw new Error(
        `Agnes video task "${ref}" has no persisted providerTaskId; refusing to poll (would resubmit)`,
      );
    }
    const info = await this.client.getTask(key, record.model ?? undefined);
    const mapped = mapAgnesToPipelineState(info);

    const updated: AgnesVideoTaskRecord = {
      ...record,
      state: mapped.state,
      resultUrl: mapped.resultUrl ?? record.resultUrl,
      urlExpiration: mapped.urlExpiration ?? record.urlExpiration,
      failure: mapped.failure ?? record.failure,
      pollCount: (record.pollCount ?? 0) + 1,
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Resolve to pollable, then poll until a terminal state
   * (GENERATED_TEMPORARY or REJECTED) or the deadline. Sleeps `intervalMs`
   * between polls. The final record always reflects the last observed state
   * in the store.
   */
  async runToTerminal(ref: string, options: AgnesPollRunOptions = {}): Promise<AgnesVideoTaskRecord> {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    let record = await this.ensurePollable(ref);
    while (!isAgnesPollTerminal(record.state)) {
      if (Date.now() >= deadline) {
        throw new AgnesPollTimeoutError(ref, this.retrievalKey(record) ?? "", record.state);
      }
      await this.sleep(intervalMs);
      record = await this.pollOnce(ref);
    }
    return record;
  }

  /** Agnes retrieval key: `videoId` preferred (same as provider task ID on
   *  create responses), `providerTaskId` fallback. */
  private retrievalKey(record: AgnesVideoTaskRecord): string | undefined {
    return record.videoId ?? record.providerTaskId;
  }
}

/** Type guard: narrow a record state to the poll-visible subset. */
export function isPollVisibleState(state: AgnesPipelineState): boolean {
  return (
    state === "SUBMITTED" ||
    state === "GENERATING" ||
    isAgnesPollTerminal(state)
  );
}
