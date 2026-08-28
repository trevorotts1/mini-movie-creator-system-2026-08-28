/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { KieClient, type KieRecordInfoData } from "../client/index.js";
import {
  KieTaskRunner,
  mapToPipelineState,
  type KieCreateTaskRequest,
  type KieTaskInfo,
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

const API_KEY = "test-key-abc123def456ghi789";
const REQUEST: KieCreateTaskRequest = {
  model: "bytedance/seedance-2-mini",
  input: { prompt: "a lighthouse in fog", aspect_ratio: "9:16", resolution: "720p" },
};

/** Full-stack runner: real KieClient over a scripted fetch + memory store. */
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

/** recordInfo body for a success with documented `resultJson` string shape. */
function recordInfo(data: KieRecordInfoData): Response {
  return jsonResponse(200, envelope(data));
}

const SUCCESS_RESULT_JSON = JSON.stringify({
  resultUrls: ["https://cdn.kie.ai/tmp/shot-42.mp4"],
});

describe("KIE-010 contract: submit through the real client (KIE-001 → KIE-002)", () => {
  it("submit path: POST createTask carries model+input; taskId persisted before any poll", async () => {
    const { runner, store, calls } = stack([
      jsonResponse(200, envelope({ taskId: "task_bytedance_001" })),
      recordInfo({ taskId: "task_bytedance_001", state: "generating" }),
    ]);

    const submitted = await runner.ensureSubmitted("shot-42:keyframe-a", REQUEST);

    expect(submitted.state).toBe("SUBMITTED");
    expect(submitted.providerTaskId).toBe("task_bytedance_001");
    expect(submitted.model).toBe(REQUEST.model);

    // Wire contract: exactly one POST to the documented createTask path.
    const [createCall] = calls;
    expect(createCall!.url).toBe("https://mock.kie.test/api/v1/jobs/createTask");
    expect(createCall!.init.method).toBe("POST");
    expect(JSON.parse(createCall!.init.body as string)).toEqual({
      model: REQUEST.model,
      input: REQUEST.input,
    });

    // Idempotency contract: SUBMITTING then SUBMITTED persisted BEFORE any poll.
    expect(store.saveOrder).toHaveLength(2);
    expect(store.saveOrder[0]!.state).toBe("SUBMITTING");
    expect(store.saveOrder[1]!.state).toBe("SUBMITTED");
    expect(store.saveOrder[1]!.providerTaskId).toBe("task_bytedance_001");
    expect(calls).toHaveLength(1); // no recordInfo yet
  });

  it("poll path: recordInfo GET with taskId query; envelope unwrapped; resultJson parsed", async () => {
    const { runner, store, calls } = stack([
      jsonResponse(200, envelope({ taskId: "task_002" })),
      recordInfo({
        taskId: "task_002",
        state: "success",
        resultJson: SUCCESS_RESULT_JSON,
      }),
    ]);

    await runner.ensureSubmitted("shot-7:hero", REQUEST);
    const final = await runner.pollOnce("shot-7:hero");

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual(["https://cdn.kie.ai/tmp/shot-42.mp4"]);
    expect(final.pollCount).toBe(1);

    const [pollCall] = calls.slice(1);
    expect(pollCall!.url).toBe(
      "https://mock.kie.test/api/v1/jobs/recordInfo?taskId=task_002",
    );
    expect(pollCall!.init.method).toBe("GET");
    expect(store.rows.get("shot-7:hero")!.state).toBe("GENERATED_TEMPORARY");
  });

  it("full happy path runToTerminal: waiting → generating → success over the wire", async () => {
    const { runner, store, calls } = stack([
      jsonResponse(200, envelope({ taskId: "task_003" })),
      recordInfo({ taskId: "task_003", state: "waiting" }),
      recordInfo({ taskId: "task_003", state: "generating" }),
      recordInfo({
        taskId: "task_003",
        state: "success",
        resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie.ai/tmp/wan-a.mp4"] }),
      }),
    ]);

    const final = await runner.runToTerminal("shot-9:wan", REQUEST, { intervalMs: 0 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual(["https://cdn.kie.ai/tmp/wan-a.mp4"]);
    expect(final.pollCount).toBe(3);
    // 1 createTask + 3 recordInfo on the wire.
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toContain("/api/v1/jobs/createTask");
    for (const poll of calls.slice(1)) {
      expect(poll.url).toContain("/api/v1/jobs/recordInfo?taskId=task_003");
      expect(poll.init.headers && (poll.init.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${API_KEY}`,
      );
    }
    expect(store.saveOrder.at(-1)!.state).toBe("GENERATED_TEMPORARY");
  });

  it("auth header is Bearer from config on every wire call", async () => {
    const { runner, calls } = stack([
      jsonResponse(200, envelope({ taskId: "task_004" })),
      recordInfo({ taskId: "task_004", state: "success", resultJson: SUCCESS_RESULT_JSON }),
    ]);
    await runner.runToTerminal("shot-1:a", REQUEST, { intervalMs: 0 });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");
    }
  });
});