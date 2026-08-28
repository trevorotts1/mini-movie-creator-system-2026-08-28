/**
 * Reasoning/vision model registry for MMCS (runbook §24 WF09-001, §22 CAP-007;
 * spec subsystem 2). OpenRouter-compatible selection: any OpenRouter-style
 * `vendor/model` model ID is accepted — the registry is never closed to its
 * presets. Separate selection slots exist for director, writer, script critic,
 * image QC, video QC, continuity QC, and final QC.
 *
 * Presets ship with a `maxReasoningEffort` per endpoint because MAX_REASONING
 * is a logical preference: it maps to the highest effort the active endpoint
 * supports, never the literal string "max" (runbook §24 WF09-002/CAP-008).
 * UNKNOWN is a valid confidence value and must never be guessed upward.
 */

import { z } from "zod";

/** The seven independent reasoning/vision model selection slots. */
export const LLM_SLOTS = [
  "director",
  "writer",
  "scriptCritic",
  "imageQc",
  "videoQc",
  "continuityQc",
  "finalQc",
] as const;
export type LlmSlot = (typeof LLM_SLOTS)[number];

/** Registry kinds this registry covers: reasoning and/or vision. */
export const LLM_KINDS = ["reasoning", "vision"] as const;
export type LlmKind = (typeof LLM_KINDS)[number];

/**
 * How a model ingests video for QC purposes. `direct` means the endpoint
 * accepts video natively; `frames` means FFmpeg must extract representative
 * frames first (runbook: if the selected model cannot ingest video directly,
 * FFmpeg extracts representative frames for image-vision QC).
 */
export const VIDEO_INGEST_MODES = ["direct", "frames", "unknown"] as const;
export type VideoIngestMode = (typeof VIDEO_INGEST_MODES)[number];

/**
 * Concrete reasoning efforts the model's endpoint is known to accept, ordered
 * ascending. MAX_REASONING maps to the last entry. An empty array means the
 * endpoint exposes no tunable effort level.
 */
export const reasoningEffortsSchema = z.array(
  z.enum(["minimal", "low", "medium", "high", "max"]),
);
export type ReasoningEffort = z.infer<typeof reasoningEffortsSchema>[number];

/** One entry in the reasoning/vision model registry. */
export const llmModelEntrySchema = z.object({
  /** OpenRouter-style model ID, e.g. "vendor/model-name". */
  modelId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/, {
      message: "modelId must be an OpenRouter-style vendor/model ID",
    }),
  /** Registry kind: reasoning and/or vision capable. */
  kind: z.enum(LLM_KINDS),
  /** ISO-8601 timestamp of the last human verification. */
  lastVerifiedAt: z.string().datetime({ offset: true }),
  /** Evidence for the values below; empty only when confidence is UNKNOWN. */
  sourceUrls: z.array(z.string().url()),
  confidence: z.enum(["VERIFIED", "PROVISIONAL", "UNKNOWN"]),
  /** Highest reasoning/thinking effort the endpoint accepts, ascending. */
  reasoningEfforts: reasoningEffortsSchema,
  /** Whether the endpoint accepts video input natively for QC. */
  videoIngest: z.enum(VIDEO_INGEST_MODES),
  /** Optional context window in tokens; null when unverified. */
  contextWindowTokens: z.number().int().positive().nullable(),
  /** Free-form notes kept out of routing decisions. */
  notes: z.string().min(1).nullable(),
});
export type LlmModelEntry = z.infer<typeof llmModelEntrySchema>;

/** A versioned snapshot of the reasoning/vision LLM registry. */
export const llmRegistrySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  entries: z.array(llmModelEntrySchema),
});
export type LlmRegistry = z.infer<typeof llmRegistrySchema>;

/**
 * Per-slot user selection. `modelId` is any OpenRouter-compatible ID — not
 * constrained to preset entries; presets are suggestions, never a closed list.
 */
export const llmSlotSelectionSchema = z.object({
  slot: z.enum(LLM_SLOTS),
  modelId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/, {
      message: "modelId must be an OpenRouter-style vendor/model ID",
    }),
  /**
   * Logical reasoning preference: "max" means "highest the endpoint supports"
   * and is resolved per endpoint by `resolveReasoningEffort` — never sent
   * literally to an API that does not accept it.
   */
  reasoningPreference: z.enum(["none", "low", "medium", "high", "max"]),
  /** Optional explicit endpoint base URL override (OpenRouter-compatible). */
  baseUrl: z.string().url().nullable(),
});
export type LlmSlotSelection = z.infer<typeof llmSlotSelectionSchema>;

/** Complete slot configuration: one selection per slot, no duplicates. */
export const llmSlotConfigSchema = z
  .array(llmSlotSelectionSchema)
  .superRefine((selections, ctx) => {
    const seen = new Set<string>();
    for (const selection of selections) {
      if (seen.has(selection.slot)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate selection for slot ${selection.slot}`,
        });
      }
      seen.add(selection.slot);
    }
  });
export type LlmSlotConfig = z.infer<typeof llmSlotConfigSchema>;

/** Parse-and-narrow helpers with readable errors. */
export function parseLlmRegistry(value: unknown): LlmRegistry {
  return llmRegistrySchema.parse(value);
}

export function safeParseLlmRegistry(value: unknown): LlmRegistry | null {
  const result = llmRegistrySchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseLlmSlotConfig(value: unknown): LlmSlotConfig {
  return llmSlotConfigSchema.parse(value);
}

export function safeParseLlmSlotConfig(value: unknown): LlmSlotConfig | null {
  const result = llmSlotConfigSchema.safeParse(value);
  return result.success ? result.data : null;
}