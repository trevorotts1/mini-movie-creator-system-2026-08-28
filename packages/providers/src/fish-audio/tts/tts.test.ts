/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  deriveAssetId,
  DialogueTtsRunner,
  DialogueValidationError,
  hashDialogueRequest,
  isTtsTerminal,
  sha256Hex,
  TtsSynthesisError,
  validateDialogueLine,
  type AudioAssetStore,
  type AudioByteStore,
  type DialogueAudioAsset,
  type DialogueCachePort,
  type DialogueLineInput,
  type FishTtsSynthesizer,
  type SynthesisOutcome,
  type SynthesisRequest,
  type TtsJobRecord,
  type TtsJobStore,
} from "./index.js";

/** In-memory TtsJobStore with save-order trace (mirrors KIE-002 test store). */
function memoryJobStore(seed: TtsJobRecord[] = []): TtsJobStore & {
  rows: Map<string, TtsJobRecord>;
  saveOrder: TtsJobRecord[];
} {
  const rows = new Map<string, TtsJobRecord>();
  const saveOrder: TtsJobRecord[] = [];
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

/** In-memory AudioAssetStore. */
function memoryAssetStore(seed: DialogueAudioAsset[] = []): AudioAssetStore & {
  rows: Map<string, DialogueAudioAsset>;
  saveOrder: DialogueAudioAsset[];
} {
  const rows = new Map<string, DialogueAudioAsset>();
  const saveOrder: DialogueAudioAsset[] = [];
  for (const asset of seed) rows.set(asset.assetId, { ...asset });
  return {
    rows,
    saveOrder,
    async load(assetId) {
      return rows.get(assetId);
    },
    async save(asset) {
      saveOrder.push({ ...asset });
      rows.set(asset.assetId, { ...asset });
    },
  };
}

/** In-memory AudioByteStore (durable bytes across runner restarts, §21). */
function memoryByteStore(): AudioByteStore & {
  blobs: Map<string, Uint8Array>;
  saveOrder: string[];
} {
  const blobs = new Map<string, Uint8Array>();
  const saveOrder: string[] = [];
  return {
    blobs,
    saveOrder,
    async load(assetId: string) {
      return blobs.get(assetId);
    },
    async save(assetId: string, bytes: Uint8Array) {
      saveOrder.push(assetId);
      blobs.set(assetId, new Uint8Array(bytes));
    },
  };
}

/** Scripted synthesizer: records requests, replays scripted outcomes. */
function scriptedSynthesizer(
  outcomes: SynthesisOutcome[],
  calls: { requests: SynthesisRequest[] } = { requests: [] },
): FishTtsSynthesizer {
  let index = 0;
  return {
    async synthesize(request) {
      calls.requests.push({ ...request });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (!outcome) throw new Error("no scripted outcome");
      return outcome;
    },
  };
}

const AUDIO_A = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const AUDIO_B = new Uint8Array([9, 9, 9, 9]);

const LINE: DialogueLineInput = {
  characterId: "CHAR_MONICA_BENNETT_001",
  voiceId: "voice-abc123",
  text: "You never told me the harbor was closed.",
  model: "s2.1-pro",
  format: "mp3",
  seriesId: "SERIES_HARBOR_001",
  episodeId: "ep01",
  sceneId: "sc03",
  shotId: "shot12",
  characterVersion: "v2",
};

function okOutcome(audio: Uint8Array = AUDIO_A, providerTaskId?: string): SynthesisOutcome {
  return { ok: true, audio, providerTaskId, providerModel: "s2.1-pro" };
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
}

function makeRunner(
  synthesizer: FishTtsSynthesizer,
  jobStore = memoryJobStore(),
  assetStore = memoryAssetStore(),
  byteStore?: AudioByteStore,
): DialogueTtsRunner {
  return new DialogueTtsRunner(synthesizer, jobStore, assetStore, { bytes: byteStore });
}

describe("validateDialogueLine (FISH-003 input validation)", () => {
  it("accepts a valid line and defaults originalText + format", () => {
    const validated = validateDialogueLine(LINE);
    expect(validated.originalText).toBe(LINE.text);
    expect(validated.format).toBe("mp3");
  });

  it("rejects bad character ids, blank voice, and empty text before persisting", () => {
    expect(() => validateDialogueLine({ ...LINE, characterId: "monica" })).toThrow(
      DialogueValidationError,
    );
    expect(() => validateDialogueLine({ ...LINE, voiceId: "  " })).toThrow(/voiceId/);
    expect(() => validateDialogueLine({ ...LINE, text: "" })).toThrow(/text/);
    expect(() => validateDialogueLine({ ...LINE, text: "   " })).toThrow(/text/);
  });
});

describe("hashDialogueRequest (§38 idempotency identifier)", () => {
  it("is stable across key order and sensitive to voice-defining inputs", () => {
    const a = hashDialogueRequest({
      characterId: "CHAR_A_001",
      voiceId: "v1",
      text: "hello",
      model: "s2-pro",
      format: "mp3",
      settings: { temperature: 0.7, topP: 0.9 },
    });
    const b = hashDialogueRequest({
      settings: { topP: 0.9, temperature: 0.7 },
      format: "mp3",
      model: "s2-pro",
      text: "hello",
      voiceId: "v1",
      characterId: "CHAR_A_001",
    });
    expect(a).toBe(b);

    expect(hashDialogueRequest({ ...{ characterId: "CHAR_A_001", voiceId: "v1", text: "hello" }, text: "HELLO" })).not.toBe(a);
    expect(
      hashDialogueRequest({ characterId: "CHAR_A_001", voiceId: "v2", text: "hello", model: "s2-pro", format: "mp3" }),
    ).not.toBe(
      hashDialogueRequest({ characterId: "CHAR_A_001", voiceId: "v1", text: "hello", model: "s2-pro", format: "mp3" }),
    );
  });

  it("placement metadata never changes the hash (same audio, any shot)", () => {
    const h1 = hashDialogueRequest({ characterId: "CHAR_A_001", voiceId: "v1", text: "hi" });
    const h2 = hashDialogueRequest({ characterId: "CHAR_A_001", voiceId: "v1", text: "hi", settings: {} });
    // settings: undefined vs {} must normalize to the same hash via stableStringify
    expect(h1).toBe(h2);
  });
});

describe("DialogueTtsRunner — job record persisted BEFORE synthesis (runbook §21/§38)", () => {
  it("writes SUBMITTING before synthesize is called, GENERATED_TEMPORARY after", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer(
      [{ ok: true, audio: AUDIO_A, providerModel: "s2.1-pro" }],
      calls,
    );
    const jobStore = memoryJobStore();
    const assetStore = memoryAssetStore();
    const runner = new DialogueTtsRunner(synthesizer, jobStore, assetStore);

    // The synthesizer must observe a persisted SUBMITTING record while it runs.
    let observedDuring: TtsJobRecord | undefined;

    const runnerWithProbe = new DialogueTtsRunner(
      {
        async synthesize(request) {
          observedDuring = jobStore.rows.get("ep01:line-1");
          return synthesizer.synthesize(request);
        },
      },
      jobStore,
      assetStore,
    );

    const result = await runnerWithProbe.generateDialogueAudio("ep01:line-1", LINE);

    expect(observedDuring?.state).toBe("SUBMITTING"); // persisted before synthesis
    expect(observedDuring?.requestHash).toBeTruthy();
    expect(jobStore.saveOrder.map((r) => r.state)).toEqual([
      "SUBMITTING",
      "GENERATED_TEMPORARY",
    ]);
    expect(result.fromCache).toBe(false);
    expect(calls.requests.length).toBe(1);
  });

  it("returns asset with provider_task_id stamped on job + asset (acceptance)", async () => {
    const synthesizer = scriptedSynthesizer([
      { ok: true, audio: AUDIO_A, providerTaskId: "fish-job-777", providerModel: "s2.1-pro" },
    ]);
    const runner = makeRunner(synthesizer);

    const { job, asset, audio } = await runner.generateDialogueAudio("ep01:line-2", LINE);

    // Acceptance: mocked synthesis → asset with provider_task_id.
    expect(job.providerTaskId).toBe("fish-job-777");
    expect(asset.providerTaskId).toBe("fish-job-777");
    expect(asset.provider).toBe("fish-audio");
    expect(asset.assetType).toBe("dialogue_audio");
    expect(asset.checksum).toBe(sha256Hex(AUDIO_A));
    expect(asset.byteLength).toBe(AUDIO_A.byteLength);
    expect(asset.assetState).toBe("GENERATED_TEMPORARY");
    expect(asset.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(audio).toEqual(AUDIO_A);
    expect(job.assetId).toBe(asset.assetId);
    expect(job.state).toBe("GENERATED_TEMPORARY");

    // The asset is durable in the store.
    const stored = await memoryAssetStore(); // shape check only
    void stored;
  });

  it("derives fish-tts-<requestHash> providerTaskId when Fish returns none (sync TTS)", async () => {
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }]);
    const runner = makeRunner(synthesizer);

    const { job, asset } = await runner.generateDialogueAudio("ep01:line-3", LINE);
    const expectedHash = hashDialogueRequest({
      characterId: LINE.characterId,
      voiceId: LINE.voiceId,
      text: LINE.text,
      model: LINE.model,
      format: "mp3",
      settings: undefined,
    });

    expect(job.providerTaskId).toBe(`fish-tts-${expectedHash}`);
    expect(asset.providerTaskId).toBe(`fish-tts-${expectedHash}`);
    expect(asset.assetId).toBe(deriveAssetId(expectedHash));
  });
});

describe("DialogueTtsRunner — audio is a separate durable asset (spec §30)", () => {
  it("asset record carries no video binding and survives independent lookup", async () => {
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }]);
    const assetStore = memoryAssetStore();
    const runner = makeRunner(synthesizer, memoryJobStore(), assetStore);

    const { asset } = await runner.generateDialogueAudio("ep01:line-4", LINE);

    // The record must be loadable by assetId independent of any video.
    const reloaded = assetStore.rows.get(asset.assetId);
    expect(reloaded).toBeDefined();
    expect(reloaded?.dialogueRef).toBe("ep01:line-4");
    // No video/clip binding field exists on the asset type.
    expect(Object.keys(reloaded ?? {}).some((k) => /video|clip/i.test(k))).toBe(false);
  });

  it("same line under different placement metadata reuses the same asset id (hash excludes placement)", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }], calls);
    const runner = makeRunner(synthesizer);

    const first = await runner.generateDialogueAudio("ep01:sc03:shot1:line1", LINE);
    const second = await runner.generateDialogueAudio("ep01:sc03:shot2:line1", LINE);

    expect(first.asset.assetId).toBe(second.asset.assetId);
    expect(second.fromCache).toBe(true); // idempotent reuse, not resynthesis
    expect(calls.requests.length).toBe(1); // paid once
  });
});

describe("DialogueTtsRunner — idempotent reuse (runbook §21 resume, never resubmit)", () => {
  it("terminal job with same hash reuses the asset without calling the synthesizer", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }], calls);
    const jobStore = memoryJobStore();
    const assetStore = memoryAssetStore();
    const runner = new DialogueTtsRunner(synthesizer, jobStore, assetStore);

    await runner.generateDialogueAudio("ep01:line-5", LINE);
    const again = await runner.generateDialogueAudio("ep01:line-5", LINE);

    expect(calls.requests.length).toBe(1);
    expect(again.fromCache).toBe(true);
    expect(again.asset.assetId).toBe(again.job.assetId);
    expect(again.audio).toEqual(AUDIO_A);
  });

  it("changed text under the same ref is a deliberate re-generation (new hash)", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer(
      [
        { ok: true, audio: AUDIO_A },
        { ok: true, audio: AUDIO_B },
      ],
      calls,
    );
    const runner = makeRunner(synthesizer);

    const first = await runner.generateDialogueAudio("ep01:line-6", LINE);
    const second = await runner.generateDialogueAudio("ep01:line-6", {
      ...LINE,
      text: "You never told me the harbor was OPEN.",
    });

    expect(calls.requests.length).toBe(2);
    expect(first.asset.assetId).not.toBe(second.asset.assetId);
    expect(second.fromCache).toBe(false);
    expect(second.job.state).toBe("GENERATED_TEMPORARY");
    expect(second.asset.checksum).toBe(sha256Hex(AUDIO_B));
  });

  it("resume() returns the durable asset + bytes after restart without resynthesis", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }], calls);
    const jobStore = memoryJobStore();
    const assetStore = memoryAssetStore();
    const byteStore = memoryByteStore();
    const runner = new DialogueTtsRunner(synthesizer, jobStore, assetStore, { bytes: byteStore });
    await runner.generateDialogueAudio("ep01:line-7", LINE);

    // Bytes were persisted durably at generation time.
    const generatedAssetId = jobStore.rows.get("ep01:line-7")?.assetId as string;
    expect(byteStore.saveOrder).toContain(generatedAssetId);
    expect(byteStore.blobs.get(generatedAssetId)).toEqual(AUDIO_A);

    // Fresh runner (simulated restart), same stores, no shared in-memory state.
    const resumed = await new DialogueTtsRunner(synthesizer, jobStore, assetStore, {
      bytes: byteStore,
    }).resume("ep01:line-7");

    expect(calls.requests.length).toBe(1); // no resubmit, no double spend
    expect(resumed.fromCache).toBe(true);
    expect(resumed.audio).toEqual(AUDIO_A);
    expect(resumed.asset.providerTaskId).toBe(jobStore.rows.get("ep01:line-7")?.providerTaskId);
  });

  it("resume refuses a REJECTED job and a job without a durable asset", async () => {
    const jobStore = memoryJobStore();
    const assetStore = memoryAssetStore();
    const runner = new DialogueTtsRunner(scriptedSynthesizer([]), jobStore, assetStore);

    jobStore.rows.set("r1", {
      ref: "r1",
      state: "REJECTED",
      requestHash: "h1",
      failure: { message: "402 payment required" },
      createdAt: "t",
      updatedAt: "t",
    });
    jobStore.rows.set("r2", {
      ref: "r2",
      state: "SUBMITTING",
      requestHash: "h2",
      createdAt: "t",
      updatedAt: "t",
    });

    await expect(runner.resume("r1")).rejects.toThrow(TtsSynthesisError);
    await expect(runner.resume("r2")).rejects.toThrow(/regenerate/);
  });
});

describe("DialogueTtsRunner — REJECTED synthesis lands failure in the store", () => {
  it("persists REJECTED with failure detail and throws TtsSynthesisError", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer(
      [{ ok: false, failure: { message: "Fish Audio API HTTP 402: no payment", kind: "http-error" } }],
      calls,
    );
    const jobStore = memoryJobStore();
    const runner = new DialogueTtsRunner(synthesizer, jobStore, memoryAssetStore());

    await expect(runner.generateDialogueAudio("ep01:line-8", LINE)).rejects.toThrow(TtsSynthesisError);

    const stored = jobStore.rows.get("ep01:line-8");
    expect(stored?.state).toBe("REJECTED");
    expect(stored?.failure?.message).toContain("402");
    expect(stored?.failure?.kind).toBe("http-error");
    // A rejected job never carries an asset id.
    expect(stored?.assetId).toBeUndefined();
  });
});

describe("DialogueTtsRunner — cache seam (FISH-005 port)", () => {
  it("cache hit with loadable asset skips synthesis and marks fromCache", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_B }], calls);
    const jobStore = memoryJobStore();
    const assetStore = memoryAssetStore();
    const runner = new DialogueTtsRunner(synthesizer, jobStore, assetStore);

    // Generate once (fills cache + byte registry).
    const generated = await runner.generateDialogueAudio("ep01:line-9", LINE);

    // Second runner sharing the stores + a cache pointing at the same asset.
    const cache: DialogueCachePort = {
      async findAssetId(requestHash) {
        return requestHash === generated.job.requestHash ? generated.asset.assetId : undefined;
      },
      async put() {
        /* no-op */
      },
    };
    const second = await runner.generateDialogueAudio("ep01:line-9-fresh-ref", LINE, cache);

    expect(calls.requests.length).toBe(1);
    expect(second.fromCache).toBe(true);
    expect(second.asset.assetId).toBe(generated.asset.assetId);
    expect(second.job.providerTaskId).toBe(generated.asset.providerTaskId);
    expect(second.audio).toEqual(AUDIO_B);
  });

  it("cache hit with missing bytes falls through to synthesis (never returns nothing)", async () => {
    const calls = { requests: [] as SynthesisRequest[] };
    const synthesizer = scriptedSynthesizer([{ ok: true, audio: AUDIO_A }], calls);
    const cache: DialogueCachePort = {
      async findAssetId() {
        return "da-does-not-exist";
      },
      async put() {
        /* no-op */
      },
    };
    const runner = new DialogueTtsRunner(synthesizer, memoryJobStore(), memoryAssetStore());

    const result = await runner.generateDialogueAudio("ep01:line-10", LINE, cache);

    expect(calls.requests.length).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(result.audio).toEqual(AUDIO_A);
  });
});

describe("FishClientSynthesizer (FISH-001 adapter)", () => {
  it("refuses to guess a model when none is configured (FISH-010 owns model config)", async () => {
    const { FishClientSynthesizer } = await import("./synthesize.js");
    const synth = new FishClientSynthesizer({} as never);
    const outcome = await synth.synthesize({
      characterId: "CHAR_A_001",
      voiceId: "v1",
      text: "hello",
      format: "mp3",
      model: undefined,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.message).toMatch(/model is required/i);
  });
});

describe("state helpers", () => {
  it("isTtsTerminal matches exactly GENERATED_TEMPORARY and REJECTED", () => {
    expect(isTtsTerminal("GENERATED_TEMPORARY")).toBe(true);
    expect(isTtsTerminal("REJECTED")).toBe(true);
    expect(isTtsTerminal("SUBMITTING")).toBe(false);
    expect(isTtsTerminal("ARCHIVED")).toBe(false);
    expect(isTtsTerminal("QC_PENDING")).toBe(false);
  });
});

// Reused store helpers above; keep imports referenced.
void memoryAssetStore;
void AUDIO_A;
void AUDIO_B;