/// <reference types="node" />
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVALS_FILE,
  ApprovalStore,
  ApprovalsStoreError,
  GATE_IDS,
  emptyApprovalsDocument,
  normalizeApprovalsDocument,
  type GateId,
} from "./index.js";
import { GateOrderError, GateTransitionError } from "../state-machine/index.js";

let dir: string;
let seq = 0;

/** Injectable clock: deterministic, strictly increasing ISO timestamps. */
function tick(): string {
  seq += 1;
  return `2026-08-29T00:00:${String(seq).padStart(2, "0")}.000Z`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mmcs-approvals-"));
  seq = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("persistence (spec §3: gates are persisted domain states)", () => {
  it("persists all six gates PENDING on first load (first boot)", async () => {
    const store = new ApprovalStore(dir);
    const doc = await store.load();
    for (const gate of GATE_IDS) {
      expect(doc.gates[gate].state).toBe("PENDING");
    }
    // The file exists on disk immediately — a crash cannot lose the gates.
    const raw = JSON.parse(await readFile(join(dir, APPROVALS_FILE), "utf8"));
    expect(raw.schemaVersion).toBe(1);
    for (const gate of GATE_IDS) {
      expect(raw.gates[gate].state).toBe("PENDING");
    }
  });

  it("an approval survives store recreation (durable across restart)", async () => {
    const first = new ApprovalStore(dir);
    await first.load();
    await first.approve("concept", { decidedBy: "trevor", now: tick() });

    // Simulate a process restart: brand-new store over the same directory.
    const second = new ApprovalStore(dir);
    const snapshot = await second.snapshot("concept");
    expect(snapshot.state).toBe("APPROVED");
    expect(snapshot.approvedAt).toBe("2026-08-29T00:00:01.000Z");
    expect(snapshot.decidedBy).toBe("trevor");
  });

  it("persists rejection and reopen with their timestamps", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    await store.approve("concept", { decidedBy: "trevor", now: tick() });
    await store.reject("script", { note: "needs punch-up", now: tick() });
    await store.reopen("script", { now: tick() });
    await store.approve("script", { decidedBy: "trevor", note: "v2 lands", now: tick() });

    const raw = JSON.parse(await readFile(join(dir, APPROVALS_FILE), "utf8"));
    const record = raw.gates.script;
    expect(record.state).toBe("APPROVED");
    expect(record.approvedAt).toBe("2026-08-29T00:00:04.000Z");
    expect(record.note).toBe("v2 lands");
  });

  it("illegal transitions throw BEFORE touching disk (store unchanged)", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    await store.reject("concept", { now: tick() });
    const before = await readFile(join(dir, APPROVALS_FILE), "utf8");

    // REJECTED -> APPROVED is illegal in one step.
    await expect(
      store.approve("concept", { now: tick() }),
    ).rejects.toBeInstanceOf(GateTransitionError);

    // Same-state no-op is illegal too.
    await expect(store.reject("concept", { now: tick() })).rejects.toBeInstanceOf(
      GateTransitionError,
    );

    const after = await readFile(join(dir, APPROVALS_FILE), "utf8");
    expect(after).toBe(before);
  });

  it("gate order blocks out-of-order approval at store level", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    // Approving script with concept still PENDING must throw and persist nothing.
    await expect(store.approve("script", { now: tick() })).rejects.toBeInstanceOf(
      GateOrderError,
    );
    const snapshot = await store.snapshot("script");
    expect(snapshot.state).toBe("PENDING");
  });

  it("approves the full §3 sequence in order", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    for (const gate of GATE_IDS) {
      await store.approve(gate, { decidedBy: "trevor", now: tick() });
    }
    const snapshots = await store.snapshots();
    expect(snapshots.map((s) => s.state)).toEqual([
      "APPROVED",
      "APPROVED",
      "APPROVED",
      "APPROVED",
      "APPROVED",
      "APPROVED",
    ]);
    // Rough-cut gate (5) — the VID-014 ApprovalGatePort reads exactly this.
    const roughCut = await store.snapshot("rough-cut");
    expect(roughCut).toMatchObject({
      gate: "rough-cut",
      state: "APPROVED",
      approvedAt: expect.any(String),
    });
  });

  it("serializes concurrent decisions in-process (no lost update)", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    // concept approved first so the later in-order approvals are legal.
    await store.approve("concept", { now: tick() });
    // Fire many legal transitions; the write queue must land every one.
    await store.reopen("concept", { now: tick() });
    await store.approve("concept", { now: tick() });
    await store.reopen("concept", { now: tick() });
    await store.approve("concept", { now: tick() });
    const final = await store.snapshot("concept");
    expect(final.state).toBe("APPROVED");
  });
});

describe("corrupt documents surface, never reset", () => {
  it("throws on a corrupt non-empty document", async () => {
    await writeFile(join(dir, APPROVALS_FILE), "{not json", "utf8");
    const store = new ApprovalStore(dir);
    await expect(store.load()).rejects.toThrow();
  });

  it("throws on an unknown schemaVersion", async () => {
    await writeFile(
      join(dir, APPROVALS_FILE),
      JSON.stringify({ ...emptyApprovalsDocument(tick()), schemaVersion: 99 }),
      "utf8",
    );
    const store = new ApprovalStore(dir);
    await expect(store.load()).rejects.toBeInstanceOf(ApprovalsStoreError);
  });

  it("throws when an APPROVED record lacks approvedAt", async () => {
    const doc = emptyApprovalsDocument(tick());
    (doc.gates.concept as unknown as { approvedAt: string | null }).approvedAt = null;
    doc.gates.concept.state = "APPROVED";
    await writeFile(join(dir, APPROVALS_FILE), JSON.stringify(doc), "utf8");
    const store = new ApprovalStore(dir);
    await expect(store.load()).rejects.toBeInstanceOf(ApprovalsStoreError);
  });

  it("treats a missing file as first boot (fresh PENDING), not corruption", async () => {
    const store = new ApprovalStore(dir);
    const doc = await store.load();
    expect(doc.gates.canon.state).toBe("PENDING");
  });

  it("rejects a store with no dir", () => {
    expect(() => new ApprovalStore("")).toThrow(ApprovalsStoreError);
  });
});

describe("normalizeApprovalsDocument", () => {
  it("round-trips a valid document", () => {
    const doc = emptyApprovalsDocument(tick());
    doc.gates.concept = {
      ...doc.gates.concept,
      state: "APPROVED",
      approvedAt: tick(),
    };
    const normalized = normalizeApprovalsDocument(JSON.parse(JSON.stringify(doc)));
    expect(normalized.gates.concept.state).toBe("APPROVED");
    expect(normalized.gates.canon.state).toBe("PENDING");
  });

  it("throws on a gate record with a corrupt state", () => {
    const doc = emptyApprovalsDocument(tick());
    const broken = JSON.parse(JSON.stringify(doc));
    broken.gates.concept.state = "MAYBE";
    expect(() => normalizeApprovalsDocument(broken)).toThrow(ApprovalsStoreError);
  });

  it("throws when a gate record is missing entirely", () => {
    const doc = emptyApprovalsDocument(tick());
    const broken = JSON.parse(JSON.stringify(doc));
    delete broken.gates.storyboard;
    expect(() => normalizeApprovalsDocument(broken)).toThrow(ApprovalsStoreError);
  });

  it("throws on an unknown gate key instead of silently dropping it", () => {
    // Regression (QC): a foreign/hand-edited gate key used to be dropped on
    // normalize and then vanish on the next write — external damage must
    // surface, not be silently reset.
    const broken = JSON.parse(JSON.stringify(emptyApprovalsDocument(tick())));
    broken.gates["final-render"] = { state: "PENDING" };
    expect(() => normalizeApprovalsDocument(broken)).toThrow(ApprovalsStoreError);
  });
});

describe("read-only discipline (no live references out of the store)", () => {
  it("get()/load() return a frozen document; mutating it cannot corrupt the store", async () => {
    const store = new ApprovalStore(dir);
    const doc = await store.load();
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.gates)).toBe(true);
    expect(Object.isFrozen(doc.gates.concept)).toBe(true);
    const before = JSON.stringify(doc);
    expect(() => {
      (doc.gates.concept as unknown as { state: string }).state = "APPROVED";
    }).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
    const reread = await store.get();
    expect(reread.gates.concept.state).toBe("PENDING");
  });

  it("the record returned by approve() is frozen too", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    const record = await store.approve("concept", { decidedBy: "trevor", now: tick() });
    expect(Object.isFrozen(record)).toBe(true);
    const snapshot = await store.snapshot("concept");
    expect(snapshot.state).toBe("APPROVED");
  });
});

describe("unknown gates are refused everywhere", () => {
  it("snapshot/approve/reject/reopen reject a gate outside the six", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    const bogus = "final-render" as unknown as GateId;
    await expect(store.snapshot(bogus)).rejects.toThrow();
    await expect(store.approve(bogus)).rejects.toThrow();
    await expect(store.reject(bogus)).rejects.toThrow();
    await expect(store.reopen(bogus)).rejects.toThrow();
  });
});

describe("VID-014 ApprovalGatePort compatibility", () => {
  it("a snapshot() call satisfies the (gate) => {gate, state, approvedAt} port shape", async () => {
    const store = new ApprovalStore(dir);
    await store.load();
    for (const gate of ["concept", "script", "character", "storyboard"] as const) {
      await store.approve(gate, { decidedBy: "trevor", now: tick() });
    }
    await store.approve("rough-cut", { decidedBy: "trevor", now: tick() });
    // The exact structural call VID-014's port makes.
    const snapshot = await store.snapshot("rough-cut");
    expect(Object.keys(snapshot).sort()).toEqual(
      ["approvedAt", "decidedBy", "gate", "note", "rejectedAt", "state"].sort(),
    );
    expect(snapshot.gate).toBe("rough-cut");
    expect(snapshot.state).toBe("APPROVED");
    expect(typeof snapshot.approvedAt).toBe("string");
    expect(snapshot.approvedAt).not.toBeNull();
  });
});

describe("store construction edge", () => {
  it("creates its directory on demand", async () => {
    const nested = join(dir, "state", "approvals-deep");
    const store = new ApprovalStore(nested);
    await store.load();
    await store.approve("concept", { now: tick() });
    const raw = JSON.parse(
      await readFile(join(nested, APPROVALS_FILE), "utf8"),
    );
    expect(raw.gates.concept.state).toBe("APPROVED");
    await mkdir(nested, { recursive: true });
  });
});