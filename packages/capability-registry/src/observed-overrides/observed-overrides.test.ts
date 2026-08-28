import { describe, expect, it } from "vitest";

import {
  AGNES_25_FLASH_OBSERVATIONS,
  AGNES_RUNTIME_DISCOVERED_25_IDS,
  AGNES_RUNTIME_DISCOVERY,
  AGNES_RUNTIME_MODEL_IDS,
  AGNES_VIDEO_V2_OBSERVATIONS,
  CONFIRMED_FAILURES_THRESHOLD,
  mergeOverride,
  refineFacet,
  recordVerifiedFailure,
  toObservedOverride,
  type ObservedOverride,
  type RuntimeObservation,
  type VerifiedFailureEvent,
} from "./index.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const RECENT = "2026-08-27T00:00:00.000Z";
const STALE = "2026-07-01T00:00:00.000Z";

function observation(overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    facet: "contextWindowTokens",
    kind: "limitProbe",
    method: "runtime",
    sourceUrl: "https://apihub.agnes-ai.com/v1/models",
    observedAt: RECENT,
    observedValue: 524288,
    evidence: "probe accepted/rejected",
    transientClass: null,
    ...overrides,
  };
}

describe("runtime observations refine UNKNOWN facets (PROVISIONAL + provenance)", () => {
  it("fills a null/UNKNOWN facet with PROVISIONAL confidence", () => {
    const outcome = refineFacet(
      { value: null, confidence: "UNKNOWN" },
      observation(),
      NOW,
    );
    expect(outcome).toEqual({
      action: "filled",
      facet: "contextWindowTokens",
      value: 524288,
      confidence: "PROVISIONAL",
    });
  });

  it("fills a facet with no current entry", () => {
    const outcome = refineFacet(null, observation(), NOW);
    expect(outcome.action).toBe("filled");
  });

  it("refines a PROVISIONAL value with a newer observation", () => {
    const outcome = refineFacet(
      { value: 262144, confidence: "PROVISIONAL" },
      observation({ observedValue: 524288 }),
      NOW,
    );
    expect(outcome).toMatchObject({ action: "refined", value: 524288, confidence: "PROVISIONAL" });
  });

  it("toObservedOverride stamps PROVISIONAL with source + observedAt + modelId", () => {
    const override = toObservedOverride("agnes", "agnes-2.5-flash", observation());
    expect(override).toEqual({
      provider: "agnes",
      modelId: "agnes-2.5-flash",
      facet: "contextWindowTokens",
      value: 524288,
      confidence: "PROVISIONAL",
      sourceUrl: "https://apihub.agnes-ai.com/v1/models",
      observedAt: RECENT,
      observationCount: 1,
      rejectionClass: null,
    });
  });

  it("toObservedOverride returns null for transient failures (no capability info)", () => {
    const override = toObservedOverride(
      "agnes",
      "agnes-2.5-flash",
      observation({ kind: "transientFailure", observedValue: null, transientClass: "timeout" }),
    );
    expect(override).toBeNull();
  });

  it("toObservedOverride returns null for stale observations", () => {
    const override = toObservedOverride(
      "agnes",
      "agnes-2.5-flash",
      observation({ observedAt: STALE }),
    );
    expect(override).toBeNull();
  });

  it("mergeOverride bumps observationCount on same value, replaces on different", () => {
    const first = toObservedOverride("agnes", "agnes-2.5-flash", observation());
    const second = toObservedOverride(
      "agnes",
      "agnes-2.5-flash",
      observation({ observedAt: "2026-08-28T00:00:00.000Z" }),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const merged = mergeOverride([first as ObservedOverride], second as ObservedOverride);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.observationCount).toBe(2);
    expect(merged[0]?.observedAt).toBe("2026-08-28T00:00:00.000Z");

    const changed = mergeOverride(
      [first as ObservedOverride],
      toObservedOverride(
        "agnes",
        "agnes-2.5-flash",
        observation({ observedValue: 262144, observedAt: "2026-08-28T00:00:00.000Z" }),
      ) as ObservedOverride,
    );
    expect(changed[0]?.value).toBe(262144);
    expect(changed[0]?.observationCount).toBe(1);
  });

  it("mergeOverride never mutates the input array", () => {
    const first = toObservedOverride("agnes", "agnes-2.5-flash", observation()) as ObservedOverride;
    const before = [...first ? [first] : []];
    const input = [first];
    mergeOverride(input, { ...first, facet: "maxOutputTokens", value: 65536 });
    expect(input).toEqual(before);
  });
});

describe("VERIFIED values are immutable on one transient failure", () => {
  it("keeps VERIFIED on a single transient timeout", () => {
    const outcome = refineFacet(
      { value: 524288, confidence: "VERIFIED" },
      observation({ kind: "transientFailure", observedValue: null, transientClass: "timeout" }),
      NOW,
    );
    expect(outcome).toEqual({
      action: "keptVerified",
      facet: "contextWindowTokens",
      reason: "single-transient-failure",
    });
  });

  it("keeps VERIFIED on a single network failure", () => {
    const outcome = refineFacet(
      { value: true, confidence: "VERIFIED" },
      observation({
        facet: "toolCallingSupported",
        kind: "transientFailure",
        observedValue: null,
        transientClass: "network",
      }),
      NOW,
    );
    expect(outcome.action).toBe("keptVerified");
  });

  it("keeps VERIFIED even when a fresh observation contradicts the value (never rewritten inline)", () => {
    const outcome = refineFacet(
      { value: 262144, confidence: "VERIFIED" },
      observation({ observedValue: 524288 }),
      NOW,
    );
    expect(outcome).toEqual({
      action: "keptVerified",
      facet: "contextWindowTokens",
      reason: "verified-immutable-on-transient",
    });
  });

  it("keeps VERIFIED when observation matches", () => {
    const outcome = refineFacet(
      { value: 524288, confidence: "VERIFIED" },
      observation({ observedValue: 524288 }),
      NOW,
    );
    expect(outcome).toEqual({
      action: "keptVerified",
      facet: "contextWindowTokens",
      reason: "verified-matches-observation",
    });
  });
});

describe("demotion gate: threshold consecutive same-class failures on distinct days", () => {
  it("requires exactly three by default", () => {
    expect(CONFIRMED_FAILURES_THRESHOLD).toBe(3);
  });

  it("one transient failure never demotes", () => {
    const result = recordVerifiedFailure(
      [],
      { facet: "contextWindowTokens", failureClass: "timeout", at: "2026-08-26T10:00:00.000Z" },
    );
    expect(result.demote).toBe(false);
  });

  it("two failures never demote", () => {
    const result = recordVerifiedFailure(
      [{ facet: "f", failureClass: "timeout", at: "2026-08-26T10:00:00.000Z" }],
      { facet: "f", failureClass: "timeout", at: "2026-08-27T10:00:00.000Z" },
    );
    expect(result.consecutiveSameClass).toBe(2);
    expect(result.distinctDays).toBe(2);
    expect(result.demote).toBe(false);
  });

  it("three same-class failures on the same day do not demote (distinct-day gate)", () => {
    const events = [
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-26T01:00:00.000Z" },
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-26T02:00:00.000Z" },
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-26T03:00:00.000Z" },
    ];
    const third = events[2];
    expect(third).toBeDefined();
    const result = recordVerifiedFailure(events.slice(0, 2), third as VerifiedFailureEvent);
    expect(result.consecutiveSameClass).toBe(3);
    expect(result.distinctDays).toBe(1);
    expect(result.demote).toBe(false);
  });

  it("three same-class failures on three distinct days demote", () => {
    const events = [
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-24T10:00:00.000Z" },
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-25T10:00:00.000Z" },
    ];
    const result = recordVerifiedFailure(events, {
      facet: "f",
      failureClass: "timeout",
      at: "2026-08-26T10:00:00.000Z",
    });
    expect(result.consecutiveSameClass).toBe(3);
    expect(result.distinctDays).toBe(3);
    expect(result.demote).toBe(true);
  });

  it("an intervening different failure class breaks the consecutive run", () => {
    const events = [
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-24T10:00:00.000Z" },
      { facet: "f", failureClass: "rateLimited" as const, at: "2026-08-25T10:00:00.000Z" },
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-26T10:00:00.000Z" },
      { facet: "f", failureClass: "timeout" as const, at: "2026-08-27T10:00:00.000Z" },
    ];
    // Only the trailing run of `timeout` counts.
    const fourth = events[3];
    expect(fourth).toBeDefined();
    const result = recordVerifiedFailure(events.slice(0, 3), fourth as VerifiedFailureEvent);
    expect(result.consecutiveSameClass).toBe(2);
    expect(result.demote).toBe(false);
  });
});

describe("Agnes 2.5 runtime IDs recorded with source and date", () => {
  it("records the 2.5 family IDs discovered at runtime", () => {
    expect(AGNES_RUNTIME_DISCOVERED_25_IDS).toEqual([
      "agnes-2.5-flash",
      "agnes-2.5-pro",
      "agnes-2.5-pro-alpha",
    ]);
  });

  it("includes agnes-video-v2.0 alongside the 2.5 IDs in the full runtime list", () => {
    expect(AGNES_RUNTIME_MODEL_IDS).toContain("agnes-video-v2.0");
    for (const id of AGNES_RUNTIME_DISCOVERED_25_IDS) {
      expect(AGNES_RUNTIME_MODEL_IDS).toContain(id);
    }
  });

  it("every Agnes observation carries a runtime method, sourceUrl, and observedAt date", () => {
    const all = [...AGNES_25_FLASH_OBSERVATIONS, ...AGNES_VIDEO_V2_OBSERVATIONS];
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const obs of all) {
      expect(obs.method).toBe("runtime");
      expect(obs.sourceUrl).toContain("apihub.agnes-ai.com");
      expect(Date.parse(obs.observedAt)).not.toBeNaN();
    }
  });

  it("carries the probed 2.5-flash limits (512K context, 64K output, tools)", () => {
    const byFacet = new Map(AGNES_25_FLASH_OBSERVATIONS.map((o) => [o.facet, o]));
    expect(byFacet.get("contextWindowTokens")?.observedValue).toBe(524288);
    expect(byFacet.get("maxOutputTokens")?.observedValue).toBe(65536);
    expect(byFacet.get("toolCallingSupported")?.observedValue).toBe(true);
  });

  it("carries the video num_frames constraint (8n+1, <= 441)", () => {
    const frames = AGNES_VIDEO_V2_OBSERVATIONS.find((o) => o.facet === "numFramesConstraint");
    expect(frames?.observedValue).toBe(441);
    expect(frames?.evidence).toContain("8n+1");
  });

  it("discovery metadata names the provider and a real endpoint source", () => {
    expect(AGNES_RUNTIME_DISCOVERY.provider).toBe("agnes");
    expect(AGNES_RUNTIME_DISCOVERY.baseUrl).toBe("https://apihub.agnes-ai.com/v1");
  });

  it("Agnes observations flow through refineFacet as PROVISIONAL fills", () => {
    for (const obs of AGNES_25_FLASH_OBSERVATIONS) {
      if (obs.facet === "modelList") continue;
      const outcome = refineFacet({ value: null, confidence: "UNKNOWN" }, obs, NOW);
      expect(outcome).toMatchObject({ action: "filled", confidence: "PROVISIONAL" });
    }
  });
});

describe("stale and indeterminate observations", () => {
  it("ignores stale observations even for UNKNOWN facets", () => {
    const outcome = refineFacet(
      { value: null, confidence: "UNKNOWN" },
      observation({ observedAt: STALE }),
      NOW,
    );
    expect(outcome).toEqual({ action: "ignored", facet: "contextWindowTokens", reason: "stale-observation" });
  });

  it("ignores malformed observedAt", () => {
    const outcome = refineFacet(
      { value: null, confidence: "UNKNOWN" },
      observation({ observedAt: "not-a-date" }),
      NOW,
    );
    expect(outcome.action === "ignored" && outcome.reason).toBe("stale-observation");
  });

  it("ignores null-value non-transient probes (indeterminate proves nothing)", () => {
    const outcome = refineFacet(
      { value: 524288, confidence: "PROVISIONAL" },
      observation({ kind: "capabilityProbe", observedValue: null }),
      NOW,
    );
    expect(outcome).toEqual({ action: "ignored", facet: "contextWindowTokens", reason: "no-change" });
  });

  it("no-change when PROVISIONAL value re-observed identical", () => {
    const outcome = refineFacet(
      { value: 524288, confidence: "PROVISIONAL" },
      observation({ observedValue: 524288 }),
      NOW,
    );
    expect(outcome.action === "ignored" && outcome.reason).toBe("no-change");
  });
});