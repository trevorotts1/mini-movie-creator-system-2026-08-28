// DIR-015 command tests — `mmcs storyboard` + `mmcs approve-storyboard`
// over the CORE-011 dispatcher seam (mergeSpecs/buildProgram) and the pure
// command contracts with injected ports.
import { describe, expect, it } from "vitest";

import { buildProgram, dispatch } from "../../dispatch/dispatcher.js";
import { buildRegistry, mergeSpecs } from "../../dispatch/registry.js";
import type { Handler } from "../../dispatch/stubs.js";
import {
  APPROVE_STORYBOARD_SPEC,
  STORYBOARD_SPEC,
  makeStoryboardHandlers,
  parseStoryboardOptions,
  runApproveStoryboard,
  runStoryboardCommand,
  type GateDecisionInputLike,
  type GateSnapshotLike,
  type GateStateLike,
  type StoryboardApprovalPortLike,
  type StoryboardCommandPorts,
  type StoryboardPlanSummaryLike,
} from "./commands.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function planSummary(episodeCode = "S01E01"): StoryboardPlanSummaryLike {
  return {
    episodeCode,
    aspectRatio: "16:9",
    approvalState: "DRAFT",
    contractCount: 2,
    shotIds: ["SC01-SH01", "SC01-SH02"],
    skippedShotIds: [],
  };
}

const ALL_GATES = [
  "concept",
  "script",
  "character",
  "storyboard",
  "rough-cut",
  "canon",
] as const;

/**
 * In-memory mirror of core `ApprovalStore` semantics (§3 transitions +
 * gate-order enforcement on approve) — what the bootstrap injects at
 * integration, so the tests prove the command honors those guarantees.
 */
function memoryGates(initial?: Partial<Record<string, GateStateLike>>) {
  const states: Record<string, GateStateLike> = {};
  for (const gate of ALL_GATES) states[gate] = "PENDING";
  Object.assign(states, initial ?? {});
  /** Decision inputs seen by approve()/reject(), in call order. */
  const seen: Array<{ op: "approve" | "reject"; gate: string; decision?: GateDecisionInputLike }> = [];

  const snapshotOf = (gate: string): GateSnapshotLike => ({
    gate,
    state: states[gate] ?? "PENDING",
    approvedAt: states[gate] === "APPROVED" ? "2026-08-28T10:00:00.000Z" : null,
    rejectedAt: states[gate] === "REJECTED" ? "2026-08-28T10:00:00.000Z" : null,
    decidedBy: "trevor",
    note: null,
  });

  const transition = (
    gate: string,
    to: GateStateLike,
    decision?: GateDecisionInputLike,
  ): { state: string } => {
    const from = states[gate] ?? "PENDING";
    const legal: Record<GateStateLike, readonly GateStateLike[]> = {
      PENDING: ["APPROVED", "REJECTED"],
      APPROVED: ["PENDING"],
      REJECTED: ["PENDING"],
    };
    if (!legal[from].includes(to)) {
      throw new Error(`illegal gate transition ${from} → ${to} for "${gate}"`);
    }
    states[gate] = to;
    void decision;
    return { state: to };
  };

  const port: StoryboardApprovalPortLike & {
    reopen(gate: string): Promise<{ state: string }>;
  } = {
    async approve(gate, decision) {
      seen.push({ op: "approve", gate, decision });
      const index = ALL_GATES.indexOf(gate as (typeof ALL_GATES)[number]);
      for (let i = 0; i < index; i++) {
        const earlier = ALL_GATES[i] as string;
        if (states[earlier] !== "APPROVED") {
          throw new Error(
            `gate "${gate}" cannot be approved while earlier gate "${earlier}" is ${states[earlier]} (spec §3 gate order)`,
          );
        }
      }
      return transition(gate, "APPROVED", decision);
    },
    async reject(gate, decision) {
      seen.push({ op: "reject", gate, decision });
      return transition(gate, "REJECTED", decision);
    },
    async snapshot(gate) {
      return snapshotOf(gate);
    },
    async reopen(gate) {
      return transition(gate, "PENDING");
    },
  };

  return {
    port,
    states,
    seen,
    approveEarlierGates(): void {
      states.concept = "APPROVED";
      states.script = "APPROVED";
      states.character = "APPROVED";
    },
  };
}

function ports(
  plan: StoryboardPlanSummaryLike | undefined,
  gates: ReturnType<typeof memoryGates>["port"],
): StoryboardCommandPorts {
  return {
    loadPlan: (episodeCode) =>
      plan !== undefined && plan.episodeCode === episodeCode ? plan : undefined,
    gates,
  };
}

/* ------------------------------------------------------------------ */
/* Option parsing                                                      */
/* ------------------------------------------------------------------ */

describe("parseStoryboardOptions", () => {
  it("parses episode/aspect/json", () => {
    expect(
      parseStoryboardOptions(["--episode", "S01E02", "--aspect", "9:16", "--json"]),
    ).toEqual({ episode: "S01E02", aspect: "9:16", json: true });
  });

  it("parses --reject <note>", () => {
    expect(parseStoryboardOptions(["--reject", "framing is wrong"])).toEqual({
      rejectNote: "framing is wrong",
    });
  });

  it("unknown flag is a usage error", () => {
    expect(parseStoryboardOptions(["--wat", "x"]).parseError).toMatch(/unknown option/);
  });

  it("a value-less flag is a usage error", () => {
    expect(parseStoryboardOptions(["--episode"]).parseError).toMatch(/requires a value/);
  });

  it("a bare positional is a usage error (scriptable, never permissive)", () => {
    expect(parseStoryboardOptions(["S01E01"]).parseError).toMatch(/unexpected argument/);
  });
});

/* ------------------------------------------------------------------ */
/* `mmcs storyboard` — plan, then STOP at gate 4                       */
/* ------------------------------------------------------------------ */

describe("runStoryboardCommand", () => {
  it("prints the plan and the gate-4 STOP banner; exits 0", async () => {
    const double = memoryGates();
    const result = await runStoryboardCommand(
      ["--episode", "S01E01"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("2 frame contract(s) at 16:9");
    expect(text).toContain("planned shot SC01-SH01");
    expect(text).toContain("STOP: gate 4");
    expect(text).toContain("No paid generation while the storyboard is unapproved");
    expect(text).toContain("mmcs approve-storyboard --episode S01E01");
    expect(text).toContain("gate state: PENDING");
  });

  it("missing --episode is a usage error (exit 2)", async () => {
    const double = memoryGates();
    const result = await runStoryboardCommand([], ports(planSummary(), double.port));
    expect(result.exitCode).toBe(2);
    expect(result.lines[0]).toContain("--episode <code> is required");
  });

  it("no plan available exits 1 — nothing invented", async () => {
    const double = memoryGates();
    const result = await runStoryboardCommand(
      ["--episode", "S01E09"],
      ports(undefined, double.port),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join(" ")).toContain("no shot plan available for S01E09");
  });

  it("--aspect reaches the planner (the flag is honored, not dropped)", async () => {
    const double = memoryGates();
    const seenAspects: Array<string | undefined> = [];
    const result = await runStoryboardCommand(
      ["--episode", "S01E01", "--aspect", "9:16"],
      {
        loadPlan: (_episodeCode, aspect) => {
          seenAspects.push(aspect);
          return { ...planSummary(), aspectRatio: aspect ?? "16:9" };
        },
        gates: double.port,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(seenAspects).toEqual(["9:16"]);
    expect(result.lines.join("\n")).toContain("at 9:16");
  });

  it("--json emits the scriptable summary with the stop marker", async () => {
    const double = memoryGates();
    const result = await runStoryboardCommand(
      ["--episode", "S01E01", "--json"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(parsed.stop).toBe("storyboard-approval-gate-4");
    expect(parsed.gate).toBe("PENDING");
    expect(parsed.approvalState).toBe("DRAFT");
  });
});

/* ------------------------------------------------------------------ */
/* `mmcs approve-storyboard` — record the gate-4 decision              */
/* ------------------------------------------------------------------ */

describe("runApproveStoryboard", () => {
  it("approve: PENDING → APPROVED in the store, exits 0", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E01"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    expect(double.states.storyboard).toBe("APPROVED");
    expect(result.lines.join("\n")).toContain("gate 4 APPROVED");
    expect(result.lines.join("\n")).toContain("paid generation may proceed");
  });

  it("approve with an earlier gate still PENDING propagates the gate-order error", async () => {
    const double = memoryGates(); // concept/script/character PENDING
    await expect(
      runApproveStoryboard(["--episode", "S01E01"], ports(planSummary(), double.port)),
    ).rejects.toThrow(/gate order/);
    expect(double.states.storyboard).toBe("PENDING"); // nothing recorded
  });

  it("reject via --reject: gate → REJECTED, plan held at DRAFT, generation stays blocked", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E01", "--reject", "shot 2 framing is wrong"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    expect(double.states.storyboard).toBe("REJECTED");
    const text = result.lines.join("\n");
    expect(text).toContain("gate 4 REJECTED");
    expect(text).toContain("held at DRAFT");
    expect(text).toContain("remains BLOCKED");
  });

  it("approve on an already-APPROVED plan exits 1 (never flip in one step)", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    double.states.storyboard = "APPROVED";
    const approved = { ...planSummary(), approvalState: "APPROVED" as const };
    const result = await runApproveStoryboard(
      ["--episode", "S01E01"],
      ports(approved, double.port),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join(" ")).toContain("already APPROVED");
  });

  it("approve records the operator identity (decidedBy) in the decision", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E01"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    const seen = double.seen.filter((s) => s.op === "approve");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.decision?.decidedBy).toBe("trevor"); // gate records name their decider
  });

  it("reject records the operator identity and the note in the decision", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E01", "--reject", "framing wrong"],
      ports(planSummary(), double.port),
    );
    expect(result.exitCode).toBe(0);
    const seen = double.seen.filter((s) => s.op === "reject");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.decision?.decidedBy).toBe("trevor");
    expect(seen[0]?.decision?.note).toBe("framing wrong");
  });

  it("reject on an already-APPROVED plan exits 1 with the reopen hint (never a raw flip error)", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    double.states.storyboard = "APPROVED";
    const approved = { ...planSummary(), approvalState: "APPROVED" as const };
    const result = await runApproveStoryboard(
      ["--episode", "S01E01", "--reject", "changed my mind"],
      ports(approved, double.port),
    );
    expect(result.exitCode).toBe(1);
    const text = result.lines.join(" ");
    expect(text).toContain("already APPROVED");
    expect(text).toContain("reopen the gate before rejecting");
    expect(double.states.storyboard).toBe("APPROVED"); // gate untouched
    expect(double.seen).toHaveLength(0); // nothing reached the store
  });

  it("reject on an already-REJECTED gate propagates the store transition error", async () => {
    const double = memoryGates();
    double.states.storyboard = "REJECTED";
    await expect(
      runApproveStoryboard(
        ["--episode", "S01E01", "--reject", "still wrong"],
        ports(planSummary(), double.port),
      ),
    ).rejects.toThrow(/illegal gate transition/);
  });

  it("no plan available exits 1 with the storyboard-first hint", async () => {
    const double = memoryGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E09"],
      ports(undefined, double.port),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join(" ")).toContain("mmcs storyboard --episode S01E09");
  });

  it("missing --episode is a usage error (exit 2)", async () => {
    const double = memoryGates();
    const result = await runApproveStoryboard([], ports(planSummary(), double.port));
    expect(result.exitCode).toBe(2);
  });

  it("--json emits the decision record", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const result = await runApproveStoryboard(
      ["--episode", "S01E01", "--json"],
      ports(planSummary(), double.port),
    );
    const parsed = JSON.parse(result.lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(parsed.decision).toBe("APPROVED");
    expect(parsed.gateState).toBe("APPROVED");
  });
});

/* ------------------------------------------------------------------ */
/* Dispatcher seam: specs merge, program wires the real handlers       */
/* ------------------------------------------------------------------ */

/** Capture stdout/stderr the way the backup command tests do. */
function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

/** Command-like options instance — the integration shape when flags register. */
function likeCommand(values: Record<string, unknown>): Record<string, unknown> {
  return { getOptionValue: (k: string) => values[k] };
}

describe("storyboard dispatcher wiring", () => {
  it("both specs merge over the base registry without losing any verb", () => {
    const merged = mergeSpecs(buildRegistry(), [STORYBOARD_SPEC, APPROVE_STORYBOARD_SPEC]);
    const names = merged.map((c) => c.name);
    expect(names).toContain("storyboard");
    expect(names).toContain("approve-storyboard");
    for (const spec of buildRegistry()) {
      expect(names).toContain(spec.name);
    }
    expect(merged.find((c) => c.name === "storyboard")?.group).toBe("storyboard");
    expect(merged.find((c) => c.name === "approve-storyboard")?.group).toBe("storyboard");
  });

  it("buildProgram wires both verbs over the stubs (real handlers in the program)", () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const handlers = makeStoryboardHandlers(
      ports(planSummary(), double.port),
    ) as unknown as Record<string, Handler>;
    const program = buildProgram(
      mergeSpecs(buildRegistry(), [STORYBOARD_SPEC, APPROVE_STORYBOARD_SPEC]),
      handlers,
    );
    // Both verbs resolve on the program without commander errors.
    expect(() => program.parseOptions(["storyboard", "--help"])).not.toThrow();
    void program;
  });

  it("handler prints the plan and STOP banner through a Command-like options instance", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const handlers = makeStoryboardHandlers(ports(planSummary(), double.port));
    const cap = capture();
    try {
      handlers.storyboard!({}, likeCommand({ episode: "S01E01" }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(cap.out.join("")).toContain("STOP: gate 4");
      expect(cap.out.join("")).toContain("gate state: PENDING");
      expect(double.states.storyboard).toBe("PENDING"); // plan alone never advances the gate
    } finally {
      cap.restore();
    }
  });

  it("full flow: storyboard (STOP) → approve-storyboard → gate APPROVED", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const handlers = makeStoryboardHandlers(ports(planSummary(), double.port));
    const cap = capture();
    try {
      handlers.storyboard!({}, likeCommand({ episode: "S01E01" }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(double.states.storyboard).toBe("PENDING");

      handlers["approve-storyboard"]!({}, likeCommand({ episode: "S01E01" }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(double.states.storyboard).toBe("APPROVED");
      expect(cap.out.join("")).toContain("gate 4 APPROVED");
    } finally {
      cap.restore();
    }
  });

  it("bare verb (no flags reach the handler) reports the usage error and exits 1", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const handlers = makeStoryboardHandlers(ports(planSummary(), double.port));
    const cap = capture();
    const prevExit = process.exitCode;
    try {
      handlers.storyboard!({}, {}); // CORE-011 wire passes {} — flags never arrive
      await new Promise((resolve) => setImmediate(resolve));
      expect(cap.err.join("")).toContain("storyboard: --episode <code> is required");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      cap.restore();
    }
  });

  it("an async store rejection surfaces as a clean stderr line, not a raw rejection", async () => {
    const double = memoryGates();
    double.approveEarlierGates();
    const failing: StoryboardCommandPorts = {
      loadPlan: () => planSummary(),
      gates: {
        ...double.port,
        async approve() {
          throw new Error("disk unavailable");
        },
      },
    };
    const handlers = makeStoryboardHandlers(failing);
    const cap = capture();
    const prevExit = process.exitCode;
    try {
      handlers["approve-storyboard"]!({}, likeCommand({ episode: "S01E01" }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(cap.err.join("")).toContain("approve-storyboard: disk unavailable");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      cap.restore();
    }
  });
});
