/// <reference types="node" />
/**
 * e2e-dry-run.test.ts — REL-004 test: the full dry-run module stays green
 * and its report generation stays honest.
 *
 * The heavyweight proof lives in the runner itself (scripts/release/
 * e2e-dry-run.ts executes the whole §30 pipeline against real subsystem
 * code). These tests pin the contract the batch-merge gate relies on:
 *   1. the scenario module exports the runner + report surface,
 *   2. runE2eDryRun() on a tiny scratch fixture exits with EVERY scenario
 *      PASS (the same green the wrapper e2e-dry-run.sh gates on),
 *   3. renderMarkdown() reports honestly (PASS/FAIL echo, live coverage
 *      marked BLOCKED — the spec §30 honesty rule).
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main, renderMarkdown, runE2eDryRun } from "./e2e-dry-run.js";

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = join(tmpdir(), `mmcs-e2e-dry-run-test-${process.pid}-${Date.now()}`);
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("e2e-dry-run (REL-004)", () => {
  it("exposes the runner + report surface the wrapper and report own", () => {
    expect(typeof runE2eDryRun).toBe("function");
    expect(typeof renderMarkdown).toBe("function");
    expect(typeof main).toBe("function");
  });

  it("runs the FULL scenario list with every scenario PASS on a scratch run", async () => {
    const result = await runE2eDryRun({ scratchRoot });
    expect(result.ok).toBe(true);
    expect(result.scenarios.length).toBeGreaterThanOrEqual(8);
    for (const scenario of result.scenarios) {
      expect(scenario.ok, `${scenario.scenario} failed: ${scenario.steps.map((s) => `${s.name}=${s.ok ? "ok" : "FAIL"}`).join(", ")}`).toBe(true);
    }
    // Stage coverage: the pipeline's §30 spine is all present.
    const names = result.scenarios.map((s) => s.scenario).join("|");
    expect(names).toContain("S0-S1");
    expect(names).toContain("S2-S3");
    expect(names).toContain("S11-S14");
    expect(names).toContain("S19-S20");
    expect(names).toContain("S21-S23");
    // Scratch dir kept for inspection (caller cleans up).
    rmSync(scratchRoot, { recursive: true, force: true });
  }, 240_000);

  it("renderMarkdown is scenario-driven (PASS echo + BLOCKED live coverage)", async () => {
    const result = await runE2eDryRun({ scratchRoot });
    const md = renderMarkdown(result);
    expect(md).toContain("MMCS End-to-End Dry Run Report");
    expect(md).toContain("**Result: PASS**");
    expect(md).toContain("BLOCKED — credentials absent");
    // Honesty regression (QC fix): the restart-boundary bullet must describe
    // the mechanics that actually ran (SQLite / in-memory map) — no phantom
    // "shared map" store claimed without being exercised.
    expect(md).toContain("SAME durable store (SQLite or in-memory map)");
    expect(md).not.toContain("shared map");
    // Every scenario line carries its verdict.
    for (const s of result.scenarios) {
      expect(md).toContain(s.scenario);
    }
    rmSync(scratchRoot, { recursive: true, force: true });
  }, 240_000);

  it("main() exits 0 and can write the markdown report (--markdown contract)", async () => {
    const code = await main(["--markdown", "--scratch", scratchRoot]);
    expect(code).toBe(0);
    const report = readFileSync(
      join(__dirname, "..", "..", "docs", "e2e-dry-run-report.md"),
      "utf8",
    );
    expect(report).toContain("MMCS End-to-End Dry Run Report");
  }, 300_000);
});