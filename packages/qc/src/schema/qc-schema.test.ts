import { describe, expect, it } from "vitest";

import {
  QC_CHECK_IDS,
  QC_CHECK_LABELS,
  QC_RESULT_SCHEMA_VERSION,
  QC_ROUTES,
  QC_VERDICTS,
  failedCheck,
  parseShotQcResult,
  passedCheck,
  qcCheckIdSchema,
  qcRouteSchema,
  qcVerdictSchema,
  reviewCheck,
  rollupVerdict,
  safeParseShotQcResult,
  shotQcResultSchema,
  type QcCheckId,
  type QcCheckResult,
  type ShotQcResult,
} from "./index.js";

const STARTED = "2026-08-28T12:00:00.000Z";
const COMPLETED = "2026-08-28T12:00:05.000Z";

/** Every spec §20 check id, in canonical order, all PASS by default. */
function allPassingChecks(
  overrides: Partial<Record<QcCheckId, QcCheckResult>> = {},
): QcCheckResult[] {
  return QC_CHECK_IDS.map(
    (checkId) =>
      overrides[checkId] ??
      passedCheck(checkId, `${QC_CHECK_LABELS[checkId]} matches reference`),
  );
}

function validResult(overrides: Partial<ShotQcResult> = {}): ShotQcResult {
  return {
    schemaVersion: QC_RESULT_SCHEMA_VERSION,
    seriesId: "series-1",
    episodeId: "S01E03",
    sceneId: "SC04",
    shotId: "SH07",
    assetId: "asset_001",
    route: "video-direct",
    reviewedBy: "agnes-25-flash",
    checks: allPassingChecks(),
    verdict: "PASS",
    startedAt: STARTED,
    completedAt: COMPLETED,
    attempt: 0,
    supersedesResultId: null,
    reportNotes: null,
    ...overrides,
  };
}

describe("QC check ids (spec §20 coverage)", () => {
  it("exposes exactly the 17 spec §20 checks in canonical order", () => {
    expect([...QC_CHECK_IDS]).toEqual([
      "character-identity",
      "face-consistency",
      "skin-tone",
      "hair",
      "wardrobe",
      "accessories",
      "anatomy-artifacts",
      "props",
      "location",
      "lighting-continuity",
      "camera-requirement",
      "action-requirement",
      "visual-artifacts",
      "lip-face",
      "start-end-state",
      "neighbor-continuity",
      "dialogue-suitability",
    ]);
  });

  it("rejects unknown check ids", () => {
    expect(qcCheckIdSchema.safeParse("vibe").success).toBe(false);
  });

  it("labels every check id", () => {
    for (const checkId of QC_CHECK_IDS) {
      expect(QC_CHECK_LABELS[checkId].length).toBeGreaterThan(0);
    }
  });
});

describe("verdict + route enums", () => {
  it("exposes PASS/FAIL/REVIEW verdicts and rejects others", () => {
    expect([...QC_VERDICTS]).toEqual(["PASS", "FAIL", "REVIEW"]);
    expect(qcVerdictSchema.safeParse("MAYBE").success).toBe(false);
  });

  it("exposes video-direct and extracted-frames routes only", () => {
    expect([...QC_ROUTES]).toEqual(["video-direct", "extracted-frames"]);
    expect(qcRouteSchema.safeParse("telepathy").success).toBe(false);
  });
});

describe("shotQcResultSchema", () => {
  it("accepts a fully-populated passing result", () => {
    const parsed = parseShotQcResult(validResult());
    expect(parsed.shotId).toBe("SH07");
    expect(parsed.verdict).toBe("PASS");
  });

  it("rejects a result missing any spec §20 check", () => {
    const incomplete = validResult({
      checks: allPassingChecks().filter((c) => c.checkId !== "skin-tone"),
    });
    const parsed = shotQcResultSchema.safeParse(incomplete);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("skin-tone");
    }
  });

  it("rejects a duplicate check result", () => {
    const checks = allPassingChecks();
    checks.push(passedCheck("hair", "hair matches reference"));
    const parsed = shotQcResultSchema.safeParse(validResult({ checks }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("duplicate");
    }
  });

  it("rejects a check with no evidence", () => {
    const checks = allPassingChecks({
      "character-identity": {
        checkId: "character-identity",
        verdict: "PASS",
        evidence: [],
        characterId: "char_monica",
        characterVersion: null,
        notes: null,
      },
    });
    const parsed = shotQcResultSchema.safeParse(validResult({ checks }));
    expect(parsed.success).toBe(false);
  });

  it("rejects a verdict outside the enum and a mismatched schemaVersion", () => {
    expect(
      shotQcResultSchema.safeParse(validResult({ verdict: "OK" as never })).success,
    ).toBe(false);
    expect(
      shotQcResultSchema.safeParse(validResult({ schemaVersion: 999 as never })).success,
    ).toBe(false);
  });

  it("rejects non-ISO timestamps", () => {
    expect(
      shotQcResultSchema.safeParse(validResult({ startedAt: "yesterday" })).success,
    ).toBe(false);
  });

  it("safeParse returns null on invalid input", () => {
    expect(safeParseShotQcResult({ not: "a result" })).toBeNull();
    expect(safeParseShotQcResult(validResult())).not.toBeNull();
  });
});

describe("evidence fields", () => {
  it("supports frame evidence with timecode and ref", () => {
    const checks = allPassingChecks({
      "lip-face": reviewCheck("lip-face", "mouth flutter mid-word", {
        evidence: [
          {
            kind: "frame",
            description: "frame SH07_0032.png at 1.6s",
            timecodeSeconds: 1.6,
            frameRef: "frames/SH07_0032.png",
            value: null,
          },
        ],
      }),
    });
    const parsed = parseShotQcResult(validResult({ checks, verdict: "REVIEW" }));
    const lip = parsed.checks.find((c) => c.checkId === "lip-face");
    expect(lip?.evidence[0]?.frameRef).toBe("frames/SH07_0032.png");
    expect(lip?.evidence[0]?.timecodeSeconds).toBe(1.6);
  });

  it("supports metric evidence with a measured value", () => {
    const checks = allPassingChecks({
      "skin-tone": passedCheck("skin-tone", "hue delta within tolerance", {
        evidence: [
          {
            kind: "metric",
            description: "hue delta vs locked reference",
            timecodeSeconds: 0.5,
            frameRef: null,
            value: 3.2,
          },
        ],
      }),
    });
    const parsed = parseShotQcResult(validResult({ checks }));
    const skin = parsed.checks.find((c) => c.checkId === "skin-tone");
    expect(skin?.evidence[0]?.value).toBe(3.2);
  });
});

describe("rollupVerdict", () => {
  it("FAIL beats REVIEW beats PASS", () => {
    expect(rollupVerdict(allPassingChecks())).toBe("PASS");
    expect(
      rollupVerdict(
        allPassingChecks({ hair: reviewCheck("hair", "texture drift") }),
      ),
    ).toBe("REVIEW");
    expect(
      rollupVerdict(
        allPassingChecks({
          hair: reviewCheck("hair", "texture drift"),
          props: failedCheck("props", "coffee cup vanishes mid-shot"),
        }),
      ),
    ).toBe("FAIL");
  });
});

describe("check constructors", () => {
  it("passedCheck defaults to one observation", () => {
    const check = passedCheck("location", "diner interior matches");
    expect(check.verdict).toBe("PASS");
    expect(check.evidence).toHaveLength(1);
    expect(check.evidence[0]?.kind).toBe("observation");
  });

  it("failedCheck carries character binding and notes", () => {
    const check = failedCheck("character-identity", "wrong face shape", {
      characterId: "char_monica",
      characterVersion: "v02",
      notes: "regenerate with identity reference",
    });
    expect(check.verdict).toBe("FAIL");
    expect(check.characterId).toBe("char_monica");
    expect(check.characterVersion).toBe("v02");
  });
});