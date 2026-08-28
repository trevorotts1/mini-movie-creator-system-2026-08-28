import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaError,
  emptyCheckpoint,
  normalizeCheckpoint,
  uniqueIds,
} from "./checkpoint-schema.js";

describe("normalizeCheckpoint", () => {
  it("accepts a full runbook §5 document", () => {
    const state = normalizeCheckpoint({
      schemaVersion: 1,
      project: "mmcs",
      repoRoot: "/repo",
      origin: "https://example.git",
      upstream: "upstream/repo",
      integrationBranch: "integration",
      lastCheckpointAt: "2026-08-28T00:00:00.000Z",
      lastMergeAt: null,
      lastWatchdogAt: "2026-08-28T00:01:00.000Z",
      currentWave: 2,
      buildComplete: false,
      activeWorkflowIds: ["WF01"],
      readyTaskIds: ["A"],
      blockedTaskIds: ["B"],
      mergeQueueTaskIds: ["C"],
      lastKnownGoodCommit: "abc",
    });
    expect(state.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(state.readyTaskIds).toEqual(["A"]);
    expect(state.currentWave).toBe(2);
  });

  it("fills defaults for omitted optional fields", () => {
    const state = normalizeCheckpoint({ schemaVersion: 1 });
    expect(state.project).toBe("");
    expect(state.integrationBranch).toBe("integration");
    expect(state.readyTaskIds).toEqual([]);
    expect(state.buildComplete).toBe(false);
    expect(state.currentWave).toBe(1);
  });

  it("throws on non-object documents", () => {
    expect(() => normalizeCheckpoint(null)).toThrow(CheckpointSchemaError);
    expect(() => normalizeCheckpoint([1, 2])).toThrow(CheckpointSchemaError);
    expect(() => normalizeCheckpoint("checkpoint")).toThrow(CheckpointSchemaError);
  });

  it("throws on missing or non-numeric schemaVersion", () => {
    expect(() => normalizeCheckpoint({})).toThrow(CheckpointSchemaError);
    expect(() => normalizeCheckpoint({ schemaVersion: "one" })).toThrow(
      CheckpointSchemaError,
    );
  });

  it("rejects future schema versions (writer newer than reader)", () => {
    expect(() => normalizeCheckpoint({ schemaVersion: 99 })).toThrow(
      /newer than supported/,
    );
  });

  it("rejects non-string-array id buckets", () => {
    expect(() =>
      normalizeCheckpoint({ schemaVersion: 1, readyTaskIds: [1, 2] }),
    ).toThrow(/readyTaskIds/);
    expect(() =>
      normalizeCheckpoint({ schemaVersion: 1, blockedTaskIds: "CORE-015" }),
    ).toThrow(/blockedTaskIds/);
  });

  it("emptyCheckpoint produces a schemaVersion-current document", () => {
    const state = emptyCheckpoint("proj", "/root");
    const round = normalizeCheckpoint(state);
    expect(round.project).toBe("proj");
    expect(round.repoRoot).toBe("/root");
  });
});

describe("uniqueIds", () => {
  it("deduplicates preserving first-seen order", () => {
    expect(uniqueIds(["A", "B", "A", "C", "B"])).toEqual(["A", "B", "C"]);
  });
});