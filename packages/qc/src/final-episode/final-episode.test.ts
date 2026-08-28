import { describe, it, expect } from "vitest";
import {
  parseAspectRatio,
  validateFinalEpisodeQcInput,
  evaluatePresentationGate,
  buildProductionReport,
  runFinalEpisodeQC,
  EPISODE_QC_TOLERANCES,
  type FinalEpisodeQcInput,
  type ShotProductionRecord,
} from "./final-episode.js";

/** Healthy accepted shot helper. */
function shot(overrides: Partial<ShotProductionRecord> = {}): ShotProductionRecord {
  return {
    shotId: "SH01",
    sceneId: "SC01",
    provider: "agnes",
    model: "video-2.5-flash",
    durationSeconds: 4,
    generatedSeconds: 4,
    acceptedSeconds: 4,
    rejectedSeconds: 0,
    retries: 0,
    cost: 0.04,
    currency: "USD",
    quotaUsed: 4,
    quotaUnit: "seconds",
    qcStatus: "accepted",
    sourceResolution: { width: 1080, height: 1920 },
    characters: ["monica"],
    ...overrides,
  };
}

/** Healthy episode input helper. */
function input(overrides: Partial<FinalEpisodeQcInput> = {}): FinalEpisodeQcInput {
  return {
    episodeId: "S01E01",
    seriesId: "S01",
    name: "Pilot",
    runtimeSeconds: 12,
    targetRuntimeSeconds: 12,
    declaredAspectRatio: "9:16",
    renderResolution: { width: 1080, height: 1920 },
    shots: [
      shot({ shotId: "SH01", durationSeconds: 4, characters: ["monica"] }),
      shot({ shotId: "SH02", provider: "kie", model: "seedance-2-mini", durationSeconds: 4, acceptedSeconds: 4, generatedSeconds: 6, rejectedSeconds: 2, retries: 1, cost: 0.12, quotaUsed: 6, characters: ["monica", "leo"] }),
      shot({ shotId: "SH03", durationSeconds: 4, characters: ["zoe"] }),
    ],
    canonChanges: [
      { id: "CC01", description: "Monica eye color", status: "approved" },
    ],
    finalUrl: "https://media.example.com/S01E01/final.mp4",
    qcCompletedAt: "2026-08-28T14:00:00Z",
    presentedAt: "2026-08-28T15:00:00Z",
    ...overrides,
  };
}

describe("parseAspectRatio", () => {
  it("parses 16:9 and 9:16", () => {
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9, 10);
    expect(parseAspectRatio("9:16")).toBeCloseTo(9 / 16, 10);
  });

  it("throws on malformed or non-positive input", () => {
    expect(() => parseAspectRatio("1080p")).toThrow(TypeError);
    expect(() => parseAspectRatio("0:16")).toThrow(TypeError);
    expect(() => parseAspectRatio("16:0")).toThrow(TypeError);
  });
});

describe("validateFinalEpisodeQcInput", () => {
  it("accepts a healthy input", () => {
    expect(() => validateFinalEpisodeQcInput(input())).not.toThrow();
  });

  it("rejects missing episodeId/seriesId", () => {
    expect(() => validateFinalEpisodeQcInput({ ...input(), episodeId: "" })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), seriesId: "" })).toThrow(TypeError);
  });

  it("rejects non-positive runtime and bad render resolution", () => {
    expect(() => validateFinalEpisodeQcInput({ ...input(), runtimeSeconds: 0 })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), renderResolution: { width: 0, height: 1920 } })).toThrow(TypeError);
  });

  it("rejects wrong-aspect declared ratio", () => {
    expect(() => validateFinalEpisodeQcInput({ ...input(), declaredAspectRatio: "1080p" })).toThrow(TypeError);
  });

  it("rejects empty shots and invalid shot fields", () => {
    expect(() => validateFinalEpisodeQcInput({ ...input(), shots: [] })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), shots: [shot({ durationSeconds: -1 })] })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), shots: [shot({ retries: 1.5 })] })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), shots: [shot({ currency: "usd" })] })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), shots: [shot({ qcStatus: "maybe" as never })] })).toThrow(TypeError);
  });

  it("accepts a rejected shot with zero assembly duration", () => {
    expect(() =>
      validateFinalEpisodeQcInput({
        ...input(),
        shots: [shot({ qcStatus: "rejected", durationSeconds: 0, acceptedSeconds: 0 })],
      }),
    ).not.toThrow();
  });

  it("rejects an accepted shot with zero assembly duration", () => {
    expect(() =>
      validateFinalEpisodeQcInput({
        ...input(),
        shots: [shot({ qcStatus: "accepted", durationSeconds: 0 })],
      }),
    ).toThrow(TypeError);
  });

  it("rejects a bad finalUrl and malformed timestamps", () => {
    expect(() => validateFinalEpisodeQcInput({ ...input(), finalUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), qcCompletedAt: "yesterday" })).toThrow(TypeError);
    expect(() => validateFinalEpisodeQcInput({ ...input(), presentedAt: "2026-02-31T10:00:00Z" })).toThrow(TypeError);
  });

  it("rejects invalid canon change status", () => {
    expect(() =>
      validateFinalEpisodeQcInput({
        ...input(),
        canonChanges: [{ id: "CC01", description: "x", status: "live" as never }],
      }),
    ).toThrow(TypeError);
  });
});

describe("evaluatePresentationGate", () => {
  it("allows presentation when nothing was presented", () => {
    expect(evaluatePresentationGate(null, null).allowed).toBe(true);
  });

  it("blocks presentation when QC completed after presentation", () => {
    const gate = evaluatePresentationGate("2026-08-28T15:00:00Z", "2026-08-28T14:00:00Z");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("before full-episode QC");
  });

  it("blocks presentation with no QC completion recorded", () => {
    const gate = evaluatePresentationGate(null, "2026-08-28T14:00:00Z");
    expect(gate.allowed).toBe(false);
  });

  it("allows presentation when QC completed first", () => {
    expect(evaluatePresentationGate("2026-08-28T14:00:00Z", "2026-08-28T15:00:00Z").allowed).toBe(true);
  });
});

describe("buildProductionReport", () => {
  it("passes a healthy episode (§21 report fields)", () => {
    const result = runFinalEpisodeQC(input());
    expect(result.status).toBe("PASS");
    expect(result.presentationAllowed).toBe(true);
    const report = result.report;
    expect(report.episodeId).toBe("S01E01");
    expect(report.runtimeSeconds).toBe(12);
    expect(report.aspectRatio).toBe("9:16");
    expect(report.resolution).toEqual({ width: 1080, height: 1920 });
    expect(report.generatedSeconds).toBe(14); // 4 + 6 + 4
    expect(report.acceptedSeconds).toBe(12);
    expect(report.rejectedSeconds).toBe(2);
    expect(report.retries).toBe(1);
    expect(report.costTotal).toBeCloseTo(0.2, 10);
    expect(report.currency).toBe("USD");
    expect(report.characters).toEqual(["leo", "monica", "zoe"]);
    expect(report.characterCount).toBe(3);
    expect(report.canonChanges).toHaveLength(1);
    expect(report.canonChanges[0]?.status).toBe("approved");
    expect(report.finalUrl).toBe("https://media.example.com/S01E01/final.mp4");
    expect(report.qcStatus).toBe("PASS");
    expect(report.nativeQuality).toBe(true);
    expect(report.upscaledSegments).toBe(0);
  });

  it("groups providers/models with per-model seconds and costs", () => {
    const report = buildProductionReport(input());
    expect(report.providersModels).toHaveLength(2);
    const agnes = report.providersModels.find((m) => m.provider === "agnes");
    expect(agnes).toBeDefined();
    expect(agnes?.model).toBe("video-2.5-flash");
    expect(agnes?.playedSeconds).toBe(8);
    expect(agnes?.generatedSeconds).toBe(8);
    expect(agnes?.cost).toBeCloseTo(0.08, 10);
    const kie = report.providersModels.find((m) => m.provider === "kie");
    expect(kie?.playedSeconds).toBe(4);
    expect(kie?.generatedSeconds).toBe(6);
    expect(kie?.rejectedSeconds).toBe(2);
    expect(kie?.retries).toBe(1);
  });

  it("never invents currency when no cost exists", () => {
    const report = buildProductionReport(input({
      shots: [shot({ cost: null, durationSeconds: 4 })],
    }));
    expect(report.costTotal).toBeNull();
    expect(report.currency).toBeNull();
    expect(report.providersModels[0]?.cost).toBeNull();
    expect(report.providersModels[0]?.currency).toBeNull();
  });

  it("marks upscaled sources as non-native quality (spec §21)", () => {
    const input720 = input({
      shots: [
        shot({ shotId: "SH01", sourceResolution: { width: 720, height: 1280 } }),
        shot({ shotId: "SH02", provider: "kie", model: "seedance-2-mini", durationSeconds: 4, sourceResolution: { width: 1080, height: 1920 }, characters: ["monica", "leo"] }),
        shot({ shotId: "SH03", sourceResolution: { width: 1080, height: 1920 } }),
      ],
    });
    const result = runFinalEpisodeQC(input720);
    expect(result.report.nativeQuality).toBe(false);
    expect(result.report.upscaledSegments).toBe(1);
    expect(result.status).toBe("PASS"); // upscale is provenance, not failure
    expect(result.issues.some((i) => i.code === "UPSCALED")).toBe(true);
  });

  it("fails on runtime mismatch, pending/rejected shot, missing URL, aspect mismatch", () => {
    const result = runFinalEpisodeQC(input({
      runtimeSeconds: 20,
      shots: [shot({ shotId: "SH01", durationSeconds: 4, qcStatus: "pending" })],
      finalUrl: null,
      declaredAspectRatio: "16:9",
    }));
    expect(result.status).toBe("FAIL");
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("RUNTIME_MISMATCH");
    expect(codes).toContain("SHOT_NOT_ACCEPTED");
    expect(codes).toContain("MISSING_FINAL_URL");
    expect(codes).toContain("ASPECT_MISMATCH");
  });

  it("fails when seconds do not reconcile (accepted+rejected > generated)", () => {
    const result = runFinalEpisodeQC(input({
      shots: [shot({ generatedSeconds: 4, acceptedSeconds: 6, rejectedSeconds: 0 })],
    }));
    expect(result.status).toBe("FAIL");
    expect(result.issues.some((i) => i.code === "SECONDS_CONSISTENCY")).toBe(true);
  });

  it("fails on mixed-currency costs and warns on partial coverage", () => {
    const result = runFinalEpisodeQC(input({
      shots: [
        shot({ shotId: "SH01", cost: 0.1, currency: "USD" }),
        shot({ shotId: "SH02", cost: 0.1, currency: "EUR", durationSeconds: 4 }),
        shot({ shotId: "SH03", cost: null, durationSeconds: 4, currency: "USD" }),
      ],
    }));
    expect(result.status).toBe("FAIL");
    expect(result.issues.some((i) => i.code === "CURRENCY_MISMATCH")).toBe(true);
    expect(result.report.costTotal).toBeNull();
    expect(result.issues.some((i) => i.code === "PARTIAL_COST_COVERAGE")).toBe(true);
  });

  it("warns on trim, target deviation and quota unit mismatch, still PASSes", () => {
    const result = runFinalEpisodeQC(input({
      runtimeSeconds: 12,
      targetRuntimeSeconds: 18,
      shots: [
        shot({ shotId: "SH01", durationSeconds: 4, acceptedSeconds: 5, generatedSeconds: 5, quotaUsed: 5, quotaUnit: "frames" }),
        shot({ shotId: "SH02", durationSeconds: 4, quotaUsed: 6, quotaUnit: "frames", provider: "kie", model: "seedance-2-mini", cost: 0.12, characters: ["monica", "leo"] }),
        shot({ shotId: "SH03", durationSeconds: 4, quotaUsed: 7, quotaUnit: "seconds" }),
      ],
    }));
    expect(result.status).toBe("PASS");
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("ACCEPTED_MATCH");
    expect(codes).toContain("TARGET_DEVIATION");
    expect(codes).toContain("QUOTA_UNIT_MISMATCH");
  });

  it("rejects 720p source when render is 1080p — never silent resolution claim", () => {
    const result = runFinalEpisodeQC(input({
      runtimeSeconds: 4,
      renderResolution: { width: 1920, height: 1080 },
      declaredAspectRatio: "16:9",
      shots: [shot({ sourceResolution: { width: 1280, height: 720 }, durationSeconds: 4 })],
    }));
    expect(result.report.nativeQuality).toBe(false);
    expect(result.status).toBe("PASS");
  });

  it("handles a shot with large over-generation (60s generated, 4s used)", () => {
    const result = runFinalEpisodeQC(input({
      runtimeSeconds: 4,
      shots: [shot({ durationSeconds: 4, acceptedSeconds: 4, generatedSeconds: 60, rejectedSeconds: 56 })],
    }));
    expect(result.status).toBe("PASS");
    expect(result.report.acceptedSeconds).toBe(4);
    expect(result.report.rejectedSeconds).toBe(56);
  });

  it("does not double-count a shot string with provider/model prefix collisions", () => {
    const report = buildProductionReport(input({
      shots: [
        shot({ shotId: "SH01", provider: "agnes", model: "video-2.5" }),
        shot({ shotId: "SH02", provider: "agnes2", model: "video-2.5", durationSeconds: 4 }),
        shot({ shotId: "SH03", provider: "agnes", model: "video-2.5x", durationSeconds: 4 }),
      ],
    }));
    expect(report.providersModels).toHaveLength(3);
    expect(report.generatedSeconds).toBe(12);
  });

  it("collects quota usage per provider/model", () => {
    const report = buildProductionReport(input());
    expect(report.quotaUsage).toHaveLength(2);
    expect(report.quotaUsage.find((q) => q.provider === "kie" && q.model === "seedance-2-mini")?.quotaUsed).toBe(6);
  });
});

describe("runFinalEpisodeQC", () => {
  it("blocks presentation before QC via gate result", () => {
    const result = runFinalEpisodeQC(input({
      qcCompletedAt: null,
      presentedAt: "2026-08-28T15:00:00Z",
    }));
    expect(result.presentationAllowed).toBe(false);
    expect(result.presentationGateReason).toContain("before full-episode QC");
    expect(result.status).toBe("FAIL");
  });

  it("PASS when QC completes before presentation", () => {
    const result = runFinalEpisodeQC(input());
    expect(result.status).toBe("PASS");
  });

  it("throws on invalid input, not silently passing", () => {
    expect(() => runFinalEpisodeQC({ ...input(), shots: [] })).toThrow(TypeError);
  });
});
