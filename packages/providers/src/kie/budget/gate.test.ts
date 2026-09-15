// SKR-007 — the KIE budget gate.
//
// The defect: KIE had NO budget-gate port at all while Agnes had one, so a KIE submit could
// spend without ever consulting the cumulative ceiling. The architectural half of the money
// risk this item names.
//
// Everything here runs against a SCRIPTED FETCH — no network, no provider, no spend. That is
// the whole reason this fix is not blocked on a spend decision: the guard is exercised the
// same way the client's own tests exercise the transport.

import { describe, expect, it } from "vitest";
import { KieClient, type KieFetch } from "../client/client.js";
import { KieBudgetRefusedError, type KieBudgetGate, type KieBudgetReservationRequest } from "./index.js";

const API_KEY = "test-key-abc123def456ghi789";
const instantSleep = async () => {};

/** Scripted transport that records what was actually sent. */
function scriptedFetch(script: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: KieFetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (next instanceof Response) return next;
    throw next ?? new Error("script exhausted");
  };
  return { fetch, calls };
}

const okResponse = () =>
  new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: "task_1" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** A gate that grants, recording reserves and releases. */
function grantingGate() {
  const reserved: KieBudgetReservationRequest[] = [];
  const released: Array<{ id: string; reason: string }> = [];
  const gate: KieBudgetGate = {
    async reserve(request) {
      reserved.push(request);
      return {
        id: `res_${reserved.length}`,
        async release(reason) {
          released.push({ id: `res_${reserved.length}`, reason });
        },
      };
    },
    async releaseById(id, reason) {
      released.push({ id, reason });
    },
  };
  return { gate, reserved, released };
}

/** A gate that refuses — the ceiling is reached. */
function refusingGate(reason = "ceiling reached") {
  const gate: KieBudgetGate = {
    async reserve(request) {
      throw new KieBudgetRefusedError(request.ref, request.estimatedCostUsd, reason);
    },
    async releaseById() {},
  };
  return { gate };
}

function makeClient(fetch: KieFetch, budgetGate?: KieBudgetGate) {
  return new KieClient(
    { apiKey: API_KEY, baseUrl: "https://mock.kie.test", sleep: instantSleep },
    { fetch, ...(budgetGate ? { budgetGate } : {}) },
  );
}

const body = { model: "bytedance/seedance-2-mini", input: { prompt: "x" } };

describe("KieClient.createTask budget gate (SKR-007)", () => {
  it("reserves BEFORE issuing the request, and holds the reservation on success", async () => {
    const { fetch, calls } = scriptedFetch([okResponse()]);
    const { gate, reserved, released } = grantingGate();
    const client = makeClient(fetch, gate);

    const result = await client.createTask(body, { ref: "job_1", estimatedCostUsd: 0.42 });

    expect(result.ok).toBe(true);
    expect(reserved).toEqual([
      { ref: "job_1", provider: "kie", model: "bytedance/seedance-2-mini", estimatedCostUsd: 0.42, currency: "USD" },
    ]);
    // A successful submit must NOT release — the hold stands until the task is committed.
    expect(released).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("REFUSES without issuing any request when the gate will not authorise", async () => {
    // The load-bearing assertion: a refusal must be free. If the request were issued first,
    // an exhausted ceiling would still spend.
    const { fetch, calls } = scriptedFetch([okResponse()]);
    const { gate } = refusingGate();
    const client = makeClient(fetch, gate);

    await expect(
      client.createTask(body, { ref: "job_2", estimatedCostUsd: 25 }),
    ).rejects.toThrowError(/ceiling reached/);

    expect(calls).toHaveLength(0);
  });

  it("releases the hold when the request reports failure", async () => {
    const { fetch } = scriptedFetch([
      new Response(JSON.stringify({ code: 500, msg: "boom" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    const { gate, released } = grantingGate();
    const client = makeClient(fetch, gate);

    const result = await client.createTask(body, { ref: "job_3", estimatedCostUsd: 1 });

    expect(result.ok).toBe(false);
    expect(released).toEqual([{ id: "res_1", reason: "failed" }]);
  });

  it("releases the hold when the transport itself throws", async () => {
    const { fetch } = scriptedFetch([new Error("socket hang up")]);
    const { gate, released } = grantingGate();
    const client = makeClient(fetch, gate);

    const result = await client.createTask(body, { ref: "job_4", estimatedCostUsd: 1 });

    // The client retries then returns a failure envelope; either way the hold must not strand.
    expect(result.ok).toBe(false);
    expect(released.length).toBeGreaterThan(0);
    expect(released.every((r) => r.reason === "failed")).toBe(true);
  });

  it("FAILS CLOSED when a gate is configured but no budget context is supplied", async () => {
    // A gate with no ask would otherwise submit unguarded — the exact hole this closes.
    const { fetch, calls } = scriptedFetch([okResponse()]);
    const { gate } = grantingGate();
    const client = makeClient(fetch, gate);

    await expect(client.createTask(body)).rejects.toThrowError(KieBudgetRefusedError);
    expect(calls).toHaveLength(0);
  });

  it("refuses rather than submits when the gate itself throws a non-refusal error", async () => {
    const { fetch, calls } = scriptedFetch([okResponse()]);
    const gate = {
      async reserve() {
        throw new Error("ledger unavailable");
      },
      async releaseById() {},
    } as unknown as KieBudgetGate;
    const client = makeClient(fetch, gate);

    await expect(client.createTask(body, { ref: "job_5", estimatedCostUsd: 1 })).rejects.toThrowError(
      /could not authorise/,
    );
    expect(calls).toHaveLength(0);
  });

  it("behaves exactly as before when NO gate is configured", async () => {
    // Existing callers must be unaffected.
    const { fetch, calls } = scriptedFetch([okResponse()]);
    const client = makeClient(fetch);

    const result = await client.createTask(body);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
