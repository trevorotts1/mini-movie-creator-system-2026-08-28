import { describe, expect, it } from "vitest";
import {
  GATE_IDS,
  GATE_LABELS,
  GATE_STATES,
  UnknownGateError,
  gateNumber,
  isGateId,
  isGateState,
  pendingGateRecord,
  toGateSnapshot,
} from "./index.js";

/** The six spec §3 gates, verbatim order. */
const SPEC_GATES = ["concept", "script", "character", "storyboard", "rough-cut", "canon"];

describe("spec §3 gate ids", () => {
  it("exposes exactly the six spec gates in mandatory order", () => {
    expect([...GATE_IDS]).toEqual(SPEC_GATES);
  });

  it("labels all six gates, index-aligned, from the spec §3 wording", () => {
    expect(GATE_LABELS.length).toBe(6);
    expect(GATE_LABELS[0]).toBe("Concept");
    expect(GATE_LABELS[2]).toBe("New character selection/lock");
    expect(GATE_LABELS[5]).toBe("Canon/Series Bible update");
  });

  it("numbers gates 1-based in spec order", () => {
    expect(gateNumber("concept")).toBe(1);
    expect(gateNumber("script")).toBe(2);
    expect(gateNumber("character")).toBe(3);
    expect(gateNumber("storyboard")).toBe(4);
    expect(gateNumber("rough-cut")).toBe(5);
    expect(gateNumber("canon")).toBe(6);
  });

  it("throws UnknownGateError for an id outside the six gates", () => {
    expect(() => gateNumber("final-render" as never)).toThrow(UnknownGateError);
  });

  it("discriminates gate ids and states", () => {
    expect(isGateId("rough-cut")).toBe(true);
    expect(isGateId("final-render")).toBe(false);
    expect(isGateId(5)).toBe(false);
    expect(isGateState("PENDING")).toBe(true);
    expect(isGateState("APPROVED")).toBe(true);
    expect(isGateState("REJECTED")).toBe(true);
    expect(isGateState("pending")).toBe(false);
    expect(isGateState("OPEN")).toBe(false);
  });

  it("carries exactly the three persisted approval states", () => {
    expect([...GATE_STATES]).toEqual(["PENDING", "APPROVED", "REJECTED"]);
  });

  it("builds a fresh all-null PENDING record per gate", () => {
    const record = pendingGateRecord("concept", "2026-08-29T00:00:00.000Z");
    expect(record).toEqual({
      gate: "concept",
      state: "PENDING",
      approvedAt: null,
      rejectedAt: null,
      decidedBy: null,
      note: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });

  it("projects a record to the consumer snapshot without live references", () => {
    const record = pendingGateRecord("script", "2026-08-29T00:00:00.000Z");
    const snapshot = toGateSnapshot(record);
    expect(snapshot).toEqual({
      gate: "script",
      state: "PENDING",
      approvedAt: null,
      rejectedAt: null,
      decidedBy: null,
      note: null,
    });
    expect(snapshot).not.toBe(record);
  });
});