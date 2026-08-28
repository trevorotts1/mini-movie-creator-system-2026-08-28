/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  captureIntoKieRecord,
  TempUrlCapturer,
  TempUrlCaptureError,
  type TempUrlArchivalHandoff,
  type TempUrlRecord,
  type TempUrlStore,
} from "./index.js";

/** In-memory TempUrlStore with save-order trace. */
function memoryStore(seed: TempUrlRecord[] = []): TempUrlStore & {
  rows: Map<string, TempUrlRecord>;
  saveOrder: TempUrlRecord[];
} {
  const rows = new Map<string, TempUrlRecord>();
  const saveOrder: TempUrlRecord[] = [];
  for (const record of seed) rows.set(record.key, { ...record });
  return {
    rows,
    saveOrder,
    async load(key) {
      return rows.get(key);
    },
    async save(record) {
      saveOrder.push({ ...record });
      rows.set(record.key, { ...record });
    },
  };
}

/** Scripted handoff spy: records every request, honors next-outcome script. */
function scriptedHandoff(
  outcomes: { accepted: boolean; error?: string }[] = [{ accepted: true }],
): TempUrlArchivalHandoff & { requests: unknown[] } {
  const requests: unknown[] = [];
  let index = 0;
  return {
    requests,
    async archive(request) {
      requests.push(request);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? { accepted: true };
      index += 1;
      return { url: request.url, ...outcome };
    },
  };
}

/** Injectable clock: fixed base + n seconds per tick. */
function clock(baseMs = 1_700_000_000_000): () => string {
  let tick = 0;
  return () => new Date(baseMs + tick++ * 1000).toISOString();
}

const GENERATED_TEMPORARY = {
  ref: "shot-7:keyframe-a",
  state: "GENERATED_TEMPORARY",
  resultUrls: ["https://files.kie.ai/temp/clip-a.mp4", "https://files.kie.ai/temp/clip-b.mp4"],
};

describe("capture on GENERATED_TEMPORARY (KIE-008 acceptance)", () => {
  it("persists provider URL + expiration immediately for every result URL", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });
    const now = clock();

    const records = await capturer.capture(GENERATED_TEMPORARY, {
      expiresAt: "2026-08-28T12:00:00Z",
      providerModel: "bytedance/seedance-2-mini",
      providerTaskId: "task-101",
    });

    expect(records).toHaveLength(2);
    const capturedAt = now(); // one tick per capture() call, not per record
    for (const record of records) {
      expect(record.state).toBe("GENERATED_TEMPORARY");
      expect(record.expiresAt).toBe("2026-08-28T12:00:00Z");
      expect(record.providerModel).toBe("bytedance/seedance-2-mini");
      expect(record.providerTaskId).toBe("task-101");
      expect(record.capturedAt).toBe(capturedAt);
      expect(record.handoffStatus).toBe("TRIGGERED");
      expect(record.handoffTriggeredAt).toBeDefined();
    }
    // Both URLs persisted in the store, and the store write happened before
    // the handoff (persist-before-handoff invariant: first save is a PENDING
    // record, not already TRIGGERED).
    expect(store.rows.size).toBe(2);
    const firstSave = store.saveOrder[0]!;
    expect(firstSave.handoffStatus).toBe("PENDING");
    expect(handoff.requests).toHaveLength(2);
    expect(handoff.requests[0]).toMatchObject({
      ref: "shot-7:keyframe-a",
      url: "https://files.kie.ai/temp/clip-a.mp4",
      expiresAt: "2026-08-28T12:00:00Z",
    });
  });

  it("capture persists URL before triggering handoff (store-write ordering)", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    await capturer.capture(GENERATED_TEMPORARY);

    // Every URL has at least one PENDING save before the TRIGGERED save.
    for (const url of GENERATED_TEMPORARY.resultUrls!) {
      const savesForUrl = store.saveOrder.filter((r) => r.url === url);
      expect(savesForUrl).toHaveLength(2);
      expect(savesForUrl[0]!.handoffStatus).toBe("PENDING");
      expect(savesForUrl[1]!.handoffStatus).toBe("TRIGGERED");
    }
  });

  it("re-running capture is idempotent: no duplicate records, no double trigger", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const first = await capturer.capture(GENERATED_TEMPORARY);
    const second = await capturer.capture(GENERATED_TEMPORARY);

    expect(store.rows.size).toBe(2);
    expect(first).toEqual(second);
    expect(handoff.requests).toHaveLength(2); // one per URL, not four
    expect(handoff.requests.map((r) => (r as { url: string }).url).sort()).toEqual(
      [...GENERATED_TEMPORARY.resultUrls!].sort(),
    );
  });

  it("re-arms a PENDING record from a crash (persisted, handoff never fired)", async () => {
    const capturedAt = "2026-08-28T11:00:00Z";
    const store = memoryStore([
      {
        key: TempUrlCapturer.urlKey("shot-7:keyframe-a", "https://files.kie.ai/temp/clip-a.mp4"),
        ref: "shot-7:keyframe-a",
        url: "https://files.kie.ai/temp/clip-a.mp4",
        state: "GENERATED_TEMPORARY",
        capturedAt,
        handoffStatus: "PENDING",
      },
    ]);
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const records = await capturer.capture(GENERATED_TEMPORARY);

    // Crash-resume: the already-persisted URL is re-armed (not duplicated),
    // and the other URL is captured fresh.
    expect(store.rows.size).toBe(2);
    const rearmed = records.find((r) => r.url === "https://files.kie.ai/temp/clip-a.mp4")!;
    expect(rearmed.capturedAt).toBe(capturedAt); // original capture time kept
    expect(rearmed.handoffStatus).toBe("TRIGGERED");
    expect(handoff.requests).toHaveLength(2);
  });

  it("never re-triggers a URL already handed off (TRIGGERED stays single-fire)", async () => {
    const store = memoryStore([
      {
        key: TempUrlCapturer.urlKey("shot-7:keyframe-a", "https://files.kie.ai/temp/clip-a.mp4"),
        ref: "shot-7:keyframe-a",
        url: "https://files.kie.ai/temp/clip-a.mp4",
        state: "GENERATED_TEMPORARY",
        capturedAt: "2026-08-28T11:00:00Z",
        handoffStatus: "TRIGGERED",
        handoffTriggeredAt: "2026-08-28T11:00:01Z",
      },
    ]);
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const records = await capturer.capture(GENERATED_TEMPORARY);

    const already = records.find((r) => r.url === "https://files.kie.ai/temp/clip-a.mp4")!;
    expect(already.handoffStatus).toBe("TRIGGERED");
    expect(already.handoffTriggeredAt).toBe("2026-08-28T11:00:01Z");
    // Only the second URL triggered a handoff.
    expect(handoff.requests).toHaveLength(1);
    expect((handoff.requests[0] as { url: string }).url).toBe(
      "https://files.kie.ai/temp/clip-b.mp4",
    );
  });

  it("records a handoff rejection as FAILED with redacted error, URL stays persisted", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff([{ accepted: false, error: "token expired" }]);
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const records = await capturer.capture(GENERATED_TEMPORARY);

    expect(store.rows.size).toBe(2); // persisted regardless of handoff
    for (const record of records) {
      expect(record.handoffStatus).toBe("FAILED");
      expect(record.handoffError).toBe("token expired");
      expect(record.handoffErrorAt).toBeDefined();
    }
  });

  it("records a handoff THROW as FAILED and never rethrows (URL safe, no regeneration)", async () => {
    const store = memoryStore();
    const handoff: TempUrlArchivalHandoff = {
      async archive() {
        throw new Error("network down");
      },
    };
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    // transport error must not escape: capture completes with FAILED records
    const records = await capturer.capture(GENERATED_TEMPORARY);

    expect(records).toHaveLength(2);
    expect(records[0]!.handoffStatus).toBe("FAILED");
    expect(records[0]!.handoffError).toBe("network down");
    expect(store.rows.size).toBe(2);
  });

  it("rejects capture when the record is not GENERATED_TEMPORARY", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    await expect(
      capturer.capture({ ref: "shot-8", state: "GENERATING", resultUrls: ["https://files.kie.ai/temp/x.mp4"] }),
    ).rejects.toThrow(TempUrlCaptureError);
    expect(store.rows.size).toBe(0);
  });

  it("rejects capture when there are no result URLs (nothing to archive)", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    await expect(
      capturer.capture({ ref: "shot-9", state: "GENERATED_TEMPORARY", resultUrls: [] }),
    ).rejects.toThrow(/no result URLs/);
  });

  it("rejects non-http(s) result values instead of storing garbage", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    await expect(
      capturer.capture({
        ref: "shot-10",
        state: "GENERATED_TEMPORARY",
        resultUrls: ["file:///etc/passwd"],
      }),
    ).rejects.toThrow(/non-http/);
    expect(store.rows.size).toBe(0);
  });

  it("rejects a non-ISO expiration instead of persisting a guess", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    await expect(
      capturer.capture(GENERATED_TEMPORARY, { expiresAt: "in-an-hour" }),
    ).rejects.toThrow(/ISO-8601/);
    expect(store.rows.size).toBe(0);
  });

  it("accepts missing expiration (provider states no TTL) and archives immediately", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const records = await capturer.capture(GENERATED_TEMPORARY);

    for (const record of records) {
      expect(record.expiresAt).toBeUndefined(); // UNKNOWN, not invented
      expect(record.handoffStatus).toBe("TRIGGERED");
    }
  });

  it("single URL result captures exactly one record and one handoff", async () => {
    const store = memoryStore();
    const handoff = scriptedHandoff();
    const capturer = new TempUrlCapturer(store, handoff, { now: clock() });

    const records = await capturer.capture({
      ref: "shot-1",
      state: "GENERATED_TEMPORARY",
      resultUrls: ["https://files.kie.ai/temp/solo.mp4"],
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe("shot-1::https://files.kie.ai/temp/solo.mp4");
    expect(handoff.requests).toHaveLength(1);
  });
});

describe("captureIntoKieRecord (KIE-002 runner integration)", () => {
  it("appends persisted expiration metadata onto the task record", () => {
    const captured: TempUrlRecord[] = [
      {
        key: "shot-1::https://files.kie.ai/temp/a.mp4",
        ref: "shot-1",
        url: "https://files.kie.ai/temp/a.mp4",
        expiresAt: "2026-08-28T12:00:00Z",
        state: "GENERATED_TEMPORARY",
        capturedAt: "2026-08-28T11:00:00Z",
        handoffStatus: "TRIGGERED",
      },
      {
        key: "shot-1::https://files.kie.ai/temp/b.mp4",
        ref: "shot-1",
        url: "https://files.kie.ai/temp/b.mp4",
        state: "GENERATED_TEMPORARY",
        capturedAt: "2026-08-28T11:00:00Z",
        handoffStatus: "TRIGGERED",
      },
    ];
    const merged = captureIntoKieRecord(
      { ref: "shot-1", state: "GENERATED_TEMPORARY", resultUrls: ["https://files.kie.ai/temp/b.mp4"] },
      captured,
    );

    expect(merged.resultUrls).toEqual(["https://files.kie.ai/temp/b.mp4"]);
    expect(merged.providerUrlExpirations).toEqual({
      "https://files.kie.ai/temp/a.mp4": "2026-08-28T12:00:00Z",
    });
  });

  it("returns no expiration map when no URL carries one", () => {
    const captured: TempUrlRecord[] = [
      {
        key: "shot-2::https://files.kie.ai/temp/c.mp4",
        ref: "shot-2",
        url: "https://files.kie.ai/temp/c.mp4",
        state: "GENERATED_TEMPORARY",
        capturedAt: "2026-08-28T11:00:00Z",
        handoffStatus: "TRIGGERED",
      },
    ];
    const merged = captureIntoKieRecord(
      { ref: "shot-2", state: "GENERATED_TEMPORARY", resultUrls: ["https://files.kie.ai/temp/c.mp4"] },
      captured,
    );

    expect(merged.providerUrlExpirations).toBeUndefined();
  });
});
