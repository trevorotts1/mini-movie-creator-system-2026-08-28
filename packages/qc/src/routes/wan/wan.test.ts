/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  buildWanRouteBody,
  classifyWanShot,
  evaluateWanPolicy,
  priorTiersExhausted,
  projectWanSpendUsd,
  routeShotToWan,
  validateWanRouteInput,
  WAN_POLICY_GATES,
  WAN_POLICY_TABLE,
  WAN_ROUTE_LIMITS,
  WanRouteSubmitError,
  WanRouteValidationError,
  type WanRouteAttempt,
  type WanRouteContext,
  type WanRouteResult,
  type WanRouteShot,
} from "./index.js";

/** Default clean context: no history, zero spend, room under the ceiling. */
function cleanContext(overrides: Partial<WanRouteContext> = {}): WanRouteContext {
  return {
    qualityHistory: [],
    spend: { cumulativeUsd: 0, approvedCeilingUsd: 25.0 },
    ...overrides,
  };
}

/** Baseline shot with NO qualifying trait (policy must skip it). */
function plainShot(overrides: Partial<WanRouteShot> = {}): WanRouteShot {
  return {
    shotId: "S01E03_SC04_SH07",
    targetDurationSeconds: 8,
    compiledPrompt: "Monica turns toward the window, medium shot.",
    compiledPromptCharacters: 43,
    ...overrides,
  };
}

function stubClient(taskId = "wan-task-001", calls: { bodies: unknown[] } = { bodies: [] }) {
  return {
    async createTask(body: { model: string; input: Record<string, unknown> }) {
      calls.bodies.push(body);
      return { taskId };
    },
  };
}

/** History where all prior tiers failed (spec §20 chain). */
const allPriorTiersFailed: WanRouteAttempt[] = [
  { provider: "agnes-flash", outcome: "fail", failureClass: "prompt_seed" },
  { provider: "agnes-regular", outcome: "fail", failureClass: "identity" },
  { provider: "seedance", outcome: "fail", failureClass: "reference" },
];

describe("WAN_POLICY_TABLE (spec §13)", () => {
  it("has one row per qualifying trait", () => {
    const traits = [
      "hero",
      "action",
      "complex",
      "long",
      "reference_heavy",
      "quality_history_escalation",
    ];
    expect(WAN_POLICY_TABLE.map((r) => r.trait)).toEqual(traits);
  });

  it("every row routes to a verified Wan 3.0 model id at 1080P", () => {
    for (const row of WAN_POLICY_TABLE) {
      expect(["wan/3-0-video", "wan/3-0-video-prime"]).toContain(row.model);
      expect(row.resolution).toBe("1080P");
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  it("table rows are immutable", () => {
    expect(Object.isFrozen(WAN_POLICY_TABLE)).toBe(true);
    expect(Object.isFrozen(WAN_POLICY_GATES)).toBe(true);
  });
});

describe("evaluateWanPolicy — trigger table", () => {
  it("routes a hero shot to Wan 3.0 at 1080P", () => {
    const decision = evaluateWanPolicy(plainShot({ hero: true }), cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.model).toBe("wan/3-0-video");
      expect(decision.resolution).toBe("1080P");
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_hero");
    }
  });

  it("routes an action shot to Wan 3.0", () => {
    const decision = evaluateWanPolicy(plainShot({ action: true }), cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_action");
    }
  });

  it("routes a complex shot to Wan 3.0", () => {
    const decision = evaluateWanPolicy(plainShot({ complexity: "complex" }), cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_complex");
    }
  });

  it("routes a long shot (target > 12s) to Wan 3.0", () => {
    const decision = evaluateWanPolicy(plainShot({ targetDurationSeconds: 15 }), cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_long");
    }
  });

  it("does NOT route a 12s shot (long is strictly greater than the threshold)", () => {
    const decision = evaluateWanPolicy(plainShot({ targetDurationSeconds: 12 }), cleanContext());
    expect(decision.outcome).toBe("skip");
    expect(decision.reasons[0]?.code).toBe("no_qualifying_trait");
  });

  it("routes a reference-heavy shot (>= 5 references) to Wan 3.0", () => {
    const shot = plainShot({
      referenceImageUrls: [
        "https://a.example/1.png",
        "https://a.example/2.png",
        "https://a.example/3.png",
      ],
      referenceVideoUrls: ["https://a.example/v1.mp4", "https://a.example/v2.mp4"],
    });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_reference_heavy");
    }
  });

  it("routes on quality-history escalation when all prior tiers failed", () => {
    const decision = evaluateWanPolicy(plainShot(), cleanContext({ qualityHistory: allPriorTiersFailed }));
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.map((r) => r.code)).toContain("policy_row_quality_history_escalation");
    }
  });

  it("skips a plain standard shot with no qualifying trait", () => {
    const decision = evaluateWanPolicy(plainShot(), cleanContext());
    expect(decision.outcome).toBe("skip");
    expect(decision.reasons[0]?.code).toBe("no_qualifying_trait");
  });

  it("hero is the first matching row when several traits qualify", () => {
    const shot = plainShot({ hero: true, action: true, complexity: "complex" });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons[0]?.code).toBe("policy_row_hero");
      expect(decision.reasons.find((r) => r.code === "traits")?.detail).toContain("action");
    }
  });
});

describe("evaluateWanPolicy — capability factor", () => {
  it("skips when the compiled prompt exceeds Wan's 20,000-char hard max", () => {
    const shot = plainShot({
      hero: true,
      compiledPrompt: "x".repeat(20_001),
      compiledPromptCharacters: 20_001,
    });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.outcome).toBe("skip");
    expect(decision.reasons[0]?.code).toBe("prompt_over_limit");
  });

  it("skips when reference images exceed Wan's max of 10", () => {
    const shot = plainShot({
      hero: true,
      referenceImageUrls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}.png`),
    });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.outcome).toBe("skip");
    expect(decision.reasons[0]?.code).toBe("too_many_reference_images");
  });

  it("skips when reference videos exceed Wan's max of 5", () => {
    const shot = plainShot({
      hero: true,
      referenceVideoUrls: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}.mp4`),
    });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.reasons[0]?.code).toBe("too_many_reference_videos");
  });

  it("skips when reference audio exceeds Wan's max of 5", () => {
    const shot = plainShot({
      hero: true,
      referenceAudioUrls: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}.mp3`),
    });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.reasons[0]?.code).toBe("too_many_reference_audio");
  });

  it("skips when the target duration exceeds Wan's 30s max", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 31 });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.reasons[0]?.code).toBe("duration_over_limit");
  });

  it("skips when the target duration is under Wan's 2s min", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 1 });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.reasons[0]?.code).toBe("duration_under_limit");
  });

  it("does NOT treat the -1 model-decides sentinel as under-limit", () => {
    const decision = evaluateWanPolicy(
      plainShot({ hero: true, targetDurationSeconds: -1 }),
      cleanContext(),
    );
    expect(decision.outcome).toBe("route");
  });

  it("skips when reference video + output exceeds the 30s input+output window (KIE-005 billing rule)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 20, referenceVideoSeconds: 15 });
    const decision = evaluateWanPolicy(shot, cleanContext());
    expect(decision.reasons[0]?.code).toBe("reference_video_duration_over_limit");
  });

  it("capability gate runs before the spend gate", () => {
    expect(WAN_POLICY_GATES[0]?.id).toBe("capability");
    expect(WAN_POLICY_GATES[1]?.id).toBe("spend");
  });
});

describe("evaluateWanPolicy — quality-history factor", () => {
  it("priorTiersExhausted is false with empty history", () => {
    expect(priorTiersExhausted([])).toBe(false);
  });

  it("priorTiersExhausted is true only when every prior-tier attempt failed", () => {
    expect(priorTiersExhausted(allPriorTiersFailed)).toBe(true);
    expect(
      priorTiersExhausted([
        { provider: "agnes-flash", outcome: "fail" },
        { provider: "seedance", outcome: "pass" },
      ]),
    ).toBe(false);
    expect(priorTiersExhausted([{ provider: "seedance", outcome: "fail" }])).toBe(true);
  });

  it("a pass at any earlier tier resets the escalation signal", () => {
    const decision = evaluateWanPolicy(
      plainShot(),
      cleanContext({
        qualityHistory: [
          { provider: "agnes-flash", outcome: "fail" },
          { provider: "agnes-regular", outcome: "pass" },
          { provider: "seedance", outcome: "fail" },
        ],
      }),
    );
    expect(decision.outcome).toBe("skip");
  });

  it("history from unrelated providers does not trigger escalation", () => {
    const decision = evaluateWanPolicy(
      plainShot(),
      cleanContext({ qualityHistory: [{ provider: "wan", outcome: "fail" }] }),
    );
    expect(decision.outcome).toBe("skip");
  });
});

describe("evaluateWanPolicy — cost factor", () => {
  it("projects spend with the verified per-second rates", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 10 });
    expect(projectWanSpendUsd(shot, "1080P")?.totalUsd).toBeCloseTo(1.6, 4);
    expect(projectWanSpendUsd(shot, "720P")?.totalUsd).toBeCloseTo(0.8, 4);
    expect(projectWanSpendUsd(shot, "480P")?.totalUsd).toBeCloseTo(0.4, 4);
  });

  it("bills input reference-video seconds plus output duration (Kie billing rule)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 10, referenceVideoSeconds: 5 });
    expect(projectWanSpendUsd(shot, "1080P")).toEqual({ totalUsd: 2.4, billableSeconds: 15 });
  });

  it("projects prime-model spend with the verified prime rates", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 10 });
    expect(projectWanSpendUsd(shot, "1080P", true)?.totalUsd).toBeCloseTo(2.52, 4);
    expect(projectWanSpendUsd(shot, "480P", true)?.totalUsd).toBeCloseTo(0.612, 4);
  });

  it("returns null when the duration is model-chosen (-1)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: -1 });
    expect(projectWanSpendUsd(shot, "1080P")).toBeNull();
  });

  it("routes while cumulative + projected stays under the $25 ceiling", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // $4.80
    const decision = evaluateWanPolicy(shot, cleanContext({ spend: { cumulativeUsd: 20, approvedCeilingUsd: 25 } }));
    expect(decision.outcome).toBe("route");
  });

  it("holds for approval when cumulative + projected reaches the ceiling", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // $4.80
    const decision = evaluateWanPolicy(shot, cleanContext({ spend: { cumulativeUsd: 24.99, approvedCeilingUsd: 25 } }));
    expect(decision.outcome).toBe("hold");
    expect(decision.reasons[0]?.code).toBe("spend_ceiling");
  });

  it("holds when cumulative spend alone already reached the ceiling", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 5 }); // $0.80
    const decision = evaluateWanPolicy(shot, cleanContext({ spend: { cumulativeUsd: 25, approvedCeilingUsd: 25 } }));
    expect(decision.outcome).toBe("hold");
    expect(decision.reasons[0]?.code).toBe("spend_ceiling");
  });

  it("respects a lower user-configured ceiling too (configurable policy)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // $4.80
    const decision = evaluateWanPolicy(shot, cleanContext({ spend: { cumulativeUsd: 3, approvedCeilingUsd: 5 } }));
    expect(decision.outcome).toBe("hold");
  });

  it("route reasons include cost and quota lines", () => {
    const decision = evaluateWanPolicy(
      plainShot({ hero: true }),
      cleanContext({ spend: { cumulativeUsd: 1, approvedCeilingUsd: 25, remainingQuotaSeconds: 90 } }),
    );
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      const codes = decision.reasons.map((r) => r.code);
      expect(codes).toContain("cost");
      expect(codes).toContain("quota");
    }
  });

  it("quota line reports remaining included seconds when tracked", () => {
    const decision = evaluateWanPolicy(
      plainShot({ hero: true }),
      cleanContext({ spend: { cumulativeUsd: 0, approvedCeilingUsd: 25, remainingQuotaSeconds: 90 } }),
    );
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") {
      expect(decision.reasons.find((r) => r.code === "quota")?.detail).toContain("90");
    }
  });

  it("does not hold when included quota fully covers the billable seconds (spec §4: quota is never paid spend)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // 30s billable
    const decision = evaluateWanPolicy(
      shot,
      cleanContext({ spend: { cumulativeUsd: 25, approvedCeilingUsd: 25, remainingQuotaSeconds: 30 } }),
    );
    expect(decision.outcome).toBe("route");
  });

  it("still holds when quota covers only part of the billable seconds", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // 30s billable
    const decision = evaluateWanPolicy(
      shot,
      cleanContext({ spend: { cumulativeUsd: 24.99, approvedCeilingUsd: 25, remainingQuotaSeconds: 10 } }),
    );
    expect(decision.outcome).toBe("hold");
  });

  it("prime-model spend gate uses the prime rate (higher projection)", () => {
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 }); // 30s
    const fast = evaluateWanPolicy(
      shot,
      cleanContext({ preferFastModel: true, spend: { cumulativeUsd: 24.5, approvedCeilingUsd: 25 } }),
    );
    expect(fast.outcome).toBe("hold"); // 30 × 0.252 = $7.56 ≥ 25
  });
});

describe("evaluateWanPolicy — model selection", () => {
  it("uses the standard Wan 3.0 model by default", () => {
    const decision = evaluateWanPolicy(plainShot({ hero: true }), cleanContext());
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") expect(decision.model).toBe("wan/3-0-video");
  });

  it("swaps to the prime variant when preferFastModel is set", () => {
    const decision = evaluateWanPolicy(plainShot({ hero: true }), cleanContext({ preferFastModel: true }));
    expect(decision.outcome).toBe("route");
    if (decision.outcome === "route") expect(decision.model).toBe("wan/3-0-video-prime");
  });
});

describe("classifyWanShot", () => {
  it("collects multiple traits in table order", () => {
    const shot = plainShot({
      hero: true,
      action: true,
      complexity: "complex",
      targetDurationSeconds: 20,
      referenceImageUrls: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}.png`),
    });
    expect(classifyWanShot(shot)).toEqual(["hero", "action", "complex", "long", "reference_heavy"]);
  });

  it("returns empty for a plain shot", () => {
    expect(classifyWanShot(plainShot())).toEqual([]);
  });
});

describe("validateWanRouteInput — final pre-submit barrier", () => {
  it("accepts a valid request", () => {
    const input = { prompt: "Hero shot", duration: 12, resolution: "1080P" as const };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).not.toThrow();
  });

  it("rejects an over-20,000-char prompt BEFORE the provider call", () => {
    const input = { prompt: "x".repeat(20_001), duration: 5 };
    try {
      validateWanRouteInput(input, "wan/3-0-video");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WanRouteValidationError);
      const issues = (err as WanRouteValidationError).issues;
      expect(issues[0]?.field).toBe("prompt");
      expect(issues[0]?.limit).toBe(20_000);
      expect(issues[0]?.actual).toBe(20_001);
    }
  });

  it("rejects too many reference images BEFORE the provider call", () => {
    const input = {
      prompt: "refs",
      duration: 5,
      referenceImageUrls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}.png`),
    };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).toThrow(WanRouteValidationError);
  });

  it("rejects first/last-frame combined with multimodal references", () => {
    const input = {
      prompt: "mixed",
      duration: 5,
      firstFrameUrl: "https://a.example/first.png",
      referenceImageUrls: ["https://a.example/ref.png"],
    };
    try {
      validateWanRouteInput(input, "wan/3-0-video");
      expect.unreachable("should have thrown");
    } catch (err) {
      const issues = (err as WanRouteValidationError).issues;
      expect(issues.some((i) => i.field === "input")).toBe(true);
    }
  });

  it("rejects non-http URLs", () => {
    const input = { prompt: "x", duration: 5, referenceImageUrls: ["ftp://a.example/ref.png"] };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).toThrow(WanRouteValidationError);
  });

  it("rejects out-of-range duration and out-of-range seed, listing all issues at once", () => {
    const input = { prompt: "x", duration: 45, seed: -1 };
    try {
      validateWanRouteInput(input, "wan/3-0-video");
      expect.unreachable("should have thrown");
    } catch (err) {
      const issues = (err as WanRouteValidationError).issues;
      expect(issues.map((i) => i.field).sort()).toEqual(["duration", "seed"]);
    }
  });

  it("accepts a seed at the top of the verified range", () => {
    const input = { prompt: "x", duration: 5, seed: 2_147_483_647 };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).not.toThrow();
  });

  it("allows duration -1 (model decides)", () => {
    const input = { prompt: "x", duration: -1 };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).not.toThrow();
  });

  it("rejects an empty prompt with no media", () => {
    const input = { prompt: "", duration: 5 };
    expect(() => validateWanRouteInput(input, "wan/3-0-video")).toThrow(WanRouteValidationError);
  });

  it("rejects an unknown model id", () => {
    const input = { prompt: "x", duration: 5 };
    expect(() => validateWanRouteInput(input, "other/model" as WanRouteModelIdBad)).toThrow(
      WanRouteValidationError,
    );
  });

  it("rejects a fake id sharing the wan/ prefix", () => {
    const input = { prompt: "x", duration: 5 };
    expect(() => validateWanRouteInput(input, "wan/attacker-invented" as WanRouteModelIdBad)).toThrow(
      WanRouteValidationError,
    );
  });
});

type WanRouteModelIdBad = "wan/3-0-video" | "wan/3-0-video-prime";

describe("buildWanRouteBody — wire shape", () => {
  it("maps camelCase input to the verified snake_case wire fields", () => {
    const body = buildWanRouteBody(
      {
        prompt: "Hero",
        firstFrameUrl: "https://a.example/first.png",
        referenceAudioUrls: ["https://a.example/v.wav"],
        duration: 10,
        audio: false,
        seed: 42,
      },
      "wan/3-0-video",
      "1080P",
      "https://cb.example/hook",
    );
    expect(body.model).toBe("wan/3-0-video");
    expect(body.callBackUrl).toBe("https://cb.example/hook");
    expect(body.input).toMatchObject({
      prompt: "Hero",
      first_frame_url: "https://a.example/first.png",
      reference_audio_urls: ["https://a.example/v.wav"],
      resolution: "1080P",
      aspect_ratio: "adaptive",
      duration: 10,
      audio: false,
      seed: 42,
    });
  });

  it("omits undefined optionals instead of sending nulls", () => {
    const body = buildWanRouteBody({ prompt: "p", duration: 5 }, "wan/3-0-video", "1080P");
    expect(body.input).not.toHaveProperty("first_frame_url");
    expect(body.input).not.toHaveProperty("reference_image_urls");
    expect(body.input).not.toHaveProperty("seed");
  });
});

describe("routeShotToWan — end to end", () => {
  it("submits a hero shot and returns taskId, model, resolution, projected cost", async () => {
    const calls = { bodies: [] as unknown[] };
    const shot = plainShot({ hero: true });
    const result = await routeShotToWan(stubClient("wan-task-77", calls), shot, cleanContext());
    expect(result.status).toBe("submitted");
    if (result.status === "submitted") {
      expect(result.taskId).toBe("wan-task-77");
      expect(result.model).toBe("wan/3-0-video");
      expect(result.resolution).toBe("1080P");
      expect(result.projectedCostUsd).toBeCloseTo(8 * 0.16, 4);
      expect(result.input.prompt).toBe(shot.compiledPrompt);
      expect(result.reasons.map((r) => r.code)).toContain("policy_row_hero");
    }
    expect(calls.bodies[0]).toMatchObject({
      model: "wan/3-0-video",
      input: { resolution: "1080P", duration: 8 },
    });
  });

  it("returns skipped (no provider call) for a plain shot", async () => {
    const calls = { bodies: [] as unknown[] };
    const result = await routeShotToWan(stubClient("x", calls), plainShot(), cleanContext());
    expect(result.status).toBe("skipped");
    expect(calls.bodies).toHaveLength(0);
  });

  it("returns held-for-approval (no provider call) at the spend ceiling", async () => {
    const calls = { bodies: [] as unknown[] };
    const shot = plainShot({ hero: true, targetDurationSeconds: 30 });
    const context = cleanContext({ spend: { cumulativeUsd: 24.99, approvedCeilingUsd: 25 } });
    const result = await routeShotToWan(stubClient("x", calls), shot, context);
    expect(result.status).toBe("held-for-approval");
    expect(calls.bodies).toHaveLength(0);
  });

  it("throws WanRouteValidationError and never calls the provider on invalid wire input", async () => {
    const calls = { bodies: [] as unknown[] };
    const shot = plainShot({
      hero: true,
      referenceImageUrls: ["not-a-url"],
    });
    await expect(routeShotToWan(stubClient("x", calls), shot, cleanContext())).rejects.toThrow(
      WanRouteValidationError,
    );
    expect(calls.bodies).toHaveLength(0);
  });

  it("over-limit reference images skip at the POLICY stage (before any wire validation)", async () => {
    const calls = { bodies: [] as unknown[] };
    const shot = plainShot({
      hero: true,
      referenceImageUrls: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}.png`),
    });
    const result = await routeShotToWan(stubClient("x", calls), shot, cleanContext());
    expect(result.status).toBe("skipped");
    expect(result.reasons[0]?.code).toBe("too_many_reference_images");
    expect(calls.bodies).toHaveLength(0);
  });

  it("wraps client failures in WanRouteSubmitError", async () => {
    const failingClient = {
      async createTask() {
        throw new Error("kie 500");
      },
    };
    await expect(routeShotToWan(failingClient, plainShot({ hero: true }), cleanContext())).rejects.toThrow(
      WanRouteSubmitError,
    );
  });

  it("forwards callBackUrl to the client", async () => {
    const calls = { bodies: [] as unknown[] };
    await routeShotToWan(stubClient("y", calls), plainShot({ hero: true }), cleanContext(), {
      callBackUrl: "https://cb.example/hook",
    });
    expect(calls.bodies[0]).toMatchObject({ callBackUrl: "https://cb.example/hook" });
  });

  it("rejects a non-http callBackUrl before any provider call", async () => {
    const calls = { bodies: [] as unknown[] };
    await expect(
      routeShotToWan(stubClient("z", calls), plainShot({ hero: true }), cleanContext(), {
        callBackUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(WanRouteValidationError);
    expect(calls.bodies).toHaveLength(0);
  });
});

describe("WanRouteResult type completeness (compile-level)", () => {
  it("discriminates all three result statuses", () => {
    const submitted: WanRouteResult = {
      status: "submitted",
      shotId: "s",
      taskId: "t",
      model: "wan/3-0-video",
      resolution: "1080P",
      projectedCostUsd: 0.8,
      reasons: [{ code: "x", detail: "y" }],
      input: { prompt: "p" },
    };
    const skipped: WanRouteResult = { status: "skipped", shotId: "s", reasons: [] };
    const held: WanRouteResult = { status: "held-for-approval", shotId: "s", reasons: [] };
    expect([submitted.status, skipped.status, held.status]).toEqual([
      "submitted",
      "skipped",
      "held-for-approval",
    ]);
  });

  it("verified limits match the capability registry row (KIE-005)", () => {
    expect(WAN_ROUTE_LIMITS.hardMaxPromptCharacters).toBe(20_000);
    expect(WAN_ROUTE_LIMITS.maxReferenceImages).toBe(10);
    expect(WAN_ROUTE_LIMITS.maxReferenceVideos).toBe(5);
    expect(WAN_ROUTE_LIMITS.maxReferenceAudio).toBe(5);
    expect(WAN_ROUTE_LIMITS.maxDurationSeconds).toBe(30);
    expect(WAN_ROUTE_LIMITS.minDurationSeconds).toBe(2);
    expect(WAN_ROUTE_LIMITS.usdPerSecondByResolution["1080P"]).toBe(0.16);
    expect(WAN_ROUTE_LIMITS.usdPerSecondByResolutionPrime["1080P"]).toBe(0.252);
  });
});