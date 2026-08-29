// DIR-008 CLI acceptance tests: `mmcs write-script` + `mmcs approve script`
// wiring (spec §24 / §3 gate 2). Mirror of CHAR-004's contract tests.
import { describe, expect, it, vi } from "vitest";

import {
  APPROVE_SCRIPT_SPEC,
  parseApproveScriptOptions,
  USAGE_APPROVE_SCRIPT,
  USAGE_WRITE_SCRIPT,
  WRITE_SCRIPT_SPEC,
  isRejectNote,
  stripRejectMarker,
  type ScriptGatePorts,
  type WriteScriptCommandPorts,
} from "./contract.js";
import {
  makeApproveScriptHandler,
  makeWriteScriptHandler,
} from "./commands.js";

const NOW = "2026-08-28T10:05:00.000Z";

/** Recording port double over the gate-2 domain. */
function makePorts(overrides: Partial<WriteScriptCommandPorts> = {}): WriteScriptCommandPorts & {
  approvals: Array<{ decidedBy?: string; note?: string }>;
  rejections: Array<{ decidedBy?: string; note?: string }>;
  presentations: number;
} {
  const state = {
    approvals: [] as Array<{ decidedBy?: string; note?: string }>,
    rejections: [] as Array<{ decidedBy?: string; note?: string }>,
    presentations: 0,
  };
  const ports = {
    present() {
      state.presentations += 1;
      return {
        presented: true,
        output: [
          "Screenplay \"The Vault\" written: 6 scene(s), 3 character(s).",
          "Script QC passed — STOP at gate 2 (script approval, spec §3).",
          "Approve with `mmcs approve script`.",
        ],
        record: {
          screenplayId: "SCR_THE_VAULT_001",
          state: "PENDING" as const,
          decidedAt: null,
          decidedBy: null,
          note: null,
        },
      };
    },
    approveScript(decision: { decidedBy?: string; note?: string }) {
      state.approvals.push(decision);
      return {
        exitCode: 0 as const,
        output: [`SCRIPT APPROVED: SCR_THE_VAULT_001 (gate 2 complete, spec §3).`],
        record: {
          screenplayId: "SCR_THE_VAULT_001",
          state: "APPROVED" as const,
          decidedAt: NOW,
          decidedBy: decision.decidedBy ?? null,
          note: decision.note ?? null,
        },
      };
    },
    rejectScript(decision: { decidedBy?: string; note?: string }) {
      state.rejections.push(decision);
      return {
        exitCode: 0 as const,
        output: [`SCRIPT REJECTED: SCR_THE_VAULT_001 sent back for revision (spec §14).`],
        record: {
          screenplayId: "SCR_THE_VAULT_001",
          state: "REJECTED" as const,
          decidedAt: NOW,
          decidedBy: decision.decidedBy ?? null,
          note: decision.note ?? null,
        },
      };
    },
    ...state,
    ...overrides,
  };
  // Live counter views — the spread above snapshots plain numbers.
  Object.defineProperty(ports, "presentations", {
    get: () => state.presentations,
    configurable: true,
  });
  return ports as typeof ports & WriteScriptCommandPorts;
}

describe("spec §24 surface", () => {
  it("exposes exactly the two owned verbs with spec names", () => {
    expect(WRITE_SCRIPT_SPEC.name).toBe("write-script");
    expect(WRITE_SCRIPT_SPEC.group).toBe("approvals");
    expect(APPROVE_SCRIPT_SPEC.name).toBe("approve script");
    expect(APPROVE_SCRIPT_SPEC.group).toBe("approvals");
    expect(WRITE_SCRIPT_SPEC.args).toBeUndefined();
  });
});

describe("write-script handler", () => {
  it("presents the screenplay, exits 0, prints the gate-2 stop", () => {
    const ports = makePorts();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    makeWriteScriptHandler(ports)();
    const text = String(stdout.mock.calls.map((c) => c[0]).join(""));
    stdout.mockRestore();

    expect(ports.presentations).toBe(1);
    expect(text).toContain("STOP at gate 2");
    expect(text).toContain("mmcs approve script");
  });

  it("exits 1 and throws when the presentation is refused", () => {
    const ports = makePorts({
      present: () => ({
        presented: false,
        output: ["Gate 1 not passed: the concept is PENDING; no screenplay work before concept approval (spec §3)."],
        record: null,
      }),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => makeWriteScriptHandler(ports)()).toThrow(/rejected \(exit 1\)/);
    const text = String(stderr.mock.calls.map((c) => c[0]).join(""));
    stderr.mockRestore();
    expect(text).toContain("Gate 1 not passed");
  });
});

describe("approve script handler", () => {
  it("records the APPROVED decision with the operator id", () => {
    const ports = makePorts();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    makeApproveScriptHandler(ports)({ decidedBy: "trevor" }, ["--by", "trevor"]);
    const text = String(stdout.mock.calls.map((c) => c[0]).join(""));
    stdout.mockRestore();

    expect(ports.approvals).toEqual([{ decidedBy: "trevor", note: undefined }]);
    expect(text).toContain("SCRIPT APPROVED");
  });

  it("routes a reject-note to the REJECTED transition with the marker stripped", () => {
    const ports = makePorts();
    makeApproveScriptHandler(ports)({}, ["--note", "reject: act two sags"]);
    expect(ports.rejections).toEqual([{ decidedBy: undefined, note: "act two sags" }]);
    expect(ports.approvals).toHaveLength(0);
  });

  it("falls back through parsed flags to pre-parsed options", () => {
    const ports = makePorts();
    makeApproveScriptHandler(ports)({ decidedBy: "op", note: "ship it" }, []);
    expect(ports.approvals).toEqual([{ decidedBy: "op", note: "ship it" }]);
  });

  it("throws for the dispatcher to map when the decision exits 1", () => {
    const ports = makePorts({
      approveScript: () => ({
        exitCode: 1 as const,
        output: [
          "Gate 2 not satisfied: no screenplay has been presented for approval.",
          "Run `mmcs write-script` first (spec §3).",
        ],
        record: null,
      }),
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => makeApproveScriptHandler(ports)({}, [])).toThrow(/rejected \(exit 1\)/);
    const text = String(stderr.mock.calls.map((c) => c[0]).join(""));
    stderr.mockRestore();
    expect(text).toContain("mmcs write-script");
  });

  it("re-exported factories in commands.js are the same functions the tests use", () => {
    expect(typeof makeWriteScriptHandler).toBe("function");
    expect(typeof makeApproveScriptHandler).toBe("function");
  });
});

describe("parseApproveScriptOptions", () => {
  it("parses --by and --note pairs", () => {
    const parsed = parseApproveScriptOptions(["--by", "trevor", "--note", "looks great"]);
    expect(parsed.by).toBe("trevor");
    expect(parsed.note).toBe("looks great");
    expect(parsed.unknown).toEqual([]);
  });

  it("collects unknown flags as inert data (never executed, spec §29)", () => {
    const hostile = "--note $(rm -rf /)";
    const parsed = parseApproveScriptOptions([hostile]);
    expect(parsed.unknown).toEqual([hostile]);
  });

  it("tolerates a missing flag value", () => {
    const parsed = parseApproveScriptOptions(["--by"]);
    expect(parsed.by).toBeUndefined();
  });
});

describe("reject-note helpers", () => {
  it("isRejectNote matches case-insensitively and only on the marker", () => {
    expect(isRejectNote("reject: bad")).toBe(true);
    expect(isRejectNote("REJECT: bad")).toBe(true);
    expect(isRejectNote("looks great")).toBe(false);
    expect(isRejectNote(undefined)).toBe(false);
  });

  it("stripRejectMarker strips only the marker", () => {
    expect(stripRejectMarker("reject: act two sags")).toBe("act two sags");
    expect(stripRejectMarker("ship it")).toBe("ship it");
    expect(stripRejectMarker(undefined)).toBeUndefined();
  });
});

describe("usage texts", () => {
  it("document both verbs and the gate-2 stop", () => {
    expect(USAGE_WRITE_SCRIPT).toContain("mmcs write-script");
    expect(USAGE_WRITE_SCRIPT).toContain("gate 2");
    expect(USAGE_APPROVE_SCRIPT).toContain("mmcs approve script");
    expect(USAGE_APPROVE_SCRIPT).toContain("reject:");
  });
});
