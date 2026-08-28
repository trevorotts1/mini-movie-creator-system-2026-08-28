/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { extractAlignment } from "./extract.js";
import type { FishAlignmentPayload } from "./types.js";
import {
  FishAlignmentStore,
  parseAlignmentDoc,
} from "./store.js";
import { isCurrentDialogueAssetKey } from "./key.js";
import type { FishDialogueAlignment } from "./types.js";

// ---------------------------------------------------------------------------
// Known-alignment fixture: "The door opens." spoken over 1.2s of audio.
// Provider payload arrives in SECONDS with fractional times (the harder
// normalization path); the expected canonical record is spelled out in full.
// ---------------------------------------------------------------------------

const FIXTURE_KEY =
  "fsh1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const FIXTURE_TEXT = "The door opens.";

const FIXTURE_MODEL = "s2-pro";

const FIXED_NOW = new Date("2026-08-28T13:20:00.000Z");

const fixturePayload: FishAlignmentPayload = {
  text: FIXTURE_TEXT,
  duration: 1.25,
  timeUnit: "s",
  words: [
    {
      word: "The",
      start: 0.02,
      end: 0.18,
      phonemes: [
        { phoneme: "DH", start: 0.02, end: 0.08 },
        { phoneme: "AH", start: 0.08, end: 0.18 },
      ],
    },
    // Deliberately out of order in the payload — extraction must sort.
    {
      word: "opens.",
      start: 0.62,
      end: 1.2,
      phonemes: [
        { phoneme: "OW", start: 0.62, end: 0.75 },
        { phoneme: "P", start: 0.75, end: 0.83 },
        { phoneme: "AH", start: 0.83, end: 0.93 },
        { phoneme: "N", start: 0.93, end: 1.05 },
        { phoneme: "Z", start: 1.05, end: 1.2 },
      ],
    },
    {
      word: "door",
      start: 0.22,
      end: 0.58,
      phonemes: [
        { phoneme: "D", start: 0.22, end: 0.3 },
        { phoneme: "AO", start: 0.3, end: 0.48 },
        { phoneme: "R", start: 0.48, end: 0.58 },
      ],
    },
  ],
};

/** The expected canonical record, spelled out word by word. */
function expectedFixtureAlignment(
  extractedAt: string,
): FishDialogueAlignment {
  return {
    key: FIXTURE_KEY,
    text: FIXTURE_TEXT,
    model: FIXTURE_MODEL,
    source: "provider_response",
    words: [
      {
        word: "The",
        startMs: 20,
        endMs: 180,
        phonemes: [
          { phoneme: "DH", startMs: 20, endMs: 80 },
          { phoneme: "AH", startMs: 80, endMs: 180 },
        ],
      },
      {
        word: "door",
        startMs: 220,
        endMs: 580,
        phonemes: [
          { phoneme: "D", startMs: 220, endMs: 300 },
          { phoneme: "AO", startMs: 300, endMs: 480 },
          { phoneme: "R", startMs: 480, endMs: 580 },
        ],
      },
      {
        word: "opens.",
        startMs: 620,
        endMs: 1200,
        phonemes: [
          { phoneme: "OW", startMs: 620, endMs: 750 },
          { phoneme: "P", startMs: 750, endMs: 830 },
          { phoneme: "AH", startMs: 830, endMs: 930 },
          { phoneme: "N", startMs: 930, endMs: 1050 },
          { phoneme: "Z", startMs: 1050, endMs: 1200 },
        ],
      },
    ],
    durationMs: 1250,
    extractedAt,
  };
}

// ---------------------------------------------------------------------------
// In-memory fs for store tests (mirrors the sibling stores' seam).
// ---------------------------------------------------------------------------

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: string[] = [];
  return {
    files,
    ops,
    fs: {
      async readFile(p: string) {
        const v = files.get(p);
        if (v === undefined) {
          const err = new Error(`ENOENT: ${p}`) as Error & { code?: string };
          err.code = "ENOENT";
          throw err;
        }
        return v;
      },
      async writeFile(p: string, data: string) {
        ops.push(`write:${p}`);
        files.set(p, data);
      },
      async mkdir() {
        return undefined;
      },
      async rename(a: string, b: string) {
        ops.push(`rename:${a}->${b}`);
        const v = files.get(a);
        if (v !== undefined) {
          files.set(b, v);
          files.delete(a);
        }
      },
    },
  };
}

function extractFixture(): FishDialogueAlignment {
  return extractAlignment(fixturePayload, {
    key: FIXTURE_KEY,
    model: FIXTURE_MODEL,
    now: () => FIXED_NOW,
  });
}

// ---------------------------------------------------------------------------

describe("isCurrentDialogueAssetKey", () => {
  it("accepts the fsh1 cache-key format", () => {
    expect(isCurrentDialogueAssetKey(FIXTURE_KEY)).toBe(true);
  });

  it("rejects wrong version, bad hex, and non-key strings", () => {
    expect(isCurrentDialogueAssetKey("fsh2:aaaa")).toBe(false);
    expect(isCurrentDialogueAssetKey("fsh1:ZZZZ")).toBe(false);
    expect(isCurrentDialogueAssetKey("fsh1:abc")).toBe(false);
    expect(isCurrentDialogueAssetKey("../../etc/passwd")).toBe(false);
    expect(isCurrentDialogueAssetKey("The door opens.")).toBe(false);
    expect(isCurrentDialogueAssetKey("")).toBe(false);
  });
});

describe("extractAlignment (known-alignment fixture)", () => {
  it("normalizes the fixture to the exact expected record", () => {
    const alignment = extractFixture();
    expect(alignment).toEqual(expectedFixtureAlignment(FIXED_NOW.toISOString()));
  });

  it("sorts words by start time despite out-of-order payload", () => {
    const alignment = extractFixture();
    expect(alignment.words.map((w) => w.word)).toEqual(["The", "door", "opens."]);
  });

  it("converts seconds to integer milliseconds", () => {
    const alignment = extractFixture();
    expect(alignment.words[0]).toEqual({
      word: "The",
      startMs: 20,
      endMs: 180,
      phonemes: [
        { phoneme: "DH", startMs: 20, endMs: 80 },
        { phoneme: "AH", startMs: 80, endMs: 180 },
      ],
    });
  });

  it("uses the payload duration when it covers the words", () => {
    const alignment = extractFixture();
    expect(alignment.durationMs).toBe(1250);
    expect(alignment.durationMs).toBeGreaterThanOrEqual(
      alignment.words[alignment.words.length - 1]!.endMs,
    );
  });

  it("falls back to the last word end when duration is absent", () => {
    const { duration: _duration, ...noDuration } = fixturePayload;
    const alignment = extractAlignment(noDuration, {
      key: FIXTURE_KEY,
      now: () => FIXED_NOW,
    });
    expect(alignment.durationMs).toBe(1200);
  });

  it("keeps equal-timestamp words in provider order (stable sort)", () => {
    const alignment = extractAlignment(
      {
        words: [
          { word: "b", start: 100, end: 200 },
          { word: "a", start: 100, end: 200 },
          { word: "c", start: 0, end: 50 },
        ],
        text: FIXTURE_TEXT,
      },
      { key: FIXTURE_KEY, now: () => FIXED_NOW },
    );
    expect(alignment.words.map((w) => w.word)).toEqual(["c", "b", "a"]);
  });

  it("normalizes ms payloads without change", () => {
    const alignment = extractAlignment(
      {
        words: [{ word: "yes", start: 0, end: 250 }],
        text: FIXTURE_TEXT,
        duration: 300,
        timeUnit: "ms",
      },
      { key: FIXTURE_KEY, now: () => FIXED_NOW },
    );
    expect(alignment.words[0]!.startMs).toBe(0);
    expect(alignment.words[0]!.endMs).toBe(250);
    expect(alignment.durationMs).toBe(300);
  });

  it("preserves multi-voice speaker indices (S2 dialogue)", () => {
    const alignment = extractAlignment(
      {
        words: [
          { word: "Hello", start: 0, end: 100, speaker: 0 },
          { word: "Hi", start: 150, end: 220, speaker: 1 },
        ],
        text: "Hello Hi",
      },
      { key: FIXTURE_KEY, now: () => FIXED_NOW },
    );
    expect(alignment.words[0]!.speaker).toBe(0);
    expect(alignment.words[1]!.speaker).toBe(1);
  });

  it("records a transcription source when told to", () => {
    const alignment = extractAlignment(fixturePayload, {
      key: FIXTURE_KEY,
      source: "transcription",
      now: () => FIXED_NOW,
    });
    expect(alignment.source).toBe("transcription");
  });

  it("prefers options.text (original script) over payload.text", () => {
    const alignment = extractAlignment(fixturePayload, {
      key: FIXTURE_KEY,
      text: "Original script text.",
      now: () => FIXED_NOW,
    });
    expect(alignment.text).toBe("Original script text.");
  });

  it("throws with precise messages on malformed payloads", () => {
    const base = { key: FIXTURE_KEY, now: () => FIXED_NOW };
    expect(() => extractAlignment(null as unknown as FishAlignmentPayload, base)).toThrow(
      /payload must be an object/,
    );
    expect(() => extractAlignment({ words: [] }, base)).toThrow(
      /alignment text is required/,
    );
    expect(() =>
      extractAlignment({ text: FIXTURE_TEXT } as unknown as FishAlignmentPayload, base),
    ).toThrow(/words must be an array/);
    expect(() =>
      extractAlignment(
        { text: FIXTURE_TEXT, words: [{ word: "x", start: "a", end: 1 } as never] },
        base,
      ),
    ).toThrow(/words\[0\]\.start\/\.end must be finite numbers/);
    expect(() =>
      extractAlignment(
        { text: FIXTURE_TEXT, words: [{ word: "", start: 0, end: 1 }] },
        base,
      ),
    ).toThrow(/words\[0\]\.word is required/);
    expect(() =>
      extractAlignment(
        { text: FIXTURE_TEXT, words: [{ word: "x", start: 200, end: 100 }] },
        base,
      ),
    ).toThrow(/words\[0\]: end \(100ms\) is before start \(200ms\)/);
    expect(() =>
      extractAlignment(
        { text: FIXTURE_TEXT, words: [], timeUnit: "parsec" as never },
        base,
      ),
    ).toThrow(/timeUnit is unsupported/);
    expect(() =>
      extractAlignment(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", start: 0, end: 100 }],
          duration: 50,
        },
        base,
      ),
    ).toThrow(/duration \(50ms\) is less than the last word end \(100ms\)/);
    expect(() =>
      extractAlignment(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", start: 0, end: 100, speaker: -1 }],
        },
        base,
      ),
    ).toThrow(/speaker must be a non-negative integer/);
  });

  it("throws on a missing or blank key", () => {
    expect(() =>
      extractAlignment({ words: [], text: "x" }, { key: "  ", now: () => FIXED_NOW }),
    ).toThrow(/options\.key is required/);
  });

  it("never treats NaN times as valid", () => {
    expect(() =>
      extractAlignment(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", start: Number.NaN, end: 100 }],
        },
        { key: FIXTURE_KEY, now: () => FIXED_NOW },
      ),
    ).toThrow(/must be finite numbers/);
  });

  it("rejects negative word times (regression: negative -0.001s rounded to 0)", () => {
    expect(() =>
      extractAlignment(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", start: -0.001, end: 0.1 }],
          timeUnit: "s",
        },
        { key: FIXTURE_KEY, now: () => FIXED_NOW },
      ),
    ).toThrow(/must be non-negative/);
    expect(() =>
      extractAlignment(
        { text: FIXTURE_TEXT, words: [], duration: -0.001 },
        { key: FIXTURE_KEY, now: () => FIXED_NOW },
      ),
    ).toThrow(/must be non-negative/);
  });

  it("rejects an invalid source value (regression: untyped value passed straight through)", () => {
    expect(() =>
      extractAlignment(fixturePayload, {
        key: FIXTURE_KEY,
        source: "caption-import" as never,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/options\.source/);
  });
});

describe("FishAlignmentStore", () => {
  function makeStore(initial: Record<string, string> = {}) {
    const mem = memoryFs(initial);
    const store = new FishAlignmentStore({
      directory: "/tmp/test-alignment",
      fs: mem.fs,
    });
    return { mem, store };
  }

  it("saves, lists as present, and reads back the known fixture record", async () => {
    const { mem, store } = makeStore();
    const alignment = extractFixture();

    await store.save(alignment);

    expect(await store.has(FIXTURE_KEY)).toBe(true);
    const loaded = await store.getByKey(FIXTURE_KEY);
    expect(loaded).not.toBeNull();
    // Full record round-trips exactly (known-alignment persistence proof).
    expect(loaded).toEqual(alignment);
    // The file is named by the validated digest key only.
    expect(mem.files.has(`/tmp/test-alignment/${FIXTURE_KEY}.json`)).toBe(true);
    // Temp file was renamed away (atomic write path).
    expect(mem.ops.some((op) => op.startsWith("rename:"))).toBe(true);
  });

  it("returns null for a missing asset key (and for a malformed key)", async () => {
    const { store } = makeStore();
    expect(await store.getByKey(FIXTURE_KEY)).toBeNull();
    expect(await store.getByKey("not-a-key")).toBeNull();
    expect(await store.has("not-a-key")).toBe(false);
  });

  it("refuses to double-save a key; replace() overwrites", async () => {
    const { store } = makeStore();
    const alignment = extractFixture();
    await store.save(alignment);

    const reextracted = extractAlignment(fixturePayload, {
      key: FIXTURE_KEY,
      now: () => new Date("2026-08-28T15:00:00.000Z"),
    });
    await expect(store.save(reextracted)).rejects.toThrow(
      /already exists for dialogue asset .* — use replace\(\)/,
    );

    await store.replace(reextracted);
    const loaded = await store.getByKey(FIXTURE_KEY);
    expect(loaded!.extractedAt).toBe("2026-08-28T15:00:00.000Z");
    expect(loaded!.extractedAt).not.toBe(alignment.extractedAt);
  });

  it("rejects saving a record with an invalid key (path safety)", async () => {
    const { store } = makeStore();
    const bad = { ...extractFixture(), key: "../../escape" } as FishDialogueAlignment;
    await expect(store.save(bad)).rejects.toThrow(/Not a valid dialogue asset key/);
  });

  it("rejects a blank directory at construction", () => {
    expect(() => new FishAlignmentStore({ directory: "  " })).toThrow(
      /directory is required/,
    );
  });

  it("throws a clear error on a malformed stored document", async () => {
    const { store } = makeStore({
      [`/tmp/test-alignment/${FIXTURE_KEY}.json`]: "not json at all",
    });
    await expect(store.getByKey(FIXTURE_KEY)).rejects.toThrow(/not valid JSON/);

    const mem2 = memoryFs({
      [`/tmp/test-alignment/${FIXTURE_KEY}.json`]: JSON.stringify({
        formatVersion: 2,
        alignment: {},
      }),
    });
    const store2 = new FishAlignmentStore({
      directory: "/tmp/test-alignment",
      fs: mem2.fs,
    });
    await expect(store2.getByKey(FIXTURE_KEY)).rejects.toThrow(/malformed/);
  });

  it("throws on a stored document missing text (FISH-007 loader rejects it too)", async () => {
    // A record without a text field would pass the writer's structural check
    // but crash the FISH-007 caption loader downstream — the writer must
    // reject it as malformed (defect regression: parser checked key+words
    // only, not text).
    const mem = memoryFs({
      [`/tmp/test-alignment/${FIXTURE_KEY}.json`]: JSON.stringify({
        formatVersion: 1,
        alignment: { key: FIXTURE_KEY, words: [], durationMs: 0, source: "provider_response", extractedAt: "x" },
      }),
    });
    const store = new FishAlignmentStore({
      directory: "/tmp/test-alignment",
      fs: mem.fs,
    });
    await expect(store.getByKey(FIXTURE_KEY)).rejects.toThrow(/malformed/);
  });

  it("parseAlignmentDoc round-trips the fixture document verbatim", () => {
    const doc = `JSON:${JSON.stringify({
      formatVersion: 1,
      alignment: extractFixture(),
    })}`.replace("JSON:", "");
    const parsed = parseAlignmentDoc(doc, "/tmp/x.json");
    expect(parsed).toEqual(extractFixture());
  });
});

describe("FISH-007 hand-off shape", () => {
  it("exposes word start/end ms and phonemes a caption builder needs", () => {
    const alignment = extractFixture();
    // FISH-007 consumes: key, text, words[] with startMs/endMs, durationMs.
    const captionable = alignment.words.every(
      (w) =>
        typeof w.word === "string" &&
        Number.isInteger(w.startMs) &&
        Number.isInteger(w.endMs) &&
        w.startMs <= w.endMs,
    );
    expect(captionable).toBe(true);
    expect(alignment.words[0]!.phonemes).toBeDefined();
    expect(alignment.text).toBe(FIXTURE_TEXT);
    expect(alignment.key).toBe(FIXTURE_KEY);
    expect(alignment.durationMs).toBe(1250);
  });
});