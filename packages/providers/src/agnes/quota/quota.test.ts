import { describe, expect, it } from "vitest";

import {
  AGNES_QUOTA_SOURCES,
  AgnesQuotaError,
  AgnesQuotaLedger,
  InMemoryAgnesQuotaStore,
  agnesFlashQuotaConfig,
  agnesRegularQuotaConfig,
  roundCents,
} from "./index.js";

/** Fresh in-memory ledger. */
function ledger(
  configs:
    | ReturnType<typeof agnesFlashQuotaConfig>
    | readonly AgnesQuotaLedgerConfig[]
    | ReadonlyMap<string, AgnesQuotaLedgerConfig>,
  options?: ConstructorParameters<typeof AgnesQuotaLedger>[2],
): AgnesQuotaLedger {
  return new AgnesQuotaLedger(new InMemoryAgnesQuotaStore(), configs, options);
}
type AgnesQuotaLedgerConfig = ReturnType<typeof agnesFlashQuotaConfig>;

describe("AGNES_QUOTA_SOURCES + default configs", () => {
  it("carries doc provenance with a verification date", () => {
    expect(AGNES_QUOTA_SOURCES.pricingDoc).toContain("wiki.agnes-ai.com");
    expect(AGNES_QUOTA_SOURCES.verifiedOn).toBe("2026-08-28");
    expect(agnesFlashQuotaConfig().verifiedOn).toBe("2026-08-28");
    expect(agnesFlashQuotaConfig().sourceUrls.length).toBeGreaterThan(0);
    expect(agnesRegularQuotaConfig().sourceUrls.length).toBeGreaterThan(0);
  });

  it("prices Flash at the doc rate and regular at its resolution tiers", () => {
    const flash = agnesFlashQuotaConfig();
    expect(flash.modelId).toBe("agnes-video-2.5-flash");
    expect(flash.pricePerSecond).toBe(0.025);

    const regular = agnesRegularQuotaConfig();
    expect(regular.pricePerSecondByResolution).toEqual({
      "720P": 0.025,
      "960P": 0.04,
      "2K": 0.055,
    });
    // Agnes states no subscription quota on any page — never invented.
    expect(flash.includedQuotaSeconds).toBeNull();
    expect(regular.includedQuotaSeconds).toBeNull();
  });
});

describe("recordRequested", () => {
  it("opens a pending record with requested seconds and resolved price", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    const record = await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
      episodeId: "ep-1",
      shotId: "sh-1",
    });
    expect(record.outcome).toBe("pending");
    expect(record.requestedSeconds).toBe(8);
    expect(record.generatedSeconds).toBe(0);
    expect(record.acceptedSeconds).toBe(0);
    expect(record.rejectedSeconds).toBe(0);
    expect(record.retries).toBe(0);
    expect(record.pricePerSecond).toBe(0.025);
    expect(record.estimatedCost).toBe(0);
    expect(record.actualCost).toBeNull();
    expect(record.includedQuotaSeconds).toBe(0);
    expect(record.paidSeconds).toBe(0);
  });

  it("rejects negative/NaN requested seconds", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await expect(
      l.recordRequested("job-1", { modelId: "agnes-video-2.5-flash", requestedSeconds: -3 }),
    ).rejects.toThrow(AgnesQuotaError);
    await expect(
      l.recordRequested("job-1", { modelId: "agnes-video-2.5-flash", requestedSeconds: Number.NaN }),
    ).rejects.toThrow(AgnesQuotaError);
  });

  it("rejects a duplicate record (idempotency: use recordRetry)", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await expect(
      l.recordRequested("job-1", { modelId: "agnes-video-2.5-flash", requestedSeconds: 8 }),
    ).rejects.toThrow(AgnesQuotaError);
  });

  it("leaves pricing null for unknown models instead of inventing a number", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    const record = await l.recordRequested("job-x", {
      modelId: "agnes-video-9.9-unknown",
      requestedSeconds: 5,
    });
    expect(record.pricePerSecond).toBeNull();
    expect(record.estimatedCost).toBeNull();
  });

  it("honors per-resolution tiers for the regular model", async () => {
    const l = ledger(agnesRegularQuotaConfig());
    const twoK = await l.recordRequested("job-2k", {
      modelId: "agnes-video-2.5",
      requestedSeconds: 6,
      resolution: "2K",
    });
    expect(twoK.pricePerSecond).toBe(0.055);
    const nineSixty = await l.recordRequested("job-960", {
      modelId: "agnes-video-2.5",
      requestedSeconds: 6,
      resolution: "960P",
    });
    expect(nineSixty.pricePerSecond).toBe(0.04);
  });
});

describe("recordGenerated — included quota vs paid spend", () => {
  it("absorbs included quota first and only charges the excess as paid", async () => {
    const l = ledger(
      { ...agnesFlashQuotaConfig(), includedQuotaSeconds: 10, quotaResetPeriod: "monthly" },
      { initialQuotaUsedSeconds: 4 },
    );
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    const record = await l.recordGenerated("job-1", 8);
    // 6s of allowance remain (10 − 4); absorb 6, pay for 2.
    expect(record.includedQuotaSeconds).toBe(6);
    expect(record.paidSeconds).toBe(2);
    expect(record.generatedSeconds).toBe(8);
    expect(record.estimatedCost).toBeCloseTo(0.05, 10);
    const totals = await l.totals();
    expect(totals.includedQuotaSeconds).toBe(6);
    expect(totals.paidSeconds).toBe(2);
  });

  it("charges everything as paid when the allowance is exhausted", async () => {
    const l = ledger(
      { ...agnesFlashQuotaConfig(), includedQuotaSeconds: 5 },
      { initialQuotaUsedSeconds: 5 },
    );
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    const record = await l.recordGenerated("job-1", 8);
    expect(record.includedQuotaSeconds).toBe(0);
    expect(record.paidSeconds).toBe(8);
    expect(record.estimatedCost).toBeCloseTo(0.2, 10);
  });

  it("tracks quota absorption across jobs within the period", async () => {
    const l = ledger(
      { ...agnesFlashQuotaConfig(), includedQuotaSeconds: 12 },
      { initialQuotaUsedSeconds: 0 },
    );
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await l.recordRequested("job-2", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    const record = await l.recordGenerated("job-2", 8);
    // 4s allowance left after job-1 absorbed 8.
    expect(record.includedQuotaSeconds).toBe(4);
    expect(record.paidSeconds).toBe(4);
  });

  it("rejects a second recordGenerated for the same attempt", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await expect(l.recordGenerated("job-1", 8)).rejects.toThrow(AgnesQuotaError);
  });

  it("rejects negative/NaN generated seconds", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await expect(l.recordGenerated("job-1", -1)).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordGenerated("job-1", Number.NaN)).rejects.toThrow(AgnesQuotaError);
  });

  it("keeps generated seconds out of paid spend while quota covers them", async () => {
    const l = ledger(
      { ...agnesFlashQuotaConfig(), includedQuotaSeconds: 100 },
      { initialQuotaUsedSeconds: 0 },
    );
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    const record = await l.recordGenerated("job-1", 8);
    expect(record.generatedSeconds).toBe(8);
    expect(record.includedQuotaSeconds).toBe(8);
    expect(record.paidSeconds).toBe(0);
    expect(record.estimatedCost).toBe(0);
    const totals = await l.totals();
    // Paid spend stays 0 — included quota is never folded into spend (spec §4).
    expect(totals.estimatedCost).toBe(0);
    expect(totals.paidSeconds).toBe(0);
  });
});

describe("QC partition — accepted/rejected", () => {
  it("partitions generated seconds and rolls the outcome up", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    const record = await l.recordAccepted("job-1", 6);
    expect(record.acceptedSeconds).toBe(6);
    expect(record.outcome).toBe("accepted");
    const rejected = await l.recordRejected("job-1", 2);
    expect(rejected.rejectedSeconds).toBe(2);
    const totals = await l.totals();
    expect(totals.acceptedSeconds).toBe(6);
    expect(totals.rejectedSeconds).toBe(2);
    expect(totals.generatedSeconds).toBe(8);
  });

  it("closes QC after a decision; a re-decision needs a retry first", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await l.recordRejected("job-1", 8);
    await expect(l.recordAccepted("job-1", 8)).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordRejected("job-1", 0)).rejects.toThrow(AgnesQuotaError);
    // New attempt reopens QC.
    await l.recordRetry("job-1", 8);
    await l.recordGenerated("job-1", 8);
    const record = await l.recordAccepted("job-1", 8);
    expect(record.acceptedSeconds).toBe(8);
  });

  it("refuses to decide more seconds than were generated", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await expect(l.recordAccepted("job-1", 9)).rejects.toThrow(AgnesQuotaError);
    await l.recordAccepted("job-1", 6);
    await expect(l.recordRejected("job-1", 3)).rejects.toThrow(AgnesQuotaError);
  });

  it("refuses QC decisions with no generated attempt", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await expect(l.recordAccepted("job-1", 6)).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordRejected("job-1", 6)).rejects.toThrow(AgnesQuotaError);
  });
});

describe("retries and failure", () => {
  it("counts a retry, adds its requested seconds, and permits a new attempt", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await l.recordRejected("job-1", 8);
    const record = await l.recordRetry("job-1", 8);
    expect(record.retries).toBe(1);
    expect(record.requestedSeconds).toBe(16);
    expect(record.outcome).toBe("pending");
    const regenerated = await l.recordGenerated("job-1", 8);
    expect(regenerated.generatedSeconds).toBe(16);
    const totals = await l.totals();
    expect(totals.retries).toBe(1);
    expect(totals.requestedSeconds).toBe(16);
    expect(totals.generatedSeconds).toBe(16);
  });

  it("records failure of a pending attempt and forbids generating after failure", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordFailure("job-1");
    const record = await l.load("job-1");
    expect(record?.outcome).toBe("failed");
    await expect(l.recordGenerated("job-1", 8)).rejects.toThrow(AgnesQuotaError);
  });

  it("records the provider-returned actual cost beside the estimate", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    const record = await l.recordActualCost("job-1", 0.1999);
    expect(record.actualCost).toBe(0.2);
    expect(record.estimatedCost).toBeCloseTo(0.2, 10);
  });
});

describe("totals rollup", () => {
  it("scopes by episode and model", async () => {
    const l = ledger([agnesFlashQuotaConfig(), agnesRegularQuotaConfig()]);
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
      episodeId: "ep-1",
    });
    await l.recordGenerated("job-1", 8);
    await l.recordAccepted("job-1", 8);
    await l.recordRequested("job-2", {
      modelId: "agnes-video-2.5",
      requestedSeconds: 6,
      episodeId: "ep-2",
    });
    await l.recordGenerated("job-2", 6);

    const ep1 = await l.totals({ episodeId: "ep-1" });
    expect(ep1.jobCount).toBe(1);
    expect(ep1.acceptedSeconds).toBe(8);
    const flash = await l.totals({ modelId: "agnes-video-2.5-flash" });
    expect(flash.jobCount).toBe(1);
    const all = await l.totals();
    expect(all.jobCount).toBe(2);
    expect(all.generatedSeconds).toBe(14);
  });

  it("reports estimatedCost null (not a partial sum) when any job is unpriced", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    await l.recordRequested("job-2", {
      modelId: "some-unknown-model",
      requestedSeconds: 100,
    });
    await l.recordGenerated("job-2", 100);
    const totals = await l.totals();
    // job-1 alone is $0.20; returning $0.20 would understate spend at the gate.
    expect(totals.estimatedCost).toBeNull();
  });

  it("returns actualCost null until the provider returns any cost", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    expect((await l.totals()).actualCost).toBeNull();
    await l.recordGenerated("job-1", 8);
    await l.recordActualCost("job-1", 0.2);
    expect((await l.totals()).actualCost).toBeCloseTo(0.2, 10);
  });

  it("sums actual costs across jobs", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    for (const jobId of ["job-1", "job-2"]) {
      await l.recordRequested(jobId, {
        modelId: "agnes-video-2.5-flash",
        requestedSeconds: 8,
      });
      await l.recordGenerated(jobId, 8);
      await l.recordActualCost(jobId, 0.15);
    }
    expect((await l.totals()).actualCost).toBeCloseTo(0.3, 10);
  });
});

describe("store seam + misc", () => {
  it("persists through the AgnesQuotaStore seam (survives ledger reload)", async () => {
    const store = new InMemoryAgnesQuotaStore();
    const l1 = new AgnesQuotaLedger(store, agnesFlashQuotaConfig());
    await l1.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l1.recordGenerated("job-1", 8);
    const l2 = new AgnesQuotaLedger(store, agnesFlashQuotaConfig());
    const reloaded = await l2.load("job-1");
    expect(reloaded?.generatedSeconds).toBe(8);
    const totals = await l2.totals();
    expect(totals.generatedSeconds).toBe(8);
    expect(totals.estimatedCost).toBeCloseTo(0.2, 10);
  });

  it("exposes remaining included quota and validates options", async () => {
    const l = ledger(
      { ...agnesFlashQuotaConfig(), includedQuotaSeconds: 30 },
      { initialQuotaUsedSeconds: 10 },
    );
    expect(await l.remainingIncludedQuotaSeconds()).toBe(20);
    await l.recordRequested("job-1", {
      modelId: "agnes-video-2.5-flash",
      requestedSeconds: 8,
    });
    await l.recordGenerated("job-1", 8);
    expect(await l.remainingIncludedQuotaSeconds()).toBe(12);
  });

  it("rejects a negative initialQuotaUsedSeconds", () => {
    expect(
      () =>
        new AgnesQuotaLedger(new InMemoryAgnesQuotaStore(), agnesFlashQuotaConfig(), {
          initialQuotaUsedSeconds: -1,
        }),
    ).toThrow(AgnesQuotaError);
  });

  it("refuses operations on a job with no record", async () => {
    const l = ledger(agnesFlashQuotaConfig());
    await expect(l.recordGenerated("ghost", 8)).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordRetry("ghost")).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordFailure("ghost")).rejects.toThrow(AgnesQuotaError);
    await expect(l.recordActualCost("ghost", 1)).rejects.toThrow(AgnesQuotaError);
    expect(await l.load("ghost")).toBeNull();
  });
});

describe("roundCents", () => {
  it("keeps float noise out of money", () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3);
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(0)).toBe(0);
  });
});
