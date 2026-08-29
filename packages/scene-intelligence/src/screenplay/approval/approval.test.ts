// DIR-008 acceptance tests: script approval gate (spec §3 gate 2).
import { describe, expect, it } from "vitest";

import {
  pendingScriptRecord,
  presentScreenplayForApproval,
  SCRIPT_APPROVAL_SCHEMA_VERSION,
  ScriptApprovalError,
  type ScriptApprovalRecord,
  type ScriptApprovalStorePort,
  type ScriptGateStatePort,
  type ScreenplayWriterPort,
} from "./index.js";
import { assertGate2Open, gate2AllowsCastWork, runApproveScript, runRejectScript } from "./guard.js";
import { gate2BlockedReason, isScriptApproved } from "./types.js";

const NOW = "2026-08-28T10:05:00.000Z";
const QC_PASS = { screenplayId: "SCR_THE_VAULT_001", verdict: "pass" as const, criticModelId: "critic-1" };
const QC_REVISE = { screenplayId: "SCR_THE_VAULT_001", verdict: "revise" as const, criticModelId: "critic-1" };

/** In-memory gate double. */
function makeGates(concept: "PENDING" | "APPROVED" = "APPROVED", script: "PENDING" | "APPROVED" | "REJECTED" = "PENDING"): ScriptGateStatePort {
  return { conceptGateState: () => concept, scriptGateState: () => script };
}

/** In-memory store double recording every save. */
function makeStore(initial: ScriptApprovalRecord | null = null): ScriptApprovalStorePort & { saved: ScriptApprovalRecord[] } {
  let current = initial;
  const saved: ScriptApprovalRecord[] = [];
  return {
    saved,
    getRecord: () => current,
    save(record: ScriptApprovalRecord) {
      saved.push(record);
      current = record;
    },
  };
}

/** Recording writer double. */
function makeWriter(screenplayId = QC_PASS.screenplayId): ScreenplayWriterPort & { calls: number } {
  const double = {
    calls: 0,
    writeScreenplay: () => {
      double.calls += 1;
      return {
        screenplayId,
        conceptId: "CON_TST_001",
        title: "The Vault",
        sceneCount: 6,
        characterCount: 3,
      };
    },
  };
  return double;
}

describe("presentScreenplayForApproval (mmcs write-script)", () => {
  it("presents a QC-passed screenplay and persists a PENDING record", () => {
    const gates = makeGates();
    const store = makeStore();
    const writer = makeWriter();
    const res = presentScreenplayForApproval(QC_PASS, gates, store, writer, { now: NOW });

    expect(res.presented).toBe(true);
    expect(res.record).not.toBeNull();
    expect(res.record?.state).toBe("PENDING");
    expect(res.record?.screenplayId).toBe("SCR_THE_VAULT_001");
    expect(res.record?.schemaVersion).toBe(SCRIPT_APPROVAL_SCHEMA_VERSION);
    expect(res.record?.qcVerdict).toBe("pass");
    expect(res.record?.decidedAt).toBeNull();
    expect(store.saved).toHaveLength(1);
    expect(writer.calls).toBe(1);
    expect(res.output.join("\n")).toContain("STOP at gate 2");
    expect(res.output.join("\n")).toContain("mmcs approve script");
  });

  it("blocks presentation while gate 1 is not APPROVED (gate order, spec §3)", () => {
    const gates = makeGates("PENDING");
    const store = makeStore();
    const writer = makeWriter();
    const res = presentScreenplayForApproval(QC_PASS, gates, store, writer, { now: NOW });

    expect(res.presented).toBe(false);
    expect(store.saved).toHaveLength(0);
    expect(writer.calls).toBe(0);
    expect(res.output.join("\n")).toContain("Gate 1 not passed");
  });

  it("does not present an un-QC'd (revise-verdict) screenplay (spec §3: generated AND QC'd)", () => {
    const gates = makeGates();
    const store = makeStore();
    const res = presentScreenplayForApproval(QC_REVISE, gates, store, makeWriter(), { now: NOW });

    expect(res.presented).toBe(false);
    expect(store.saved).toHaveLength(0);
    expect(res.output.join("\n")).toContain("revise");
  });

  it("rejects QC evidence that names a different screenplay than the writer produced", () => {
    const store = makeStore();
    expect(() =>
      presentScreenplayForApproval(
        { ...QC_PASS, screenplayId: "SCR_OTHER_001" },
        makeGates(),
        store,
        makeWriter(),
        { now: NOW },
      ),
    ).toThrow(ScriptApprovalError);
    expect(store.saved).toHaveLength(0);
  });

  it("rejects malformed QC evidence before touching the store", () => {
    const store = makeStore();
    expect(() =>
      presentScreenplayForApproval(
        { screenplayId: "", verdict: "pass", criticModelId: null },
        makeGates(),
        store,
        makeWriter(),
      ),
    ).toThrow(ScriptApprovalError);
    expect(() =>
      presentScreenplayForApproval(
        { screenplayId: "SCR_X", verdict: "maybe" as never, criticModelId: null },
        makeGates(),
        store,
        makeWriter(),
      ),
    ).toThrow(ScriptApprovalError);
    expect(store.saved).toHaveLength(0);
  });

  it("re-presentation replaces the record (revision loop re-entry, spec §14)", () => {
    const gates = makeGates();
    const store = makeStore();
    presentScreenplayForApproval(QC_PASS, gates, store, makeWriter(), { now: NOW });
    const second = presentScreenplayForApproval(
      { ...QC_PASS, screenplayId: "SCR_THE_VAULT_002" },
      gates,
      store,
      makeWriter("SCR_THE_VAULT_002"),
      { now: "2026-08-28T10:06:00.000Z" },
    );
    expect(second.presented).toBe(true);
    expect(store.getRecord()?.screenplayId).toBe("SCR_THE_VAULT_002");
    expect(store.getRecord()?.state).toBe("PENDING");
    expect(store.saved).toHaveLength(2);
  });
});

describe("runApproveScript (mmcs approve script)", () => {
  it("approves a PENDING presented screenplay and records the decision", () => {
    const gates = makeGates();
    const store = makeStore(pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW));
    const res = runApproveScript(gates, store, { now: NOW, decidedBy: "trevor" });

    expect(res.exitCode).toBe(0);
    expect(res.record?.state).toBe("APPROVED");
    expect(res.record?.decidedBy).toBe("trevor");
    expect(res.record?.decidedAt).toBe(NOW);
    expect(res.output.join("\n")).toContain("SCRIPT APPROVED");
  });

  it("refuses approval while gate 1 is PENDING (gate order)", () => {
    const store = makeStore(pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW));
    const res = runApproveScript(makeGates("PENDING"), store, { now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.record?.state).toBe("PENDING");
    expect(res.output.join("\n")).toContain("Gate 1 not passed");
  });

  it("refuses approval when nothing was presented", () => {
    const res = runApproveScript(makeGates(), makeStore(), { now: NOW });
    expect(res.exitCode).toBe(1);
    expect(res.record).toBeNull();
    expect(res.output.join("\n")).toContain("mmcs write-script");
  });

  it("is idempotent on an APPROVED record (exit 0, no state change)", () => {
    const approved = { ...pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW), state: "APPROVED" as const, decidedAt: NOW };
    const store = makeStore(approved);
    const res = runApproveScript(makeGates("APPROVED", "APPROVED"), store, { now: NOW });
    expect(res.exitCode).toBe(0);
    expect(store.saved).toHaveLength(0);
    expect(res.output.join("\n")).toContain("already APPROVED");
  });

  it("refuses to flip a REJECTED record back to APPROVED (spec §3: re-enter through presentation)", () => {
    const rejected = { ...pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW), state: "REJECTED" as const, decidedAt: NOW };
    const store = makeStore(rejected);
    const res = runApproveScript(makeGates(), store, { now: NOW });
    expect(res.exitCode).toBe(1);
    expect(store.saved).toHaveLength(0);
    expect(res.output.join("\n")).toContain("REJECTED");
  });

  it("rejects a non-ISO decision clock", () => {
    const store = makeStore(pendingScriptRecord("SCR_X", "CON_X", QC_PASS, NOW));
    expect(() => runApproveScript(makeGates(), store, { now: "not-a-date" })).toThrow(
      ScriptApprovalError,
    );
  });
});

describe("runRejectScript (operator sends the script back)", () => {
  it("rejects a PENDING presentation and records the note", () => {
    const store = makeStore(pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW));
    const res = runRejectScript(makeGates(), store, { now: NOW, note: "act two sags" });

    expect(res.exitCode).toBe(0);
    expect(res.record?.state).toBe("REJECTED");
    expect(res.record?.note).toBe("act two sags");
    expect(res.output.join("\n")).toContain("SCRIPT REJECTED");
  });

  it("refuses to reject an APPROVED record (re-open through presentation)", () => {
    const approved = { ...pendingScriptRecord("SCR_X", "CON_X", QC_PASS, NOW), state: "APPROVED" as const, decidedAt: NOW };
    const store = makeStore(approved);
    const res = runRejectScript(makeGates(), store, { now: NOW });
    expect(res.exitCode).toBe(1);
    expect(store.saved).toHaveLength(0);
  });

  it("refuses to reject when nothing was presented", () => {
    const res = runRejectScript(makeGates(), makeStore(), { now: NOW });
    expect(res.exitCode).toBe(1);
  });
});

describe("gate-2 guard — no cast/candidate work while unapproved", () => {
  it("assertGate2Open throws while gate 2 is PENDING", () => {
    expect(() => assertGate2Open(makeGates("APPROVED", "PENDING"))).toThrow(
      /Gate 2 not passed.*spec §3/s,
    );
  });

  it("assertGate2Open throws while gate 2 is REJECTED", () => {
    expect(() => assertGate2Open(makeGates("APPROVED", "REJECTED"))).toThrow(
      ScriptApprovalError,
    );
  });

  it("assertGate2Open passes only on APPROVED", () => {
    expect(() => assertGate2Open(makeGates("APPROVED", "APPROVED"))).not.toThrow();
  });

  it("gate2AllowsCastWork mirrors isScriptApproved", () => {
    expect(gate2AllowsCastWork(makeGates("APPROVED", "PENDING"))).toBe(false);
    expect(gate2AllowsCastWork(makeGates("APPROVED", "APPROVED"))).toBe(true);
    expect(isScriptApproved(makeGates("APPROVED", "APPROVED"))).toBe(true);
  });

  it("the blocked reason names the unblocking command", () => {
    expect(gate2BlockedReason("PENDING")).toContain("mmcs approve script");
  });

  it("approving gate 2 is what unlocks the guard (state-driving-the-guard round trip)", () => {
    // The gate port the downstream task reads reflects the decision store:
    // before approval the guard throws, after runApproveScript it passes.
    const store = makeStore(pendingScriptRecord("SCR_THE_VAULT_001", "CON_TST_001", QC_PASS, NOW));
    let scriptState: "PENDING" | "APPROVED" | "REJECTED" = "PENDING";
    const gates = {
      conceptGateState: () => "APPROVED" as const,
      scriptGateState: () => scriptState,
    };
    expect(() => assertGate2Open(gates)).toThrow(ScriptApprovalError);

    const res = runApproveScript(gates, store, { now: NOW });
    expect(res.exitCode).toBe(0);
    scriptState = "APPROVED";
    expect(() => assertGate2Open(gates)).not.toThrow();
  });
});
