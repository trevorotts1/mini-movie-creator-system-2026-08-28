/**
 * Agnes quota accounting (@mmcs/providers/agnes/quota).
 *
 * Task AGN-009. Per-job usage/cost ledger for the Agnes provider family
 * (runbook §33 Cost/Quota Engine; spec §4): requested/generated/accepted/
 * rejected seconds, retries, estimated + actual cost per provider job, with
 * included subscription quota tracked SEPARATELY from paid spend.
 *
 * CORE-009 (cost-engine reservations) is the future write target — its
 * interface is still scaffold (BLOCKED), so this module is self-contained:
 * a durable `AgnesQuotaStore` contract + in-memory implementation. The
 * cost-engine ledger can adopt `AgnesQuotaStore` (or read these records)
 * without changing this module's contract.
 *
 * Pricing provenance (VERIFIED 2026-08-28 against the live Agnes docs):
 *   - https://wiki.agnes-ai.com/en/docs/pricing
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash
 *   - https://wiki.agnes-ai.com/en/docs/agnes-video-25
 * Agnes Video 2.5 Flash: $0.025 / output second at 720P (currently $0 promo).
 * Agnes Video 2.5: 720P $0.025/s · 960P $0.040/s · 2K $0.055/s.
 * No subscription included quota is stated on any Agnes page → the default
 * configs carry includedQuotaSeconds: null (none known — never invented);
 * quota-bearing configs are caller-supplied and their absorbed seconds are
 * always reported in their own field, never folded into paid spend.
 */

/** Agnes doc URLs + verification date every default config cites. */
export const AGNES_QUOTA_SOURCES = Object.freeze({
  pricingDoc: "https://wiki.agnes-ai.com/en/docs/pricing",
  flashDoc: "https://wiki.agnes-ai.com/en/docs/agnes-video-25-flash",
  regularDoc: "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
  verifiedOn: "2026-08-28",
} as const);

/** Lifecycle of one provider job's accounting record. */
export type AgnesQuotaJobOutcome =
  | "pending"
  | "failed"
  | "generated"
  | "accepted"
  | "rejected";

/** Per-model (and optionally per-resolution) pricing/quota configuration. */
export interface AgnesQuotaConfig {
  /** Exact Agnes model id the config prices (e.g. "agnes-video-2.5-flash"). */
  readonly modelId: string;
  /** List price per output second when no resolution-specific price applies; null = unknown, never guessed. */
  readonly pricePerSecond: number | null;
  /** Doc-stated per-resolution rates that override `pricePerSecond`. */
  readonly pricePerSecondByResolution?: Readonly<Record<string, number>>;
  readonly currency: string;
  /**
   * Included subscription allowance in seconds per billing period.
   * null = none known (all generated seconds are paid spend).
   */
  readonly includedQuotaSeconds: number | null;
  /** Reset cadence of the included allowance (informational). null = unknown. */
  readonly quotaResetPeriod: string | null;
  /** Where the price/quota values were read from. */
  readonly sourceUrls: readonly string[];
  /** ISO date the values were verified. */
  readonly verifiedOn: string;
}

/** Durable per-job accounting record (spec §4 per-job tracking fields). */
export interface AgnesQuotaJobRecord {
  /** MMCS job ref — the same ref the submit/poll layers persist (spec §18). */
  readonly jobId: string;
  readonly modelId: string;
  readonly episodeId: string | null;
  readonly shotId: string | null;
  /** Output seconds requested at submit time (cumulative across retries). */
  requestedSeconds: number;
  /** Output seconds the provider actually produced (cumulative across retries). */
  generatedSeconds: number;
  /** Generated seconds that passed QC (subset of generatedSeconds). */
  acceptedSeconds: number;
  /** Generated seconds that failed QC (subset of generatedSeconds). */
  rejectedSeconds: number;
  /** Resubmissions of this job after the initial attempt. */
  retries: number;
  /**
   * Generated seconds absorbed by the included subscription quota.
   * OWN FIELD — never counted into paid spend (spec §4).
   */
  includedQuotaSeconds: number;
  /** Generated seconds billed as paid spend = generatedSeconds − includedQuotaSeconds. */
  paidSeconds: number;
  /** Price per paid second resolved at request time; null = unknown pricing. */
  pricePerSecond: number | null;
  readonly priceCurrency: string;
  /** Estimated cost of the paid seconds (null when pricing unknown). */
  estimatedCost: number | null;
  /** Cost the provider actually billed, when it returns one (null until then). */
  actualCost: number | null;
  outcome: AgnesQuotaJobOutcome;
  readonly createdAt: string;
  updatedAt: string;
}

/** Persistence seam — the cost engine / SQLite layer implements this later. */
export interface AgnesQuotaStore {
  load(jobId: string): Promise<AgnesQuotaJobRecord | null>;
  save(record: AgnesQuotaJobRecord): Promise<void>;
  list(): Promise<AgnesQuotaJobRecord[]>;
}

/** In-memory store; tests and single-process runs. */
export class InMemoryAgnesQuotaStore implements AgnesQuotaStore {
  private readonly jobs = new Map<string, AgnesQuotaJobRecord>();

  async load(jobId: string): Promise<AgnesQuotaJobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async save(record: AgnesQuotaJobRecord): Promise<void> {
    this.jobs.set(record.jobId, { ...record });
  }

  async list(): Promise<AgnesQuotaJobRecord[]> {
    return [...this.jobs.values()].map((record) => ({ ...record }));
  }
}

/** Options for the ledger. */
export interface AgnesQuotaLedgerOptions {
  /**
   * Included-quota seconds already consumed this billing period BEFORE this
   * ledger's records (other processes/episodes). Default 0.
   */
  initialQuotaUsedSeconds?: number;
  /** Injectable clock (ISO strings) for tests. */
  now?: () => string;
}

/** Error carrying the offending accounting field. */
export class AgnesQuotaError extends Error {
  readonly field: string;
  readonly jobId: string | null;
  constructor(field: string, message: string, jobId: string | null = null) {
    super(message);
    this.name = "AgnesQuotaError";
    this.field = field;
    this.jobId = jobId;
  }
}

/** Agnes Video 2.5 Flash — VERIFIED 2026-08-28 ($0.025/s 720P list). */
export function agnesFlashQuotaConfig(): AgnesQuotaConfig {
  return Object.freeze({
    modelId: "agnes-video-2.5-flash",
    pricePerSecond: 0.025,
    currency: "USD",
    includedQuotaSeconds: null,
    quotaResetPeriod: null,
    sourceUrls: [AGNES_QUOTA_SOURCES.pricingDoc, AGNES_QUOTA_SOURCES.flashDoc],
    verifiedOn: AGNES_QUOTA_SOURCES.verifiedOn,
  });
}

/** Agnes Video 2.5 regular — VERIFIED 2026-08-28 (720P/960P/2K tiers). */
export function agnesRegularQuotaConfig(): AgnesQuotaConfig {
  return Object.freeze({
    modelId: "agnes-video-2.5",
    pricePerSecond: 0.025,
    pricePerSecondByResolution: Object.freeze({
      "720P": 0.025,
      "960P": 0.04,
      "2K": 0.055,
    }),
    currency: "USD",
    includedQuotaSeconds: null,
    quotaResetPeriod: null,
    sourceUrls: [AGNES_QUOTA_SOURCES.pricingDoc, AGNES_QUOTA_SOURCES.regularDoc],
    verifiedOn: AGNES_QUOTA_SOURCES.verifiedOn,
  });
}

/** Optional filters for rollups. */
export interface AgnesQuotaTotalsFilter {
  episodeId?: string;
  modelId?: string;
}

/** Cumulative rollup over the ledger's jobs (production-report fields, §21). */
export interface AgnesQuotaTotals {
  jobCount: number;
  requestedSeconds: number;
  generatedSeconds: number;
  acceptedSeconds: number;
  rejectedSeconds: number;
  retries: number;
  /** Included-quota seconds absorbed — reported separately from paid spend. */
  includedQuotaSeconds: number;
  /** Paid-spend seconds — never includes includedQuotaSeconds. */
  paidSeconds: number;
  /**
   * Sum of per-job estimated costs. null when ANY job's pricing is unknown —
   * a partial sum would under-count spend at the $25 gate (spec §4).
   */
  estimatedCost: number | null;
  /** Sum of actual costs the provider returned (null until any is returned). */
  actualCost: number | null;
  currency: string;
}

/** Round money to cents to keep float noise out of cumulative totals. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertSeconds(value: number, field: string, jobId: string | null): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new AgnesQuotaError(
      field,
      `invalid ${field} ${value} for job ${jobId ?? "(new)"}: must be a finite non-negative number of seconds`,
      jobId,
    );
  }
}

/**
 * Per-job quota/cost ledger for Agnes video jobs.
 *
 * Accounting model (runbook §33):
 *  - `recordRequested` opens the record with requested seconds (before spend).
 *  - `recordGenerated` records produced seconds; included-quota absorption is
 *    computed against the period allowance (config + initial usage + other
 *    jobs' absorption). Only seconds BEYOND the allowance become paid spend.
 *  - `recordAccepted` / `recordRejected` partition generated seconds after
   *    QC. Decisions accumulate (accept some, reject the rest) and may not
   *    exceed the generated budget for the job's lifetime.
 *  - `recordRetry` counts a resubmission and may add requested seconds for
 *    the new attempt; a further `recordGenerated` is legal only after it.
 *  - `recordActualCost` stores the provider-returned billed cost.
 *  - `totals` folds records into production-report rollups.
 */
export class AgnesQuotaLedger {
  private readonly store: AgnesQuotaStore;
  private readonly configs: ReadonlyMap<string, AgnesQuotaConfig>;
  private readonly initialQuotaUsedSeconds: number;
  private readonly now: () => string;

  constructor(
    store: AgnesQuotaStore,
    configs:
      | AgnesQuotaConfig
      | readonly AgnesQuotaConfig[]
      | ReadonlyMap<string, AgnesQuotaConfig>,
    options: AgnesQuotaLedgerOptions = {},
  ) {
    this.store = store;
    const list = configs instanceof Map ? [...configs.values()] : Array.isArray(configs) ? configs : [configs];
    this.configs = new Map(list.map((config) => [config.modelId, config]));
    this.initialQuotaUsedSeconds = options.initialQuotaUsedSeconds ?? 0;
    if (
      !Number.isFinite(this.initialQuotaUsedSeconds) ||
      this.initialQuotaUsedSeconds < 0
    ) {
      throw new AgnesQuotaError(
        "initialQuotaUsedSeconds",
        `invalid initialQuotaUsedSeconds ${this.initialQuotaUsedSeconds}: must be a finite non-negative number`,
      );
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Resolve the config for a model; unknown models are unpriceable (estimatedCost null). */
  private configFor(modelId: string): AgnesQuotaConfig | null {
    return this.configs.get(modelId) ?? null;
  }

  /** Resolve the per-second price for a job, honoring per-resolution tiers. */
  private priceFor(config: AgnesQuotaConfig, resolution: string | undefined): number | null {
    if (resolution !== undefined && config.pricePerSecondByResolution) {
      const tiered = config.pricePerSecondByResolution[resolution];
      if (tiered !== undefined) return tiered;
    }
    return config.pricePerSecond;
  }

  /**
   * Included-quota seconds still available this period: allowance minus
   * pre-period usage minus what this ledger's jobs already absorbed.
   */
  private async remainingQuotaSeconds(): Promise<number> {
    const jobs = await this.store.list();
    const absorbed = jobs.reduce((sum, job) => sum + job.includedQuotaSeconds, 0);
    const allowance = [...this.configs.values()].reduce(
      (max, config) => Math.max(max, config.includedQuotaSeconds ?? 0),
      0,
    );
    return Math.max(0, allowance - this.initialQuotaUsedSeconds - absorbed);
  }

  private static derive(
    record: AgnesQuotaJobRecord,
  ): AgnesQuotaJobRecord {
    const paidSeconds = roundCents(record.generatedSeconds - record.includedQuotaSeconds);
    const estimatedCost =
      record.pricePerSecond === null ? null : roundCents(paidSeconds * record.pricePerSecond);
    return { ...record, paidSeconds, estimatedCost };
  }

  /**
   * Record the requested seconds for a job BEFORE submission (state is
   * derived before spend — runbook §33 / baseline doctrine).
   */
  async recordRequested(
    jobId: string,
    input: {
      modelId: string;
      requestedSeconds: number;
      episodeId?: string | null;
      shotId?: string | null;
      resolution?: string;
    },
  ): Promise<AgnesQuotaJobRecord> {
    assertSeconds(input.requestedSeconds, "requestedSeconds", jobId);
    const existing = await this.store.load(jobId);
    if (existing) {
      throw new AgnesQuotaError(
        "jobId",
        `job ${jobId} already has an accounting record; use recordRetry for resubmissions`,
        jobId,
      );
    }
    const config = this.configFor(input.modelId);
    const pricePerSecond = config ? this.priceFor(config, input.resolution) : null;
    const record: AgnesQuotaJobRecord = {
      jobId,
      modelId: input.modelId,
      episodeId: input.episodeId ?? null,
      shotId: input.shotId ?? null,
      requestedSeconds: input.requestedSeconds,
      generatedSeconds: 0,
      acceptedSeconds: 0,
      rejectedSeconds: 0,
      retries: 0,
      includedQuotaSeconds: 0,
      paidSeconds: 0,
      pricePerSecond,
      priceCurrency: config?.currency ?? "USD",
      estimatedCost: pricePerSecond === null ? null : 0,
      actualCost: null,
      outcome: "pending",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.store.save(AgnesQuotaLedger.derive(record));
    return (await this.store.load(jobId)) as AgnesQuotaJobRecord;
  }

  /**
   * Record produced seconds for the current attempt. Absorbs included quota
   * first; only excess seconds become paid spend. A second `recordGenerated`
   * for the same attempt is rejected — a new attempt goes through
   * `recordRetry` first, so one generation maps to one quota absorption.
   */
  async recordGenerated(jobId: string, generatedSeconds: number): Promise<AgnesQuotaJobRecord> {
    assertSeconds(generatedSeconds, "generatedSeconds", jobId);
    const record = await this.require(jobId);
    if (record.outcome !== "pending") {
      throw new AgnesQuotaError(
        "outcome",
        `job ${jobId} is ${record.outcome}; record a retry before generating again`,
        jobId,
      );
    }
    const remaining = await this.remainingQuotaSeconds();
    const absorb = Math.min(remaining, generatedSeconds);
    const updated: AgnesQuotaJobRecord = {
      ...record,
      generatedSeconds: roundCents(record.generatedSeconds + generatedSeconds),
      includedQuotaSeconds: roundCents(record.includedQuotaSeconds + absorb),
      outcome: "generated",
      updatedAt: this.now(),
    };
    await this.store.save(AgnesQuotaLedger.derive(updated));
    return (await this.store.load(jobId)) as AgnesQuotaJobRecord;
  }

  /** QC accepted `acceptedSeconds` of the generated output. */
  async recordAccepted(jobId: string, acceptedSeconds: number): Promise<AgnesQuotaJobRecord> {
    assertSeconds(acceptedSeconds, "acceptedSeconds", jobId);
    const record = await this.require(jobId);
    if (record.outcome !== "generated") {
      throw new AgnesQuotaError(
        "outcome",
        `job ${jobId} has no current generated attempt to accept (outcome ${record.outcome})`,
        jobId,
      );
    }
    const totalDecided = roundCents(record.acceptedSeconds + record.rejectedSeconds + acceptedSeconds);
    if (totalDecided > record.generatedSeconds) {
      throw new AgnesQuotaError(
        "acceptedSeconds",
        `job ${jobId}: accepted ${acceptedSeconds}s would push decided seconds ${totalDecided} beyond generated ${record.generatedSeconds}`,
        jobId,
      );
    }
    const updated: AgnesQuotaJobRecord = {
      ...record,
      acceptedSeconds: roundCents(record.acceptedSeconds + acceptedSeconds),
      outcome: "accepted",
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return updated;
  }

  /** QC rejected `rejectedSeconds` of the generated output. */
  async recordRejected(jobId: string, rejectedSeconds: number): Promise<AgnesQuotaJobRecord> {
    assertSeconds(rejectedSeconds, "rejectedSeconds", jobId);
    const record = await this.require(jobId);
    if (record.outcome !== "generated" && record.outcome !== "accepted") {
      throw new AgnesQuotaError(
        "outcome",
        `job ${jobId} has no current generated attempt to reject (outcome ${record.outcome})`,
        jobId,
      );
    }
    const totalDecided = roundCents(record.acceptedSeconds + record.rejectedSeconds + rejectedSeconds);
    if (totalDecided > record.generatedSeconds) {
      throw new AgnesQuotaError(
        "rejectedSeconds",
        `job ${jobId}: rejected ${rejectedSeconds}s would push decided seconds ${totalDecided} beyond generated ${record.generatedSeconds}`,
        jobId,
      );
    }
    const updated: AgnesQuotaJobRecord = {
      ...record,
      rejectedSeconds: roundCents(record.rejectedSeconds + rejectedSeconds),
      outcome: "rejected",
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Count a resubmission of this job (spec §4 retries). Optionally records
   * the additional requested seconds for the new attempt. The retry is
   * persisted BEFORE the next submission, so a restart mid-retry still shows
   * the attempt was counted.
   */
  async recordRetry(
    jobId: string,
    additionalRequestedSeconds = 0,
  ): Promise<AgnesQuotaJobRecord> {
    assertSeconds(additionalRequestedSeconds, "additionalRequestedSeconds", jobId);
    const record = await this.require(jobId);
    const updated: AgnesQuotaJobRecord = {
      ...record,
      retries: record.retries + 1,
      requestedSeconds: roundCents(record.requestedSeconds + additionalRequestedSeconds),
      outcome: "pending",
      updatedAt: this.now(),
    };
    await this.store.save(AgnesQuotaLedger.derive(updated));
    return (await this.store.load(jobId)) as AgnesQuotaJobRecord;
  }

  /** The submission failed outright — no clip was produced for this attempt. */
  async recordFailure(jobId: string): Promise<AgnesQuotaJobRecord> {
    const record = await this.require(jobId);
    if (record.outcome !== "pending") {
      throw new AgnesQuotaError(
        "outcome",
        `job ${jobId} is ${record.outcome}; only a pending attempt can fail`,
        jobId,
      );
    }
    const updated: AgnesQuotaJobRecord = { ...record, outcome: "failed", updatedAt: this.now() };
    await this.store.save(updated);
    return updated;
  }

  /** Store the cost the provider actually billed (overrides nothing — kept beside the estimate). */
  async recordActualCost(jobId: string, actualCost: number): Promise<AgnesQuotaJobRecord> {
    if (!Number.isFinite(actualCost) || actualCost < 0) {
      throw new AgnesQuotaError(
        "actualCost",
        `invalid actualCost ${actualCost} for job ${jobId}: must be a finite non-negative amount`,
        jobId,
      );
    }
    const record = await this.require(jobId);
    const updated: AgnesQuotaJobRecord = {
      ...record,
      actualCost: roundCents(actualCost),
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return updated;
  }

  async load(jobId: string): Promise<AgnesQuotaJobRecord | null> {
    return this.store.load(jobId);
  }

  private async require(jobId: string): Promise<AgnesQuotaJobRecord> {
    const record = await this.store.load(jobId);
    if (!record) {
      throw new AgnesQuotaError(
        "jobId",
        `no accounting record for job ${jobId}; call recordRequested first`,
        jobId,
      );
    }
    return record;
  }

  /** Cumulative rollup across jobs (optionally scoped), for the production report. */
  async totals(filter: AgnesQuotaTotalsFilter = {}): Promise<AgnesQuotaTotals> {
    const jobs = (await this.store.list()).filter(
      (job) =>
        (filter.episodeId === undefined || job.episodeId === filter.episodeId) &&
        (filter.modelId === undefined || job.modelId === filter.modelId),
    );
    const sum = (pick: (job: AgnesQuotaJobRecord) => number): number =>
      roundCents(jobs.reduce((total, job) => total + pick(job), 0));

    let estimatedCost = 0;
    let estimatedUnknown = false;
    for (const job of jobs) {
      if (job.estimatedCost === null) {
        // Unknown-priced job: a partial sum would UNDER-count spend at the
        // gate — report unknown, not a misleadingly small number (spec §4).
        estimatedUnknown = true;
      } else {
        estimatedCost += job.estimatedCost;
      }
    }

    let actualCost: number | null = null;
    for (const job of jobs) {
      if (job.actualCost !== null) {
        actualCost = (actualCost ?? 0) + job.actualCost;
      }
    }

    const currencies = new Set(jobs.map((job) => job.priceCurrency));
    return {
      jobCount: jobs.length,
      requestedSeconds: sum((job) => job.requestedSeconds),
      generatedSeconds: sum((job) => job.generatedSeconds),
      acceptedSeconds: sum((job) => job.acceptedSeconds),
      rejectedSeconds: sum((job) => job.rejectedSeconds),
      retries: jobs.reduce((total, job) => total + job.retries, 0),
      includedQuotaSeconds: sum((job) => job.includedQuotaSeconds),
      paidSeconds: sum((job) => job.paidSeconds),
      estimatedCost: estimatedUnknown ? null : roundCents(estimatedCost),
      actualCost: actualCost === null ? null : roundCents(actualCost),
      currency: currencies.size === 1 ? (jobs[0]?.priceCurrency ?? "USD") : "USD",
    };
  }

  /** Included-quota seconds still available this period (informational). */
  async remainingIncludedQuotaSeconds(): Promise<number> {
    return this.remainingQuotaSeconds();
  }
}