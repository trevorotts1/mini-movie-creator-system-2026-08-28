/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  AgnesPollTimeoutError,
  AgnesVideoPollRunner,
  extractUrlExpiration,
  isAgnesPollTerminal,
  mapAgnesToPipelineState,
  normalizeAgnesStatus,
  parseAgnesResultUrl,
  type AgnesVideoClient,
  type AgnesVideoTaskInfo,
  type AgnesVideoTaskRecord,
  type AgnesVideoTaskStore,
} from "./index.js";

/** In-memory AgnesVideoTaskStore with save-order trace. */
function memoryStore(seed: AgnesVideoTaskRecord[] = []): AgnesVideoTaskStore & {
  rows: Map<string, AgnesVideoTaskRecord>;
  saveOrder: AgnesVideoTaskRecord[];
} {
  const rows = new Map<string, AgnesVideoTaskRecord>();
  const saveOrder: AgnesVideoTaskRecord[] = [];
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

/**
 * Scripted poll-only client. IMPORTANT: no createTask method exists on the
 * poll port — the runner cannot submit even by accident. Any test relying on
 * "no resubmit" is structurally guaranteed by the interface.
 */
function scriptedClient(
  infos: AgnesVideoTaskInfo[],
  calls: { keys: Array<{ key: string; model?: string }> } = { keys: [] },
): AgnesVideoClient {
  let pollIndex = 0;
  return {
    async getTask(key, modelName) {
      calls.keys.push({ key, model: modelName });
      const info = infos[Math.min(pollIndex, infos.length - 1)];
      pollIndex += 1;
      if (!info) throw new Error(`no scripted info for ${key}`);
      return info;
    },
  };
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
}

const instantSleep = async () => undefined;

const SUBMITTED_RECORD: AgnesVideoTaskRecord = {
  ref: "shot-1",
  state: "SUBMITTED",
  providerTaskId: "task_abc123",
  videoId: "video_abc123",
  model: "agnes-video-2.5-flash",
  createdAt: "2026-08-28T10:00:00.000Z",
  updatedAt: "2026-08-28T10:00:00.000Z",
};

describe("normalizeAgnesStatus (verified provider strings)", () => {
  it("maps documented Agnes status strings", () => {
    expect(normalizeAgnesStatus("queued")).toBe("waiting");
    expect(normalizeAgnesStatus("submitted")).toBe("waiting");
    expect(normalizeAgnesStatus("in_progress")).toBe("running");
    expect(normalizeAgnesStatus("completed")).toBe("success");
    expect(normalizeAgnesStatus("failed")).toBe("failed");
  });

  it("never maps an unknown string to a terminal state", () => {
    expect(normalizeAgnesStatus("weird-new-provider-state")).toBe("waiting");
    expect(normalizeAgnesStatus("")).toBe("waiting");
  });
});

describe("mapAgnesToPipelineState (spec §18 machine, poll-visible subset)", () => {
  it("completed with metadata.url → GENERATED_TEMPORARY with URL", () => {
    const mapped = mapAgnesToPipelineState({
      video_id: "video_1",
      status: "completed",
      metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4" },
    });
    expect(mapped.state).toBe("GENERATED_TEMPORARY");
    expect(mapped.resultUrl).toBe("https://apihub.agnes-ai.com/generated/out.mp4");
    expect(isAgnesPollTerminal(mapped.state)).toBe(true);
  });

  it("completed without URL → REJECTED (nothing to archive)", () => {
    const mapped = mapAgnesToPipelineState({ video_id: "video_2", status: "completed", metadata: null });
    expect(mapped.state).toBe("REJECTED");
    expect(mapped.failure?.message).toContain("no result URL");
    expect(isAgnesPollTerminal(mapped.state)).toBe(true);
  });

  it("failed → REJECTED with failure detail", () => {
    const mapped = mapAgnesToPipelineState({
      video_id: "video_3",
      status: "failed",
      error: { message: "Invalid reference media", code: 400 },
    });
    expect(mapped.state).toBe("REJECTED");
    expect(mapped.failure?.message).toBe("Invalid reference media");
    expect(mapped.failure?.code).toBe(400);
    expect(isAgnesPollTerminal(mapped.state)).toBe(true);
  });

  it("queued/in_progress/unknown → GENERATING (not terminal)", () => {
    for (const status of ["queued", "in_progress", "future-provider-state"]) {
      const mapped = mapAgnesToPipelineState({ video_id: "video_4", status });
      expect(mapped.state).toBe("GENERATING");
      expect(isAgnesPollTerminal(mapped.state)).toBe(false);
    }
  });
});

describe("parseAgnesResultUrl", () => {
  it("reads metadata.url (verified Agnes field)", () => {
    expect(parseAgnesResultUrl({ status: "completed", metadata: { url: "https://a/x.mp4" } })).toBe(
      "https://a/x.mp4",
    );
  });

  it("returns undefined for missing/metadata-less payloads", () => {
    expect(parseAgnesResultUrl({ status: "completed" })).toBeUndefined();
    expect(parseAgnesResultUrl({ status: "completed", metadata: null })).toBeUndefined();
    expect(parseAgnesResultUrl({ status: "completed", metadata: { url: "not-a-url" } })).toBeUndefined();
  });
});

describe("extractUrlExpiration (never invent)", () => {
  it("undefined for every documented Agnes shape (no expiration field)", () => {
    expect(extractUrlExpiration({ status: "completed", metadata: { url: "https://a/x.mp4" } })).toBeUndefined();
  });

  it("captures provider-returned expiration when it appears, without inventing", () => {
    expect(extractUrlExpiration({ status: "completed", urlExpiration: "2026-08-29T00:00:00Z" })).toBe(
      "2026-08-29T00:00:00Z",
    );
  });
});

describe("AgnesVideoPollRunner — poll-only, resume at SUBMITTED (kill-poller test)", () => {
  it("resumes an existing SUBMITTED job: polls its persisted key, never submits", async () => {
    const calls = { keys: [] as Array<{ key: string; model?: string }> };
    const client = scriptedClient(
      [
        { video_id: "video_abc123", status: "queued" },
        { video_id: "video_abc123", status: "completed", metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4" } },
      ],
      calls,
    );
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 10_000 });

    // Same task ID polled every round — the persisted job, never a new one.
    expect(calls.keys.map((k) => k.key)).toEqual(["video_abc123", "video_abc123"]);
    // model_name sent on retrieval (required for keyframe/reference tasks).
    expect(calls.keys[0]?.model).toBe("agnes-video-2.5-flash");
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.providerTaskId).toBe("task_abc123");
    expect(final.videoId).toBe("video_abc123");
    expect(final.pollCount).toBe(2);
  });

  it("kill-poller simulation: fresh runner on the SAME store (restart) → same task ID, no second charge", async () => {
    // First process: polls once, observes in-flight, then is "killed".
    const firstProcess = scriptedClient([{ video_id: "video_abc123", status: "in_progress" }]);
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner1 = new AgnesVideoPollRunner(firstProcess, store, { now: clock(), sleep: instantSleep });
    await runner1.pollOnce("shot-1");
    expect(store.rows.get("shot-1")?.state).toBe("GENERATING");
    expect(store.rows.get("shot-1")?.providerTaskId).toBe("task_abc123");

    // Second process (restart) with a FRESH client: resumes the same job.
    const secondProcess = scriptedClient([
      { video_id: "video_abc123", status: "completed", metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4" } },
    ]);
    const runner2 = new AgnesVideoPollRunner(secondProcess, store, { now: clock(), sleep: instantSleep });
    const final = await runner2.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 10_000 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    // Same provider task ID as the pre-restart record — no new job was created.
    expect(final.providerTaskId).toBe("task_abc123");
    expect(final.pollCount).toBe(2);
    // The poll-only port has no create method; a second charge is impossible.
  });

  it("GENERATED_TEMPORARY record is returned untouched (restart → archive known URL, never regenerate)", async () => {
    const calls = { keys: [] as Array<{ key: string; model?: string }> };
    const client = scriptedClient([{ video_id: "video_abc123", status: "completed" }], calls);
    const store = memoryStore([
      {
        ref: "shot-9",
        state: "GENERATED_TEMPORARY",
        providerTaskId: "task_abc123",
        videoId: "video_abc123",
        resultUrl: "https://apihub.agnes-ai.com/generated/done.mp4",
        urlExpiration: null,
        createdAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:01:00.000Z",
      },
    ]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-9", { intervalMs: 1, timeoutMs: 10_000 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrl).toBe("https://apihub.agnes-ai.com/generated/done.mp4");
    // No poll happened — the known URL is ready for the archival layer.
    expect(calls.keys).toEqual([]);
  });

  it("refuses to poll a record with no persisted providerTaskId (would resubmit)", async () => {
    const client = scriptedClient([{ video_id: "video_x", status: "completed" }]);
    const store = memoryStore([
      {
        ref: "never-submitted",
        state: "SUBMITTING",
        createdAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:00:00.000Z",
      },
    ]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    await expect(runner.pollOnce("never-submitted")).rejects.toThrow(/no persisted providerTaskId/);
    expect(store.rows.get("never-submitted")?.state).toBe("SUBMITTING");
  });

  it("refuses to run for a ref with no persisted record at all", async () => {
    const client = scriptedClient([{ video_id: "video_x", status: "completed" }]);
    const store = memoryStore();
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    await expect(runner.runToTerminal("ghost-ref")).rejects.toThrow(/no persisted record/);
  });

  it("throws AgnesPollTimeoutError when deadline passes; record with key survives for resume", async () => {
    const client = scriptedClient([{ video_id: "video_abc123", status: "in_progress" }]);
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    await expect(runner.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 0 })).rejects.toBeInstanceOf(
      AgnesPollTimeoutError,
    );
    const kept = store.rows.get("shot-1");
    expect(kept?.providerTaskId).toBe("task_abc123");
    expect(kept?.state === "SUBMITTED" || kept?.state === "GENERATING").toBe(true);
  });

  it("REJECTED failure detail lands in the store", async () => {
    const client = scriptedClient([{ video_id: "video_abc123", status: "failed", error: { message: "rate limited" } }]);
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 1000 });

    expect(final.state).toBe("REJECTED");
    expect(final.failure?.message).toBe("rate limited");
    expect(store.rows.get("shot-1")?.failure?.message).toBe("rate limited");
  });

  it("GENERATED_TEMPORARY persists URL + URL expiration when provider returns one", async () => {
    const client = scriptedClient([
      {
        video_id: "video_abc123",
        status: "completed",
        metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4", expires_at: 1787000000 },
      },
    ]);
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 1000 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.resultUrl).toBe("https://apihub.agnes-ai.com/generated/out.mp4");
    // Expiration parsed from provider-returned field, persisted on the record.
    expect(final.urlExpiration).toBe(new Date(1787000000 * 1000).toISOString());
    expect(store.rows.get("shot-1")?.urlExpiration).toBe(new Date(1787000000 * 1000).toISOString());
  });

  it("GENERATED_TEMPORARY persists URL with urlExpiration null when provider returns none (never invented)", async () => {
    const client = scriptedClient([
      { video_id: "video_abc123", status: "completed", metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4" } },
    ]);
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const runner = new AgnesVideoPollRunner(client, store, { now: clock(), sleep: instantSleep });

    const final = await runner.runToTerminal("shot-1", { intervalMs: 1, timeoutMs: 1000 });

    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.urlExpiration).toBeUndefined();
    expect(store.rows.get("shot-1")?.urlExpiration).toBeUndefined();
  });

  it("bounded loop polls until terminal state with interval sleeps", async () => {
    const calls = { keys: [] as Array<{ key: string; model?: string }> };
    const client = scriptedClient(
      [
        { video_id: "video_abc123", status: "queued" },
        { video_id: "video_abc123", status: "in_progress" },
        { video_id: "video_abc123", status: "completed", metadata: { url: "https://apihub.agnes-ai.com/generated/out.mp4" } },
      ],
      calls,
    );
    const store = memoryStore([{ ...SUBMITTED_RECORD }]);
    const sleeps: number[] = [];
    const runner = new AgnesVideoPollRunner(client, store, {
      now: clock(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const final = await runner.runToTerminal("shot-1", { intervalMs: 250, timeoutMs: 10_000 });

    expect(calls.keys.map((k) => k.key)).toEqual(["video_abc123", "video_abc123", "video_abc123"]);
    expect(sleeps).toEqual([250, 250, 250]);
    expect(final.state).toBe("GENERATED_TEMPORARY");
    expect(final.pollCount).toBe(3);
  });
});
