/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { KieClient } from "../client/index.js";
import {
  KieTaskRunner,
  KieTaskTimeoutError,
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
  model: "bytedance/seedance-2-mini",
  input: { prompt: "a lighthouse in fog", aspect_ratio: "9:16" },
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

describe("KIE-010 contract: resume (persist-before-poll, never resubmit)", () => {
  it("resume at SUBMITTED: existing providerTaskId polled, createTask never called again", async () => {
    // Simulate crash after submit: record persisted in SUBMITTED with the task id.
    const seeded = recordOf({
      ref: "shot-42:keyframe-a",
      state: "SUBMITTED",
      providerTaskId: "task_bytedance_001",
      model: REQUEST.model,
      submitRequest: REQUEST,
    });
    const { runner, store, calls } = stack(
      [
        recordInfo({ taskId: "task_bytedance_001", state: "generating" }),
        recordInfo({
          taskId: "task_bytedance_001",
          state: "success",
          resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie.ai/tmp/resumed.mp4"] }),
        }),
      ],
      [seeded],
    );

    const resumed = await runner.ensureSubmitted("shot-42:keyframe-a", REQUEST);

    // Resume contract: state normalized to SUBMITTED, NO submit on the wire.
    expect(resumed.state).toBe("SUBMITTED");
    expect(resumed.providerTaskId).toBe("task_bytedance_001");
    expect(calls).toHaveLength(0);
    expect(store.rows.get("shot-42:keyframe-a")!.state).toBe("SUBMITTED");

    // Polling continues the EXISTING provider task.
    const final = await runner.runToTerminal("shot-42:keyframe-a", REQUEST, { intervalMs: 0 });
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual(["https://cdn.kie.ai/tmp/resumed.mp4"]);
    expect(calls.every((c) => c.url.includes("recordInfo"))).toBe(true);
    expect(calls.some((c) => c.url.includes("createTask"))).toBe(false);
  });

  it("resume at GENERATING: same promise — poll existing id only", async () => {
    const seeded = recordOf({
      ref: "shot-5:b",
      state: "GENERATING",
      providerTaskId: "task_gen_009",
    });
    const { runner, calls } = stack(
      [
        recordInfo({ taskId: "task_gen_009", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie.ai/x.mp4"] }) }),
      ],
      [seeded],
    );

    const final = await runner.runToTerminal("shot-5:b", REQUEST, { intervalMs: 0 });
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("recordInfo?taskId=task_gen_009");
  });

  it("poll refuses without persisted providerTaskId (would resubmit = double spend)", async () => {
    const { runner } = stack([], [
      recordOf({ ref: "shot-2:c", state: "PLANNED" }),
    ]);
    await expect(runner.pollOnce("shot-2:c")).rejects.toThrow(/refusing to poll/);
  });

  it("runToTerminal throws KieTaskTimeoutError on deadline and last state is in the store", async () => {
    const seeded = recordOf({
      ref: "shot-8:d",
      state: "SUBMITTED",
      providerTaskId: "task_slow_1",
    });
    const { runner, store } = stack(
      [recordInfo({ taskId: "task_slow_1", state: "generating" })],
      [seeded],
    );

    await expect(
      runner.runToTerminal("shot-8:d", REQUEST, { intervalMs: 0, timeoutMs: -1 }),
    ).rejects.toThrow(KieTaskTimeoutError);
    // Deadline abort must NOT clobber the in-flight record: still SUBMITTED/GENERATING with the id.
    const last = store.rows.get("shot-8:d")!;
    expect(last.providerTaskId).toBe("task_slow_1");
    expect(["SUBMITTED", "GENERATING"]).toContain(last.state);
  });

  it("runToTerminal timeout error carries ref, providerTaskId, lastState", async () => {
    const seeded = recordOf({
      ref: "shot-8:e",
      state: "GENERATING",
      providerTaskId: "task_slow_2",
    });
    const { runner } = stack(
      [recordInfo({ taskId: "task_slow_2", state: "queuing" })],
      [seeded],
    );
    try {
      await runner.runToTerminal("shot-8:e", REQUEST, { intervalMs: 0, timeoutMs: -1 });
      expect.unreachable("expected KieTaskTimeoutError");
    } catch (err) {
      expect(err).toBeInstanceOf(KieTaskTimeoutError);
      const timeout = err as KieTaskTimeoutError;
      expect(timeout.ref).toBe("shot-8:e");
      expect(timeout.providerTaskId).toBe("task_slow_2");
      expect(timeout.lastState).toBe("GENERATING");
    }
  });
});