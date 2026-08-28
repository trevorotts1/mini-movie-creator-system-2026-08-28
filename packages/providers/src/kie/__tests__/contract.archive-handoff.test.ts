/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { KieClient, type KieRecordInfoData } from "../client/index.js";
import {
  KieTaskRunner,
  mapToPipelineState,
  type KieCreateTaskRequest,
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
import { recordInfo } from "./wire.js";

const API_KEY = "test-key-abc123def456ghi789";
const REQUEST: KieCreateTaskRequest = {
  model: "bytedance/seedance-2-mini",
  input: { prompt: "neon rain on asphalt", aspect_ratio: "9:16" },
};

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

describe("KIE-010 contract: archive handoff (GENERATED_TEMPORARY is the handoff record)", () => {
  it("terminal record carries everything the archival layer needs: urls + taskId + model + submitRequest", async () => {
    const { runner, store } = stack([
      jsonResponse(200, envelope({ taskId: "task_arch_1" })),
      recordInfo({
        taskId: "task_arch_1",
        state: "success",
        resultJson: JSON.stringify({
          resultUrls: ["https://cdn.kie.ai/tmp/a.mp4", "https://cdn.kie.ai/tmp/b.mp4"],
        }),
      }),
    ]);

    await runner.ensureSubmitted("ep1:shot2", REQUEST);
    const final = await runner.pollOnce("ep1:shot2");

    // Archival handoff contract (KIE-008 downstream reads exactly these):
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual([
      "https://cdn.kie.ai/tmp/a.mp4",
      "https://cdn.kie.ai/tmp/b.mp4",
    ]);
    expect(final.providerTaskId).toBe("task_arch_1");
    expect(final.model).toBe(REQUEST.model);
    expect(final.submitRequest).toEqual(REQUEST);
    // Timestamps present for retention math (result URLs expire 24h per docs).
    expect(final.createdAt).toBeTruthy();
    expect(final.updatedAt).toBeTruthy();

    // And the STORE holds the same record — the durable handoff surface.
    const stored = store.rows.get("ep1:shot2")!;
    expect(stored.state).toBe("GENERATED_TEMPORARY");
    expect(stored.resultUrls).toEqual(final.resultUrls);
 expect(stored.providerTaskId).toBe("task_arch_1");
  });

  it("seeded GENERATED_TEMPORARY restart → terminal short-circuit, no regeneration (runbook §21)", async () => {
    const seeded: KieTaskRecord = {
      ref: "ep1:shot3",
      state: "GENERATED_TEMPORARY",
      providerTaskId: "task_before_crash",
      model: REQUEST.model,
      resultUrls: ["https://cdn.kie.ai/tmp/pre-crash.mp4"],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      pollCount: 2,
    };
    const { runner, calls, store } = stack([], [seeded]);

    // Restart at GENERATED_TEMPORARY → archive known provider URL immediately;
    // runner must not touch the wire.
    const final = await runner.runToTerminal("ep1:shot3", REQUEST, { intervalMs: 0 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual(["https://cdn.kie.ai/tmp/pre-crash.mp4"]);
    expect(final.providerTaskId).toBe("task_before_crash");
    expect(calls).toHaveLength(0);
    expect(store.saveOrder).toHaveLength(0); // nothing rewritten, nothing resubmitted
  });

  it("multiple result URL shapes (resultJson string: object, bare array, nested) all map", async () => {
    const shapes: Array<{ data: KieRecordInfoData; expected: string[] }> = [
      {
        data: { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://x/y.mp4"] }) },
        expected: ["https://x/y.mp4"],
      },
      {
        data: { state: "success", resultJson: JSON.stringify(["https://x/a.mp4", "https://x/b.mp4"]) },
        expected: ["https://x/a.mp4", "https://x/b.mp4"],
      },
      {
        // resultJson-as-object holding resultUrls (parser descends one level).
        data: { state: "success", resultJson: JSON.stringify({ resultJson: { resultUrls: ["https://x/c.mp4"] } }) },
        expected: ["https://x/c.mp4"],
      },
      // Seedance 2 return_last_frame shape: resultUrls empty → firstFrame/lastFrame are
      // NOT video URLs; documented as empty arrays → success-no-urls → REJECTED.
      {
        data: {
          state: "success",
          resultJson: JSON.stringify({ resultUrls: [], firstFrameUrl: [], lastFrameUrl: [] }),
        },
        expected: [],
      },
    ];

    for (const [i, shape] of shapes.entries()) {
      const ref = `shape:${i}`;
      const { runner } = stack([
        jsonResponse(200, envelope({ taskId: `task_shape_${i}` })),
        recordInfo({ taskId: `task_shape_${i}`, ...shape.data } as KieRecordInfoData),
      ]);
      await runner.ensureSubmitted(ref, REQUEST);
      const final = await runner.pollOnce(ref);
      if (shape.expected.length > 0) {
        expect(final.state).toBe("GENERATED_TEMPORARY");
        expect(final.resultUrls).toEqual(shape.expected);
      } else {
        expect(final.state).toBe("REJECTED");
      }
    }
  });
});

describe("KIE-010 contract: client failure taxonomy across the seam", () => {
  it("429 retries within budget then succeeds (bounded retry contract)", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(429, envelope(null, 429, "too many requests")),
      jsonResponse(200, envelope({ taskId: "task_rl_1" })),
    ]);
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, maxRetries: 3, retryBackoffMs: 0 },
      { fetch },
    );
    const result = await client.createTask(REQUEST);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("401 is terminal — auth failures never retried, never leak the key", async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(401, envelope(null, 401, "You do not have access permissions")),
    ]);
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, maxRetries: 3, retryBackoffMs: 0 },
      { fetch },
    );
    const result = await client.createTask({ model: REQUEST.model, input: REQUEST.input });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http-error");
      expect(result.error.status).toBe(401);
      expect(result.error.message).not.toContain(API_KEY);
    }
    expect(calls).toHaveLength(1);
  });

  it("network error retried to exhaustion returns KieFailure, not a throw", async () => {
    const { fetch, calls } = scriptedFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, maxRetries: 3, retryBackoffMs: 0 },
      { fetch },
    );
    const result = await client.recordInfo("task_net");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
    expect(calls).toHaveLength(3);
  });

  it("adapter maps client KieApiError into a rejected promise (no silent success)", async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(200, envelope(null, 402, "insufficient credits")),
    ]);
    const client = new KieClient(
      { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep, maxRetries: 1 },
      { fetch },
    );
    const taskClient = kieClientAsTaskClient(client);
    await expect(taskClient.createTask(REQUEST)).rejects.toThrow(/402/);
  });
});