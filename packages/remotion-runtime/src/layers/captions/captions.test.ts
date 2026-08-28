/**
 * VID-004 acceptance tests — dialogue/captions layer.
 *
 * Acceptance criteria (todo TASK-VID-004):
 *  1. word-exact captions from FISH-007 alignment rendered in timeline
 *  2. timing sync test: caption frame == alignment ms→frames
 *  3. `npx vitest run packages/remotion-runtime/src/layers/captions` green
 */
import { describe, expect, it } from "vitest";
import { CaptionTrackError } from "./errors.js";
import { msToFrame } from "./timing.js";
import {
  activeChunkAt,
  activeWordAt,
  buildCaptionTrack,
  chunkTrack,
} from "./track.js";
import { chunkTrack as chunkTrackReexport } from "./index.js";
import type { AlignmentTrackInput } from "./types.js";

/** A known FISH-006-style alignment record: 4 words with real-ish ms
 * timings (word-exact, includes punctuation tokens verbatim). */
const ALIGNMENT: AlignmentTrackInput = {
  text: "Pawn to e4. Check.",
  durationMs: 3200,
  words: [
    { word: "Pawn", startMs: 100, endMs: 340 },
    { word: "to", startMs: 400, endMs: 470 },
    { word: "e4.", startMs: 520, endMs: 1400 },
    { word: "Check.", startMs: 1600, endMs: 2100 },
  ],
};

describe("buildCaptionTrack", () => {
  it("builds a word-exact track: every alignment word survives verbatim", () => {
    const track = buildCaptionTrack(ALIGNMENT, 30);
    expect(track.words.map((w) => w.word)).toEqual([
      "Pawn",
      "to",
      "e4.",
      "Check.",
    ]);
    // Verbatim ms preserved — no re-tokenization, no rounding drift.
    expect(track.words.map((w) => w.startMs)).toEqual([100, 400, 520, 1600]);
    expect(track.words.map((w) => w.endMs)).toEqual([340, 470, 1400, 2100]);
  });

  it("carries the original script text verbatim (untrusted passthrough)", () => {
    const track = buildCaptionTrack(ALIGNMENT, 30);
    expect(track.text).toBe("Pawn to e4. Check.");
  });

  it("records asset key provenance when given", () => {
    const track = buildCaptionTrack(ALIGNMENT, 30, {
      assetKey: "fsh1:abc",
    });
    expect(track.assetKey).toBe("fsh1:abc");
    expect(buildCaptionTrack(ALIGNMENT, 30).assetKey).toBeNull();
  });

  it("throws on empty word list — dialogue must never render as silence", () => {
    expect(() => buildCaptionTrack({ words: [] }, 30)).toThrow(
      CaptionTrackError,
    );
    expect(() =>
      buildCaptionTrack(undefined as unknown as AlignmentTrackInput, 30),
    ).toThrow(CaptionTrackError);
  });

  it("throws when ALL words are structurally unusable", () => {
    expect(() =>
      buildCaptionTrack(
        {
          words: [
            { word: "x", startMs: Number.NaN, endMs: 100 },
            { word: "y", startMs: -5, endMs: 100 },
          ],
        },
        30,
      ),
    ).toThrow(CaptionTrackError);
  });

  it("skips broken words but keeps usable ones (count reported in error only)", () => {
    const track = buildCaptionTrack(
      {
        words: [
          { word: "good", startMs: 0, endMs: 200 },
          { word: "bad", startMs: Number.NaN, endMs: 300 },
        ],
      },
      30,
    );
    expect(track.words.map((w) => w.word)).toEqual(["good"]);
  });

  it("rejects invalid fps and startFrame", () => {
    expect(() => buildCaptionTrack(ALIGNMENT, 0)).toThrow(CaptionTrackError);
    expect(() => buildCaptionTrack(ALIGNMENT, -30)).toThrow(CaptionTrackError);
    expect(() =>
      buildCaptionTrack(ALIGNMENT, 30, { startFrame: 1.5 }),
    ).toThrow(CaptionTrackError);
  });

  it("sorts words by start time regardless of input order", () => {
    const track = buildCaptionTrack(
      {
        words: [
          { word: "second", startMs: 500, endMs: 700 },
          { word: "first", startMs: 0, endMs: 400 },
        ],
      },
      30,
    );
    expect(track.words.map((w) => w.word)).toEqual(["first", "second"]);
  });

  it("durationFrames uses audio duration when it exceeds the last word", () => {
    const track = buildCaptionTrack(ALIGNMENT, 30); // durationMs 3200 > 2100
    expect(track.durationFrames).toBe(msToFrame(3200, 30));
    const short = buildCaptionTrack(
      { durationMs: 100, words: ALIGNMENT.words },
      30,
    );
    expect(short.durationFrames).toBe(msToFrame(2100, 30)); // last word wins
  });
});

describe("timing sync — caption frame == alignment ms→frames", () => {
  it("every caption frame derives from the alignment ms by msToFrame (30fps)", () => {
    const fps = 30;
    const track = buildCaptionTrack(ALIGNMENT, fps);
    track.words.forEach((w) => {
      expect(msToFrame(w.startMs, fps)).toBe(Math.round((w.startMs / 1000) * fps));
      expect(msToFrame(w.endMs, fps)).toBe(Math.round((w.endMs / 1000) * fps));
      // and the track's own chunk conversion agrees
      expect(msToFrame(w.startMs, track.fps)).toBe(
        Math.round((w.startMs / 1000) * track.fps),
      );
    });
    expect(track.durationFrames).toBe(Math.round((3200 / 1000) * fps));
  });

  it("same identity holds at 24fps and 29.97 (round-half-away convention of Math.round)", () => {
    for (const fps of [24, 25, 29.97, 60]) {
      const track = buildCaptionTrack(ALIGNMENT, fps);
      track.words.forEach((w) => {
        expect(Math.round((w.startMs / 1000) * fps)).toBe(
          msToFrame(w.startMs, fps),
        );
        expect(Math.round((w.endMs / 1000) * fps)).toBe(
          msToFrame(w.endMs, fps),
        );
      });
    }
  });

  it("startFrame mounts the asset on the global timeline without changing ms math", () => {
    const fps = 30;
    const MOUNT = 480; // scene mounted at 16s (frame 480)
    const track = buildCaptionTrack(ALIGNMENT, fps, { startFrame: MOUNT });
    track.words.forEach((w) => {
      expect(msToFrame(w.startMs, fps, MOUNT)).toBe(
        Math.round((w.startMs / 1000) * fps) + MOUNT,
      );
    });
    // Upstream local_f discipline: global = round(global_s * fps) − from
    // inverted — frame(startMs=100) at 30fps from 480 → 3 + 480 = 483.
    expect(msToFrame(100, fps, MOUNT)).toBe(483);
  });

  it("known-value check: 100ms @30fps == frame 3, 2100ms == frame 63", () => {
    expect(msToFrame(100, 30)).toBe(3);
    expect(msToFrame(2100, 30)).toBe(63);
    expect(msToFrame(333, 30)).toBe(10); // 9.99 frames → rounds to 10
  });

  it("msToFrame rejects non-finite ms and non-positive fps", () => {
    expect(() => msToFrame(Number.NaN, 30)).toThrow(TypeError);
    expect(() => msToFrame(100, 0)).toThrow(TypeError);
    expect(() => msToFrame(100, -30)).toThrow(TypeError);
  });
});

describe("chunkTrack / activeChunkAt / activeWordAt", () => {
  const track = buildCaptionTrack(ALIGNMENT, 30);
  const chunks = chunkTrack(track, 2); // 2 words per chunk → 2 chunks
  const c1 = chunks[0]!;
  const c2 = chunks[1]!;

  it("groups ≤ maxWords consecutive words, never mixing speakers", () => {
    expect(chunks.map((c) => c.words.map((w) => w.word))).toEqual([
      ["Pawn", "to"],
      ["e4.", "Check."],
    ]);
  });

  it("chunk frames are msToFrame conversions of the group's word boundaries", () => {
    expect(c1.startFrame).toBe(msToFrame(100, 30)); // 3
    expect(c1.endFrame).toBe(msToFrame(470, 30)); // 14
    expect(c2.startFrame).toBe(msToFrame(520, 30)); // 16
    expect(c2.endFrame).toBe(msToFrame(2100, 30)); // 63
  });

  it("hold frame: next chunk's start, capped at end + tail; last chunk holds end + last tail", () => {
    const tail = Math.round(0.6 * 30); // 18
    const lastTail = Math.round(0.8 * 30); // 24
    expect(c1.holdFrame).toBe(Math.min(c2.startFrame, c1.endFrame + tail));
    expect(c2.holdFrame).toBe(c2.endFrame + lastTail);
  });

  it("activeChunkAt: one chunk at a time, holds until the next starts, none outside track", () => {
    expect(activeChunkAt(chunks, 5)?.words[0]?.word).toBe("Pawn");
    expect(activeChunkAt(chunks, 20)?.words[0]?.word).toBe("e4.");
    // Hold discipline: chunk 1 [3..14] holds to the next chunk's start (16),
    // so frames 14–15 still show it — captions never blink between chunks.
    expect(activeChunkAt(chunks, 14)?.words[0]?.word).toBe("Pawn");
    expect(activeChunkAt(chunks, 15)?.words[0]?.word).toBe("Pawn");
    expect(activeChunkAt(chunks, 16)?.words[0]?.word).toBe("e4.");
    // Last chunk holds end + last tail (63 + 24 = 87), then nothing.
    expect(activeChunkAt(chunks, 86)?.words[0]?.word).toBe("e4.");
    expect(activeChunkAt(chunks, 87)).toBeUndefined();
    expect(activeChunkAt(chunks, 10_000)).toBeUndefined();
  });

  it("activeWordAt returns exactly the word whose alignment ms→frames contains the frame", () => {
    const fps = 30;
    // Frame 5 == 166.7ms — inside "Pawn" [100,340)
    expect(activeWordAt(c1, 5, fps)?.word).toBe("Pawn");
    // Frame 12 == 400ms — "to" [400,470) starts at frame 12
    expect(activeWordAt(c1, 12, fps)?.word).toBe("to");
    // "to" ends at msToFrame(470,30)=14, so frame 14 is NOT < 14 —
    // e4. starts at frame 16, so frames 14–15 have no spoken word.
    expect(activeWordAt(c1, 14, fps)).toBeUndefined();
    expect(activeWordAt(c1, 15, fps)).toBeUndefined();
    // e4. spans frames 16..42 — a word 880ms long must stay active across
    // many frames, proving sync, not just boundary hits.
    expect(activeWordAt(c2, 16, fps)?.word).toBe("e4.");
    expect(activeWordAt(c2, 40, fps)?.word).toBe("e4.");
    expect(activeWordAt(c2, 41, fps)?.word).toBe("e4.");
    // Between words (e4. ends frame 42, Check. starts frame 48): no word
    // spoken — a gap in speech is never filled with a wrong highlight.
    expect(activeWordAt(c2, 44, fps)).toBeUndefined();
    // Check. [1600,2100) → frames 48..62
    expect(activeWordAt(c2, 48, fps)?.word).toBe("Check.");
    expect(activeWordAt(c2, 62, fps)?.word).toBe("Check.");
    expect(activeWordAt(c2, 63, fps)).toBeUndefined();
  });

  it("splits chunks on speaker change even below maxWords", () => {
    const multi: AlignmentTrackInput = {
      words: [
        { word: "A", startMs: 0, endMs: 100, speaker: 0 },
        { word: "B", startMs: 150, endMs: 250, speaker: 1 },
      ],
    };
    const t = buildCaptionTrack(multi, 30);
    const cs = chunkTrack(t, 4);
    expect(cs.map((c) => c.words.map((w) => w.word))).toEqual([["A"], ["B"]]);
  });

  it("rejects invalid maxWords", () => {
    expect(() => chunkTrack(track, 0)).toThrow(CaptionTrackError);
  });

  it("index re-exports the same functions (public surface)", () => {
    expect(chunkTrackReexport).toBe(chunkTrack);
  });
});

describe("word-exactness discipline (upstream gen_voice.py port)", () => {
  it("never re-tokenizes timed words: punctuation stays attached", () => {
    const track = buildCaptionTrack(
      {
        text: "f7, is safe.",
        words: [
          { word: "f7,", startMs: 0, endMs: 315 },
          { word: "is", startMs: 382, endMs: 450 },
          { word: "safe.", startMs: 497, endMs: 860 },
        ],
      },
      30,
    );
    expect(track.words.map((w) => w.word)).toEqual(["f7,", "is", "safe."]);
  });

  it("multi-speaker timings survive the round-trip", () => {
    const track = buildCaptionTrack(
      {
        words: [
          { word: "Hi", startMs: 0, endMs: 200, speaker: 0 },
          { word: "Hello", startMs: 300, endMs: 700, speaker: 1 },
        ],
      },
      30,
    );
    expect(track.words[0]?.speaker).toBe(0);
    expect(track.words[1]?.speaker).toBe(1);
  });

  it("aligns exactly with a full FishDialogueAlignment-shaped record (structural compat)", () => {
    // Shape mirrors FISH-006 FishDialogueAlignment without importing it.
    const fishAlignment = {
      key: "fsh1:deadbeef",
      text: "Bishop c4 — aiming at f7, the weakest square.",
      source: "provider_response" as const,
      model: "s2.1-pro",
      extractedAt: "2026-08-28T00:00:00Z",
      durationMs: 3900,
      words: [
        { word: "Bishop", startMs: 0, endMs: 277 },
        { word: "c4", startMs: 331, endMs: 688 },
        { word: "—", startMs: 752, endMs: 823 },
        { word: "aiming", startMs: 811, endMs: 986 },
      ],
    };
    const track = buildCaptionTrack(fishAlignment, 30, {
      assetKey: fishAlignment.key,
    });
    expect(track.words).toHaveLength(4);
    expect(track.words[0]).toMatchObject({ word: "Bishop", startMs: 0, endMs: 277 });
    expect(track.assetKey).toBe("fsh1:deadbeef");
  });
});