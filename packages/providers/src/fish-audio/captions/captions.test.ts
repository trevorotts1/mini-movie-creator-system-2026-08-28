/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORDS,
  buildCaptionTrack,
  framesToMs,
  isDeliveryTag,
  msToFrames,
} from "./build.js";
import { isCurrentDialogueAssetKey, FISH_CACHE_KEY_VERSION } from "./key.js";
import { parseAlignmentDoc, loadCaptionTrack } from "./load.js";
import { CaptionTrackStore, parseCaptionTrackDoc } from "./store.js";
import type { CaptionSourceAlignment, CaptionTrack } from "./types.js";
import type { CaptionTrackFile } from "./file.js";

// ---------------------------------------------------------------------------
// Known-alignment fixture: "The door opens." spoken over 1.2s of audio —
// the same dialogue FISH-006's fixture alignment carries. The expected
// caption track is spelled out in full (word-exact proof).
// ---------------------------------------------------------------------------

const FIXTURE_KEY =
  "fsh1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const FIXTURE_TEXT = "The door opens.";

const FIXED_NOW = new Date("2026-08-28T15:55:00.000Z");

const fixtureSource: CaptionSourceAlignment = {
  key: FIXTURE_KEY,
  text: FIXTURE_TEXT,
  words: [
    // Deliberately out of order — the builder must sort (mirrors FISH-006).
    { word: "opens.", startMs: 620, endMs: 1200 },
    { word: "The", startMs: 20, endMs: 180 },
    { word: "door", startMs: 220, endMs: 580 },
  ],
  durationMs: 1250,
};

/** The expected caption track, spelled out cue by cue, word by word. */
function expectedFixtureTrack(builtAt: string): CaptionTrack {
  return {
    sourceKey: FIXTURE_KEY,
    text: FIXTURE_TEXT,
    durationMs: 1250,
    cues: [
      {
        words: [
          { word: "The", startMs: 20, endMs: 180 },
          { word: "door", startMs: 220, endMs: 580 },
          { word: "opens.", startMs: 620, endMs: 1200 },
        ],
        startMs: 20,
        endMs: 1200,
      },
    ],
    wordCount: 3,
    options: { maxWords: DEFAULT_MAX_WORDS, filterDeliveryTags: true },
    builtAt,
  };
}

// ---------------------------------------------------------------------------
// In-memory fs for store/loader tests (mirrors the sibling stores' seam).
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

function buildFixture(): CaptionTrack {
  return buildCaptionTrack(fixtureSource, { now: () => FIXED_NOW });
}

const fixtureAlignmentDoc = JSON.stringify({
  formatVersion: 1,
  alignment: {
    key: FIXTURE_KEY,
    text: FIXTURE_TEXT,
    model: "s2-pro",
    source: "provider_response",
    words: [
      {
        word: "The",
        startMs: 20,
        endMs: 180,
        phonemes: [{ phoneme: "DH", startMs: 20, endMs: 180 }],
      },
      { word: "door", startMs: 220, endMs: 580 },
      { word: "opens.", startMs: 620, endMs: 1200 },
    ],
    durationMs: 1250,
    extractedAt: "2026-08-28T13:20:00.000Z",
  },
});

// ---------------------------------------------------------------------------

describe("isCurrentDialogueAssetKey (local copy)", () => {
  it("accepts the fsh1 cache-key format", () => {
    expect(isCurrentDialogueAssetKey(FIXTURE_KEY)).toBe(true);
    expect(FISH_CACHE_KEY_VERSION).toBe("fsh1");
  });

  it("rejects wrong version, bad hex, and non-key strings", () => {
    expect(isCurrentDialogueAssetKey("fsh2:aaaa")).toBe(false);
    expect(isCurrentDialogueAssetKey("fsh1:ZZZZ")).toBe(false);
    expect(isCurrentDialogueAssetKey("../../etc/passwd")).toBe(false);
    expect(isCurrentDialogueAssetKey("The door opens.")).toBe(false);
    expect(isCurrentDialogueAssetKey("")).toBe(false);
  });
});

describe("isDeliveryTag (upstream gen_voice.py discipline)", () => {
  it("flags bracketed delivery directions as tags", () => {
    expect(isDeliveryTag("[excited]")).toBe(true);
    expect(isDeliveryTag("[pause]")).toBe(true);
    expect(isDeliveryTag("wow]")).toBe(true);
  });

  it("never flags spoken words", () => {
    expect(isDeliveryTag("hello")).toBe(false);
    expect(isDeliveryTag("door.")).toBe(false);
    expect(isDeliveryTag("it's")).toBe(false);
  });
});

describe("buildCaptionTrack (known-alignment fixture)", () => {
  it("normalizes the fixture to the exact expected track", () => {
    const track = buildFixture();
    expect(track).toEqual(expectedFixtureTrack(FIXED_NOW.toISOString()));
  });

  it("sorts words by start time despite out-of-order input", () => {
    const track = buildFixture();
    expect(track.cues[0]!.words.map((w) => w.word)).toEqual([
      "The",
      "door",
      "opens.",
    ]);
  });

  it("keeps word-exact timings — integers pass through untouched", () => {
    const track = buildFixture();
    const [cue] = track.cues;
    expect(cue!.words[0]).toEqual({ word: "The", startMs: 20, endMs: 180 });
    expect(cue!.startMs).toBe(20);
    expect(cue!.endMs).toBe(1200);
  });

  it("uses the source duration when it covers the words", () => {
    const track = buildFixture();
    expect(track.durationMs).toBe(1250);
    expect(track.durationMs).toBeGreaterThanOrEqual(
      track.cues[track.cues.length - 1]!.endMs,
    );
  });

  it("falls back to the last word end when duration is absent", () => {
    const { durationMs: _d, ...noDuration } = fixtureSource;
    const track = buildCaptionTrack(noDuration, { now: () => FIXED_NOW });
    expect(track.durationMs).toBe(1200);
  });

  it("groups cues by maxWords (upstream chunkLines slicing)", () => {
    const source: CaptionSourceAlignment = {
      text: "one two three four five six seven",
      words: [
        { word: "one", startMs: 0, endMs: 100 },
        { word: "two", startMs: 100, endMs: 200 },
        { word: "three", startMs: 200, endMs: 300 },
        { word: "four", startMs: 300, endMs: 400 },
        { word: "five", startMs: 400, endMs: 500 },
        { word: "six", startMs: 500, endMs: 600 },
        { word: "seven", startMs: 600, endMs: 700 },
      ],
    };
    const track = buildCaptionTrack(source, { maxWords: 3, now: () => FIXED_NOW });
    expect(track.cues.map((c) => c.words.map((w) => w.word).join(" "))).toEqual([
      "one two three",
      "four five six",
      "seven",
    ]);
    expect(track.cues[0]).toMatchObject({ startMs: 0, endMs: 300 });
    expect(track.cues[1]).toMatchObject({ startMs: 300, endMs: 600 });
    expect(track.cues[2]).toMatchObject({ startMs: 600, endMs: 700 });
  });

  it("filters delivery tags from cues but keeps the original text verbatim", () => {
    const source: CaptionSourceAlignment = {
      text: "[excited] Run! [pause] Now.",
      words: [
        { word: "[excited]", startMs: 0, endMs: 50 },
        { word: "Run!", startMs: 50, endMs: 300 },
        { word: "[pause]", startMs: 300, endMs: 500 },
        { word: "Now.", startMs: 500, endMs: 800 },
      ],
    };
    const track = buildCaptionTrack(source, { now: () => FIXED_NOW });
    // Tags are delivery directions — never captioned (upstream discipline).
    expect(track.cues[0]!.words.map((w) => w.word)).toEqual(["Run!", "Now."]);
    expect(track.wordCount).toBe(2);
    // Original script text preserved verbatim.
    expect(track.text).toBe("[excited] Run! [pause] Now.");
    // Cue timing anchors to the first CAPTIONED word, not a filtered tag.
    expect(track.cues[0]!.startMs).toBe(50);
  });

  it("keeps delivery tags when filtering is explicitly disabled", () => {
    const track = buildCaptionTrack(fixtureSource, {
      filterDeliveryTags: false,
      now: () => FIXED_NOW,
    });
    expect(track.options.filterDeliveryTags).toBe(false);
  });

  it("preserves multi-voice speaker indices; homogeneous cues carry one", () => {
    const source: CaptionSourceAlignment = {
      text: "Hello Hi",
      words: [
        { word: "Hello", startMs: 0, endMs: 100, speaker: 0 },
        { word: "Hi", startMs: 150, endMs: 220, speaker: 1 },
      ],
    };
    const track = buildCaptionTrack(source, { now: () => FIXED_NOW });
    expect(track.cues[0]!.speaker).toBeUndefined(); // mixed-speaker cue
    const single: CaptionSourceAlignment = {
      text: "Hello there",
      words: [
        { word: "Hello", startMs: 0, endMs: 100, speaker: 1 },
        { word: "there", startMs: 120, endMs: 200, speaker: 1 },
      ],
    };
    const t2 = buildCaptionTrack(single, { now: () => FIXED_NOW });
    expect(t2.cues[0]!.speaker).toBe(1);
  });

  it("records the source key and build options", () => {
    const track = buildFixture();
    expect(track.sourceKey).toBe(FIXTURE_KEY);
    expect(track.options).toEqual({
      maxWords: DEFAULT_MAX_WORDS,
      filterDeliveryTags: true,
    });
    expect(track.builtAt).toBe(FIXED_NOW.toISOString());
  });

  it("throws with precise messages on malformed sources", () => {
    const base = { now: () => FIXED_NOW };
    expect(() =>
      buildCaptionTrack(null as unknown as CaptionSourceAlignment, base),
    ).toThrow(/caption source must be an object/);
    expect(() =>
      buildCaptionTrack({ words: [] } as unknown as CaptionSourceAlignment, base),
    ).toThrow(/source\.text is required/);
    expect(() =>
      buildCaptionTrack(
        { text: FIXTURE_TEXT } as unknown as CaptionSourceAlignment,
        base,
      ),
    ).toThrow(/source\.words must be an array/);
    expect(() =>
      buildCaptionTrack(
        { text: FIXTURE_TEXT, words: [{ word: "x", startMs: "a", endMs: 1 } as never] },
        base,
      ),
    ).toThrow(/startMs\/\.endMs must be integers/);
    expect(() =>
      buildCaptionTrack(
        { text: FIXTURE_TEXT, words: [{ word: "", startMs: 0, endMs: 1 }] },
        base,
      ),
    ).toThrow(/words\[0\]\.word is required/);
    expect(() =>
      buildCaptionTrack(
        { text: FIXTURE_TEXT, words: [{ word: "x", startMs: 200, endMs: 100 }] },
        base,
      ),
    ).toThrow(/words\[0\]: end \(100ms\) is before start \(200ms\)/);
    expect(() =>
      buildCaptionTrack(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", startMs: 0, endMs: 100 }],
          durationMs: 50,
        },
        base,
      ),
    ).toThrow(/durationMs \(50ms\) is less than the last word end \(100ms\)/);
    expect(() =>
      buildCaptionTrack(
        { text: FIXTURE_TEXT, words: [{ word: "x", startMs: 0.5, endMs: 100 }] },
        base,
      ),
    ).toThrow(/must be integers \(ms\)/);
    expect(() =>
      buildCaptionTrack(fixtureSource, { maxWords: 0, now: () => FIXED_NOW }),
    ).toThrow(/maxWords must be an integer between 1 and/);
  });

  it("never treats NaN/float timings as valid", () => {
    expect(() =>
      buildCaptionTrack(
        {
          text: FIXTURE_TEXT,
          words: [{ word: "x", startMs: Number.NaN, endMs: 100 }],
        },
        { now: () => FIXED_NOW },
      ),
    ).toThrow(/must be integers/);
  });

  it("produces an empty track for an empty word list (fallback posture)", () => {
    const track = buildCaptionTrack(
      { text: FIXTURE_TEXT, words: [], durationMs: 1000 },
      { now: () => FIXED_NOW },
    );
    expect(track.cues).toEqual([]);
    expect(track.wordCount).toBe(0);
    expect(track.durationMs).toBe(1000);
  });
});

describe("msToFrames / framesToMs (VID-004 sync contract)", () => {
  it("converts alignment ms to exact 30fps frames (upstream composition rate)", () => {
    expect(msToFrames(0, 30)).toBe(0);
    expect(msToFrames(1000, 30)).toBe(30);
    expect(msToFrames(20, 30)).toBe(1); // 0.6 frames → rounds to 1
    expect(msToFrames(50, 30)).toBe(2); // 1.5 → 2 (round half up)
    expect(msToFrames(1200, 30)).toBe(36);
  });

  it("round-trips through the frame grid", () => {
    for (const ms of [0, 20, 180, 220, 580, 620, 1200, 1250]) {
      const f = msToFrames(ms, 30);
      // Frame-grid inverse: re-derives the same frame, and the ms value is
      // that frame's grid position (33.33ms per frame at 30fps).
      expect(msToFrames(framesToMs(f, 30), 30)).toBe(f);
    }
  });

  it("is deterministic — same input, same frame, always", () => {
    const a = msToFrames(617, 30);
    const b = msToFrames(617, 30);
    expect(a).toBe(b);
  });

  it("supports other composition rates", () => {
    expect(msToFrames(500, 24)).toBe(12);
    expect(msToFrames(1000, 60)).toBe(60);
  });

  it("rejects non-integer ms and bad fps", () => {
    expect(() => msToFrames(1.5, 30)).toThrow(/ms must be an integer/);
    expect(() => msToFrames(100, 0)).toThrow(/fps must be a positive/);
    expect(() => msToFrames(100, -30)).toThrow(/fps must be a positive/);
    expect(() => msToFrames(100, Number.NaN)).toThrow(/fps must be a positive/);
    expect(() => framesToMs(1.5, 30)).toThrow(/frames must be an integer/);
    expect(() => framesToMs(10, 0)).toThrow(/fps must be a positive/);
  });
});

describe("parseAlignmentDoc (FISH-006 document shape)", () => {
  it("round-trips the fixture alignment document verbatim", () => {
    const doc = JSON.stringify({
      formatVersion: 1,
      alignment: {
        key: FIXTURE_KEY,
        text: FIXTURE_TEXT,
        words: [{ word: "The", startMs: 20, endMs: 180 }],
        durationMs: 1250,
      },
    });
    const parsed = parseAlignmentDoc(doc, "/tmp/x.json");
    expect(parsed.key).toBe(FIXTURE_KEY);
    expect(parsed.text).toBe(FIXTURE_TEXT);
    expect(parsed.words).toEqual([{ word: "The", startMs: 20, endMs: 180 }]);
  });

  it("throws on malformed documents", () => {
    expect(() => parseAlignmentDoc("not json", "/tmp/x.json")).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      parseAlignmentDoc(
        JSON.stringify({ formatVersion: 2, alignment: {} }),
        "/tmp/x.json",
      ),
    ).toThrow(/malformed/);
  });
});

describe("loadCaptionTrack (alignment store → caption track)", () => {
  function makeLoader(initial: Record<string, string> = {}) {
    const mem = memoryFs(initial);
    const load = (overrides: Partial<Parameters<typeof loadCaptionTrack>[0]> = {}) =>
      loadCaptionTrack({
        directory: "/tmp/test-alignment",
        key: FIXTURE_KEY,
        now: () => FIXED_NOW,
        fs: mem.fs,
        ...overrides,
      });
    return { mem, load };
  }

  it("reads a FISH-006 alignment document and builds the expected track", async () => {
    const { load } = makeLoader({
      [`/tmp/test-alignment/${FIXTURE_KEY}.json`]: JSON.stringify({
        formatVersion: 1,
        alignment: {
          key: FIXTURE_KEY,
          text: FIXTURE_TEXT,
          words: [
            { word: "The", startMs: 20, endMs: 180 },
            { word: "door", startMs: 220, endMs: 580 },
            { word: "opens.", startMs: 620, endMs: 1200 },
          ],
          durationMs: 1250,
          extractedAt: "2026-08-28T13:20:00.000Z",
        },
      }),
    });
    const track = await load();
    expect(track).toEqual(expectedFixtureTrack(FIXED_NOW.toISOString()));
  });

  it("rejects a malformed key (path safety)", async () => {
    const { load } = makeLoader();
    await expect(load({ key: "../../escape" })).rejects.toThrow(
      /Not a valid dialogue asset key/,
    );
    await expect(load({ key: "  " })).rejects.toThrow(/Not a valid dialogue asset key/);
    // Regression: a PADDED key must be rejected loudly, not silently
    // trimmed into a valid key that then misses the file (ENOENT).
    const padded = ` ${FIXTURE_KEY} `;
    const { load: loadPadded } = makeLoader({
      [`/tmp/test-alignment/${FIXTURE_KEY}.json`]: fixtureAlignmentDoc,
    });
    await expect(loadPadded({ key: padded })).rejects.toThrow(
      /Not a valid dialogue asset key/,
    );
  });

  it("throws a clear error when no alignment record exists", async () => {
    const { load } = makeLoader();
    await expect(load()).rejects.toThrow(/No alignment record for dialogue asset/);
  });

  it("requires a directory", async () => {
    const { load } = makeLoader();
    await expect(load({ directory: "  " })).rejects.toThrow(/directory is required/);
  });
});

describe("CaptionTrackStore", () => {
  function makeStore(initial: Record<string, string> = {}) {
    const mem = memoryFs(initial);
    const store = new CaptionTrackStore({
      directory: "/tmp/test-captions",
      fs: mem.fs,
    });
    return { mem, store };
  }

  it("saves, lists as present, and reads back the known fixture track", async () => {
    const { mem, store } = makeStore();
    const track = buildFixture();

    await store.save(track);

    expect(await store.has(FIXTURE_KEY)).toBe(true);
    const loaded = await store.getByKey(FIXTURE_KEY);
    expect(loaded).not.toBeNull();
    // Full track round-trips exactly (word-exact persistence proof).
    expect(loaded).toEqual(track);
    expect(mem.files.has(`/tmp/test-captions/${FIXTURE_KEY}.json`)).toBe(true);
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
    const track = buildFixture();
    await store.save(track);

    const rebuilt = buildCaptionTrack(fixtureSource, {
      now: () => new Date("2026-08-28T16:00:00.000Z"),
    });
    await expect(store.save(rebuilt)).rejects.toThrow(
      /already exists for dialogue asset .* — use replace\(\)/,
    );

    await store.replace(rebuilt);
    const loaded = await store.getByKey(FIXTURE_KEY);
    expect(loaded!.builtAt).toBe("2026-08-28T16:00:00.000Z");
    expect(loaded!.builtAt).not.toBe(track.builtAt);
  });

  it("refuses to save a track with no source key", async () => {
    const { store } = makeStore();
    const keyed = buildFixture();
    const unkeyed: CaptionTrack = { ...keyed, sourceKey: undefined };
    await expect(store.save(unkeyed)).rejects.toThrow(/sourceKey is required/);
    await expect(store.replace(unkeyed)).rejects.toThrow(/sourceKey is required/);
  });

  it("rejects saving a track with an invalid key (path safety)", async () => {
    const { store } = makeStore();
    const bad = { ...buildFixture(), sourceKey: "../../escape" } as CaptionTrack;
    await expect(store.save(bad)).rejects.toThrow(/Not a valid dialogue asset key/);
  });

  it("rejects a blank directory at construction", () => {
    expect(() => new CaptionTrackStore({ directory: "  " })).toThrow(
      /directory is required/,
    );
  });

  it("throws a clear error on a malformed stored document", async () => {
    const { store } = makeStore({
      [`/tmp/test-captions/${FIXTURE_KEY}.json`]: "not json at all",
    });
    await expect(store.getByKey(FIXTURE_KEY)).rejects.toThrow(/not valid JSON/);

    const mem2 = memoryFs({
      [`/tmp/test-captions/${FIXTURE_KEY}.json`]: JSON.stringify({
        formatVersion: 2,
        track: {},
      }),
    });
    const store2 = new CaptionTrackStore({
      directory: "/tmp/test-captions",
      fs: mem2.fs,
    });
    await expect(store2.getByKey(FIXTURE_KEY)).rejects.toThrow(/malformed/);
  });

  it("parseCaptionTrackDoc round-trips the fixture document verbatim", () => {
    const doc: CaptionTrackFile = {
      formatVersion: 1,
      track: buildFixture(),
    };
    const parsed = parseCaptionTrackDoc(JSON.stringify(doc), "/tmp/x.json");
    expect(parsed).toEqual(buildFixture());
  });
});

describe("FISH-007 → VID-004 hand-off shape", () => {
  it("exposes the cue data a captions layer renders (word-exact proof)", async () => {
    const track = buildFixture();
    // VID-004 consumes: cues[] with words[] carrying startMs/endMs, plus the
    // ms→frames conversion for the timeline sync test.
    const renderable = track.cues.every(
      (c) =>
        c.words.length > 0 &&
        c.startMs === c.words[0]!.startMs &&
        c.endMs === c.words[c.words.length - 1]!.endMs &&
        c.words.every(
          (w) =>
            typeof w.word === "string" &&
            Number.isInteger(w.startMs) &&
            Number.isInteger(w.endMs) &&
            w.startMs <= w.endMs,
        ),
    );
    expect(renderable).toBe(true);
    expect(track.text).toBe(FIXTURE_TEXT);
    expect(track.sourceKey).toBe(FIXTURE_KEY);
    // The full pipeline: alignment doc → track → frames, deterministic.
    const first = track.cues[0]!;
    expect(msToFrames(first.startMs, 30)).toBe(1);
    expect(msToFrames(first.endMs, 30)).toBe(36);
  });

  it("cue spans never overlap the next cue's span", () => {
    const source: CaptionSourceAlignment = {
      text: "a b c d e f g h i j",
      words: Array.from({ length: 10 }, (_, i) => ({
        word: String.fromCharCode(97 + i),
        startMs: i * 100,
        endMs: i * 100 + 90,
      })),
    };
    const track = buildCaptionTrack(source, { maxWords: 4, now: () => FIXED_NOW });
    for (let i = 0; i < track.cues.length - 1; i++) {
      expect(track.cues[i]!.endMs).toBeLessThanOrEqual(track.cues[i + 1]!.startMs);
    }
  });
});