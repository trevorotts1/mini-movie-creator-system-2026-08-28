import { describe, expect, it } from "vitest";

import {
  DEFAULT_FPS,
  TimelineError,
  buildShotTimeline,
  framesForSeconds,
  globalFrameFromLocal,
  localFrame,
  shotAtGlobalFrame,
  timelineDurationInFrames,
  type ShotTimelineInput,
} from "./index.js";

/** Three shots of a 10s episode at the upstream 30fps baseline. */
const EPISODE: ShotTimelineInput[] = [
  { shotId: "SHOT_E01_S0_00", sequenceIndex: 0, durationSeconds: 3.4 },
  { shotId: "SHOT_E01_S0_01", sequenceIndex: 1, durationSeconds: 4.0 },
  { shotId: "SHOT_E01_S0_02", sequenceIndex: 2, durationSeconds: 2.6 },
];

describe("framesForSeconds", () => {
  it("uses round(seconds * fps) — the upstream conversion", () => {
    expect(framesForSeconds(3.4, 30)).toBe(102);
    expect(framesForSeconds(0, 30)).toBe(0);
    expect(framesForSeconds(1.5, 30)).toBe(45);
    // 23.976-style fractional fps stays integer too
    expect(framesForSeconds(1, 24)).toBe(24);
    expect(framesForSeconds(1 / 3, 30)).toBe(10);
  });

  it("rejects negative/NaN seconds and non-positive fps", () => {
    expect(() => framesForSeconds(-1, 30)).toThrow(TimelineError);
    expect(() => framesForSeconds(NaN, 30)).toThrow(TimelineError);
    expect(() => framesForSeconds(1, 0)).toThrow(TimelineError);
    expect(() => framesForSeconds(1, Infinity)).toThrow(TimelineError);
  });
});

describe("local/global frame conversion (upstream frames.mjs convention)", () => {
  it("local_f = round(global_s * fps) − sequence_from, matching Short6Sheet", () => {
    // Short6Sheet: SHEET_FROM = 102, L(12.6) = round(12.6 * 30) − 102 = 276.
    const SHEET_FROM = 102;
    expect(localFrame(12.6, SHEET_FROM, 30)).toBe(276);
    expect(localFrame(3.4, SHEET_FROM, 30)).toBe(0);
    expect(localFrame(12.6, 0, 30)).toBe(378);
  });

  it("globalFrameFromLocal inverts localFrame exactly", () => {
    const sequenceFrom = 102;
    for (const globalSeconds of [3.4, 12.6, 27.0, 38.0]) {
      const lf = localFrame(globalSeconds, sequenceFrom, 30);
      expect(globalFrameFromLocal(lf, sequenceFrom)).toBe(
        framesForSeconds(globalSeconds, 30),
      );
    }
  });

  it("rejects non-integer frames", () => {
    expect(() => localFrame(1.0, 0.5, 30)).toThrow(TimelineError);
    expect(() => globalFrameFromLocal(1.5, 0)).toThrow(TimelineError);
  });
});

describe("buildShotTimeline", () => {
  it("maps known timings at 30fps", () => {
    const timeline = buildShotTimeline(EPISODE);
    expect(timeline).toHaveLength(3);

    // Shot 0 mounts at global frame 0, runs to round(3.4*30) = 102.
    expect(timeline[0]).toMatchObject({
      shotId: "SHOT_E01_S0_00",
      sequenceIndex: 0,
      fps: 30,
      sequenceFrom: 0,
      globalOutFrame: 102,
      durationInFrames: 102,
      localInFrame: 0,
      localOutFrame: 102,
    });
    // Shot 1: 3.4s→7.4s, frames 102→222.
    expect(timeline[1]).toMatchObject({
      shotId: "SHOT_E01_S0_01",
      sequenceFrom: 102,
      globalOutFrame: 222,
      durationInFrames: 120,
    });
    // Shot 2: 7.4s→10.0s, frames 222→300.
    expect(timeline[2]).toMatchObject({
      shotId: "SHOT_E01_S0_02",
      sequenceFrom: 222,
      globalOutFrame: 300,
      durationInFrames: 78,
    });
    expect(timelineDurationInFrames(timeline)).toBe(300); // 10s * 30fps
  });

  it("input order does not matter — sequences sort by sequenceIndex", () => {
    const shuffled = buildShotTimeline([EPISODE[2]!, EPISODE[0]!, EPISODE[1]!]);
    expect(shuffled.map((s) => s.sequenceIndex)).toEqual([0, 1, 2]);
    expect(shuffled.map((s) => s.shotId)).toEqual([
      "SHOT_E01_S0_00",
      "SHOT_E01_S0_01",
      "SHOT_E01_S0_02",
    ]);
  });

  it("each shot's sequenceFrom equals the previous shot's globalOutFrame (no gaps)", () => {
    const timeline = buildShotTimeline(EPISODE, { fps: 24 });
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i]!.sequenceFrom).toBe(timeline[i - 1]!.globalOutFrame);
    }
  });

  it("preserves the local_f convention: cue at shot-local seconds maps like frames.mjs", () => {
    // A cue 2.2s into shot 1 (which mounts at 102) is global round(5.6*30)=168
    // and local 168−102=66 — exactly local_f = round(global_s*fps) − sequence_from.
    const timeline = buildShotTimeline(EPISODE);
    const shot1 = timeline[1]!;
    const globalS = shot1.startSeconds + 2.2;
    expect(framesForSeconds(globalS, 30)).toBe(168);
    expect(localFrame(globalS, shot1.sequenceFrom, 30)).toBe(66);
    expect(globalFrameFromLocal(66, shot1.sequenceFrom)).toBe(168);
  });

  it("supports non-default fps", () => {
    const timeline = buildShotTimeline(
      [{ shotId: "A", sequenceIndex: 0, durationSeconds: 1.5 }],
      { fps: 24 },
    );
    expect(timeline[0]).toMatchObject({
      fps: 24,
      sequenceFrom: 0,
      globalOutFrame: 36,
      durationInFrames: 36,
    });
  });

  it("empty input yields an empty timeline of length 0", () => {
    expect(buildShotTimeline([])).toEqual([]);
    expect(timelineDurationInFrames([])).toBe(0);
  });

  it("rejects duplicate sequenceIndex", () => {
    expect(() =>
      buildShotTimeline([
        { shotId: "A", sequenceIndex: 3, durationSeconds: 1 },
        { shotId: "B", sequenceIndex: 3, durationSeconds: 1 },
      ]),
    ).toThrow(TimelineError);
  });

  it("rejects invalid sequenceIndex", () => {
    expect(() =>
      buildShotTimeline([{ shotId: "A", sequenceIndex: -1, durationSeconds: 1 }]),
    ).toThrow(TimelineError);
    expect(() =>
      buildShotTimeline([
        { shotId: "A", sequenceIndex: 0.5, durationSeconds: 1 },
      ]),
    ).toThrow(TimelineError);
  });

  it("rejects invalid durations", () => {
    expect(() =>
      buildShotTimeline([{ shotId: "A", sequenceIndex: 0, durationSeconds: -2 }]),
    ).toThrow(TimelineError);
    expect(() =>
      buildShotTimeline([{ shotId: "A", sequenceIndex: 0, durationSeconds: NaN }]),
    ).toThrow(TimelineError);
  });
});

describe("shotAtGlobalFrame", () => {
  const timeline = buildShotTimeline(EPISODE);

  it("finds the owning shot (half-open [sequenceFrom, globalOutFrame))", () => {
    expect(shotAtGlobalFrame(timeline, 0)?.shotId).toBe("SHOT_E01_S0_00");
    expect(shotAtGlobalFrame(timeline, 101)?.shotId).toBe("SHOT_E01_S0_00");
    expect(shotAtGlobalFrame(timeline, 102)?.shotId).toBe("SHOT_E01_S0_01");
    expect(shotAtGlobalFrame(timeline, 221)?.shotId).toBe("SHOT_E01_S0_01");
    expect(shotAtGlobalFrame(timeline, 222)?.shotId).toBe("SHOT_E01_S0_02");
    expect(shotAtGlobalFrame(timeline, 299)?.shotId).toBe("SHOT_E01_S0_02");
  });

  it("returns undefined out of range or for invalid frames", () => {
    expect(shotAtGlobalFrame(timeline, 300)).toBeUndefined();
    expect(shotAtGlobalFrame(timeline, -1)).toBeUndefined();
    expect(shotAtGlobalFrame(timeline, 10.5)).toBeUndefined();
  });
});