import { describe, expect, it } from "vitest";
import {
  affectedAreas,
  admitOne,
  orderBatch,
  scanDiff,
  SECRET_PATTERNS,
} from "./batch-merge.js";
import type { QcEvidence } from "./batch-merge.js";

// ---------------------------------------------------------------------------
// Fixture QC verdicts + queues (the acceptance "fixture queue")
// ---------------------------------------------------------------------------

function passQc(commit: string, extra: Partial<QcEvidence> = {}): QcEvidence {
  return {
    taskId: "T-1",
    phase: "PASS",
    commit,
    checksRun: "npx vitest run …",
    defectsFound: 0,
    defectsFixed: 0,
    finalTestResult: "PASS",
    qcAgent: "qc-batch",
    blockers: [],
    ...extra,
  };
}

const noopResolve = async (_ref: string) => "0".repeat(40);
const noopAncestor = async () => true;

function input(overrides: Partial<Parameters<typeof admitOne>[0]> = {}) {
  return {
    entry: { taskId: "T-1", branch: "task/T-1" },
    qc: passQc("a".repeat(40)),
    task: undefined,
    landed: new Set<string>(),
    satisfiedDeps: new Set<string>(),
    resolveRef: noopResolve,
    isAncestor: noopAncestor,
    integrationBranch: "integration",
    ...overrides,
  };
}

describe("admitOne — no QC PASS = no merge (runbook §7.2 step 3/4)", () => {
  it("admits a clean Sonnet-QC-PASS entry", async () => {
    const d = await admitOne(input());
    expect(d.ok).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("rejects a missing qc.json", async () => {
    const d = await admitOne(input({ qc: null }));
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("NO_QC_PASS");
  });

  it("rejects a non-PASS phase (BUILDER_DONE, FAIL, QC_FIXING…)", async () => {
    for (const phase of ["BUILDER_DONE", "FAIL", "QC_FIXING", "PENDING"]) {
      const d = await admitOne(input({ qc: passQc("a".repeat(40), { phase }) }));
      expect(d.ok).toBe(false);
      expect(d.reason).toBe("NO_QC_PASS");
    }
  });

  it("rejects failing tests even when phase says PASS", async () => {
    const d = await admitOne(
      input({ qc: passQc("a".repeat(40), { finalTestResult: "FAIL" }) }),
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("FAILING_TESTS");
  });

  it("rejects open defects (found > fixed)", async () => {
    const d = await admitOne(
      input({ qc: passQc("a".repeat(40), { defectsFound: 3, defectsFixed: 1 }) }),
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("QC_OPEN_DEFECTS");
  });

  it("rejects open blockers", async () => {
    const d = await admitOne(
      input({ qc: passQc("a".repeat(40), { blockers: ["needs rebase"] }) }),
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("BLOCKERS_PRESENT");
  });

  it("rejects unsatisfied dependencies even with QC PASS", async () => {
    const d = await admitOne(
      input({
        task: { id: "T-1", dependsOn: ["T-0"] },
        satisfiedDeps: new Set<string>(),
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("DEPENDENCIES_UNSATISFIED");
  });

  it("accepts a dependency satisfied by qc PASS evidence alone", async () => {
    const d = await admitOne(
      input({
        task: { id: "T-1", dependsOn: ["T-0"] },
        satisfiedDeps: new Set(["T-0"]),
      }),
    );
    expect(d.ok).toBe(true);
  });

  it("rejects a branch that does not resolve", async () => {
    const d = await admitOne(
      input({ resolveRef: async () => null }),
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("BRANCH_MISSING");
  });

  it("rejects when the QC commit is not on the branch", async () => {
    const d = await admitOne(input({ isAncestor: async () => false }));
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("QC_COMMIT_NOT_ON_BRANCH");
  });

  it("rejects an already-merged task id", async () => {
    const d = await admitOne(input({ landed: new Set(["T-1"]) }));
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("ALREADY_MERGED");
  });
});

describe("orderBatch — dependency-first, then conflict risk", () => {
  const paths = (sets: Record<string, string[]>) => {
    const m = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(sets)) m.set(k, new Set(v));
    return m;
  };

  it("orders a dependency chain dep → dependent", () => {
    const out = orderBatch(
      ["B", "A"],
      new Map([
        ["B", ["A"]],
        ["A", []],
      ]),
      paths({ A: ["packages/core/src/a.ts"], B: ["packages/core/src/b.ts"] }),
    );
    expect(out).toEqual(["A", "B"]);
  });

  it("lower-overlap items merge before higher-overlap ties", () => {
    const out = orderBatch(
      ["X", "Y"],
      new Map([
        ["X", []],
        ["Y", []],
      ]),
      paths({
        X: ["packages/core/src/x.ts"],
        Y: ["packages/core/src/shared.ts", "packages/core/src/x.ts"],
      }),
    );
    expect(out[0]).toBe("X");
  });

  it("ties break alphabetically for deterministic plans", () => {
    const out = orderBatch(
      ["C", "A", "B"],
      new Map(),
      paths({ A: ["p/1.ts"], B: ["p/2.ts"], C: ["p/3.ts"] }),
    );
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("drops dependencies outside the batch without stalling the item", () => {
    const out = orderBatch(
      ["A"],
      new Map([["A", ["NOT-IN-BATCH"]]]),
      paths({ A: ["p/1.ts"] }),
    );
    expect(out).toEqual(["A"]);
  });

  it("handles a diamond graph without repeats", () => {
    const out = orderBatch(
      ["D", "B", "C", "A"],
      new Map([
        ["A", []],
        ["B", ["A"]],
        ["C", ["A"]],
        ["D", ["B", "C"]],
      ]),
      paths({ A: [], B: [], C: [], D: [] }),
    );
    expect(out).toEqual(["A", "B", "C", "D"]);
  });
});

describe("scanDiff — secret scan + heavy media before push", () => {
  it("flags an Anthropic-style key without echoing the value", () => {
    const v = scanDiff(
      'const k = "sk-ant-abcdefghijklmnop123";',
      [],
      () => null,
    );
    // Both the sk-ant- specific pattern and the generic sk- shape hit.
    expect(v.secrets.length).toBeGreaterThanOrEqual(1);
    for (const s of v.secrets) expect(s).toMatch(/^pattern /);
    expect(JSON.stringify(v)).not.toContain("abcdefghijklmnop123");
  });

  it("flags github / aws / private-key shapes", () => {
    for (const sample of [
      "token: ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3",
      "AKIA" + "IOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "key = 'x'.padEnd(30, 'y')".replace("'x'", `'${"a".repeat(30)}'`),
    ]) {
      const hits = SECRET_PATTERNS.filter((re) => re.test(sample));
      if (sample.startsWith("AKIA") || sample.includes("PRIVATE KEY") || sample.includes("ghp_")) {
        expect(hits.length, sample).toBeGreaterThan(0);
      }
    }
  });

  it("flags media extensions as heavy media", () => {
    const v = scanDiff(
      "binary",
      [{ path: "media/clip.mp4", status: "added" }],
      () => null,
    );
    expect(v.heavyMedia).toEqual(["media/clip.mp4"]);
  });

  it("flags oversize non-media blobs", () => {
    const v = scanDiff(
      "binary",
      [{ path: "data/dump.json", status: "added" }],
      () => 10 * 1024 * 1024,
    );
    expect(v.heavyMedia).toEqual(["data/dump.json"]);
  });

  it("passes clean text diffs", () => {
    const v = scanDiff(
      "+export const x = 1;",
      [{ path: "src/x.ts", status: "modified" }],
      () => 120,
    );
    expect(v.secrets).toEqual([]);
    expect(v.heavyMedia).toEqual([]);
  });
});

describe("affectedAreas", () => {
  it("maps package paths to the package area", () => {
    expect(affectedAreas(["packages/core/src/a.ts"])).toEqual(["packages/core"]);
  });

  it("collapses mixed unknown roots to ALL", () => {
    expect(affectedAreas(["remotion/src/x.ts"])).toEqual(["ALL"]);
  });

  it("ignores control-plane and docs paths", () => {
    expect(affectedAreas(["state/tasks.json", "docs/a.md", "ledger.md"])).toEqual([]);
  });
});