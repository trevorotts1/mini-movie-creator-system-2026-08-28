import { mapToPipelineState } from "./status.js";
import type {
  KieCreateTaskRequest,
  KiePipelineState,
  KieTaskClient,
  KieTaskRecord,
  KieTaskRunnerOptions,
  KieTaskStore,
} from "./types.js";
import { isPollTerminal } from "./types.js";

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600_000;

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error thrown when the poll loop exhausts its deadline while in flight. */
export class KieTaskTimeoutError extends Error {
  constructor(
    public readonly ref: string,
    public readonly providerTaskId: string,
    public readonly lastState: KiePipelineState,
  ) {
    super(`Kie task "${ref}" (${providerTaskId}) did not reach a terminal state before deadline; last state ${lastState}`);
    this.name = "KieTaskTimeoutError";
  }
}

/**
 * Generic Kie task runner: submit-or-resume + bounded poll.
 *
 * Idempotency contract (runbook §21):
 * - The provider task ID is persisted (store.save) BEFORE any polling begins.
 * - A record already in SUBMITTED/GENERATING state is RESUMED: its persisted
 *   providerTaskId is polled and the submit endpoint is never called again.
 * - Only a record with no providerTaskId (PLANNED/BUDGET_RESERVED) triggers a
 *   fresh submit, and the returned ID is persisted before the first poll.
 */
export class KieTaskRunner {
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: KieTaskClient,
    private readonly store: KieTaskStore,
    options: KieTaskRunnerOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Ensure a record exists and has a provider task ID, persisted before
   * polling. Resume path: existing providerTaskId → poll it, no resubmit.
   * Fresh path: SUBMITTING → createTask → persist SUBMITTED → poll.
   */
  async ensureSubmitted(ref: string, request: KieCreateTaskRequest): Promise<KieTaskRecord> {
    const existing = await this.store.load(ref);
    if (existing?.providerTaskId) {
      // Resume: poll the existing provider task. Never resubmit (double spend).
      if (existing.state === "PLANNED" || existing.state === "BUDGET_RESERVED" || existing.state === "SUBMITTING") {
        const resumed: KieTaskRecord = {
          ...existing,
          state: "SUBMITTED",
          model: existing.model ?? request.model,
          submitRequest: existing.submitRequest ?? request,
          updatedAt: this.now(),
        };
        await this.store.save(resumed);
        return resumed;
      }
      return existing;
    }

    const createdAt = existing?.createdAt ?? this.now();
    const submitting: KieTaskRecord = {
      ref,
      state: "SUBMITTING",
      model: request.model,
      submitRequest: request,
      createdAt,
      updatedAt: this.now(),
    };
    await this.store.save(submitting);

    const created = await this.client.createTask(request);
    const submitted: KieTaskRecord = {
      ...submitting,
      state: "SUBMITTED",
      providerTaskId: created.taskId,
      updatedAt: this.now(),
    };
    // Persist the provider task ID BEFORE the first poll.
    await this.store.save(submitted);
    return submitted;
  }

  /**
   * Poll one round for `ref` (by its persisted providerTaskId) and update the
   * store. Terminal states are written once and short-circuit.
   */
  async pollOnce(ref: string): Promise<KieTaskRecord> {
    const record = await this.requirePolledRecord(ref);
    if (!record.providerTaskId) {
      throw new Error(`Kie task "${ref}" has no persisted providerTaskId; refusing to poll (would resubmit)`);
    }
    const info = await this.client.getTask(record.providerTaskId);
    const mapped = mapToPipelineState(info);

    if (isPollTerminal(mapped.state)) {
      const updated: KieTaskRecord = {
        ...record,
        state: mapped.state,
        resultUrls: mapped.resultUrls,
        failure: mapped.failure,
        pollCount: (record.pollCount ?? 0) + 1,
        updatedAt: this.now(),
      };
      await this.store.save(updated);
      return updated;
    }

    const updated: KieTaskRecord = {
      ...record,
      state: "GENERATING",
      pollCount: (record.pollCount ?? 0) + 1,
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Ensure submitted, then poll until a terminal state (GENERATED_TEMPORARY or
   * REJECTED) or the deadline. Sleeps `intervalMs` between polls. The final
   * record always reflects the last observed state in the store.
   */
  async runToTerminal(
    ref: string,
    request: KieCreateTaskRequest,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<KieTaskRecord> {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    let record = await this.ensureSubmitted(ref, request);
    while (!isPollTerminal(record.state)) {
      if (Date.now() >= deadline) {
        throw new KieTaskTimeoutError(ref, record.providerTaskId ?? "", record.state);
      }
      await this.sleep(intervalMs);
      record = await this.pollOnce(ref);
    }
    return record;
  }

  private async requirePolledRecord(ref: string): Promise<KieTaskRecord> {
    const record = await this.store.load(ref);
    if (!record) throw new Error(`Kie task "${ref}" has no persisted record`);
    if (!record.providerTaskId) {
      throw new Error(`Kie task "${ref}" has no persisted providerTaskId; refusing to poll (would resubmit)`);
    }
    if (isPollTerminal(record.state)) return record;
    return record;
  }
}

/** Type guard: narrow a record state to the poll-visible subset. */
export function isPollVisibleState(state: KiePipelineState): boolean {
  return (
    state === "SUBMITTED" ||
    state === "GENERATING" ||
    isPollTerminal(state)
  );
}