import { describe, expect, it } from "vitest";

import {
  QC_CHECK_IDS,
  failedCheck,
  passedCheck,
  reviewCheck,
  rollupVerdict,
  shotQcResultSchema,
} from "./index.js";

/** Regression tests for QC-001 fixer round: verdict/timestamp consistency. */

const base = {
  schemaVersion: 1 as const,
  seriesId: "s",
  episodeId: "e",
  sceneId: "sc",
  shotId: "sh",
  route: "video-direct" as const,
  reviewedBy: "m",
  verdict: "PASS" as const,
  startedAt: "2026-08-28T12:00:00Z",
  completedAt: "2026-08-28T12:00:05Z",
  checks: QC_CHECK_IDS.map((id) => passedCheck(id, "ok")),
};

function checksWith(overrides: Record<string, "FAIL" | "REVIEW"> = {}) {
  return QC_CHECK_IDS.map((id) => {
    switch (overrides[id]) {
      case "FAIL":
        return failedCheck(id, "bad");
      case "REVIEW":
        return reviewCheck(id, "unclear");
      default:
        return passedCheck(id, "ok");
    }
  });
}

describe("verdict consistency (regression)", () => {
  it("rejects verdict PASS while a check FAILs", () => {
    const r = shotQcResultSchema.safeParse({
      ...base,
      checks: checksWith({ hair: "FAIL" }),
      verdict: "PASS",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("contradicts");
    }
  });

  it("rejects verdict FAIL while every check passes", () => {
    const r = shotQcResultSchema.safeParse({
      ...base,
      checks: checksWith(),
      verdict: "FAIL",
    });
    expect(r.success).toBe(false);
  });

  it("accepts verdict matching rollup: PASS, REVIEW, FAIL", () => {
    expect(
      shotQcResultSchema.safeParse({ ...base, checks: checksWith() }).success,
    ).toBe(true);
    expect(
      shotQcResultSchema.safeParse({
        ...base,
        checks: checksWith({ hair: "REVIEW" }),
        verdict: "REVIEW",
      }).success,
    ).toBe(true);
    expect(
      shotQcResultSchema.safeParse({
        ...base,
        checks: checksWith({ hair: "FAIL" }),
        verdict: "FAIL",
      }).success,
    ).toBe(true);
  });
});

describe("timestamp ordering (regression)", () => {
  it("rejects completedAt earlier than startedAt", () => {
    const r = shotQcResultSchema.safeParse({
      ...base,
      startedAt: "2026-08-28T12:00:05Z",
      completedAt: "2026-08-28T12:00:00Z",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("completedAt");
    }
  });

  it("accepts equal and later completion", () => {
    expect(
      shotQcResultSchema.safeParse({
        ...base,
        startedAt: "2026-08-28T12:00:00Z",
        completedAt: "2026-08-28T12:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      shotQcResultSchema.safeParse({ ...base, checks: checksWith() }).success,
    ).toBe(true);
  });
});

describe("rollupVerdict empty input (regression)", () => {
  it("throws on empty checks instead of reporting PASS", () => {
    expect(() => rollupVerdict([])).toThrow(/at least one check/);
  });
});
