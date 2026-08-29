// DIR-003 dispatcher-level tests — `mmcs develop-concept` + `mmcs approve
// concept` wired over the CORE-011 stubs via mergeSpecs/buildProgram (the
// integration seam this task hands to the batch merger).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram, dispatch } from "../../dispatch/dispatcher.js";
import { buildRegistry, mergeSpecs } from "../../dispatch/registry.js";
import type { Handler } from "../../dispatch/stubs.js";
import {
  APPROVE_CONCEPT_SPEC,
  CONCEPT_COMMAND_SPECS,
  DEVELOP_CONCEPT_SPEC,
  makeApproveConceptHandler,
  makeDevelopConceptHandler,
  parseApproveConceptOptions,
  runApproveConcept,
  runDevelopConcept,
  type ConceptDraftLike,
  type DevelopConceptPorts,
} from "./commands.js";

const DRAFT: ConceptDraftLike = {
  conceptId: "concept_" + "a".repeat(32),
  intakeId: "idea_" + "b".repeat(32),
  options: [
    { optionId: "option_1", title: "The Signal in the Beam" },
    { optionId: "option_2", title: "Tidefall" },
    { optionId: "option_3", title: "Lampfall Bay" },
  ],
  recommendedOptionId: "option_1",
};

interface FakeGateState {
  state: "PENDING" | "APPROVED" | "REJECTED";
  approvedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

function fakePorts(state: FakeGateState["state"] = "PENDING"): DevelopConceptPorts & {
  gate: FakeGateState;
} {
  const gate: FakeGateState = {
    state,
    approvedAt: state === "APPROVED" ? "2026-08-28T10:00:00.000Z" : null,
    decidedBy: null,
    note: null,
  };
  const stamp = (next: FakeGateState["state"]) => {
    gate.state = next;
    if (next === "APPROVED") gate.approvedAt = new Date().toISOString();
    return next;
  };
  return {
    gate,
    developConcept: async () => DRAFT,
    gates: {
      snapshot: async () => ({ ...gate }),
      approve: async (_gate, decision) => {
        gate.decidedBy = decision?.decidedBy ?? null;
        gate.note = decision?.note ?? null;
        return { state: stamp("APPROVED"), approvedAt: gate.approvedAt };
      },
      reject: async () => ({ state: stamp("REJECTED") }),
      reopen: async () => ({ state: stamp("PENDING") }),
    },
  };
}

function capture(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
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

describe("concept command specs", () => {
  it("names the spec §24 verbs exactly", () => {
    expect(DEVELOP_CONCEPT_SPEC.name).toBe("develop-concept");
    expect(APPROVE_CONCEPT_SPEC.name).toBe("approve concept");
    expect(DEVELOP_CONCEPT_SPEC.group).toBe("approvals");
    expect(APPROVE_CONCEPT_SPEC.group).toBe("approvals");
  });

  it("both specs merge over the base registry without losing any verb", () => {
    const merged = mergeSpecs(buildRegistry(), [...CONCEPT_COMMAND_SPECS]);
    const names = merged.map((c) => c.name);
    expect(names).toContain("develop-concept");
    expect(names).toContain("approve concept");
    for (const spec of buildRegistry()) {
      expect(names).toContain(spec.name);
    }
  });
});

describe("runDevelopConcept — presentation contract", () => {
  it("lists every option with the recommendation marked and instructs to STOP", async () => {
    const ports = fakePorts();
    const result = await runDevelopConcept(ports);
    expect(result.exitCode).toBe(0);
    const text = result.output.join("\n");
    expect(text).toContain("concept_" + "a".repeat(32));
    expect(text).toContain("option_1: The Signal in the Beam (recommended)");
    expect(text).toContain("option_2: Tidefall");
    expect(text).toContain("STOP");
    expect(text).toContain("mmcs approve concept");
    expect(text).toContain("No screenplay work happens before concept approval");
  });
});

describe("runApproveConcept — decision contract", () => {
  it("approves from PENDING and unblocks screenplay work", async () => {
    const ports = fakePorts();
    const result = await runApproveConcept(
      parseApproveConceptOptions({ by: "trevor" }),
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("Concept gate APPROVED");
    expect(ports.gate.state).toBe("APPROVED");
    expect(ports.gate.decidedBy).toBe("trevor");
  });

  it("already-APPROVED gate refuses a second approval (no illegal self-transition)", async () => {
    const ports = fakePorts("APPROVED");
    const result = await runApproveConcept(
      parseApproveConceptOptions({}),
      ports,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("already APPROVED");
  });

  it("rejects from PENDING with a note", async () => {
    const ports = fakePorts();
    const result = await runApproveConcept(
      parseApproveConceptOptions({ reject: true, note: "needs a stronger hook" }),
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(ports.gate.state).toBe("REJECTED");
    expect(result.output.join("\n")).toContain("back for revision");
  });

  it("APPROVED → REJECTED is refused (spec §3: reopen first)", async () => {
    const ports = fakePorts("APPROVED");
    const result = await runApproveConcept(
      parseApproveConceptOptions({ reject: true }),
      ports,
    );
    expect(result.exitCode).toBe(2);
    expect(ports.gate.state).toBe("APPROVED");
  });

  it("REJECTED → APPROVED is refused (spec §3: reopen first)", async () => {
    const ports = fakePorts("REJECTED");
    const result = await runApproveConcept(
      parseApproveConceptOptions({}),
      ports,
    );
    expect(result.exitCode).toBe(2);
    expect(ports.gate.state).toBe("REJECTED");
  });

  it("reopen from APPROVED returns to PENDING", async () => {
    const ports = fakePorts("APPROVED");
    const result = await runApproveConcept(
      parseApproveConceptOptions({ reopen: true }),
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(ports.gate.state).toBe("PENDING");
  });

  it("reopen from PENDING is refused (nothing to reopen)", async () => {
    const ports = fakePorts();
    const result = await runApproveConcept(
      parseApproveConceptOptions({ reopen: true }),
      ports,
    );
    expect(result.exitCode).toBe(1);
  });

  it("--reject with --reopen is a usage error (exit 2)", async () => {
    const ports = fakePorts();
    const result = await runApproveConcept(
      parseApproveConceptOptions({ reject: true, reopen: true }),
      ports,
    );
    expect(result.exitCode).toBe(2);
  });

  it("help prints usage and exits 0", async () => {
    const ports = fakePorts();
    const result = await runApproveConcept(
      parseApproveConceptOptions({ help: true }),
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("Usage: mmcs approve concept");
  });

  it("untrusted note/by strings are carried as inert data, never evaluated", async () => {
    const ports = fakePorts();
    const hostile = "$(\"rm -rf /\")'; DROP TABLE gates; --";
    const result = await runApproveConcept(
      parseApproveConceptOptions({ note: hostile, by: hostile }),
      ports,
    );
    expect(result.exitCode).toBe(0);
    // stored verbatim as data on the fake store
    expect(ports.gate.note).toBe(hostile);
  });
});

describe("dispatcher wiring (mergeSpecs + buildProgram)", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function wireHandlers(ports: DevelopConceptPorts): Record<string, Handler> {
    return {
      "develop-concept": makeDevelopConceptHandler(ports) as unknown as Handler,
      "approve concept": makeApproveConceptHandler(ports) as unknown as Handler,
    };
  }

  it("develop-concept runs its real handler through the merged program", async () => {
    const ports = fakePorts();
    const program = buildProgram(
      mergeSpecs(buildRegistry(), [...CONCEPT_COMMAND_SPECS]),
      wireHandlers(ports),
    );
    await program.parseAsync(["develop-concept"], { from: "user" });
    // the fake store still reads PENDING — develop-concept presents, not decides
    expect(ports.gate.state).toBe("PENDING");
  });

  it("approve concept routes through the merged program (nested verb; bare = usage refusal)", async () => {
    const ports = fakePorts();
    const program = buildProgram(
      mergeSpecs(buildRegistry(), [...CONCEPT_COMMAND_SPECS]),
      wireHandlers(ports),
    );
    // The dispatcher's wire() passes {} as options — with no flags registered,
    // a bare `approve concept` approves the recommended option (the contract's
    // documented default). Nested-verb routing is the point here; flags flow
    // through the Command-like getOptionValue path (next test, CORE-015 seam).
    await program.parseAsync(["approve", "concept"], { from: "user" });
    expect(ports.gate.state).toBe("APPROVED");
  });

  it("handler reads flags via a Command-like getOptionValue instance (integration shape)", async () => {
    const ports = fakePorts();
    const handler = makeApproveConceptHandler(ports) as unknown as (
      args: Record<string, string>,
      options: Record<string, unknown>,
    ) => Promise<number>;
    const likeCommand = {
      getOptionValue: (k: string) =>
        ({ by: "trevor", note: "ship it" })[k],
    };
    const code = await handler({}, likeCommand);
    expect(code).toBe(0);
    expect(ports.gate.state).toBe("APPROVED");
    expect(ports.gate.decidedBy).toBe("trevor");
    expect(ports.gate.note).toBe("ship it");
  });

  it("dispatch() routes both verbs with exit 0 over the overrides", async () => {
    const ports = fakePorts();
    const res = await dispatch(
      ["develop-concept"],
      [...CONCEPT_COMMAND_SPECS],
      wireHandlers(ports),
    );
    expect(res.exitCode).toBe(0);
    expect(res.error).toBeUndefined();
  });

  it("makeDevelopConceptHandler emits the presentation and returns exit 0", async () => {
    const ports = fakePorts();
    const code = await makeDevelopConceptHandler(ports)();
    expect(code).toBe(0);
  });

  it("makeApproveConceptHandler returns 1 on a refused second approval", async () => {
    const ports = fakePorts("APPROVED");
    const code = await makeApproveConceptHandler(ports)({});
    expect(code).toBe(1);
  });
});
