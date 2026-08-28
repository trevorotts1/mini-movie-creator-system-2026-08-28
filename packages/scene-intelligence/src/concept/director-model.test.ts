/**
 * Director-model capability gate tests — DIR-002.
 *
 * Acceptance: "no provider call without capability check". These tests pin
 * the gate: a client only exists after the check passes; missing profile,
 * missing endpoint, missing key, and unmappable reasoning all refuse.
 */

import { describe, expect, it } from "vitest";

import {
  DIRECTOR_SLOT,
  DirectorModelError,
  OPENROUTER_BASE_URL,
  OPENROUTER_REASONING_ADAPTER,
  checkDirectorCapability,
  isOpenRouterModelId,
  prepareDirectorModel,
  toPerToken1k,
  type DirectorTransport,
} from "./director-model.js";

/** A recording transport; its request body is captured for wire assertions. */
function recordingTransport(response: unknown): { transport: DirectorTransport; wires: unknown[] } {
  const wires: unknown[] = [];
  return {
    transport: {
      kind: "mock",
      request: async (wire) => {
        wires.push(wire);
        return response;
      },
    },
    wires,
  };
}

const KNOWN_MODEL = "z-ai/glm-5.3-flash";
const UNKNOWN_MODEL = "totally-new/unlisted-model";

const GOOD_CONNECTION = {
  modelId: KNOWN_MODEL,
  baseUrl: OPENROUTER_BASE_URL,
  apiKey: "test-key",
} as const;

describe("isOpenRouterModelId", () => {
  it("accepts OpenRouter-style vendor/model ids", () => {
    for (const id of ["z-ai/glm-5.3-flash", "openai/gpt-7.2", "vendor/model-name", "a/b:c"]) {
      expect(isOpenRouterModelId(id), id).toBe(true);
    }
  });

  it("rejects bare ids, empty, non-strings", () => {
    for (const id of ["bare-model", "", "/leading", "trailing/", "a//b"]) {
      expect(isOpenRouterModelId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe("checkDirectorCapability — no call without capability check", () => {
  it("passes for a seeded registry model with complete connection", () => {
    const verdict = checkDirectorCapability({ connection: GOOD_CONNECTION });
    expect(verdict.allowed).toBe(true);
    expect(verdict.issues).toHaveLength(0);
    expect(verdict.effort).toBe("high"); // openrouter adapter: MAX → high, never literal "max"
    expect(verdict.profile).not.toBeNull();
    expect(verdict.profile?.confidence).toBe("PROVISIONAL");
    expect(verdict.adapterId).toBe(OPENROUTER_REASONING_ADAPTER);
  });

  it("refuses a model with no registry profile (unknown models refused by default)", () => {
    const verdict = checkDirectorCapability({
      connection: { modelId: UNKNOWN_MODEL, baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.issues.some((issue) => issue.code === "MODEL_NOT_IN_REGISTRY")).toBe(true);
  });

  it("refuses a malformed model id", () => {
    const verdict = checkDirectorCapability({
      connection: { modelId: "bare-model", baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.issues.some((issue) => issue.code === "MODEL_NOT_IN_REGISTRY")).toBe(true);
  });

  it("refuses when no API key is available", () => {
    const verdict = checkDirectorCapability({
      connection: { modelId: KNOWN_MODEL, baseUrl: OPENROUTER_BASE_URL, apiKey: null },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.issues.some((issue) => issue.code === "MISSING_BASE_URL_OR_KEY")).toBe(true);
  });

  it("refuses when the endpoint base URL is missing/blank", () => {
    const verdict = checkDirectorCapability({
      connection: { modelId: KNOWN_MODEL, baseUrl: "  ", apiKey: "k" },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.issues.some((issue) => issue.code === "MISSING_BASE_URL_OR_KEY")).toBe(true);
  });

  it("never maps MAX_REASONING onto a literal 'max' on the openrouter adapter", () => {
    const verdict = checkDirectorCapability({ connection: GOOD_CONNECTION });
    expect(verdict.effort === "max").toBe(false);
    expect(verdict.effort).toBe("high");
  });

  it("rescales per-million seed pricing to the per_token_1k unit it labels", () => {
    // CAP-007 seeds carry usdPerMillionInput; the gate hands CAP-006 a
    // per_token_1k block — the amount must match the unit or any downstream
    // estimate is off by 1000x (runbook §33 spend gate integrity).
    expect(toPerToken1k(0.075)).toBeCloseTo(0.000075, 10);
    expect(toPerToken1k(null)).toBeNull();
    const verdict = checkDirectorCapability({ connection: GOOD_CONNECTION });
    expect(verdict.allowed).toBe(true); // rescaled amount still passes validation
  });
});

describe("prepareDirectorModel", () => {
  it("returns a checked client for a good connection", () => {
    const { transport } = recordingTransport({});
    const client = prepareDirectorModel({ connection: GOOD_CONNECTION, transport });
    expect(client.modelId).toBe(KNOWN_MODEL);
    expect(client.hasApiKey).toBe(true);
    expect(client.capabilityCheck.effort).toBe("high");
    expect(client.capabilityCheck.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws for an unlisted model — no client exists to call with", () => {
    const { transport } = recordingTransport({});
    expect(() =>
      prepareDirectorModel({
        connection: { modelId: UNKNOWN_MODEL, baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
        transport,
      }),
    ).toThrowError(/capability check failed/);
  });

  it("throws with value-free gate issues", () => {
    const { transport } = recordingTransport({});
    try {
      prepareDirectorModel({
        connection: { modelId: UNKNOWN_MODEL, baseUrl: null, apiKey: null },
        transport,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("DirectorModelError");
      const issues = (error as { issues: readonly { field: string }[] }).issues;
      // baseUrl=null falls back to the default OpenRouter base — only the
      // unlisted model and the missing key are gate failures here.
      expect(issues.map((issue) => issue.field).sort()).toEqual(["apiKey", "modelId"]);
    }
  });
});