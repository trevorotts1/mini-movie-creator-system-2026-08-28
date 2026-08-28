/// <reference types="node" />
import { describe, expect, it } from "vitest";

import { requestHash } from "@mmcs/core/idempotency/request-hash.js";
import { connectSqlite } from "@mmcs/database/index.js";
import { AGNES_VIDEO_2_5, AGNES_VIDEO_2_5_FLASH } from "@mmcs/capability-registry/data/agnes.js";
import type { MediaModelCapabilitySeed } from "@mmcs/capability-registry/data/types.js";

import {
  AgnesVideoBudgetDeclinedError,
  AgnesVideoSubmitter,
  InMemoryAgnesVideoJobStore,
  agnesVideoCapability,
  buildAgnesVideoSubmitRequest,
  classifyMode,
  estimateSpendUsd,
  validateAgnesVideoSubmit,
  AgnesVideoValidationError,
  type AgnesVideoBudgetGate,
  AgnesVideoJobStoreSqlite,
  type AgnesVideoClient,
  type AgnesVideoJobRecord,
  type AgnesVideoJobStore,
  type AgnesVideoSubmitRequest,
} from "./index.js";

/** In-memory store exposing save order for the persist-before-poll assertions. */
function tracedStore(
  seed: AgnesVideoJobRecord[] = [],
): InMemoryAgnesVideoJobStore & {
  saveOrder: AgnesVideoJobRecord[];
} {
  const store = new InMemoryAgnesVideoJobStore();
  for (const record of seed) void store.save(record);
  return store as InMemoryAgnesVideoJobStore & { saveOrder: AgnesVideoJobRecord[] };
}

/** Scripted client: returns a fixed video_id and counts submissions. */
function scriptedClient(
  videoId: string,
  calls: { submitCount: number; seen: AgnesVideoSubmitRequest[] } = {
    submitCount: 0,
    seen: [],
  },
): AgnesVideoClient {
  return {
    async createVideo(request) {
      calls.submitCount += 1;
      calls.seen.push(request);
      return { videoId, raw: { echo: request.mode } };
    },
  };
}

/** Budget gate that records reservations and exposes release outcomes. */
function budgetGate(
  options: { decline?: boolean } = {},
): AgnesVideoBudgetGate & {
  reservations: { ref: string; estimatedCostUsd: number }[];
  released: { id: string; reason: string }[];
} {
  const gate = {
    reservations: [] as { ref: string; estimatedCostUsd: number }[],
    released: [] as { id: string; reason: string }[],
    async reserve(request: { ref: string; estimatedCostUsd: number }) {
      if (options.decline) {
        throw new AgnesVideoBudgetDeclinedError(request.ref, request.estimatedCostUsd);
      }
      gate.reservations.push({
        ref: request.ref,
        estimatedCostUsd: request.estimatedCostUsd,
      });
      let id = `res-${gate.reservations.length}`;
      return {
        id,
        async release(reason: "submitted" | "failed") {
          gate.released.push({ id, reason });
        },
      };
    },
  };
  return gate as typeof gate & AgnesVideoBudgetGate;
}

const BASE_INPUT = {
  prompt: "Monica sprints down a rain-slick alley, neon reflections everywhere",
  seconds: "5",
};

function fixedClock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
}

describe("classifyMode (AGN-004 mode derivation)", () => {
  it("derives text/keyframe/reference from inputs", () => {
    expect(classifyMode({})).toBe("text");
    expect(classifyMode({ firstFrameUrl: "https://x/a.png" })).toBe("keyframe");
    expect(classifyMode({ lastFrameUrl: "https://x/b.png" })).toBe("keyframe");
    expect(classifyMode({ referenceImageUrls: ["https://x/c.png"] })).toBe("reference");
    expect(classifyMode({ referenceVideos: [{ url: "https://x/v.mp4" }] })).toBe("reference");
 expect(classifyMode({ referenceAudioUrls: ["https://x/a.mp3"] })).toBe("reference");
  });
});

describe("buildAgnesVideoSubmitRequest (AGN-004 payload shape)", () => {
  it("emits only present fields (no contradictory empty arrays)", () => {
    const request = buildAgnesVideoSubmitRequest({ prompt: "p", seconds: "6" });
    expect(request.model).toBe("agnes-video-2.5-flash");
    expect(request.mode).toBe("text");
    expect(request.seconds).toBe("6");
    expect(request.size).toBe("720P");
    expect("images" in request).toBe(false);
    expect("videos" in request).toBe(false);
    expect("audios" in request).toBe(false);
    expect("first_frame" in request).toBe(false);
  });

  it("maps flash + reference fields to Agnes schema names", () => {
    const request = buildAgnesVideoSubmitRequest({
      model: "agnes-video-2.5",
      prompt: "p",
      mode: "reference",
      referenceImageUrls: ["https://x/1.png", "https://x/2.png"],
      referenceVideos: [{ url: "https://x/v.mp4", start_seconds: 2, require_audio: true }],
      referenceAudioUrls: ["https://x/voice.mp3"],
      size: "2K",
      aspectRatio: "9:16",
      seed: 7,
    });
    expect(request.model).toBe("agnes-video-2.5");
    expect(request.images).toEqual(["https://x/1.png", "https://x/2.png"]);
    expect(request.videos).toEqual([{ url: "https://x/v.mp4", start_seconds: 2, require_audio: true }]);
    expect(request.audios).toEqual(["https://x/voice.mp3"]);
    expect(request.size).toBe("2K");
    expect(request.aspect_ratio).toBe("9:16");
    expect(request.seed).toBe(7);
  });
});

describe("validateAgnesVideoSubmit (spec §5 pre-request chain)", () => {
  it("passes a clean text-mode request and records the exact character count", () => {
    const prompt = "A".repeat(5000);
    const result = validateAgnesVideoSubmit(
      { prompt, seconds: "8" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.ok).toBe(true);
    expect(result.promptCharacterCount).toBe(5000);
  });

  it("preserves UNKNOWN: a huge prompt stays VALID for Agnes (no invented ceiling)", () => {
    // spec §33: never invent an Agnes hard prompt ceiling. hardMaxCharacters
    // is null → the PROMPT_EXCEEDS_HARD_MAX branch must not fire at any size.
    expect(AGNES_VIDEO_2_5_FLASH.prompt.hardMaxCharacters).toBeNull();
    const result = validateAgnesVideoSubmit(
      { prompt: "x".repeat(100_000) },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(
      result.issues.some((issue) => issue.code === "PROMPT_EXCEEDS_HARD_MAX"),
    ).toBe(false);
  });

  it("enforces a hard max only when the profile documents one (non-null)", () => {
    const capability = {
      ...AGNES_VIDEO_2_5_FLASH,
      prompt: { ...AGNES_VIDEO_2_5_FLASH.prompt, hardMaxCharacters: 100 },
    } as MediaModelCapabilitySeed;
    const result = validateAgnesVideoSubmit(
      { prompt: "y".repeat(101) },
      capability,
    );
    expect(result.issues.some((issue) => issue.code === "PROMPT_EXCEEDS_HARD_MAX")).toBe(true);
  });

  it("stage references: Flash rejects a 6th reference image (documented max 5)", () => {
    const result = validateAgnesVideoSubmit(
      {
        prompt: "p",
        mode: "reference",
        referenceImageUrls: ["1", "2", "3", "4", "5", "6"].map((n) => `https://x/${n}.png`),
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "REFERENCE_IMAGES_EXCEED_MAX")).toBe(true);
  });

  it("stage references: Flash rejects any reference video (HTTP 400 documented)", () => {
    const result = validateAgnesVideoSubmit(
      {
        prompt: "p",
        mode: "reference",
        referenceVideos: [{ url: "https://x/v.mp4" }],
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "REFERENCE_VIDEOS_NOT_SUPPORTED")).toBe(true);
  });

  it("stage references: regular 2.5 accepts reference videos (count UNKNOWN, not enforced)", () => {
    const result = validateAgnesVideoSubmit(
      {
        model: "agnes-video-2.5",
        prompt: "p",
        mode: "reference",
        referenceVideos: [{ url: "https://x/v.mp4" }],
      },
      AGNES_VIDEO_2_5,
    );
    expect(result.ok).toBe(true);
  });

  it("stage modes: keyframe excludes reference inputs (documented combination)", () => {
    const result = validateAgnesVideoSubmit(
      {
        prompt: "p",
        mode: "keyframe",
        firstFrameUrl: "https://x/first.png",
        referenceImageUrls: ["https://x/ref.png"],
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "MODE_EXCLUSIVITY")).toBe(true);
  });

  it("stage modes: reference excludes first_frame (documented combination)", () => {
    const result = validateAgnesVideoSubmit(
      {
        prompt: "p",
        mode: "reference",
        firstFrameUrl: "https://x/first.png",
        referenceImageUrls: ["https://x/ref.png"],
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("MODE_EXCLUSIVITY");
  });

  it("stage modes: CAP-005 hard rule fires even when mode omitted (frame + refs)", () => {
    const result = validateAgnesVideoSubmit(
      {
        prompt: "p",
        firstFrameUrl: "https://x/first.png",
        referenceImageUrls: ["https://x/ref.png"],
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "MODE_EXCLUSIVITY")).toBe(true);
  });

  it("stage modes: last_frame requires first_frame", () => {
    const result = validateAgnesVideoSubmit(
      { prompt: "p", mode: "keyframe", lastFrameUrl: "https://x/last.png" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "LAST_FRAME_REQUIRES_FIRST")).toBe(true);
  });

  it("stage duration: seconds outside 4–12 rejected; valid bounds accepted", () => {
    const tooLow = validateAgnesVideoSubmit(
      { prompt: "p", seconds: "3" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(tooLow.issues.some((issue) => issue.code === "SECONDS_OUT_OF_RANGE")).toBe(true);
    const tooHigh = validateAgnesVideoSubmit(
      { prompt: "p", seconds: "13" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(tooHigh.issues.some((issue) => issue.code === "SECONDS_OUT_OF_RANGE")).toBe(true);
    expect(tooLow.issues.some((issue) => issue.code === "SECONDS_OUT_OF_RANGE")).toBe(true);
  });

  it("stage duration: non-numeric seconds string rejected", () => {
    const result = validateAgnesVideoSubmit(
      { prompt: "p", seconds: "5.5" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "SECONDS_INVALID")).toBe(true);
  });

  it("stage resolution: Flash rejects any size except 720P (HTTP 400 documented)", () => {
    const result = validateAgnesVideoSubmit(
      { prompt: "p", size: "2K" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "SIZE_NOT_SUPPORTED")).toBe(true);
  });

  it("stage resolution: regular 2.5 accepts 960P and 2K", () => {
    expect(
      validateAgnesVideoSubmit({ prompt: "p", size: "960P" }, AGNES_VIDEO_2_5).ok,
    ).toBe(true);
    expect(
      validateAgnesVideoSubmit({ prompt: "p", size: "2K" }, AGNES_VIDEO_2_5).ok,
    ).toBe(true);
  });

  it("rejects an empty prompt", () => {
    const result = validateAgnesVideoSubmit({ prompt: "" }, AGNES_VIDEO_2_5_FLASH);
    expect(result.issues.some((issue) => issue.code === "PROMPT_REQUIRED")).toBe(true);
  });

  it("rejects n != 1 (Agnes Video 2.5 generates 1 only)", () => {
    const result = validateAgnesVideoSubmit(
      { prompt: "p", n: 2 as unknown as 1 },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(result.issues.some((issue) => issue.code === "N_NOT_SUPPORTED")).toBe(true);
  });
});

describe("estimateSpendUsd (spec §4: derive cost before spending)", () => {
  it("prices output seconds at the documented list rate", () => {
    const estimate = estimateSpendUsd(
      { prompt: "p", seconds: "12" },
      AGNES_VIDEO_2_5_FLASH,
    );
    expect(estimate).toBeCloseTo(12 * 0.025, 6);
  });

  it("adds input-video seconds and excess images per the pricing rules", () => {
    const estimate = estimateSpendUsd(
      {
        prompt: "p",
        mode: "reference",
        seconds: "10",
        referenceVideos: [{ url: "https://x/v.mp4" }],
        referenceImageUrls: ["1", "2", "3", "4", "5", "6", "7"].map((n) => `https://x/${n}.png`),
      },
      AGNES_VIDEO_2_5_FLASH,
    );
    // 10s output + 10s input video at $0.025/s + 2 excess images at $0.005.
    expect(estimate).toBeCloseTo(20 * 0.025 + 2 * 0.005, 6);
  });
});

describe("agnesVideoCapability (stage 1: profile resolution)", () => {
  it("resolves both seeded Agnes video profiles with provenance", () => {
    const flash = agnesVideoCapability("agnes-video-2.5-flash");
    expect(flash.modelId).toBe("agnes-video-2.5-flash");
    expect(flash.confidence).toBe("VERIFIED");
    expect(flash.sourceUrls.length).toBeGreaterThan(0);
    expect(flash.prompt.hardMaxCharacters).toBeNull();
    const regular = agnesVideoCapability("agnes-video-2.5");
    expect(regular.output.resolutions).toContain("2K");
  });
});

describe("AgnesVideoSubmitter (mocked submit → SUBMITTED, spec §18)", () => {
  it("submits and returns a SUBMITTED record with the provider job ID persisted", async () => {
    const calls = { submitCount: 0, seen: [] as AgnesVideoSubmitRequest[] };
    const store = tracedStore();
    const gate = budgetGate();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_abc123", calls),
      store,
      gate,
      { now: fixedClock() },
    );

    const record = await submitter.submit("S01E03:SC04:SH07", BASE_INPUT);

    expect(record.state).toBe("SUBMITTED");
    expect(record.providerJobId).toBe("vid_abc123");
    expect(record.provider).toBe("agnes");
    expect(record.model).toBe("agnes-video-2.5-flash");
    expect(record.submitRequest?.mode).toBe("text");
    expect(record.promptCharacterCount).toBe(BASE_INPUT.prompt.length);
    expect(record.estimatedCostUsd).toBeCloseTo(5 * 0.025, 6);
    expect(record.submittedAt).toBeDefined();
    expect(record.archivalStatus).toBe("PENDING");
    expect(calls.submitCount).toBe(1);
  });

  it("persists the request BEFORE the provider call and the job ID before any poll", async () => {
    const store = tracedStore();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_order1"),
      store,
      budgetGate(),
      { now: fixedClock() },
    );

    await submitter.submit("job-1", BASE_INPUT);

    const states = store.saveOrder.map((record) => record.state);
    // BUDGET_RESERVED → SUBMITTING → SUBMITTED; the request payload is on the
    // very first durable record, the provider ID first appears on SUBMITTED.
    expect(states).toEqual(["BUDGET_RESERVED", "SUBMITTING", "SUBMITTED"]);
    expect(store.saveOrder[0]?.submitRequest?.prompt).toBe(BASE_INPUT.prompt);
    expect(store.saveOrder[0]?.providerJobId).toBeUndefined();
    const submitted = store.saveOrder.find((record) => record.state === "SUBMITTED");
    expect(submitted?.providerJobId).toBe("vid_order1");
    // No poll bookkeeping ever appears in the submit path.
    expect(store.saveOrder.every((record) => record.lastPolledAt === undefined)).toBe(true);
  });

  it("is idempotent: a SUBMITTED record is returned untouched, never resubmitted", async () => {
    const calls = { submitCount: 0, seen: [] as AgnesVideoSubmitRequest[] };
    const store = tracedStore();
    const gate = budgetGate();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_once", calls),
      store,
      gate,
      { now: fixedClock() },
    );

    const first = await submitter.submit("job-idem", BASE_INPUT);
    const second = await submitter.submit("job-idem", BASE_INPUT);

    expect(calls.submitCount).toBe(1);
    expect(second.providerJobId).toBe(first.providerJobId);
    expect(second.state).toBe("SUBMITTED");
  });

  it("request hash is stable for identical requests and persisted on every save", async () => {
    const store = tracedStore();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_hash"),
      store,
      budgetGate(),
      { now: fixedClock() },
    );

    await submitter.submit("job-hash", BASE_INPUT);
    const expected = requestHash("agnes.video.submit.v1", store.saveOrder[0]?.submitRequest);
    for (const saved of store.saveOrder) {
      expect(saved.requestHash).toBe(expected);
   }
  });

  it("different request → different hash (no hash collisions across variants)", async () => {
    const store = tracedStore();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_hash2"),
      store,
      budgetGate(),
      { now: fixedClock() },
    );
    await submitter.submit("job-hash-a", BASE_INPUT);
    await submitter.submit("job-hash-b", { ...BASE_INPUT, seconds: "9" });
    expect(store.saveOrder[0]?.requestHash).not.toBe(store.saveOrder.at(-1)?.requestHash);
  });

  it("validation failure aborts before ANY durable write and throws AgnesVideoValidationError", async () => {
    const calls = { submitCount: 0, seen: [] as AgnesVideoSubmitRequest[] };
    const store = tracedStore();
    const gate = budgetGate();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_never", calls),
      store,
      gate,
      { now: fixedClock() },
    );

    await expect(
      submitter.submit("job-invalid", {
        prompt: "p",
        seconds: "13", // out of documented 4–12 range
      }),
    ).rejects.toBeInstanceOf(AgnesVideoValidationError);

    expect(store.saveOrder).toEqual([]); // nothing persisted
    expect(gate.reservations).toEqual([]); // no budget touched
    expect(calls.submitCount).toBe(0); // no provider call
  });

  it("budget decline records REJECTED and does not submit", async () => {
    const calls = { submitCount: 0, seen: [] as AgnesVideoSubmitRequest[] };
    const store = tracedStore();
    const gate = budgetGate({ decline: true });
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_no_spend", calls),
      store,
      gate,
      { now: fixedClock() },
    );

    await expect(submitter.submit("job-budget", BASE_INPUT)).rejects.toBeInstanceOf(
      AgnesVideoBudgetDeclinedError,
    );

    const final = await store.load("job-budget");
    expect(final?.state).toBe("REJECTED");
    expect(final?.providerJobId).toBeUndefined();
    expect(calls.submitCount).toBe(0);
  });

  it("client failure releases the reservation, records REJECTED, and rethrows", async () => {
    const failingClient: AgnesVideoClient = {
      async createVideo() {
        throw new Error("agnes 500: upstream unavailable");
      },
    };
    const store = tracedStore();
    const gate = budgetGate();
    const submitter = new AgnesVideoSubmitter(failingClient, store, gate, {
      now: fixedClock(),
    });

    await expect(submitter.submit("job-fail", BASE_INPUT)).rejects.toThrow(
      "agnes 500: upstream unavailable",
    );

    const final = await store.load("job-fail");
    expect(final?.state).toBe("REJECTED");
    expect(final?.providerJobId).toBeUndefined();
    expect(final?.retryCount).toBe(1);
    expect(gate.released.at(-1)?.reason).toBe("failed");
  });

  it("resume after a mid-flight crash (record without providerJobId) re-enters at BUDGET_RESERVED and converges", async () => {
    const calls = { submitCount: 0, seen: [] as AgnesVideoSubmitRequest[] };
    const store = tracedStore();
    const submitter = new AgnesVideoSubmitter(
      scriptedClient("vid_recovered", calls),
      store,
      budgetGate(),
      { now: fixedClock() },
    );

    await submitter.submit("job-crash", BASE_INPUT); // full happy path
    expect(calls.submitCount).toBe(1);

    // Simulate a crash-before-submission state: record exists with no job ID.
    await store.save({
      ref: "job-crash-2",
      state: "SUBMITTING",
      requestHash: "stale",
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    const recovered = await submitter.submit("job-crash-2", BASE_INPUT);
    expect(recovered.state).toBe("SUBMITTED");
    expect(recovered.providerJobId).toBe("vid_recovered");
    expect(recovered.requestHash).not.toBe("stale");
  });
});

describe("AgnesVideoJobStoreSqlite (CORE-007 seam)", () => {
  it("round-trips a record through SQLite with denormalized columns", async () => {
    const db = connectSqlite({ path: ":memory:" });
    const store = new AgnesVideoJobStoreSqlite(db);
    const record: AgnesVideoJobRecord = {
      ref: "S01E03:SC04:SH07",
      state: "SUBMITTED",
      requestHash: "deadbeef",
      provider: "agnes",
      model: "agnes-video-2.5-flash",
      providerJobId: "vid_sql1",
      submitRequest: buildAgnesVideoSubmitRequest({ prompt: "p" }),
      promptCharacterCount: 1,
      estimatedCostUsd: 0.125,
      submittedAt: "2026-08-28T10:00:00.000Z",
      archivalStatus: "PENDING",
      retryCount: 0,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:00:00.000Z",
    };

    await store.save(record);
    const loaded = await store.load(record.ref);
    expect(loaded?.state).toBe("SUBMITTED");
    expect(loaded?.providerJobId).toBe("vid_sql1");
    expect(loaded?.submitRequest?.model).toBe("agnes-video-2.5-flash");

    // Denormalized columns queryable without JSON parsing.
    const row = db
      .get("SELECT provider_task_id, state FROM provider_jobs WHERE ref = ?", record.ref);
    expect(row?.["provider_task_id"]).toBe("vid_sql1");
    expect(row?.["state"]).toBe("SUBMITTED");

    // Upsert overwrites by ref.
    await store.save({ ...record, state: "GENERATING" });
    const updated = await store.load(record.ref);
    expect(updated?.state).toBe("GENERATING");
    expect((await store.load("missing"))).toBeUndefined();
    db.close();
  });
});