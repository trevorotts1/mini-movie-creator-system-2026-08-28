/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AGNES_FLASH_MODEL,
  AGNES_REGULAR_MODEL,
  IDENTITY_REFERENCE_CHECKS,
  MAX_FLASH_ATTEMPTS,
  STALE_FLASH_MODEL,
  FlashRouteError,
  assertFlashPassIsFinal,
  classifyFlashFailure,
  nextRetrySeed,
  routeFlashShot,
  type FlashQcResult,
  type FlashShotContext,
} from "./index.js";

const CTX: FlashShotContext = {
  shotId: "S01E03_SC04_SH07",
  model: AGNES_FLASH_MODEL,
  seed: 42,
};

function passQc(overrides: Partial<FlashQcResult> = {}): FlashQcResult {
  return { verdict: "PASS", failures: [], ...overrides };
}

function failQc(
  checks: string[],
  overrides: Partial<FlashQcResult> = {},
): FlashQcResult {
  return {
    verdict: "FAIL",
    failures: checks.map((check) => ({ check, detail: `failed ${check}` })),
    ...overrides,
  };
}

describe("Flash PASS kept as FINAL footage (never preview-only)", () => {
  it("initial attempt PASS → KEEP_AS_FINAL with final-footage flags", () => {
    const decision = routeFlashShot(
      CTX,
      passQc({ videoUrl: "https://cdn.agnes/v1.mp4", providerTaskId: "vid_1" }),
      1,
    );
    expect(decision.action).toBe("KEEP_AS_FINAL");
    if (decision.action === "KEEP_AS_FINAL") {
      expect(decision.disposition).toBe("FINAL");
      expect(decision.isFinalFootage).toBe(true);
      expect(decision.previewOnly).toBe(false);
      expect(decision.reason).toBe("flash-pass");
      expect(decision.model).toBe(AGNES_FLASH_MODEL);
      expect(decision.attemptsUsed).toBe(1);
      expect(decision.videoUrl).toBe("https://cdn.agnes/v1.mp4");
      expect(decision.providerTaskId).toBe("vid_1");
    }
    expect(() => assertFlashPassIsFinal(decision)).not.toThrow();
  });

  it("retry-attempt PASS is also FINAL (retry never downgrades footage)", () => {
    const decision = routeFlashShot(
      CTX,
      passQc({ videoUrl: "https://cdn.agnes/v2.mp4" }),
      2,
    );
    expect(decision.action).toBe("KEEP_AS_FINAL");
    expect(() => assertFlashPassIsFinal(decision)).not.toThrow();
  });

  it("assertFlashPassIsFinal rejects a downgraded PASS decision", () => {
    const base = routeFlashShot(CTX, passQc(), 1);
    const downgraded = { ...base, disposition: "PREVIEW" };
    expect(() => assertFlashPassIsFinal(downgraded as never)).toThrow(
      FlashRouteError,
    );
  });

  it("PASS decision carries previewOnly=false, the only preview mention", () => {
    const decision = routeFlashShot(CTX, passQc(), 1);
    expect((decision as { previewOnly?: unknown }).previewOnly).toBe(false);
  });
});

describe("likely prompt/seed failure → exactly one Flash retry", () => {
  it("content FAIL (visual-artifacts) on attempt 1 → RETRY_FLASH attempt 2", () => {
    const decision = routeFlashShot(CTX, failQc(["visual-artifacts"]), 1);
    expect(decision.action).toBe("RETRY_FLASH");
    if (decision.action === "RETRY_FLASH") {
      expect(decision.attempt).toBe(2);
      expect(decision.maxAttempts).toBe(MAX_FLASH_ATTEMPTS);
      expect(decision.reason).toBe("likely-prompt-seed");
      expect(decision.promptUnchanged).toBe(true);
      expect(decision.seed).toBe(43);
      expect(decision.model).toBe(AGNES_FLASH_MODEL);
    }
  });

  it("anatomy/action/camera/lighting failures are likely-prompt-seed", () => {
    for (const check of [
      "body-anatomy",
      "action-requirement",
      "camera-requirement",
      "lighting-continuity",
      "lip-face",
      "start-end-state",
      "dialogue-suitability",
    ]) {
      expect(classifyFlashFailure(failQc([check]))).toBe("likely-prompt-seed");
    }
  });

  it("retry budget is hard-bounded: attempt 2 FAIL → ESCALATE, never a 3rd retry", () => {
    const decision = routeFlashShot(CTX, failQc(["visual-artifacts"]), 2);
    expect(decision.action).toBe("ESCALATE");
    if (decision.action === "ESCALATE") {
      expect(decision.to).toBe(AGNES_REGULAR_MODEL);
      expect(decision.reason).toBe("retry-budget-exhausted");
      expect(decision.disposition).toBe("ESCALATED");
      expect(decision.attemptsUsed).toBe(2);
    }
    expect(MAX_FLASH_ATTEMPTS).toBe(2);
  });

  it("second likely-prompt-seed failure escalates to Agnes regular", () => {
    const decision = routeFlashShot(CTX, failQc(["visual-artifacts"]), 2);
    if (decision.action === "ESCALATE") {
      expect(decision.to).toBe(AGNES_REGULAR_MODEL);
    }
  });
});

describe("identity/reference and provider failures never consume the retry", () => {
  it("identity failure on attempt 1 escalates immediately", () => {
    const decision = routeFlashShot(CTX, failQc(["character-identity"]), 1);
    expect(decision.action).toBe("ESCALATE");
    if (decision.action === "ESCALATE") {
      expect(decision.reason).toBe("identity-reference");
      expect(decision.to).toBe(AGNES_REGULAR_MODEL);
    }
  });

  it("every identity/reference block check routes around the retry", () => {
    for (const check of IDENTITY_REFERENCE_CHECKS) {
      const decision = routeFlashShot(CTX, failQc([check]), 1);
      expect(decision.action).toBe("ESCALATE");
    }
  });

  it("providerError=true on a FAIL escalates without consuming the retry", () => {
    const decision = routeFlashShot(
      CTX,
      { verdict: "FAIL", failures: [], providerError: true },
      1,
    );
    expect(decision.action).toBe("ESCALATE");
    if (decision.action === "ESCALATE") {
      expect(decision.reason).toBe("provider-error");
    }
  });

  it("provider-transport check failure escalates", () => {
    const decision = routeFlashShot(CTX, failQc(["provider-transport"]), 1);
    expect(decision.action).toBe("ESCALATE");
  });

  it("mixed identity + artifact failure is identity-reference (stronger class wins)", () => {
    expect(classifyFlashFailure(failQc(["wardrobe", "visual-artifacts"]))).toBe(
      "identity-reference",
    );
  });
});

describe("nextRetrySeed", () => {
  it("increments the seed deterministically", () => {
    expect(nextRetrySeed(42)).toBe(43);
  });

  it("wraps at the int32 ceiling", () => {
    expect(nextRetrySeed(2147483647)).toBe(1);
  });

  it("never emits the reserved 0 seed", () => {
    expect(nextRetrySeed(-1)).toBe(1);
  });

  it("rejects non-integer seeds", () => {
    expect(() => nextRetrySeed(1.5)).toThrow(FlashRouteError);
  });
});

describe("model identity guards (runbook §11.1)", () => {
  it("refuses the stale agnes-video-v2.0 id", () => {
    expect(() =>
      routeFlashShot({ shotId: "s1", model: STALE_FLASH_MODEL }, passQc(), 1),
    ).toThrow(/stale/);
  });

  it("refuses any non-Flash model", () => {
    expect(() =>
      routeFlashShot(
        { shotId: "s1", model: AGNES_REGULAR_MODEL },
        passQc(),
        1,
      ),
    ).toThrow(/only governs/);
  });
});

describe("input validation", () => {
  it("rejects empty shotId", () => {
    expect(() =>
      routeFlashShot({ shotId: "  ", model: AGNES_FLASH_MODEL }, passQc(), 1),
    ).toThrow(FlashRouteError);
  });

  it("rejects zero and non-integer attemptsUsed", () => {
    expect(() => routeFlashShot(CTX, passQc(), 0)).toThrow(FlashRouteError);
    expect(() => routeFlashShot(CTX, passQc(), 1.5)).toThrow(FlashRouteError);
  });

  it("rejects unknown verdicts", () => {
    expect(() =>
      routeFlashShot(CTX, { verdict: "MAYBE" } as unknown as FlashQcResult, 1),
    ).toThrow(FlashRouteError);
  });

  it("rejects PASS carrying failures", () => {
    expect(() =>
      routeFlashShot(CTX, { verdict: "PASS", failures: failQc(["x"]).failures }, 1),
    ).toThrow(FlashRouteError);
  });

  it("rejects non-integer seed in context", () => {
    expect(() =>
      routeFlashShot(
        { shotId: "s1", model: AGNES_FLASH_MODEL, seed: 7.5 },
        passQc(),
        1,
      ),
    ).toThrow(FlashRouteError);
  });
});