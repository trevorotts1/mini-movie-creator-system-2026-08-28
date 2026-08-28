import { describe, expect, it } from "vitest";

import {
  MAX_REASONING,
  REASONING_ADAPTERS,
  REASONING_EFFORT_RANK,
  REASONING_PREFERENCES,
  UnknownAdapterError,
  applyReasoning,
  effortsFor,
  getReasoningAdapter,
  hasReasoningAdapter,
  parseReasoningPreference,
  resolveMaxReasoning,
  resolveReasoning,
  type ReasoningAdapter,
  type ReasoningEffort,
} from "./index.js";

/** Highest value reachable in a string-typed request body (recursive). */
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

/** Recursively collect every leaf scalar in the body patch. */
function leafValues(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  return Object.values(value).flatMap(leafValues);
}

/** Expected leaf fields for a budget-style adapter at a given effort. */
function buildLeafExpectation(
  adapter: ReasoningAdapter,
  budget: number,
): Record<string, unknown> {
  if (adapter.wire.style !== "thinking-budget") return {};
  const leaf: Record<string, unknown> = { [adapter.wire.param]: budget };
  for (const [k, v] of Object.entries(adapter.wire.extra ?? {})) leaf[k] = v;
  // The leaf object sits AT the full wire path.
  let node: Record<string, unknown> = leaf;
  const path = adapter.wire.path;
  for (let i = path.length - 1; i >= 0; i--) {
    node = { [path[i] as string]: node };
  }
  return node;
}

describe("adapter table integrity", () => {
  it("has unique, non-empty adapter ids", () => {
    const ids = REASONING_ADAPTERS.map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("efforts are ascending by rank", () => {
    for (const adapter of REASONING_ADAPTERS) {
      for (const [modelId, efforts] of Object.entries(adapter.modelEfforts ?? {})) {
        const ranks = efforts.map((e) => REASONING_EFFORT_RANK[e]);
        expect(ranks, `${adapter.id} override ${modelId}`).toEqual(
          [...ranks].sort((a, b) => a - b),
        );
      }
      const ranks = adapter.efforts.map((e) => REASONING_EFFORT_RANK[e]);
      expect(ranks, adapter.id).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("effort-string allowed sets are consistent with expressible efforts", () => {
    for (const adapter of REASONING_ADAPTERS) {
      if (adapter.wire.style !== "effort-string") continue;
      // Every effort the adapter declares must be sendable on its wire...
      for (const effort of adapter.efforts) {
        expect(
          adapter.wire.allowed.includes(effort),
          `${adapter.id}: ${effort} declared but not allowed on wire`,
        ).toBe(true);
      }
    }
  });

  it("budget tables cover every declared effort with positive numbers", () => {
    for (const adapter of REASONING_ADAPTERS) {
      if (adapter.wire.style !== "thinking-budget") continue;
      for (const effort of adapter.efforts) {
        const budget = adapter.wire.budgets[effort];
        expect(typeof budget, `${adapter.id}/${effort}`).toBe("number");
        expect(budget as number).toBeGreaterThan(0);
      }
      const values = Object.values(adapter.wire.budgets);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    }
  });
});

describe("MAX_REASONING never sends literal max to adapters that reject it", () => {
  it("every adapter: wire value for MAX_REASONING is inside the endpoint's accepted set", () => {
    for (const adapter of REASONING_ADAPTERS) {
      const resolved = resolveMaxReasoning(adapter);
      if (resolved.omit) {
        expect(resolved.wireValue).toBeNull();
        continue;
      }
      if (adapter.wire.style === "effort-string") {
        expect(adapter.wire.allowed, adapter.id).toContain(resolved.wireValue);
      }
    }
  });

  it("no adapter outside the literal-max allowlist emits the string 'max'", () => {
    for (const adapter of REASONING_ADAPTERS) {
      const resolved = resolveMaxReasoning(adapter);
      if (resolved.omit || adapter.wire.style !== "effort-string") continue;
      if (adapter.id === "literal-max-passthrough") continue; // verified endpoint only
      expect(resolved.wireValue, adapter.id).not.toBe("max");
    }
  });

  it("openrouter resolves MAX_REASONING to 'high', never 'max'", () => {
    const openrouter = getReasoningAdapter("openrouter");
    const resolved = resolveMaxReasoning(openrouter);
    expect(resolved.omit).toBe(false);
    expect(resolved.effort).toBe("high");
    expect(resolved.wireValue).toBe("high");
    expect(resolved.bodyPatch).toEqual({ reasoning: { effort: "high" } });
  });

  it("openai adapters resolve MAX_REASONING to 'high' at their own paths", () => {
    const responses = resolveMaxReasoning(getReasoningAdapter("openai-responses"));
    expect(responses.wireValue).toBe("high");
    expect(responses.bodyPatch).toEqual({ reasoning: { effort: "high" } });

    const chat = resolveMaxReasoning(getReasoningAdapter("openai-chat"));
    expect(chat.wireValue).toBe("high");
    expect(chat.bodyPatch).toEqual({ reasoning_effort: "high" });
  });

  it("budget adapters carry MAX_REASONING as a numeric ceiling, never a string", () => {
    const anthropic = resolveMaxReasoning(getReasoningAdapter("anthropic-messages"));
    expect(anthropic.wireValue).toBe(32768);
    expect(anthropic.bodyPatch).toEqual({ thinking: { type: "enabled", budget_tokens: 32768 } });

    const gemini = resolveMaxReasoning(getReasoningAdapter("google-gemini"));
    expect(gemini.wireValue).toBe(24576);
    expect(gemini.bodyPatch).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 24576 } },
    });
    for (const value of stringValues(anthropic.bodyPatch)) expect(value).not.toBe("max");
    for (const value of stringValues(gemini.bodyPatch)) expect(value).not.toBe("max");
  });

  it("no-knob adapter omits the reasoning parameter for MAX_REASONING", () => {
    const deepseek = resolveMaxReasoning(getReasoningAdapter("deepseek-chat"));
    expect(deepseek.omit).toBe(true);
    expect(deepseek.effort).toBeNull();
    expect(deepseek.wireValue).toBeNull();
    expect(deepseek.bodyPatch).toEqual({});
    expect(applyReasoning(getReasoningAdapter("deepseek-chat"), { model: "x" }, "MAX_REASONING")).toEqual({ model: "x" });
  });

  it("model-level override raises or lowers the ceiling for one model", () => {
    const capped: ReasoningAdapter = {
      id: "capped-endpoint",
      efforts: ["low", "medium", "high", "max"],
      wire: {
        style: "effort-string",
        path: ["reasoning_effort"],
        allowed: ["low", "medium", "high", "max"],
      },
      modelEfforts: { "vendor/small-model": ["low", "medium"] },
    };
    expect(resolveMaxReasoning(capped).wireValue).toBe("max");
    expect(resolveMaxReasoning(capped, "vendor/small-model").wireValue).toBe("medium");
    expect(effortsFor(capped)).toEqual(capped.efforts);
    expect(effortsFor(capped, "vendor/small-model")).toEqual(["low", "medium"]);
  });
});

describe("named preferences resolve within the supported ladder", () => {
  const openrouter = getReasoningAdapter("openrouter");

  it("named level maps to itself when supported", () => {
    expect(resolveReasoning(openrouter, "low").wireValue).toBe("low");
    expect(resolveReasoning(openrouter, "medium").wireValue).toBe("medium");
    expect(resolveReasoning(openrouter, "high").wireValue).toBe("high");
  });

  it("named level below the floor falls back to the endpoint floor, not none", () => {
    // OpenRouter floor is "low": a "minimal" request still reasons at "low".
    expect(resolveReasoning(openrouter, "minimal").wireValue).toBe("low");
  });

  it("named level above the supported set caps at the endpoint ceiling", () => {
    const capped: ReasoningAdapter = {
      id: "high-only",
      efforts: ["low", "medium"],
      wire: {
        style: "effort-string",
        path: ["reasoning", "effort"],
        allowed: ["low", "medium", "high"],
      },
    };
    expect(resolveReasoning(capped, "high").wireValue).toBe("medium");
    expect(resolveReasoning(capped, "MAX_REASONING").wireValue).toBe("medium");
  });

  it("none omits the parameter on every adapter style", () => {
    for (const adapter of REASONING_ADAPTERS) {
      expect(resolveReasoning(adapter, "none").omit, adapter.id).toBe(true);
    }
  });
});

describe("logical config parsing", () => {
  it("accepts canonical tokens and max aliases case-insensitively", () => {
    expect(parseReasoningPreference("MAX_REASONING")).toBe("MAX_REASONING");
    expect(parseReasoningPreference("max")).toBe("MAX_REASONING");
    expect(parseReasoningPreference("Max")).toBe("MAX_REASONING");
    expect(parseReasoningPreference("max_reasoning")).toBe("MAX_REASONING");
    expect(parseReasoningPreference("high")).toBe("high");
    expect(parseReasoningPreference(" none ")).toBe("none");
  });

  it("rejects unknown preferences", () => {
    expect(() => parseReasoningPreference("ultra")).toThrow();
    expect(() => parseReasoningPreference("")).toThrow();
  });

  it("exports the canonical logical token constant", () => {
    expect(MAX_REASONING).toBe("MAX_REASONING");
    expect(REASONING_PREFERENCES).toContain("MAX_REASONING");
  });
});

describe("lookup and application helpers", () => {
  it("getReasoningAdapter throws for unknown ids and hasReasoningAdapter reports", () => {
    expect(hasReasoningAdapter("openrouter")).toBe(true);
    expect(hasReasoningAdapter("nope")).toBe(false);
    expect(() => getReasoningAdapter("nope")).toThrow(UnknownAdapterError);
    try {
      getReasoningAdapter("nope");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe("UnknownAdapterError");
    }
  });

  it("applyReasoning merges the patch without clobbering unrelated body fields", () => {
    const body = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] };
    const out = applyReasoning(getReasoningAdapter("openrouter"), body, "MAX_REASONING");
    expect(out).toEqual({
      model: "z-ai/glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    });
    expect(out.messages).toBe(body.messages); // unrelated fields kept by reference
    // Original body never mutated.
    expect(body).not.toHaveProperty("reasoning");
  });

  it("every resolvable (adapter, preference) pair produces a well-formed patch", () => {
    for (const adapter of REASONING_ADAPTERS) {
      for (const preference of REASONING_PREFERENCES) {
        const resolved = resolveReasoning(adapter, preference);
        if (resolved.omit) continue;
        if (adapter.wire.style === "effort-string") {
          expect(leafValues(resolved.bodyPatch).length, `${adapter.id}/${preference}`).toBe(1);
          expect(leafValues(resolved.bodyPatch)[0]).toBe(resolved.wireValue);
        } else {
          // Leaf object carries the budget param (plus any static extras like
          // Anthropic's type flag) and nothing else.
          expect(resolved.bodyPatch, adapter.id).toMatchObject(
            buildLeafExpectation(adapter, resolved.wireValue as number),
          );
        }
      }
    }
  });

  it("resolving the literal wire value 'max' through resolveReasoning needs the verified adapter", () => {
    // Effort "max" is an internal ladder level, not a logical preference: it
    // reaches resolveReasoning only via an adapter's declared efforts
    // (e.g. the literal-max-passthrough endpoint), never from config.
    const passthrough = getReasoningAdapter("literal-max-passthrough");
    const resolved = resolveReasoning(passthrough, "MAX_REASONING");
    expect(resolved.wireValue).toBe("max"); // the one verified literal-max endpoint
  });
});