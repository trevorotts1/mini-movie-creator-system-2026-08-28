/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSqlite, type SqliteDatabase } from "../../connection/index.js";
import { migrate } from "../../migrations/index.js";
import { jobsAssetsMigrations } from "../../migrations/004-jobs-assets/index.js";
import { JobStateTransitionError, ProviderJobRepository } from "../index.js";
import type { ProviderJobState } from "../index.js";

let dir: string;
let db: SqliteDatabase;
let jobs: ProviderJobRepository;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mmcs-db-job-repo-"));
  db = connectSqlite({ path: join(dir, "job-repo.db") });
  migrate(db, jobsAssetsMigrations);
  jobs = new ProviderJobRepository(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function baseJob(id: string) {
  return {
    id,
    requestHash: `sha256:${id}`,
    provider: "kie",
    providerModel: "seedance-2-mini",
    requestParams: { prompt: "neon alley rain" },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

/** Drive a fresh job through the §18 ladder up to and including `target`. */
function runTo(id: string, target: ProviderJobState, extra: Record<string, unknown> = {}): void {
  jobs.create(baseJob(id));
  const ladder: ProviderJobState[] = [
    "BUDGET_RESERVED",
    "SUBMITTING",
    "SUBMITTED",
    "GENERATING",
    "GENERATED_TEMPORARY",
    "ARCHIVING",
    "ARCHIVED",
    "QC_PENDING",
  ];
  const stopIndex = target === "REJECTED" ? ladder.indexOf("ARCHIVED") : ladder.indexOf(target);
  if (stopIndex === -1 && target !== "REJECTED") {
    throw new Error(`test driver cannot reach ${target}`);
  }
  jobs.update(id, { budgetReservedAt: "2026-08-28T00:01:00.000Z", ...extra });
  for (let i = 0; i <= stopIndex; i += 1) {
    const step: ProviderJobState = ladder[i] as ProviderJobState;
    const patch: Record<string, unknown> = { status: step };
    if (step === "SUBMITTED") patch.submittedAt = "2026-08-28T00:02:00.000Z";
    if (step === "GENERATING") patch.polledAt = "2026-08-28T00:03:00.000Z";
    if (step === "GENERATED_TEMPORARY") patch.resultUrl = "https://cdn.example/tmp/clip.mp4";
    if (step === "ARCHIVED") patch.archivalStatus = "ARCHIVED";
    jobs.update(id, patch);
  }
  if (target === "REJECTED") {
    jobs.update(id, { status: "REJECTED", failureReason: "provider 500", budgetReleasedAt: "2026-08-28T00:09:00.000Z" });
  }
}

describe("ProviderJobRepository — CRUD", () => {
  it("creates, reads, lists, updates and deletes jobs", () => {
    const created = jobs.create({ ...baseJob("job-crud"), idempotencyKey: "idem-1" });
    expect(created.status).toBe("PLANNED");
    expect(created.idempotencyKey).toBe("idem-1");
    expect(jobs.findById("job-crud")).toEqual(created);
    expect(jobs.list().map((j) => j.id)).toContain("job-crud");

    const updated = jobs.update("job-crud", { retryCount: 2, failureReason: "timeout" });
    expect(updated?.retryCount).toBe(2);
    expect(updated?.failureReason).toBe("timeout");

    expect(jobs.delete("job-crud")).toBe(true);
    expect(jobs.findById("job-crud")).toBeUndefined();
    expect(jobs.update("job-crud", { retryCount: 3 })).toBeUndefined();
  });

  it("round-trips requestParams as JSON at the repository edge", () => {
    jobs.create({ ...baseJob("job-params"), requestParams: { mode: "i2v", fps: 24, nested: { a: 1 } } });
    const job = jobs.findById("job-params");
    expect(job?.requestParams).toEqual({ mode: "i2v", fps: 24, nested: { a: 1 } });
  });
});

describe("ProviderJobRepository — spec §18 restart safety", () => {
  it("persists the durable record BEFORE the provider task id exists (pre-poll write)", () => {
    const planned = jobs.create({ ...baseJob("job-prepoll") });
    expect(planned.status).toBe("PLANNED");
    expect(planned.providerTaskId).toBeUndefined();
    // Submission walks PLANNED → BUDGET_RESERVED → SUBMITTING → SUBMITTED,
    // attaching the task id to the SAME record.
    jobs.update("job-prepoll", { status: "BUDGET_RESERVED", budgetReservedAt: "2026-08-28T00:01:00.000Z" });
    jobs.update("job-prepoll", { status: "SUBMITTING" });
    const submitted = jobs.update("job-prepoll", {
      status: "SUBMITTED",
      providerTaskId: "task-777",
      submittedAt: "2026-08-28T00:02:00.000Z",
    });
    expect(submitted?.providerTaskId).toBe("task-777");
  });

  it("restart at SUBMITTED resumes polling the SAME job by provider task id (never resubmit)", () => {
    runTo("job-restart", "SUBMITTED", { providerTaskId: "task-888" });
    const resumed = jobs.findByProviderTask("kie", "task-888");
    expect(resumed?.id).toBe("job-restart");
    expect(resumed?.status).toBe("SUBMITTED");
    expect(resumed?.resultUrl).toBeUndefined();
    // Continue polling on that record:
    const generating = jobs.update("job-restart", { status: "GENERATING", polledAt: "2026-08-28T00:03:00.000Z" });
    expect(generating?.status).toBe("GENERATING");
  });

  it("restart at GENERATED_TEMPORARY finds the known provider URL for immediate archival", () => {
    runTo("job-temporary", "GENERATED_TEMPORARY");
    const found = jobs.findById("job-temporary");
    expect(found?.status).toBe("GENERATED_TEMPORARY");
    expect(found?.resultUrl).toBe("https://cdn.example/tmp/clip.mp4");
    const archived = jobs.update("job-temporary", { status: "ARCHIVING", archivalStatus: "IN_PROGRESS" });
    expect(archived?.archivalStatus).toBe("IN_PROGRESS");
  });

  it("enforces one job per (provider, idempotency key) — no double-spend", () => {
    jobs.create({ ...baseJob("job-idem-a"), idempotencyKey: "idem-shared" });
    expect(() => jobs.create({ ...baseJob("job-idem-b"), idempotencyKey: "idem-shared" })).toThrow();
    expect(jobs.findByIdempotencyKey("kie", "idem-shared")?.id).toBe("job-idem-a");
  });

  it("lists poller worklists by status", () => {
    runTo("job-wl-1", "SUBMITTED");
    runTo("job-wl-2", "GENERATING");
    const pollable = jobs.listByStatus(["SUBMITTED", "GENERATING"]);
    const ids = pollable.map((j) => j.id);
    expect(ids).toContain("job-wl-1");
    expect(ids).toContain("job-wl-2");
  });
});

describe("ProviderJobRepository — state transitions enforced", () => {
  it("throws on an illegal transition and leaves the record unchanged", () => {
    jobs.create({ ...baseJob("job-guard") });
    expect(() => jobs.update("job-guard", { status: "ARCHIVING" })).toThrow(JobStateTransitionError);
    expect(jobs.findById("job-guard")?.status).toBe("PLANNED");
  });

  it("walks the full ladder PLANNED..QC_PENDING then APPROVED", () => {
    runTo("job-full", "QC_PENDING", { estimatedCostUsd: 0.35 });
    expect(jobs.findById("job-full")?.status).toBe("QC_PENDING");
    const approved = jobs.update("job-full", { status: "APPROVED", actualCostUsd: 0.41 });
    expect(approved?.status).toBe("APPROVED");
    expect(approved?.actualCostUsd).toBeCloseTo(0.41);
  });

  it("rejects post-submission, releases the budget, records the failure", () => {
    runTo("job-reject", "REJECTED", { budgetReservedAt: "2026-08-28T00:01:00.000Z" });
    const job = jobs.findById("job-reject");
    expect(job?.status).toBe("REJECTED");
    expect(job?.budgetReleasedAt).toBe("2026-08-28T00:09:00.000Z");
    expect(job?.failureReason).toBe("provider 500");
  });
});