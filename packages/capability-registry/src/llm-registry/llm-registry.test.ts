import { describe, expect, it } from "vitest";

import {
  DEFAULT_LLM_SLOT_CONFIG,
  LLM_KINDS,
  LLM_MODEL_PRESETS,
  LLM_SLOTS,
  VIDEO_INGEST_MODES,
  findLlmModelEntry,
  llmModelEntrySchema,
  llmRegistrySchema,
  llmSlotConfigSchema,
  llmSlotSelectionSchema,
  parseLlmRegistry,
  parseLlmSlotConfig,
  resolveReasoningEffort,
  resolveVideoIngestRoute,
  safeParseLlmRegistry,
  safeParseLlmSlotConfig,
  type LlmModelEntry,
  type LlmSlotConfig,
} from "./index.js";

const ISO = "2026-08-28T12:00:00.000Z";

function validEntry(overrides: Partial<LlmModelEntry> = {}): LlmModelEntry {
  return {
    modelId: "vendor/example-model",
    kind: "reasoning",
    lastVerifiedAt: ISO,
    sourceUrls: ["https://docs.example.com/model"],
    confidence: "VERIFIED",
    reasoningEfforts: ["low", "medium", "high"],
    videoIngest: "frames",
    contextWindowTokens: 200000,
    notes: null,
    ...overrides,
  };
}

function fullSlotConfig(): LlmSlotConfig {
  return LLM_SLOTS.map((slot) => ({
    slot,
    modelId: "vendor/example-model",
    reasoningPreference: "max" as const,
    baseUrl: null,
  }));
}

describe("slot taxonomy", () => {
  it("exposes exactly the seven selection slots", () => {
    expect([...LLM_SLOTS]).toEqual([
      "director",
      "writer",
      "scriptCritic",
      "imageQc",
      "videoQc",
      "continuityQc",
      "finalQc",
    ]);
  });

  it("covers all seven slots in the default config with no duplicates", () => {
    const parsed = parseLlmSlotConfig(DEFAULT_LLM_SLOT_CONFIG);
    expect(parsed).toHaveLength(7);
    for (const slot of LLM_SLOTS) {
      expect(parsed.find((s) => s.slot === slot)).toBeDefined();
    }
  });
});

describe("openrouter-compatible model IDs", () => {
  it("accepts any vendor/model ID, not just presets", () => {
    for (const id of [
      "openai/gpt-7.2",
      "anthropic/claude-opus-4.6",
      "vendor/model-name",
      "deepseek/deepseek-v4-flash-vision-experimental",
      "vendor/model:free",
    ]) {
      expect(llmSlotSelectionSchema.safeParse({
        slot: "director",
        modelId: id,
        reasoningPreference: "max",
        baseUrl: null,
      }).success).toBe(true);
    }
  });

  it("accepts arbitrary model IDs on a registry entry too", () => {
    expect(llmModelEntrySchema.safeParse(validEntry({
      modelId: "totally-new/unknown-model",
    })).success).toBe(true);
  });

  it("rejects IDs without a vendor slash", () => {
    expect(llmSlotSelectionSchema.safeParse({
      slot: "director",
      modelId: "bare-model-id",
      reasoningPreference: "max",
      baseUrl: null,
    }).success).toBe(false);
    expect(llmModelEntrySchema.safeParse(validEntry({ modelId: "noslash" })).success).toBe(false);
  });

  it("rejects empty or whitespace IDs", () => {
    expect(llmSlotSelectionSchema.safeParse({
      slot: "writer",
      modelId: "",
      reasoningPreference: "none",
      baseUrl: null,
    }).success).toBe(false);
  });
});

describe("preset catalog", () => {
  it("ships the four build-time presets", () => {
    const ids = LLM_MODEL_PRESETS.map((p) => p.modelId);
    expect(ids).toEqual([
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4-flash-vision-experimental",
      "qwen/qwen-3.8-flash",
      "google/gemini-3.7-flash",
    ]);
  });

  it("every preset validates against the entry schema", () => {
    for (const preset of LLM_MODEL_PRESETS) {
      expect(llmModelEntrySchema.safeParse(preset).success).toBe(true);
    }
  });

  it("every preset reasoning effort list is strictly ascending", () => {
    const ladder = ["minimal", "low", "medium", "high", "max"];
    for (const preset of LLM_MODEL_PRESETS) {
      const indexes = preset.reasoningEfforts.map((e) => ladder.indexOf(e));
      for (let i = 1; i < indexes.length; i++) {
        expect(indexes[i] ?? -1).toBeGreaterThan(indexes[i - 1] ?? -2);
      }
    }
  });
});

describe("registry schema", () => {
  it("accepts a versioned registry with entries", () => {
    const registry = {
      version: 1,
      updatedAt: ISO,
      entries: LLM_MODEL_PRESETS,
    };
    expect(parseLlmRegistry(registry).entries).toHaveLength(4);
  });

  it("rejects a non-positive version", () => {
    expect(safeParseLlmRegistry({
      version: 0,
      updatedAt: ISO,
      entries: [],
    })).toBeNull();
  });

  it("rejects an invalid confidence tier", () => {
    expect(safeParseLlmRegistry({
      version: 1,
      updatedAt: ISO,
      entries: [validEntry({ confidence: "GUESSED" as unknown as LlmModelEntry["confidence"] })],
    })).toBeNull();
  });

  it("rejects non-ISO timestamps", () => {
    expect(safeParseLlmRegistry({
      version: 1,
      updatedAt: "yesterday",
      entries: [],
    })).toBeNull();
  });

  it("rejects video ingest values outside direct/frames/unknown", () => {
    expect(llmModelEntrySchema.safeParse(validEntry({ videoIngest: "maybe" as unknown as LlmModelEntry["videoIngest"] })).success).toBe(false);
  });

  it("exposes exactly direct/frames/unknown ingest modes", () => {
    expect([...VIDEO_INGEST_MODES]).toEqual(["direct", "frames", "unknown"]);
  });

  it("covers reasoning and vision kinds only", () => {
    expect([...LLM_KINDS]).toEqual(["reasoning", "vision"]);
    expect(llmModelEntrySchema.safeParse(validEntry({ kind: "video" as unknown as LlmModelEntry["kind"] })).success).toBe(false);
  });
});

describe("slot config validation", () => {
  it("accepts one selection per slot", () => {
    expect(parseLlmSlotConfig(fullSlotConfig())).toHaveLength(7);
  });

  it("rejects a duplicate slot", () => {
    const config = fullSlotConfig();
    const [first] = config;
    const duplicated = [...config, { ...first }];
    expect(safeParseLlmSlotConfig(duplicated)).toBeNull();
  });

  it("rejects an unknown slot name", () => {
    expect(safeParseLlmSlotConfig([
      { slot: "soundDesigner", modelId: "vendor/model", reasoningPreference: "max", baseUrl: null },
    ])).toBeNull();
  });

  it("rejects a preference outside the enum", () => {
    expect(safeParseLlmSlotConfig([
      { slot: "writer", modelId: "vendor/model", reasoningPreference: "ultra", baseUrl: null },
    ])).toBeNull();
  });

  it("rejects an invalid baseUrl", () => {
    expect(safeParseLlmSlotConfig([
      { slot: "writer", modelId: "vendor/model", reasoningPreference: "max", baseUrl: "not-a-url" },
    ])).toBeNull();
  });

  it("allows a subset of slots for partial overrides", () => {
    expect(parseLlmSlotConfig([
      { slot: "videoQc", modelId: "vendor/vision-model", reasoningPreference: "none", baseUrl: null },
    ])).toHaveLength(1);
  });
});

describe("resolveReasoningEffort (MAX_REASONING mapper core)", () => {
  it("maps max to the highest supported effort", () => {
    expect(resolveReasoningEffort("max", ["minimal", "low", "medium", "high"])).toBe("high");
    expect(resolveReasoningEffort("max", ["low", "medium"])).toBe("medium");
    expect(resolveReasoningEffort("max", ["high"])).toBe("high");
  });

  it("never returns literal max unless the endpoint lists it", () => {
    expect(resolveReasoningEffort("max", ["minimal", "low"])).toBe("low");
    expect(resolveReasoningEffort("max", ["low", "medium", "high", "max"])).toBe("max");
  });

  it("maps a named level to itself when supported", () => {
    expect(resolveReasoningEffort("medium", ["low", "medium", "high"])).toBe("medium");
  });

  it("steps a named level down to the nearest supported level below it", () => {
    expect(resolveReasoningEffort("high", ["minimal", "medium"])).toBe("medium");
    expect(resolveReasoningEffort("medium", ["low", "high"])).toBe("low");
    expect(resolveReasoningEffort("low", ["high"])).toBe("high");
  });

  it("returns none when the endpoint has no tunable effort", () => {
    expect(resolveReasoningEffort("max", [])).toBe("none");
  	expect(resolveReasoningEffort("high", [])).toBe("none");
  });

  it("returns none for an explicit none preference", () => {
    expect(resolveReasoningEffort("none", ["low", "high"])).toBe("none");
  });
});

describe("findLlmModelEntry and resolveVideoIngestRoute", () => {
  const registry = { entries: LLM_MODEL_PRESETS };

  it("finds an entry by model ID", () => {
    const entry = findLlmModelEntry(registry, "google/gemini-3.7-flash");
    expect(entry?.kind).toBe("vision");
    expect(findLlmModelEntry(registry, "does/not-exist")).toBeUndefined();
  });

  it("routes direct only for verified direct ingest", () => {
    expect(resolveVideoIngestRoute({ videoIngest: "direct", kind: "vision" })).toBe("direct");
    expect(resolveVideoIngestRoute({ videoIngest: "frames", kind: "vision" })).toBe("frames");
  });

  it("falls back to frames for unknown ingest and missing entries", () => {
    expect(resolveVideoIngestRoute({ videoIngest: "unknown", kind: "reasoning" })).toBe("frames");
    expect(resolveVideoIngestRoute(undefined)).toBe("frames");
  });
});

describe("DEFAULT_LLM_SLOT_CONFIG", () => {
  it("validates as a complete slot config", () => {
    const parsed = llmSlotConfigSchema.parse(DEFAULT_LLM_SLOT_CONFIG);
    expect(parsed.every((s) => s.reasoningPreference === "max")).toBe(true);
    expect(parsed.every((s) => s.baseUrl === null)).toBe(true);
  });

  it("defaults every slot to the same preset without closing the slots", () => {
    const modelIds = new Set(DEFAULT_LLM_SLOT_CONFIG.map((s) => s.modelId));
    expect(modelIds.size).toBe(1);
    // And any slot can be pointed at a non-preset ID without schema changes.
    expect(llmSlotConfigSchema.safeParse(
      fullSlotConfig().map((s) =>
        s.slot === "finalQc" ? { ...s, modelId: "any-vendor/any-model:free" } : s,
      ),
    ).success).toBe(true);
  });
});