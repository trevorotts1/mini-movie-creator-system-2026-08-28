import { describe, expect, it } from "vitest";
import {
  ARCHIVAL_STATUSES,
  JOB_STATES,
  JobStateTransitionError,
  isLegalJobTransition,
} from "../index.js";
import type { ProviderJobState } from "../index.js";

/** The §18 ladder, verbatim. */
const LADDER: readonly ProviderJobState[] = [
  "PLANNED",
  "BUDGET_RESERVED",
  "SUBMITTING",
  "SUBMITTED",
  "GENERATING",
  "GENERATED_TEMPORARY",
  "ARCHIVING",
  "ARCHIVED",
  "QC_PENDING",
];

describe("spec §18 state machine", () => {
  it("exposes exactly the twelve spec states from PLANNED to REJECTED", () => {
    expect([...JOB_STATES]).toEqual([
      "PLANNED",
      "BUDGET_RESERVED",
      "SUBMITTING",
      "SUBMITTED",
      "GENERATING",
      "GENERATED_TEMPORARY",
      "ARCHIVING",
      "ARCHIVED",
      "QC_PENDING",
      "QC_FIXING",
      "APPROVED",
      "REJECTED",
    ]);
  });

  it("allows the whole forward ladder one step at a time", () => {
    for (let i = 0; i < LADDER.length - 1; i += 1) {
      expect(isLegalJobTransition(LADDER[i] as ProviderJobState, LADDER[i + 1] as ProviderJobState)).toBe(true);
    }
  });

  it("routes QC_FIXING back to QC_PENDING, then to APPROVED or REJECTED", () => {
    expect(isLegalJobTransition("QC_PENDING", "QC_FIXING")).toBe(true);
    expect(isLegalJobTransition("QC_FIXING", "QC_PENDING")).toBe(true);
    expect(isLegalJobTransition("QC_PENDING", "APPROVED")).toBe(true);
    expect(isLegalJobTransition("QC_PENDING", "REJECTED")).toBe(true);
    expect(isLegalJobTransition("APPROVED", "REJECTED")).toBe(false);
    expect(isLegalJobTransition("REJECTED", "APPROVED")).toBe(false);
    expect(isLegalJobTransition("APPROVED", "PLANNED")).toBe(false);
  });

  it("rejects skipping steps and backwards moves on the ladder", () => {
    expect(isLegalJobTransition("PLANNED", "SUBMITTED")).toBe(false);
    expect(isLegalJobTransition("SUBMITTING", "GENERATING")).toBe(false);
    expect(isLegalJobTransition("GENERATING", "PLANNED")).toBe(false);
    expect(isLegalJobTransition("PLANNED", "APPROVED")).toBe(false);
    expect(isLegalJobTransition("BUDGET_RESERVED", "REJECTED")).toBe(false);
  });

  it("allows rejection only post-submission (budget releases on provider failure)", () => {
    expect(isLegalJobTransition("SUBMITTED", "REJECTED")).toBe(true);
    expect(isLegalJobTransition("GENERATING", "REJECTED")).toBe(true);
    expect(isLegalJobTransition("ARCHIVED", "REJECTED")).toBe(true);
  });

  it("throws a typed error carrying from/to when a transition is illegal", () => {
    expect(isLegalJobTransition("PLANNED", "ARCHIVING")).toBe(false);
    try {
      throw new JobStateTransitionError("PLANNED", "ARCHIVING");
    } catch (err) {
      expect(err).toBeInstanceOf(JobStateTransitionError);
      expect((err as JobStateTransitionError).message).toMatch(/PLANNED -> ARCHIVING/);
    }
  });

  it("covers archival statuses used by the archival_status column", () => {
    expect([...ARCHIVAL_STATUSES]).toEqual(["PENDING", "IN_PROGRESS", "ARCHIVED", "FAILED", "SKIPPED"]);
  });
});