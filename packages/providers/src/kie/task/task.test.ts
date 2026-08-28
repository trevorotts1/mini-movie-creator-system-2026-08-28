/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  isPollTerminal,
  KieTaskRunner,
  KieTaskTimeoutError,
  mapToPipelineState,
  normalizeKieStatus,
  parseResultUrls,
  type KieCreateTaskRequest,
  type KieTaskClient,
  type KieTaskInfo,
  type KieTaskRecord,
  type KieTaskStore,
} from "./index.js";

/** In-memory KieTaskStore with save-order trace. */
function memoryStore(seed: KieTaskRecord[] = []): KieTaskStore & {
  rows: Map<string, KieTaskRecord>;
  saveOrder: KieTaskRecord[];
} {
  const rows = new Map<string, KieTaskRecord>();
  const saveOrder: KieTaskRecord[] = [];
  for (const record of seed) rows.set(record.ref, { ...record });
  return {
    rows,
    saveOrder,
    async load(ref) {
      return rows.get(ref);
    },
    async save(record) {
      saveOrder.push({ ...record });
      rows.set(record.ref, { ...record });
    },
  };
}

/** Scripted client: createTask returns taskId; getTask replays scripted infos. */
function scriptedClient(
  taskId: string,
  infos: KieTaskInfo[],
  calls: { createCount: number; pollRefs: string[] } = { createCount: 0, pollRefs: [] },
): KieTaskClient {
  let pollIndex = 0;
  return {
    async createTask() {
      calls.createCount += 1;
      return { taskId };
    },
    async getTask(id) {
      calls.pollRefs.push(id);
      const info = infos[Math.min(pollIndex, infos.length - 1)];
      pollIndex += 1;
      if (!info) throw new Error(`no scripted info for ${id}`);
      return info;
    },
  };
}

const REQUEST: KieCreateTaskRequest = {
  model: "bytedance/seedance-v1-pro-text-to-video",
  input: { prompt: "test prompt", aspect_ratio: "9:16" },
};

function clock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
}

const instantSleep = async () => undefined;

describe("normalizeKieStatus (KIE-002 state mapping)", () => {
  it("maps documented provider strings", () => {
    expect(normalizeKieStatus("waiting")).toBe("waiting");
    expect(normalizeKieStatus("queuing")).toBe("waiting");
    expect(normalizeKieStatus("generating")).toBe("running");
    expect(normalizeKieStatus("success")).toBe("success");
    expect(normalizeKieStatus("fail")).toBe("failed");
  });

  it("never maps an unknown string to a terminal state", () => {
    expect(normalizeKieStatus("weird-new-provider-state")).toBe("waiting");
    expect(normalizeKieStatus("")).toBe("waiting");
  });
});

describe("mapToPipelineState (KIE-002 → runbook §21 machine)", () => {
  it("success with result URLs → GENERATED_TEMPORARY with urls", () => {
    const mapped = mapToPipelineState({
      taskId: "t1",
      state: "success",
      result: { resultUrls: ["https://files.kie.ai/temp/clip.mp4"] },
    });
    expect(mapped.state).toBe("GENERATED_TEMPORARY");
    expect(mapped.resultUrls).toEqual(["https://files.kie.ai/temp/clip.mp4"]);
    expect(isPollTerminal(mapped.state)).toBe(true);
  });

  it("success without URLs → REJECTED (nothing to archive)", () => {
    const mapped = mapToPipelineState({ taskId: "t2", state: "success", result: {} });
    expect(mapped.state).toBe("REJECTED");
    expect(mapped.failure?.message).toContain("no result URLs");
  });

  it("failed → REJECTED with failure detail", () => {
    const mapped = mapToPipelineState({
      taskId: "t3",
      state: "fail",
      failMsg: "content policy",
      failCode: 403,
      result: null,
    });
    expect(mapped.state).toBe("REJECTED");
    expect(mapped.failure?.message).toBe("content policy");
    expect(mapped.failure?.code).toBe(403);
    expect(isPollTerminal(mapped.state)).toBe(true);
  });

  it("waiting/running/unknown → GENERATING (not terminal)", () => {
    for (const raw of ["waiting", "queuing", "generating", "unknown-value"]) {
      const mapped = mapToPipelineState({ taskId: "t4", state: raw });
      expect(mapped.state).toBe("GENERATING");
      expect(isPollTerminal(mapped.state)).toBe(false);
    }
  });
});

describe("parseResultUrls", () => {
  it("accepts resultUrls array, bare string, and nested resultJson", () => {
    expect(parseResultUrls({ resultUrls: ["https://a/x.mp4"] })).toEqual(["https://a/x.mp4"]);
    expect(parseResultUrls("https://b/y.mp4")).toEqual(["https://b/y.mp4"]);
    expect(parseResultUrls({ resultJson: { resultUrls: ["https://c/z.mp4"] } })).toEqual(["https://c/z.mp4"]);
  });

  it("filters non-URL junk and empty payloads", () => {
    expect(parseResultUrls({ resultUrls: ["not-a-url", 42] })).toEqual([]);
    expect(parseResultUrls(undefined)).toEqual([]);
    expect(parseResultUrls(null)).toEqual([]);
  });
});

describe("KieTaskRunner — persist task ID before polling", () => {
  it("writes SUBMITTING then SUBMITTED with providerTaskId before first getTask", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient("prov-task-1", [{ taskId: "prov-task-1", state: "waiting" }], calls);
    const store = memoryStore();
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    await runner.ensureSubmitted("shot-1", REQUEST);

    // First poll happens only in pollOnce; ensureSubmitted must not poll at all.
    expect(calls.createCount).toBe(1);
    expect(calls.pollRefs).toEqual([]);
    expect(store.saveOrder.map((r) => r.state)).toEqual(["SUBMITTING", "SUBMITTED"]);
    expect(store.saveOrder[0]?.providerTaskId).toBeUndefined();
    expect(store.saveOrder[1]?.providerTaskId).toBe("prov-task-1");
  });

  it("refuses to poll a record without a persisted providerTaskId", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient("prov-task-x", [{ taskId: "prov-task-x", state: "success" }], calls);
    const store = memoryStore();
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    await expect(runner.pollOnce("never-submitted")).rejects.toThrow(/no persisted record/);
    // Nothing was submitted or polled.
    expect(calls.createCount).toBe(0);
    expect(calls.pollRefs).toEqual([]);
  });
});

describe("KieTaskRunner — resume at SUBMITTED polls existing task (no resubmit)", () => {
  it("SUBMITTED record with providerTaskId is resumed via getTask; createTask never called", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient(
      "prov-task-7",
      [{ taskId: "prov-task-7", state: "success", result: { resultUrls: ["https://files.kie.ai/v.mp4"] } }],
      calls,
    );
    const seed: KieTaskRecord = {
      ref: "shot-42",
      state: "SUBMITTED",
      providerTaskId: "prov-task-7",
      model: REQUEST.model,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const store = memoryStore([seed]);
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-42", REQUEST, { intervalMs: 1, timeoutMs: 1000 });

    expect(calls.createCount).toBe(0); // no resubmit, no double spend
    expect(calls.pollRefs).toEqual(["prov-task-7"]); // polls the EXISTING task
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrls).toEqual(["https://files.kie.ai/v.mp4"]);
    expect(store.rows.get("shot-42")?.state).toBe("GENERATED_TEMPORARY");
  });

  it("restart mid-SUBMITTING (no providerTaskId yet) resubmits exactly once", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient(
      "prov-task-8",
      [{ taskId: "prov-task-8", state: "success", result: { resultUrls: ["https://f/w.mp4"] } }],
      calls,
    );
    const seed: KieTaskRecord = {
      ref: "shot-9",
      state: "SUBMITTING",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const store = memoryStore([seed]);
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-9", REQUEST, { intervalMs: 1, timeoutMs: 1000 });

    // No provider ID was persisted → resubmission is the only safe path, done once.
    expect(calls.createCount).toBe(1);
    expect(calls.pollRefs).toEqual(["prov-task-8"]);
    expect(final.state).toBe("GENERATED_TEMPORARY");
  });
});

describe("KieTaskRunner — runToTerminal polling loop", () => {
  it("polls until GENERATED_TEMPORARY, recording pollCount, and sleeps between polls", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient(
      "prov-task-10",
      [
        { taskId: "prov-task-10", state: "waiting" },
        { taskId: "prov-task-10", state: "generating" },
        {
          taskId: "prov-task-10",
          state: "success",
          result: { resultUrls: ["https://files.kie.ai/final.mp4"] },
        },
      ],
      calls,
    );
    const store = memoryStore();
    const sleeps: number[] = [];
    const runner = new KieTaskRunner(client, store, {
      now: clock(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const final = await runner.runToTerminal("shot-10", REQUEST, { intervalMs: 250, timeoutMs: 10_000 });

    expect(calls.pollRefs).toEqual(["prov-task-10", "prov-task-10", "prov-task-10"]);
    // Sleep before every poll, including the one that observes success.
    expect(sleeps).toEqual([250, 250, 250]);
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.pollCount).toBe(3);
  });

  it("REJECTED failure detail lands in the store", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient(
      "prov-task-11",
      [{ taskId: "prov-task-11", state: "fail", failMsg: "rate limited", failCode: 429 }],
      calls,
    );
    const store = memoryStore();
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-11", REQUEST, { intervalMs: 1, timeoutMs: 1000 });

    expect(final.state).toBe("REJECTED");
    expect(final.failure?.message).toBe("rate limited");
    expect(final.failure?.code).toBe(429);
    expect(store.rows.get("shot-11")?.failure?.code).toBe(429);
  });

  it("throws KieTaskTimeoutError when deadline passes while in flight, record preserved", async () => {
    const calls = { createCount: 0, pollRefs: [] as string[] };
    const client = scriptedClient("prov-task-12", [{ taskId: "prov-task-12", state: "waiting" }], calls);
    const store = memoryStore();
    const runner = new KieTaskRunner(client, store, { now: clock(), sleep: instantSleep });

    await expect(runner.runToTerminal("shot-12", REQUEST, { intervalMs: 1, timeoutMs: 0 })).rejects.toBeInstanceOf(
      KieTaskTimeoutError,
    );
    // The submitted record with providerTaskId survives a timeout → resume possible.
    const kept = store.rows.get("shot-12");
    expect(kept?.providerTaskId).toBe("prov-task-12");
    expect(kept?.state === "SUBMITTED" || kept?.state === "GENERATING").toBe(true);
  });
});