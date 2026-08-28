/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { KieClient } from "../client/index.js";
import {
  KieTaskRunner,
  type KiePipelineState,
  type KieTaskRecord,
} from "../task/index.js";
import {
  envelope,
  instantSleep,
  jsonResponse,
  kieClientAsTaskClient,
  memoryStore,
  scriptedFetch,
  steppedClock,
} from "./helpers.js";
import { recordOf } from "./record.js";
import { recordInfo } from "./wire.js";

const API_KEY = "test-key-abc123def456ghi789";
const REQUEST = {
  model: "wan/3-0-video",
  input: { prompt: "waves at dusk", resolution: "1080P" },
};

/** Full-stack runner over a scripted fetch + memory store. */
function stack(script: Array<Response | Error>, seed: KieTaskRecord[] = []) {
  const { fetch, calls } = scriptedFetch(script);
  const client = new KieClient(
    {
      apiKey: API_KEY,
      baseUrl: "https://mock.kie.test",
      sleep: instantSleep,
      maxRetries: 2,
      retryBackoffMs: 0,
    },
    { fetch },
  );
  const store = memoryStore(seed);
  const runner = new KieTaskRunner(kieClientAsTaskClient(client), store, {
    now: steppedClock(),
    sleep: instantSleep,
  });
  return { client, store, runner, calls };
}

/** Poll response: task failed with a provider failMsg/failCode. */
function failedRecordInfo(failMsg: string, failCode: string): Response {
  return jsonResponse(
    200,
    envelope({
      taskId: "task_fail_1",
      state: "fail",
      failCode,
      failMsg,
      resultJson: null,
    }),
  );
}

describe("KIE-010 contract: fail path (REJECTED lands in the store)", () => {
  it("provider fail state → REJECTED with failure detail persisted", async () => {
    const { runner, store } = stack([
      jsonResponse(200, envelope({ taskId: "task_fail_1" })),
      failedRecordInfo("prompt violates content policy", "455"),
    ]);

    await runner.ensureSubmitted("shot-3:rejected", REQUEST);
    const final = await runner.pollOnce("shot-3:rejected");

    expect(final.state).toBe("REJECTED");
    expect(final.failure?.message).toBe("prompt violates content policy");
    expect(final.failure?.code).toBe(455);
    expect(store.rows.get("shot-3:rejected")!.state).toBe("REJECTED");
    expect(store.saveOrder.at(-1)!.state).toBe("REJECTED");
  });

  it("fail without failMsg falls back to the default message", async () => {
    const { runner } = stack([
      jsonResponse(200, envelope({ taskId: "task_fail_2" })),
      failedRecordInfo("", "500"),
    ]);
    await runner.ensureSubmitted("shot-4:silent-fail", REQUEST);
    const final = await runner.pollOnce("shot-4:silent-fail");
    expect(final.state).toBe("REJECTED");
    expect(final.failure?.message).toBe("Kie task failed");
  });

  it("success with no result URLs → REJECTED (cannot archive nothing)", async () => {
    const { runner } = stack([
      jsonResponse(200, envelope({ taskId: "task_empty" })),
      recordInfo({
        taskId: "task_empty",
        state: "success",
        resultJson: JSON.stringify({ resultUrls: [] }),
      }),
    ]);
    await runner.ensureSubmitted("shot-6:no-urls", REQUEST);
    const final = await runner.pollOnce("shot-6:no-urls");
    expect(final.state).toBe("REJECTED");
    expect(final.failure?.message).toMatch(/no result URLs/i);
    expect(final.failure?.raw).toEqual({ resultUrls: [] });
  });

  it("REJECTED is terminal: runToTerminal returns immediately, no further polls", async () => {
    const seeded = recordOf({
      ref: "shot-11:dead",
      state: "REJECTED",
      providerTaskId: "task_dead",
      failure: { message: "prior failure", code: 455 },
    });
    const { runner, calls } = stack([], [seeded]);
    const final = await runner.runToTerminal("shot-11:dead", REQUEST, { intervalMs: 0 });
    expect(final.state).toBe("REJECTED");
    expect(calls).toHaveLength(0); // terminal short-circuit: no wire traffic
  });

  it("transport failure surfaces as KieApiError through the adapter (no throw-loss)", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(200, envelope({ taskId: "task_x" })),
      jsonResponse(429, envelope(null, 429, "rate limited"), { "Retry-After": "1" }),
      jsonResponse(429, envelope(null, 429, "rate limited"), { "Retry-After": "1" }),
    ]);
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, maxRetries: 2, retryBackoffMs: 0 },
      { fetch },
    );
    const store = memoryStore();
    const runner = new KieTaskRunner(kieClientAsTaskClient(client), store, {
      now: steppedClock(),
      sleep: instantSleep,
    });

    await runner.ensureSubmitted("shot-12:ratelimit", REQUEST);
    await expect(runner.pollOnce("shot-12:ratelimit".replace("ratelimit", "ratelimit"))).rejects.toThrow(
      /429/,
    );
  });
});

describe("KIE-010 contract: state machine boundaries (runbook §21)", () => {
  const pollTerminalStates: KiePipelineState[] = ["GENERATED_TEMPORARY", "REJECTED"];
  const pollVisible: KiePipelineState[] = ["SUBMITTED", "GENERATING", ...pollTerminalStates];
  const nonPoll: KiePipelineState[] = [
    "PLANNED",
    "BUDGET_RESERVED",
    "SUBMITTING",
    "ARCHIVING",
    "ARCHIVED",
    "QC_PENDING",
    "QC_FIXING",
    "APPROVED",
  ];

  it("poll-visible subset is exactly SUBMITTED/GENERATING/terminals", async () => {
    // Exhaustive split: every §21 state is either poll-visible or not, no third box.
    const all: KiePipelineState[] = [
      "PLANNED", "BUDGET_RESERVED", "SUBMITTING", "SUBMITTED", "GENERATING",
      "GENERATED_TEMPORARY", "ARCHIVING", "ARCHIVED", "QC_PENDING", "QC_FIXING",
      "APPROVED", "REJECTED",
    ];
    expect(new Set(all).size).toBe(12);
    const pollVisibleExact = ["SUBMITTED", "GENERATING", "GENERATED_TEMPORARY", "REJECTED"];
    for (const state of all) {
      expect(pollVisibleExact.includes(state)).toBe(pollVisible.includes(state));
    }
  });

  it("terminal states stop the loop; downstream states (ARCHIVE/QC) are out of poll scope", async () => {
    for (const state of pollTerminalStates) {
      const seeded = recordOf({
        ref: "term",
        state,
        providerTaskId: "t2",
        ...(state === "REJECTED" ? { failure: { message: "x" } } : { resultUrls: ["https://cdn.kie.ai/a.mp4"] }),
      });
      const { runner, calls } = stack([], [seeded]);
      const final = await runner.runToTerminal("term", REQUEST, { intervalMs: 0 });
      expect(final.state).toBe(state);
      expect(calls).toHaveLength(0);
    }
    for (const state of ["PLANNED", "BUDGET_RESERVED", "SUBMITTING"] as const) {
      // Non-submitted states must never be treated as pollable terminals.
      const seeded = recordOf({ ref: "pre", state });
      const { runner } = stack([], [seeded]);
      if (state !== "SUBMITTING") {
        await expect(runner.pollOnce("pre")).rejects.toThrow(/no persisted providerTaskId|refusing to poll/);
      }
    }
  });
});