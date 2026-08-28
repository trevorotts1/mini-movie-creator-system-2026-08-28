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

describe("empty checks array (QC fixer round 2 regression)", () => {
  it("safeParse returns a structured failure (never throws) on checks: []", () => {
    // Regression: superRefine called rollupVerdict([]) which threw inside
    // safeParse — the "safe" variant must return a structured failure.
    let threw = false;
    let success: boolean | undefined;
    try {
      const r = shotQcResultSchema.safeParse({ ...base, checks: [] });
      success = r.success;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(success).toBe(false);
  });

  it("reports the missing-check error for checks: []", () => {
    const r = shotQcResultSchema.safeParse({ ...base, checks: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = JSON.stringify(r.error.issues);
      expect(messages).toContain("missing spec §20 check");
    }
  });
});

describe("attempt + evidence bounds (QC fixer round 2 regression)", () => {
  it("rejects negative and fractional attempt", () => {
    expect(
      shotQcResultSchema.safeParse({ ...base, attempt: -1 }).success,
    ).toBe(false);
    expect(
      shotQcResultSchema.safeParse({ ...base, attempt: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects non-finite or negative evidence timecodes", () => {
    const withTimecode = (value: number) =>
      QC_CHECK_IDS.map((id) => {
        const check = passedCheck(id, "ok");
        if (id === "hair") check.evidence[0]!.timecodeSeconds = value;
        return check;
      });
    expect(
      shotQcResultSchema.safeParse({
        ...base,
        checks: withTimecode(Number.NaN),
      }).success,
    ).toBe(false);
    expect(
      shotQcResultSchema.safeParse({
        ...base,
        checks: withTimecode(Number.POSITIVE_INFINITY),
      }).success,
    ).toBe(false);
    expect(
      shotQcResultSchema.safeParse({ ...base, checks: withTimecode(-3) })
        .success,
    ).toBe(false);
  });
});
