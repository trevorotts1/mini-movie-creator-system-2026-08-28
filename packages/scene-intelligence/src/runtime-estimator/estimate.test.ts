import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_RUNTIME_ESTIMATOR_OPTIONS,
  ESTIMATOR_VERSION,
  KNOWN_DURATION_FIXTURES,
  RuntimeEstimateStore,
  RuntimeEstimatorError,
  estimateRuntime,
  isValidRuntimeEstimate,
  type RuntimeEstimate,
  type ScreenplayInput,
} from "./index.js";
import { connectSqlite, type SqliteDatabase } from "../../../database/src/connection/index.js";

const TEN_PERCENT = 0.1;

describe("estimateRuntime — known-duration fixtures (±10% acceptance)", () => {
  for (const fixture of KNOWN_DURATION_FIXTURES) {
    it(`estimates "${fixture.name}" within ±10% of its known duration`, () => {
      const estimate = estimateRuntime(fixture.screenplay);

      expect(
        Math.abs(estimate.totalSeconds - fixture.expectedTotalSeconds),
      ).toBeLessThanOrEqual(fixture.expectedTotalSeconds * TEN_PERCENT);

      expect(estimate.perScene).toHaveLength(fixture.expectedSceneSeconds.length);
      estimate.perScene.forEach((scene, i) => {
        const expected = fixture.expectedSceneSeconds[i] as number;
        expect(Math.abs(scene.estimatedSeconds - expected)).toBeLessThanOrEqual(expected * TEN_PERCENT);
        expect(scene.sceneId).toBe(fixture.screenplay.scenes[i]?.id);
      });

      expect(estimate.totalSeconds).toBeCloseTo(
        estimate.perScene.reduce((sum, s) => sum + s.estimatedSeconds, 0),
        2,
      );
    });
  }

  it("sums per-scene estimates exactly into the total", () => {
    for (const fixture of KNOWN_DURATION_FIXTURES) {
      const estimate = estimateRuntime(fixture.screenplay);
      const sum = estimate.perScene.reduce((acc, s) => acc + s.estimatedSeconds, 0);
      expect(estimate.totalSeconds).toBe(Math.round(sum * 100) / 100);
    }
  });
});

describe("estimateRuntime — estimator mechanics", () => {
  it("scales linearly with dialogue word count", () => {
    const line = (words: number) =>
      Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
    const small = estimateRuntime({
      id: "S",
      scenes: [{ id: "SC01", elements: [{ kind: "dialogue", text: line(25) }] }],
    });
    const big = estimateRuntime({
      id: "B",
      scenes: [{ id: "SC01", elements: [{ kind: "dialogue", text: line(50) }] }],
    });
    // Same overhead, double dialogue → big total is exactly overhead + 2x(small−overhead).
    const overhead = DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.sceneOverheadSeconds;
    expect(big.totalSeconds).toBeCloseTo(overhead + 2 * (small.totalSeconds - overhead), 2);
  });

  it("applies the minimum-scene floor to empty scenes", () => {
    const estimate = estimateRuntime({
      id: "F",
      scenes: [{ id: "SC01", elements: [] }],
    });
    expect(estimate.perScene[0]?.estimatedSeconds).toBe(DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.minSceneSeconds);
  });

  it("honors caller overrides", () => {
    const estimate = estimateRuntime(
      {
        id: "O",
        scenes: [{ id: "SC01", elements: [{ kind: "dialogue", text: "one two three four five" }] }],
      },
      { dialogueWordsPerSecond: 1, sceneOverheadSeconds: 0, minSceneSeconds: 0 },
    );
    expect(estimate.perScene[0]?.estimatedSeconds).toBe(5);
  });

  it("rejects non-positive rate overrides", () => {
    expect(() =>
      estimateRuntime({ id: "X", scenes: [{ id: "SC01", elements: [] }] }, { dialogueWordsPerSecond: 0 }),
    ).toThrow(RuntimeEstimatorError);
    expect(() =>
      estimateRuntime({ id: "X", scenes: [{ id: "SC01", elements: [] }] }, { sceneOverheadSeconds: -1 }),
    ).toThrow(RuntimeEstimatorError);
  });

  it("treats an explicitly-undefined option key as absent, never as a NaN clobber (regression)", () => {
    // A spread-merge ({ ...defaults, ...options }) overwrites the default with
    // `undefined` for explicitly-undefined keys, producing NaN runtimes.
    const base = { id: "U", scenes: [{ id: "SC01", elements: [{ kind: "dialogue", text: "one two three" }] }] } as const;
    const plain = estimateRuntime(base);
    const undefinedOverride = estimateRuntime(base, { dialogueWordsPerSecond: undefined });
    expect(undefinedOverride.totalSeconds).toBe(plain.totalSeconds);
    expect(Number.isFinite(undefinedOverride.totalSeconds)).toBe(true);
    expect(undefinedOverride.perScene[0]?.estimatedSeconds).toBe(
      plain.perScene[0]?.estimatedSeconds,
    );
  });

  it("rejects structurally invalid screenplays", () => {
    expect(() => estimateRuntime(null as never)).toThrow(RuntimeEstimatorError);
    expect(() => estimateRuntime({ id: "", scenes: [] })).toThrow(RuntimeEstimatorError);
  });

  it("counts story text only — hostile text neither executes nor breaks the estimate", () => {
    const hostile = {
      id: "INJ",
      scenes: [
        {
          id: "SC01",
          elements: [
            { kind: "action", text: "'; DROP TABLE runtime_estimate_scenes; --" },
            { kind: "dialogue", text: "${process.exit(1)} <script>alert('x')</script>" },
          ],
        },
      ],
    } as const satisfies ScreenplayInput;
    const estimate = estimateRuntime(hostile);
    expect(estimate.totalSeconds).toBeGreaterThan(0);
    expect(estimate.perScene[0]?.dialogueWords).toBeGreaterThan(0);
  });

  it("produces a structurally valid persisted-shape estimate", () => {
    const estimate = estimateRuntime(KNOWN_DURATION_FIXTURES[0]!.screenplay);
    expect(isValidRuntimeEstimate(estimate)).toBe(true);
    expect(estimate.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(estimate.inputVersion).toBe(1);
    expect(typeof estimate.estimatedAt).toBe("string");
    expect(estimate.options.dialogueWordsPerSecond).toBe(
      DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.dialogueWordsPerSecond,
    );
  });

  it("rejects malformed persisted-shape values", () => {
    expect(isValidRuntimeEstimate(null)).toBe(false);
    expect(isValidRuntimeEstimate({})).toBe(false);
    expect(isValidRuntimeEstimate({ screenplayId: "X", totalSeconds: "many", perScene: [] })).toBe(false);
    expect(isValidRuntimeEstimate({ screenplayId: "X", totalSeconds: -5, perScene: [] })).toBe(false);
    expect(
      isValidRuntimeEstimate({
        screenplayId: "X",
        totalSeconds: 10,
        perScene: [{ sceneId: "SC01", estimatedSeconds: Number.NaN }],
      }),
    ).toBe(false);
  });
});

describe("RuntimeEstimateStore — persistence (acceptance: per-scene and total persisted)", () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mmcs-runtime-estimator-"));
    db = connectSqlite({ path: join(dir, "estimates.db") });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and reloads per-scene and total estimates exactly", () => {
    const store = new RuntimeEstimateStore(db);
    const fixture = KNOWN_DURATION_FIXTURES[1]!;
    const estimate = estimateRuntime(fixture.screenplay);

    const rowsWritten = store.save(estimate);
    expect(rowsWritten).toBe(fixture.screenplay.scenes.length);

    const restored = store.latest(fixture.screenplay.id);
    expect(restored).toBeDefined();
    expect(restored!.screenplayId).toBe(fixture.screenplay.id);
    expect(restored!.totalSeconds).toBe(estimate.totalSeconds);
    expect(restored!.scenes).toHaveLength(estimate.perScene.length);

    restored!.scenes.forEach((scene, i) => {
      const original = estimate.perScene[i]!;
      expect(scene.sceneId).toBe(original.sceneId);
      expect(scene.estimatedSeconds).toBe(original.estimatedSeconds);
      expect(scene.dialogueWords).toBe(original.dialogueWords);
      expect(scene.actionWords).toBe(original.actionWords);
    });

    expect(store.persistedTotalSeconds(fixture.screenplay.id)).toBe(estimate.totalSeconds);
  });

  it("returns undefined for an unknown screenplay and empty rows", () => {
    const store = new RuntimeEstimateStore(db);
    expect(store.latest("NOPE")).toBeUndefined();
    expect(store.persistedTotalSeconds("NOPE")).toBeUndefined();
  });

  it("supersedes prior estimates on re-estimation (latest wins)", () => {
    const store = new RuntimeEstimateStore(db);
    const fixture = KNOWN_DURATION_FIXTURES[2]!;
    const first = estimateRuntime(fixture.screenplay);
    const second = estimateRuntime(fixture.screenplay, { sceneOverheadSeconds: 2, minSceneSeconds: 2 });

    store.save(first);
    store.save(second);

    const restored = store.latest(fixture.screenplay.id);
    expect(restored!.totalSeconds).toBe(second.totalSeconds);
    expect(restored!.totalSeconds).not.toBe(first.totalSeconds);
  });

  it("refuses to persist a malformed estimate", () => {
    const store = new RuntimeEstimateStore(db);
    const broken = { screenplayId: "", totalSeconds: 5, perScene: [{}] } as unknown as RuntimeEstimate;
    expect(() => store.save(broken)).toThrow(RuntimeEstimatorError);
  });

  it("refuses estimates whose scene numbers are missing or NaN", () => {
    const store = new RuntimeEstimateStore(db);
    const valid = estimateRuntime(KNOWN_DURATION_FIXTURES[0]!.screenplay);
    const brokenScenes = [
      {
        ...valid.perScene[0],
        estimatedSeconds: Number.NaN,
      },
    ] as unknown as RuntimeEstimate["perScene"];
    expect(() =>
      store.save({ ...valid, perScene: brokenScenes } as RuntimeEstimate),
    ).toThrow(RuntimeEstimatorError);
  });

  it("refuses an estimate whose summary total contradicts its scene sum", () => {
    const store = new RuntimeEstimateStore(db);
    const valid = estimateRuntime(KNOWN_DURATION_FIXTURES[0]!.screenplay);
    expect(() =>
      store.save({ ...valid, totalSeconds: valid.totalSeconds + 100 } as RuntimeEstimate),
    ).toThrow(RuntimeEstimatorError);
  });

  it("refuses scenes with a non-string sceneTitle (regression: was persisted verbatim)", () => {
    const store = new RuntimeEstimateStore(db);
    const valid = estimateRuntime(KNOWN_DURATION_FIXTURES[0]!.screenplay);
    const badTitle = [
      { ...valid.perScene[0]!, sceneTitle: 42 as unknown as string },
    ] as unknown as RuntimeEstimate["perScene"];
    expect(() => store.save({ ...valid, perScene: badTitle } as RuntimeEstimate)).toThrow(
      RuntimeEstimatorError,
    );
  });

  it("refuses estimates carrying NaN options (regression: serialized null into options_json)", () => {
    const store = new RuntimeEstimateStore(db);
    const valid = estimateRuntime(KNOWN_DURATION_FIXTURES[0]!.screenplay);
    const nanOptions = {
      ...valid,
      options: { ...valid.options, sceneOverheadSeconds: Number.NaN },
    } as unknown as RuntimeEstimate;
    expect(() => store.save(nanOptions)).toThrow(RuntimeEstimatorError);
  });

  it("keeps the latest batch intact when two saves share one estimatedAt timestamp", () => {
    const store = new RuntimeEstimateStore(db);
    const fixture = KNOWN_DURATION_FIXTURES[1]!;
    const sharedTimestamp = "2026-08-28T20:00:00.000Z";

    const first = estimateRuntime(fixture.screenplay);
    const second = estimateRuntime(fixture.screenplay, { sceneOverheadSeconds: 9, minSceneSeconds: 9 });
    (first as { estimatedAt: string }).estimatedAt = sharedTimestamp;
    (second as { estimatedAt: string }).estimatedAt = sharedTimestamp;
    store.save(first);
    store.save(second);

    const restored = store.latest(fixture.screenplay.id);
    // Exactly the second save's scenes — never a mix of both batches.
    expect(restored!.totalSeconds).toBe(second.totalSeconds);
    expect(restored!.scenes.map((s) => s.estimatedSeconds)).toEqual(
      second.perScene.map((s) => s.estimatedSeconds),
    );
    expect(store.persistedTotalSeconds(fixture.screenplay.id)).toBe(second.totalSeconds);
  });

  it("detects inconsistent persisted state", () => {
    const store = new RuntimeEstimateStore(db);
    const fixture = KNOWN_DURATION_FIXTURES[0]!;
    store.save(estimateRuntime(fixture.screenplay));
    // Corrupt the summary total directly; the consistency check must fire.
    db.exec("UPDATE runtime_estimate_screenplays SET total_seconds = 999;");
    expect(() => store.persistedTotalSeconds(fixture.screenplay.id)).toThrow(/inconsistent/);
  });

  it("flags a non-zero summary total with zero persisted scene rows (regression: check skipped empty batches)", () => {
    const store = new RuntimeEstimateStore(db);
    const fixture = KNOWN_DURATION_FIXTURES[0]!;
    store.save(estimateRuntime(fixture.screenplay));
    // Delete every scene row for the latest batch; the summary total (23.4)
    // then contradicts the empty scene sum (0) and must be reported.
    db.exec("DELETE FROM runtime_estimate_scenes;");
    expect(() => store.persistedTotalSeconds(fixture.screenplay.id)).toThrow(/inconsistent/);
  });
});