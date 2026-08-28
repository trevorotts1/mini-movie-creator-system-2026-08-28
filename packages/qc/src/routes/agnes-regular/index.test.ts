/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  isRegularSizeTier,
  planAgnesRegularFallback,
  regularSecondsString,
  selectEscalationMode,
  worstCaseCostUsd,
} from "./index.js";
import {
  AGNES_REGULAR_MODEL_ID,
  AGNES_VIDEO_2_5_FLASH_MODEL_ID,
  type FlashAttemptOutcome,
} from "./types.js";

/** Base outcome: Flash failed once, retry consumed. */
function failedFlashOutcome(
  overrides: Partial<FlashAttemptOutcome> = {},
): FlashAttemptOutcome {
  return {
    shot: {
      shotId: "S01E03_SC04_SH07",
      sceneId: "S01E03_SC04",
      targetDurationSeconds: 8,
      keyframeStrategy: "none",
      referenceAssets: { images: ["asset://identity-monica-v2"] },
    },
    provider: "agnes",
    modelId: AGNES_VIDEO_2_5_FLASH_MODEL_ID,
    qcVerdict: "FAIL",
    retryCount: 1,
    qcReasons: ["character identity mismatch on frame 3"],
    priorModelIds: [AGNES_VIDEO_2_5_FLASH_MODEL_ID],
    ...overrides,
  };
}

describe("QC-008 — Agnes regular fallback trigger conditions", () => {
  it("escalates when Flash FAILs after its retry is exhausted", () => {
    const decision = planAgnesRegularFallback(failedFlashOutcome());
    expect(decision.action).toBe("escalate-to-agnes-regular");
    if (decision.action === "escalate-to-agnes-regular") {
      expect(decision.reason).toBe("flash-failed-after-retry");
      expect(decision.request.modelId).toBe(AGNES_REGULAR_MODEL_ID);
    }
  });

  it("does not escalate while the Flash retry has not been consumed (retryCount 0)", () => {
    const decision = planAgnesRegularFallback(failedFlashOutcome({ retryCount: 0 }));
    expect(decision).toEqual({
      action: "no-escalation",
      reason: "flash-retry-not-exhausted",
    });
  });

  it("escalates without a consumed retry when QC-007 bypassed it (identity/provider failure class)", () => {
    // QC-007 hop contract: identity/reference and provider/transport failures
    // escalate to Agnes regular WITHOUT consuming the Flash retry.
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({ retryCount: 0, retryBypassed: true }),
    );
    expect(decision.action).toBe("escalate-to-agnes-regular");
  });

  it("does not escalate a Flash PASS — PASS is kept as final footage", () => {
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({ qcVerdict: "PASS" }),
    );
    expect(decision).toEqual({ action: "no-escalation", reason: "flash-passed" });
  });

  it("rejects attempts that are not the Agnes Flash model (mismatch guard)", () => {
    for (const modelId of ["agnes-video-2.5", "bytedance/seedance-2-mini"]) {
      const decision = planAgnesRegularFallback(
        failedFlashOutcome({ modelId }),
      );
      expect(decision).toEqual({
        action: "no-escalation",
        reason: "flash-model-mismatch",
      });
    }
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({ provider: "kie" as never }),
    );
    expect(decision).toEqual({
      action: "no-escalation",
      reason: "flash-model-mismatch",
    });
  });

  it("never re-escalates a shot that already used Agnes regular (idempotency)", () => {
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({
        priorModelIds: [
          AGNES_VIDEO_2_5_FLASH_MODEL_ID,
          AGNES_REGULAR_MODEL_ID,
        ],
      }),
    );
    expect(decision).toEqual({
      action: "no-escalation",
      reason: "already-escalated-to-regular",
    });
  });

  it("declines hero/complex/action/long shots — those go to the Wan tier", () => {
    for (const shotClass of ["hero", "complex", "action", "long"] as const) {
      const decision = planAgnesRegularFallback(
        failedFlashOutcome({ shot: { ...failedFlashOutcome().shot, shotClass } }),
      );
      expect(decision).toEqual({
        action: "no-escalation",
        reason: "hero-complex-or-long-shot",
      });
    }
  });

  it("escalates a standard-class shot", () => {
    const base = failedFlashOutcome();
    const decision = planAgnesRegularFallback({
      ...base,
      shot: { ...base.shot, shotClass: "standard" },
    });
    expect(decision.action).toBe("escalate-to-agnes-regular");
  });

  it("declines durations outside the documented 4–12 s Agnes regular range", () => {
    for (const duration of [3, 0, 13, 60]) {
      const decision = planAgnesRegularFallback(
        failedFlashOutcome({
          shot: { ...failedFlashOutcome().shot, targetDurationSeconds: duration },
        }),
      );
      expect(decision).toEqual({
        action: "no-escalation",
        reason: "duration-unsupported-by-agnes-regular",
      });
    }
  });

  it("declines when remaining budget cannot cover the worst-case escalation cost", () => {
    // 8 s × 2K rate ($0.055/s) = $0.44 worst case at this duration.
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({ remainingBudgetUsd: 0.4 }),
    );
    expect(decision).toEqual({
      action: "no-escalation",
      reason: "budget-exhausted",
    });
  });

  it("escalates when remaining budget exactly covers the worst case (inclusive gate)", () => {
    const outcome = failedFlashOutcome({ remainingBudgetUsd: 0.44 });
    const decision = planAgnesRegularFallback(outcome);
    expect(decision.action).toBe("escalate-to-agnes-regular");
  });

  it("ignores the budget gate when no remaining budget is provided", () => {
    const decision = planAgnesRegularFallback(failedFlashOutcome());
    expect(decision.action).toBe("escalate-to-agnes-regular");
  });
});

describe("QC-008 — escalation request plan", () => {
  it("clamps and stringifies duration, defaults size 720P, numbers the attempt", () => {
    const decision = planAgnesRegularFallback(
      failedFlashOutcome({ shot: { ...failedFlashOutcome().shot, targetDurationSeconds: 6 } }),
    );
    if (decision.action !== "escalate-to-agnes-regular") {
      throw new Error("expected escalation");
    }
    expect(decision.request.seconds).toBe("6");
    expect(decision.request.size).toBe("720P");
    expect(decision.request.provider).toBe("agnes");
    expect(decision.request.mode).toBe("reference");
    expect(decision.request.attemptNumber).toBe(2);
  });

  it("maps first-frame / first-last-frame strategies to keyframe mode with payload", () => {
    const base = failedFlashOutcome({
      shot: {
        ...failedFlashOutcome().shot,
        keyframeStrategy: "first-last-frame",
        referenceAssets: {
          images: ["asset://first.png", "asset://last.png"],
        },
      },
    });
    const decision = planAgnesRegularFallback(base);
    if (decision.action !== "escalate-to-agnes-regular") {
      throw new Error("expected escalation");
    }
    expect(decision.request.mode).toBe("keyframe");
    expect(decision.request.keyframes).toEqual({
      firstFrameUrl: "asset://first.png",
      lastFrameUrl: "asset://last.png",
    });
    expect(decision.request.references).toBeUndefined();
  });

  it("rejects keyframe strategy combined with multimodal references (mutually exclusive)", () => {
    const outcome = failedFlashOutcome({
      shot: {
        ...failedFlashOutcome().shot,
        keyframeStrategy: "first-frame",
        referenceAssets: {
          images: ["asset://first.png"],
          videos: ["asset://ref-motion.mp4"],
        },
      },
    });
    const decision = planAgnesRegularFallback(outcome);
    expect(decision).toEqual({
      action: "no-escalation",
      reason: "conflicting-keyframe-and-references",
    });
  });

  it("keeps reference videos in reference mode — regular tier supports what Flash rejected", () => {
    const outcome = failedFlashOutcome({
      shot: {
        ...failedFlashOutcome().shot,
        referenceAssets: {
          images: ["asset://identity.png"],
          videos: ["asset://ref-motion.mp4"],
          audios: ["asset://ref-voice.mp3"],
        },
      },
    });
    const decision = planAgnesRegularFallback(outcome);
    if (decision.action !== "escalate-to-agnes-regular") {
      throw new Error("expected escalation");
    }
    expect(decision.request.mode).toBe("reference");
    expect(decision.request.references).toEqual({
      images: ["asset://identity.png"],
      videos: ["asset://ref-motion.mp4"],
      audios: ["asset://ref-voice.mp3"],
    });
  });

  it("falls back to text mode when the shot carries no references or keyframes", () => {
    const decision = planAgnesRegularFallback({
      ...failedFlashOutcome(),
      shot: {
        shotId: "S01E01_SC01_SH01",
        targetDurationSeconds: 5,
        keyframeStrategy: "none",
      },
    });
    if (decision.action !== "escalate-to-agnes-regular") {
      throw new Error("expected escalation");
    }
    expect(decision.request.mode).toBe("text");
    expect(decision.request.keyframes).toBeUndefined();
    expect(decision.request.references).toBeUndefined();
    expect(decision.request.attemptNumber).toBe(2);
  });
});

describe("QC-008 — verified-limit helpers", () => {
  it("seconds strings stay inside the documented 4–12 range", () => {
    expect(regularSecondsString(4)).toBe("4");
    expect(regularSecondsString(12)).toBe("12");
    expect(regularSecondsString(3)).toBe("4"); // clamped up
    expect(regularSecondsString(13)).toBe("12"); // clamped down
    expect(regularSecondsString(7.6)).toBe("8"); // rounded
  });

  it("worst-case cost uses the 2K ceiling ($0.055/s verified 2026-08-28)", () => {
    expect(worstCaseCostUsd(12)).toBeCloseTo(0.66, 4);
    expect(worstCaseCostUsd(5)).toBeCloseTo(0.275, 4);
  });

  it("recognizes only documented size tiers", () => {
    expect(isRegularSizeTier("720P")).toBe(true);
    expect(isRegularSizeTier("960P")).toBe(true);
    expect(isRegularSizeTier("2K")).toBe(true);
    expect(isRegularSizeTier("1080P")).toBe(false);
    expect(isRegularSizeTier("auto")).toBe(false);
  });

  it("selects keyframe mode only from the strategy, reference mode from assets", () => {
    const withKeyframe = selectEscalationMode({
      ...failedFlashOutcome(),
      shot: {
        ...failedFlashOutcome().shot,
        keyframeStrategy: "first-frame",
      },
    });
    expect(withKeyframe).toEqual({ mode: "keyframe" });

    const withRefs = selectEscalationMode(failedFlashOutcome());
    expect(withRefs).toEqual({ mode: "reference" });

    const empty = selectEscalationMode({
      ...failedFlashOutcome(),
      shot: {
        shotId: "x",
        targetDurationSeconds: 5,
        keyframeStrategy: "none",
      },
    });
    expect(empty).toEqual({ mode: "text" });
  });
});