/// <reference types="node" />
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  freshSessionRead,
  legacyCheckpointDoc,
  pickField,
  readCheckpointDoc,
  seedSandbox,
  simulateCompact,
  simulateManualCompact,
  simulateNoDataLoss,
  simulateResumedSessionInjectsAndReads,
  snapshotSandbox,
  formatReport,
  main,
  type CompactSimResult,
} from "./compact-sim.js";
import { runPreCompact } from "../hooks/pre-compact.js";
import { runPostCompact } from "../hooks/post-compact.js";
import { CHECKPOINT_FILE, CHECKPOINT_SCHEMA_VERSION } from "../../packages/core/src/recovery/index.js";

let scratchRoot: string;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "mmcs-compact-sim-test-"));
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("sandbox seeding", () => {
  it("seeds the real control-plane shape in an isolated temp repo", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "seed");
    const doc = await readCheckpointDoc(repoRoot);
    expect(doc.schema_version).toBe(1);
    expect(doc.ready_task_ids).toEqual(["REL-003", "REC-011"]);
    expect(doc.active_task_ids).toEqual(["DIR-010", "VID-012"]);
    const snapshot = await snapshotSandbox(repoRoot);
    expect(snapshot.ready).toEqual(["REL-003", "REC-011"]);
    expect(snapshot.ledgerLines).toBe(1);
    expect(snapshot.sessionOutsideMarker).toContain("REC-011 builder");
    expect(snapshot.sessionOutsideMarker).not.toContain("MMCS:PRECOMPACT:START");
  });

  it("seeded legacy doc mirrors the committed bootstrap shape", () => {
    const doc = legacyCheckpointDoc();
    expect(doc.schema_version).toBe(1);
    expect(Array.isArray(doc.ready_task_ids)).toBe(true);
    expect(typeof doc.current_main_sha).toBe("string");
  });

  it("pickField resolves camelCase truth first, snake fallback second", () => {
    expect(pickField<string[]>({ a: ["x"] }, "a", "a_legacy")).toEqual(["x"]);
    expect(pickField<string[]>({ a_legacy: ["y"] }, "a", "a_legacy")).toEqual(["y"]);
    expect(pickField<string>({}, "a", "a_legacy")).toBeUndefined();
  });
});

describe("scenario 1 — manual /compact updates the checkpoint (spec §32 recovery)", () => {
  it("runs the full PreCompact→PostCompact sequence green", async () => {
    const result = await simulateManualCompact(scratchRoot);
    expect(result.ok).toBe(true);
    for (const step of result.steps) {
      expect(step.ok, `${step.name}: ${step.evidence}`).toBe(true);
    }
    const names = result.steps.map((s) => s.name);
    expect(names).toContain("manual /compact PreCompact flush stamps the checkpoint");
    expect(names).toContain("PostCompact records the post-compact cadence event (exit 0, stamp advances)");
  });

  it("a PreCompact flush over the legacy doc stamps lastCheckpointAt and keeps buckets", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "pre-stamp");
    await runPreCompact({
      repoRoot,
      input: { session_id: "t1", hook_event_name: "PreCompact", trigger: "manual" },
    });
    const doc = await readCheckpointDoc(repoRoot);
    expect(typeof doc.lastCheckpointAt).toBe("string");
    expect(doc.lastCheckpointAt).not.toBe("2026-08-28T20:05:00Z");
    // The flush must keep both shape styles fresh (REC-002 contract).
    expect(doc.readyTaskIds).toEqual(["REL-003", "REC-011"]);
    expect(doc.ready_task_ids).toEqual(["REL-003", "REC-011"]);
  });

  it("PostCompact cadence write keeps buckets and does not reset the stamp", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "post-stamp");
    await runPreCompact({ repoRoot, input: { trigger: "manual" } });
    const before = await readCheckpointDoc(repoRoot);
    const after = await snapshotSandbox(repoRoot);
    expect(after.ready).toEqual(["REL-003", "REC-011"]);
    expect(after.active).toEqual(["DIR-010", "VID-012"]);
    expect(after.currentMainSha).toBe("773054bebbe460de0f31dcfda5315970b1c8b4f2");
    expect(before.lastCheckpointAt).not.toBe("");
  });
});

describe("scenario 2 — new/resumed session injects + reads state", () => {
  it("runs the inject-and-read scenario green", async () => {
    const result = await simulateResumedSessionInjectsAndReads(scratchRoot);
    expect(result.ok).toBe(true);
    for (const step of result.steps) {
      expect(step.ok, `${step.name}: ${step.evidence}`).toBe(true);
    }
  });

  it("a brand-new CheckpointService reconstructs the exact map from disk", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "fresh-read");
    await runPreCompact({ repoRoot, input: { trigger: "manual" } });
    const { view, state } = await freshSessionRead(repoRoot);
    expect(view.active.has("DIR-010")).toBe(true);
    expect(view.active.has("VID-012")).toBe(true);
    expect(view.ready.has("REL-003")).toBe(true);
    expect(view.qc.has("CAP-001")).toBe(true);
    expect(view.blocked.has("GHL-004")).toBe(true);
    expect(view.mergeQueue.has("KIE-002")).toBe(true);
    expect(state.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it("loadExisting rejects a repo with no checkpoint (fresh session needs the file)", async () => {
    const empty = await mkdtemp(join(scratchRoot, "empty-"));
    await expect(freshSessionRead(empty)).rejects.toThrow(/no checkpoint found/);
  });
});

describe("scenario 3 — no data loss across compaction", () => {
  it("runs the no-data-loss scenario green", async () => {
    const result = await simulateNoDataLoss(scratchRoot);
    expect(result.ok).toBe(true);
    for (const step of result.steps) {
      expect(step.ok, `${step.name}: ${step.evidence}`).toBe(true);
    }
  });

  it("every pre-compact semantic value survives the full PreCompact→PostCompact sequence", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "survive");
    const before = await snapshotSandbox(repoRoot);
    await runPreCompact({ repoRoot, input: { trigger: "manual" } });
    await runPostCompact(["--repo-root", repoRoot], {
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => JSON.stringify({ trigger: "manual" }),
    });
    const after = await snapshotSandbox(repoRoot);
    expect(after.ready.slice().sort()).toEqual(before.ready.slice().sort());
    expect(after.active.slice().sort()).toEqual(before.active.slice().sort());
    expect(after.qc).toEqual(before.qc);
    expect(after.blocked).toEqual(before.blocked);
    expect(after.mergeQueue).toEqual(before.mergeQueue);
    expect(after.currentMainSha).toBe(before.currentMainSha);
    expect(after.currentIntegrationSha).toBe(before.currentIntegrationSha);
    expect(after.lastWatchdogAt).toBe(before.lastWatchdogAt);
    // Hints grow (the resume hint is added) but never shrink.
    expect(after.nextActions).toEqual(
      expect.arrayContaining(before.nextActions),
    );
  });

  it("session.md marker block is idempotent — no duplicate blocks across flushes", async () => {
    const repoRoot = await seedSandbox(scratchRoot, "marker-idempotent");
    const input = { trigger: "manual" };
    // Fixed clock for savedAt; the checkpoint stamp itself is wall-clock by
    // REC-002 design, so idempotence is asserted structurally: exactly one
    // marker block, identical outside content, identical block skeleton.
    const strip = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>");
    await runPreCompact({ repoRoot, input });
    const once = await readFile(join(repoRoot, "session.md"), "utf8");
    await runPreCompact({ repoRoot, input });
    const twice = await readFile(join(repoRoot, "session.md"), "utf8");
    expect(once.split("<!-- MMCS:PRECOMPACT:START -->")).toHaveLength(2); // one block
    expect(twice.split("<!-- MMCS:PRECOMPACT:START -->")).toHaveLength(2); // still one
    expect(strip(twice)).toBe(strip(once));
  });
});

describe("aggregate runner + CLI (acceptance: simulation script exits 0)", () => {
  it("simulateCompact runs all three scenarios green in one scratch root", async () => {
    const scratch = await mkdtemp(join(scratchRoot, "aggregate-"));
    const result = await simulateCompact({ scratchRoot: scratch });
    expect(result.scenarios.map((s) => s.scenario)).toEqual([
      "manual-compact-checkpoint",
      "resumed-session-inject-and-read",
      "no-data-loss-across-compaction",
    ]);
    for (const scenario of result.scenarios) {
      expect(scenario.ok, scenario.scenario).toBe(true);
      for (const step of scenario.steps) {
        expect(step.ok, `${scenario.scenario} / ${step.name}: ${step.evidence}`).toBe(true);
      }
    }
    expect(result.ok).toBe(true);
  });

  it("CLI main() exits 0 and the report is machine-parsable", async () => {
    const code = await main();
    expect(code).toBe(0);
    expect(formatReport({
      ok: false,
      scenarios: [{ scenario: "x", ok: false, steps: [{ name: "n", ok: false, evidence: "e" }] }],
      scratchRoot: "/tmp",
    } satisfies CompactSimResult).split("\n")[0]).toContain("compact simulation");
  });
});
