/**
 * MAX_REASONING logical-config mapper for MMCS (runbook §24 CAP-008, §28).
 *
 * `MAX_REASONING` is a logical preference meaning "use the highest
 * reasoning/thinking effort the active endpoint supports". It is NEVER sent
 * literally: each adapter in `REASONING_ADAPTERS` declares the effort levels
 * its endpoint actually accepts (and how they go on the wire), and the mapper
 * resolves the logical preference to the highest supported level per adapter.
 * Endpoints that reject the literal string "max" can therefore never receive
 * it — the adapter table is the guard (see the adapter-table test).
 *
 * Self-contained by design: CAP-007's llm-registry maps registry entries to
 * efforts; this module maps a logical preference onto a concrete provider
 * adapter's wire format. No external dependencies.
 */

/** Logical reasoning preferences accepted in MMCS configuration. */
export const REASONING_PREFERENCES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "MAX_REASONING",
] as const;
export type ReasoningPreference = (typeof REASONING_PREFERENCES)[number];

/** The canonical logical token for "highest the endpoint supports". */
export const MAX_REASONING = "MAX_REASONING" as const;

/**
 * Concrete effort levels an endpoint may express, ascending. "max" appears
 * here ONLY for adapters whose endpoint verifiably accepts the literal
 * string; every other adapter tops out at "high" (or maps "max" to a numeric
 * thinking budget).
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Ascending rank used to compare efforts and preferences. */
export const REASONING_EFFORT_RANK: Readonly<
  Record<ReasoningEffort | ReasoningPreference, number>
> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  max: 5,
  MAX_REASONING: 5,
};

/**
 * How an adapter carries the resolved effort on the wire:
 * - `effort-string`: a literal effort string at a JSON path (e.g. OpenAI's
 *   `reasoning_effort`). `allowed` is the exact set of literals the endpoint
 *   accepts — the mapper never emits anything outside it.
 * - `thinking-budget`: a numeric thinking budget at a JSON path (Anthropic,
 *   Gemini). `budgets` maps each expressible effort to its wire number.
 */
export type ReasoningWire =
  | {
      style: "effort-string";
      /** JSON path of the effort value within the request body. */
      path: readonly string[];
      /** Exact literals the endpoint accepts; superset of `efforts`. */
      allowed: readonly ReasoningEffort[];
    }
  | {
      style: "thinking-budget";
      /** JSON path of the object that receives the budget parameter. */
      path: readonly string[];
      /** Budget parameter name inside the leaf object. */
      param: string;
      /** Wire budget (tokens) per expressible effort. */
      budgets: Readonly<Record<ReasoningEffort, number>>;
      /** Extra static fields merged into the leaf object (e.g. Anthropic's type flag). */
      extra?: Readonly<Record<string, unknown>>;
    };

/** One provider adapter's reasoning-effort contract. */
export interface ReasoningAdapter {
  /** Stable adapter id used in configuration (e.g. "openrouter"). */
  id: string;
  /** Effort levels this endpoint can express, ascending. Empty = no knob. */
  efforts: readonly ReasoningEffort[];
  /** Wire descriptor for the effort/budget. */
  wire: ReasoningWire;
  /**
   * Per-model effort overrides for endpoints that vary by model. Keys are
   * OpenRouter-style model IDs; an entry fully replaces `efforts`.
   */
  modelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
  notes?: string;
}

/** Result of resolving a logical preference against one adapter. */
export interface ResolvedReasoning {
  adapterId: string;
  /** True → omit the reasoning parameter from the request entirely. */
  omit: boolean;
  /** Resolved internal effort; null when omitted. */
  effort: ReasoningEffort | null;
  /** Literal wire value (string effort or numeric budget); null when omitted. */
  wireValue: string | number | null;
  /** JSON fragment to merge into the request body ({} when omitted). */
  bodyPatch: Readonly<Record<string, unknown>>;
}

/** Arbitrary JSON request body. */
export type ReasoningBody = Record<string, unknown>;

/** Thrown for an adapter id missing from the table. */
export class UnknownAdapterError extends Error {
  constructor(id: string) {
    super(`unknown reasoning adapter: ${id}`);
    this.name = "UnknownAdapterError";
  }
}

/** The built-in adapter table. The adapter-table test walks every entry. */
export const REASONING_ADAPTERS: readonly ReasoningAdapter[] = [
  {
    id: "openrouter",
    // OpenRouter's unified `reasoning.effort` accepts low/medium/high; it has
    // no "max" literal — MAX_REASONING resolves to "high".
    efforts: ["low", "medium", "high"],
    wire: {
      style: "effort-string",
      path: ["reasoning", "effort"],
      allowed: ["low", "medium", "high"],
    },
    notes:
      "OpenRouter unified routing: reasoning.effort in {low,medium,high}. Never send literal max.",
  },
  {
    id: "openai-responses",
    efforts: ["minimal", "low", "medium", "high"],
    wire: {
      style: "effort-string",
      path: ["reasoning", "effort"],
      allowed: ["minimal", "low", "medium", "high"],
    },
    notes: "OpenAI Responses API: reasoning.effort in {minimal,low,medium,high}.",
  },
  {
    id: "openai-chat",
    efforts: ["minimal", "low", "medium", "high"],
    wire: {
      style: "effort-string",
      path: ["reasoning_effort"],
      allowed: ["minimal", "low", "medium", "high"],
    },
    notes: "OpenAI Chat Completions: reasoning_effort string.",
  },
  {
    id: "anthropic-messages",
    // No effort strings on the wire at all: thinking is a token budget, so a
    // literal "max" is structurally impossible for this adapter.
    efforts: ["low", "medium", "high", "max"],
    wire: {
      style: "thinking-budget",
      path: ["thinking"],
      param: "budget_tokens",
      budgets: { minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 32768 },
      extra: { type: "enabled" },
    },
    notes: "Anthropic Messages: thinking.budget_tokens numeric; max = adapter ceiling.",
  },
  {
    id: "google-gemini",
    efforts: ["low", "medium", "high", "max"],
    wire: {
      style: "thinking-budget",
      path: ["generationConfig", "thinkingConfig"],
      param: "thinkingBudget",
      budgets: { minimal: 512, low: 1024, medium: 4096, high: 8192, max: 24576 },
    },
    notes: "Gemini: generationConfig.thinkingConfig.thinkingBudget numeric.",
  },
  {
    id: "deepseek-chat",
    // DeepSeek's reasoner exposes no tunable effort knob: MAX_REASONING must
    // omit the parameter entirely rather than invent a literal.
    efforts: [],
    wire: {
      style: "effort-string",
      path: ["reasoning_effort"],
      allowed: [],
    },
    notes: "No tunable reasoning knob — reasoning parameter must be omitted.",
  },
  {
    id: "literal-max-passthrough",
    // ONLY for endpoints verified to accept the literal string "max". Its
    // presence in the table proves the mapper sends "max" when — and only
    // when — an endpoint declares it.
    efforts: ["low", "medium", "high", "max"],
    wire: {
      style: "effort-string",
      path: ["reasoning_effort"],
      allowed: ["low", "medium", "high", "max"],
    },
    notes:
      "Endpoints verified to accept literal 'max'. Do not point at unverified APIs.",
  },
];

/** Adapter ids in table order. */
export const REASONING_ADAPTER_IDS: readonly string[] = REASONING_ADAPTERS.map((a) => a.id);

/** Look up an adapter by id; throws UnknownAdapterError when absent. */
export function getReasoningAdapter(id: string): ReasoningAdapter {
  const adapter = REASONING_ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new UnknownAdapterError(id);
  return adapter;
}

/** True when the table contains the adapter id. */
export function hasReasoningAdapter(id: string): boolean {
  return REASONING_ADAPTERS.some((a) => a.id === id);
}

/**
 * Parse a raw config string into a logical preference. Accepts the canonical
 * tokens plus the aliases "max"/"MAX"/"max_reasoning" (logical config only —
 * the WIRE value is decided per adapter by `resolveReasoning`).
 */
export function parseReasoningPreference(raw: string): ReasoningPreference {
  const key = raw.trim().toUpperCase().replace(/[\s_-]+/g, "_");
  if (key === "MAX_REASONING" || key === "MAX") return "MAX_REASONING";
  if (key === "NONE") return "none";
  if (key === "MINIMAL") return "minimal";
  if (key === "LOW") return "low";
  if (key === "MEDIUM") return "medium";
  if (key === "HIGH") return "high";
  throw new Error(
    `unknown reasoning preference "${raw}" — expected one of ${REASONING_PREFERENCES.join(", ")}`,
  );
}

/** Efforts an adapter expresses for a given model (model override wins). */
export function effortsFor(
  adapter: ReasoningAdapter,
  modelId?: string,
): readonly ReasoningEffort[] {
  if (modelId !== undefined) {
    const override = adapter.modelEfforts?.[modelId];
    if (override) return override;
  }
  return adapter.efforts;
}

/**
 * Build a fresh nested object that places `leafValue` at `path`
 * (e.g. path ["reasoning","effort"], value "high" → { reasoning: { effort: "high" } }).
 */
function patchAt(path: readonly string[], leafValue: unknown): Record<string, unknown> {
  const last = path[path.length - 1] as string;
  let node: Record<string, unknown> = { [last]: leafValue };
  for (let i = path.length - 1; i > 0; i--) {
    node = { [path[i - 1] as string]: node };
  }
  return node;
}

/**
 * Resolve a logical preference against one adapter (and optional model).
 *
 * Mapping rules (runbook §28: MAX_REASONING maps to the highest supported
 * effort; never assume every API accepts literal "max"):
 * - `none`, or an endpoint with no effort knob → omit the parameter.
 * - `MAX_REASONING` → the highest entry of the adapter's (model-specific)
 *   effort list.
 * - A named level → the highest supported level at or below it; when the
 *   endpoint's floor sits above the request, use its floor rather than
 *   dropping reasoning entirely.
 */
export function resolveReasoning(
  adapter: ReasoningAdapter,
  preference: ReasoningPreference,
  modelId?: string,
): ResolvedReasoning {
  const efforts = effortsFor(adapter, modelId);
  if (preference === "none" || efforts.length === 0) {
    return { adapterId: adapter.id, omit: true, effort: null, wireValue: null, bodyPatch: {} };
  }

  let effort: ReasoningEffort;
  if (preference === "MAX_REASONING") {
    effort = efforts[efforts.length - 1] as ReasoningEffort;
  } else {
    const requestedRank = REASONING_EFFORT_RANK[preference];
    const candidates = efforts.filter((e) => REASONING_EFFORT_RANK[e] <= requestedRank);
    effort =
      candidates.length > 0
        ? (candidates[candidates.length - 1] as ReasoningEffort)
        : (efforts[0] as ReasoningEffort);
  }

  const wire = adapter.wire;
  if (wire.style === "effort-string") {
    if (!wire.allowed.includes(effort)) {
      throw new Error(
        `adapter ${adapter.id}: resolved effort "${effort}" is not in the endpoint's allowed set`,
      );
    }
    return {
      adapterId: adapter.id,
      omit: false,
      effort,
      wireValue: effort,
      bodyPatch: patchAt(wire.path, effort),
    };
  }

  const budget = wire.budgets[effort];
  const leaf: Record<string, unknown> = { ...(wire.extra ?? {}), [wire.param]: budget };
  // For budget style the path names the OBJECT receiving the parameters, so
  // the leaf object itself sits at the full path.
  return {
    adapterId: adapter.id,
    omit: false,
    effort,
    wireValue: budget,
    bodyPatch: patchAt(wire.path, leaf),
  };
}

/** Shorthand: MAX_REASONING resolution for one adapter (and optional model). */
export function resolveMaxReasoning(
  adapter: ReasoningAdapter,
  modelId?: string,
): ResolvedReasoning {
  return resolveReasoning(adapter, "MAX_REASONING", modelId);
}

/** Resolve the preference and merge its patch into an existing request body. */
export function applyReasoning(
  adapter: ReasoningAdapter,
  body: Readonly<Record<string, unknown>>,
  preference: ReasoningPreference,
  modelId?: string,
): Record<string, unknown> {
  const resolved = resolveReasoning(adapter, preference, modelId);
  return resolved.omit ? { ...body } : { ...body, ...resolved.bodyPatch };
}