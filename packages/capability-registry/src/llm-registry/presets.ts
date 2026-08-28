import type { LlmKind, LlmModelEntry, ReasoningEffort } from "./llm-registry.js";

/**
 * Preset entries to verify at build time (runbook §24 WF09-001). Presets are
 * convenience entries, never a closed list — the registry accepts any
 * OpenRouter-compatible model ID. Efforts are the levels each endpoint is
 * known to accept; confidence stays PROVISIONAL until verified against the
 * live endpoint (CAP-009 owns the health/verify command).
 */
export const LLM_MODEL_PRESETS: LlmModelEntry[] = [
  {
    modelId: "z-ai/glm-5.3-flash",
    kind: "reasoning",
    lastVerifiedAt: "2026-08-28T00:00:00.000Z",
    sourceUrls: ["https://openrouter.ai/docs"],
    confidence: "PROVISIONAL",
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    videoIngest: "frames",
    contextWindowTokens: null,
    notes: "Preset: GLM 5.3 Flash. Verify endpoint effort levels before use.",
  },
  {
    modelId: "deepseek/deepseek-v4-flash-vision-experimental",
    kind: "vision",
    lastVerifiedAt: "2026-08-28T00:00:00.000Z",
    sourceUrls: ["https://openrouter.ai/docs"],
    confidence: "PROVISIONAL",
    reasoningEfforts: ["low", "medium", "high"],
    videoIngest: "frames",
    contextWindowTokens: null,
    notes:
      "Preset: DeepSeek V4 Flash Vision Experimental. Vision-capable QC slot candidate.",
  },
  {
    modelId: "qwen/qwen-3.8-flash",
    kind: "reasoning",
    lastVerifiedAt: "2026-08-28T00:00:00.000Z",
    sourceUrls: ["https://openrouter.ai/docs"],
    confidence: "PROVISIONAL",
    reasoningEfforts: ["minimal", "medium", "high"],
    videoIngest: "frames",
    contextWindowTokens: null,
    notes: "Preset: Qwen 3.8 Flash.",
  },
  {
    modelId: "google/gemini-3.7-flash",
    kind: "vision",
    lastVerifiedAt: "2026-08-28T00:00:00.000Z",
    sourceUrls: ["https://openrouter.ai/docs"],
    confidence: "PROVISIONAL",
    reasoningEfforts: ["low", "medium", "high"],
    videoIngest: "frames",
    contextWindowTokens: null,
    notes:
      "Preset: Gemini 3.7 Flash. Video ingest unverified — frames route until proven direct.",
  },
];

/**
 * Default slot configuration: every slot starts on the same verified-default
 * preset with MAX_REASONING as the logical preference. Operators override any
 * slot independently; nothing here closes a slot to other model IDs.
 */
export const DEFAULT_LLM_SLOT_CONFIG: {
  slot: import("./llm-registry.js").LlmSlot;
  modelId: string;
  reasoningPreference: "max";
  baseUrl: string | null;
}[] = (["director", "writer", "scriptCritic", "imageQc", "videoQc", "continuityQc", "finalQc"] as const).map(
  (slot) => ({
    slot,
    modelId: "z-ai/glm-5.3-flash",
    reasoningPreference: "max" as const,
    baseUrl: null,
  }),
);

/**
 * Resolve the logical reasoning preference for one endpoint. MAX_REASONING
 * maps to the highest effort the endpoint supports (last entry of the
 * ascending `reasoningEfforts` list); a named level maps to itself when the
 * endpoint supports it, else the highest available level at or below it. An
 * endpoint with no tunable effort returns "none" — the request must omit the
 * reasoning parameter entirely.
 */
export function resolveReasoningEffort(
  preference: "none" | "low" | "medium" | "high" | "max",
  supported: readonly ReasoningEffort[],
): ReasoningEffort | "none" {
  if (preference === "none" || supported.length === 0) return "none";
  if (preference === "max") return supported[supported.length - 1] as ReasoningEffort;

  const ladder: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
  const requestedIndex = ladder.indexOf(preference as Exclude<ReasoningEffort, "max">);
  const candidates = supported.filter(
    (effort) => effort !== "max" && ladder.indexOf(effort) <= requestedIndex,
  );
  if (candidates.length > 0) {
    return candidates[candidates.length - 1] as ReasoningEffort;
  }
  // Endpoint's lowest supported level is above the request: use its floor
  // rather than dropping reasoning entirely.
  return supported[0] as ReasoningEffort;
}

/** Look up a registry entry by OpenRouter-style model ID. */
export function findLlmModelEntry(
  registry: { entries: readonly LlmModelEntry[] },
  modelId: string,
): LlmModelEntry | undefined {
  return registry.entries.find((entry) => entry.modelId === modelId);
}

/**
 * Decide the QC video route for a selected model: native video when the
 * endpoint ingests it directly, FFmpeg frame extraction otherwise. UNKNOWN
 * falls back to frames — the safe default that never submits an unsupported
 * video payload.
 */
export function resolveVideoIngestRoute(
  entry: Pick<LlmModelEntry, "videoIngest" | "kind"> | undefined,
): "direct" | "frames" {
  if (!entry) return "frames";
  return entry.videoIngest === "direct" ? "direct" : "frames";
}