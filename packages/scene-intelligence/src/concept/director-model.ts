/**
 * Director-model interface for the concept pipeline — DIR-002 (runbook §24
 * WF03; spec §14: configurable orchestration/QC LLMs via OpenRouter or
 * compatible routing, separate user selection for the DIRECTOR model).
 *
 * The interface is OpenRouter-compatible: base URL defaults to
 * https://openrouter.ai/api/v1 and any OpenRouter-style `vendor/model` ID is
 * accepted (spec §14 "never closed to four models"). MAX_REASONING is
 * resolved against the CAP-007/CAP-008 data — never sent literally to an
 * endpoint that cannot express it (spec §14 "never assume every API accepts
 * a literal max").
 *
 * CAPABILITY CHECK IS MANDATORY (runbook §16 pre-request validation order;
 * task contract "no provider call without capability check"): the only way
 * to obtain a runnable client is {@linkcode prepareDirectorModel}, which
 * performs the registry checks in order and refuses to return a client when
 * any check fails. The mock transport still travels the same gate — a
 * mocked test proves the gate, not bypasses it.
 */

import { REASONING_MODEL_PROFILES } from "@mmcs/capability-registry/data";
import {
  REASONING_ADAPTERS,
  getReasoningAdapter,
  resolveReasoning,
  type ReasoningAdapter,
  type ReasoningPreference,
} from "@mmcs/capability-registry/max-reasoning";
import { validatePricingProfile } from "@mmcs/capability-registry/pricing";

import { toSingleLine } from "./sanitize.js";
import type { DirectorCapabilitySnapshot } from "./types.js";

/** Default OpenRouter-compatible chat-completions endpoint (spec §14). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_CHAT_PATH = "/chat/completions";

/** Adapter id used for OpenRouter-compatible endpoints (CAP-008 table: effort-string). */
export const OPENROUTER_REASONING_ADAPTER = "openrouter";

/** Spec §14 slot id (matches CAP-007 llm-registry slot taxonomy). */
export const DIRECTOR_SLOT = "director" as const;

/** A capability gate issue; value-free, safe to log. */
export interface CapabilityGateIssue {
  readonly field: string;
  readonly code:
    | "MODEL_NOT_IN_REGISTRY"
    | "MISSING_BASE_URL_OR_KEY"
    | "MISSING_ADAPTER"
    | "REASONING_UNMAPPABLE";
  readonly message: string;
}

/** Frozen verdict of one capability check. */
export interface CapabilityCheckResult {
  readonly allowed: boolean;
  readonly profile: DirectorCapabilitySnapshot | null;
  readonly effort: string | null;
  readonly adapterId: string;
  readonly unknownModelAllowed: boolean;
  readonly issues: readonly CapabilityGateIssue[];
  readonly checkedAt: string;
}

/** Loose director-model connection descriptor. */
export interface DirectorConnection {
  /** OpenRouter-style vendor/model ID, e.g. "z-ai/glm-5.3-flash". */
  readonly modelId: string;
  /** Endpoint base; null = {@linkcode OPENROUTER_BASE_URL} default. */
  readonly baseUrl: string | null;
  /** API key indicator; null = no key available. */
  readonly apiKey: string | null;
  /**
   * Logical reasoning preference (spec §14 "never assume literal max").
   * Defaults to MAX_REASONING.
   */
  readonly reasoningPreference?: ReasoningPreference;
}

/** Spec §14: any OpenRouter-compatible model ID is allowed — never closed to presets. */
export function isOpenRouterModelId(modelId: string): boolean {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return false;
  // Exactly one slash: "a//b" and "a/b/c" are not vendor/model ids.
  return trimmed.indexOf("/", slash + 1) === -1;
}

/** Raw wire fields the step-2 transport adapter must fill. */
export interface DirectorWire {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Step-2 transport definition. Concrete adapters close over their own fetch. */
export interface DirectorTransport {
  readonly kind: "mock" | "openai-compatible";
  /** Perform the HTTP request; returns the raw JSON response body object. */
  readonly request: (wire: DirectorWire) => Promise<unknown>;
}

/** Complete capability-checked director-model client. */
export interface DirectorModelClient {
  readonly transport: DirectorTransport;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  /** Capability snapshot the gate stamped when this client was built. */
  readonly capabilityCheck: DirectorCapabilitySnapshot;
}

export type DirectorModelErrorCode =
  | "DIRECTOR_MODEL_NOT_ALLOWED"
  | "DIRECTOR_INVALID_MODEL_ID"
  | "DIRECTOR_TRANSPORT_ERROR";

/** Typed failure from the director-model seam. Error payloads are value-free. */
export class DirectorModelError extends Error {
  readonly code: DirectorModelErrorCode;
  readonly issues: readonly CapabilityGateIssue[];

  constructor(
    code: DirectorModelErrorCode,
    message: string,
    issues: readonly CapabilityGateIssue[] = [],
  ) {
    super(message);
    this.name = "DirectorModelError";
    this.code = code;
    this.issues = issues;
  }
}

/** Fresh ISO-8601 timestamp (tests inject a fixed value). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Look up a seeded reasoning profile by exact model id; null when unseeded. */
export function getReasoningProfile(modelId: string) {
  return REASONING_MODEL_PROFILES[modelId] ?? null;
}

/**
 * Run the capability gate alone (no client). Exposed for tests and for
 * CLI/diagnostics: returns the verdict instead of throwing.
 */
export function checkDirectorCapability(options: {
  readonly connection: DirectorConnection;
  readonly unknownModelAllowed?: boolean;
  readonly nowIso?: string;
}): CapabilityCheckResult {
  const now = options.nowIso ?? nowIso();
  const { connection } = options;
  const unknownModelAllowed = options.unknownModelAllowed ?? false;
  const issues: CapabilityGateIssue[] = [];

  // 1. model id shape (spec §14: OpenRouter-compatible only).
  const modelId = typeof connection.modelId === "string" ? connection.modelId.trim() : "";
  if (!isOpenRouterModelId(modelId)) {
    issues.push({
      field: "modelId",
      code: "MODEL_NOT_IN_REGISTRY",
      message: "modelId must be an OpenRouter-style vendor/model id",
    });
  }

  // 2. adapter present (CAP-008 table guards the wire format).
  const adapterId = connection.reasoningPreference?.toLowerCase() !== "none"
    ? OPENROUTER_REASONING_ADAPTER
    : OPENROUTER_REASONING_ADAPTER;
  let adapter: ReasoningAdapter | null = null;
  try {
    adapter = getReasoningAdapter(adapterId);
  } catch {
    issues.push({
      field: "adapterId",
      code: "MISSING_ADAPTER",
      message: `unknown reasoning adapter: ${adapterId}`,
    });
  }

  // 3. connection completeness (spec §29: no bare call without endpoint + key).
  const baseUrl = (connection.baseUrl ?? OPENROUTER_BASE_URL).trim();
  if (baseUrl === "") {
    issues.push({
      field: "baseUrl",
      code: "MISSING_BASE_URL_OR_KEY",
      message: "baseUrl is required for the director model endpoint",
    });
  }
  const hasApiKey = connection.apiKey !== null && connection.apiKey.trim().length > 0;
  if (!hasApiKey) {
    issues.push({
      field: "apiKey",
      code: "MISSING_BASE_URL_OR_KEY",
      message: "an API key must be available before any provider call",
    });
  }

  // 4. capability profile + pricing sanity (runbook §16: resolve profile,
  //    then validate; CAP-006 owns the pricing/estimate contract).
  const profile = getReasoningProfile(modelId);
  let profileSnapshot: DirectorCapabilitySnapshot | null = null;
  if (profile !== null) {
    try {
      validatePricingProfile({
        provider: profile.provider,
        modelId: profile.modelId,
        kind: "reasoning",
        pricing: {
          unit: profile.pricing.usdPerMillionInput !== null ? "per_token_1k" : null,
          amount:
            profile.pricing.usdPerMillionInput !== null
              ? profile.pricing.usdPerMillionInput
              : null,
          currency: profile.pricing.currency,
          quota: null,
          overage: null,
        },
        includedQuota: { units: null, resetPeriod: null, subscription: false },
      });
    } catch (error) {
      issues.push({
        field: "pricing",
        code: "MODEL_NOT_IN_REGISTRY",
        message:
          error instanceof Error
            ? `invalid capability pricing: ${error.message}`
            : "invalid capability pricing",
      });
    }
    profileSnapshot = {
      modelId: profile.modelId,
      adapterId,
      effort: null,
      confidence: profile.confidence,
      unknownModelAllowed: false,
      checkedAt: now,
    };
  } else if (!unknownModelAllowed) {
    issues.push({
      field: "modelId",
      code: "MODEL_NOT_IN_REGISTRY",
      message:
        "model has no capability-registry profile; unknown models are refused unless explicitly allowed",
    });
  }

  // 5. reasoning preference → endpoint effort (spec §14; CAP-008 mapper).
  const preference: ReasoningPreference = connection.reasoningPreference ?? "MAX_REASONING";
  let effort: string | null = null;
  if (adapter !== null && profile !== null) {
    try {
      const resolved = resolveReasoning(adapter, preference, modelId);
      effort = resolved.effort;
    } catch (error) {
      issues.push({
        field: "reasoningPreference",
        code: "REASONING_UNMAPPABLE",
        message:
          error instanceof Error ? error.message : "reasoning preference could not be mapped",
      });
    }
  }

  return {
    allowed: issues.length === 0,
    profile: profileSnapshot,
    effort,
    adapterId,
    unknownModelAllowed: profile === null,
    issues,
    checkedAt: now,
  };
}

/**
 * Capability check + client assembly — the ONLY way to obtain a runnable
 * director client. Any failed check throws {@linkcode DirectorModelError}
 * with the gate issues. A client that exists has passed every gate.
 */
export function prepareDirectorModel(options: {
  readonly connection: DirectorConnection;
  readonly transport: DirectorTransport;
  readonly unknownModelAllowed?: boolean;
  readonly nowIso?: string;
}): DirectorModelClient {
  const verdict = checkDirectorCapability(options);
  if (!verdict.allowed) {
    throw new DirectorModelError(
      "DIRECTOR_MODEL_NOT_ALLOWED",
      "director model call not allowed — capability check failed",
      verdict.issues,
    );
  }
  const baseUrl = (options.connection.baseUrl ?? OPENROUTER_BASE_URL).trim().replace(/\/+$/, "");
  const modelId = options.connection.modelId.trim();
  const preference = options.connection.reasoningPreference ?? "MAX_REASONING";
  const adapter = getReasoningAdapter(OPENROUTER_REASONING_ADAPTER);
  const profile = getReasoningProfile(modelId);
  const resolved =
    profile !== null ? resolveReasoning(adapter, preference, modelId) : null;

  return {
    transport: options.transport,
    modelId,
    baseUrl,
    hasApiKey: options.connection.apiKey !== null && options.connection.apiKey.trim().length > 0,
    capabilityCheck: {
      modelId,
      adapterId: verdict.adapterId,
      effort: resolved?.effort ?? null,
      confidence: profile !== null ? profile.confidence : "UNKNOWN",
      unknownModelAllowed: profile === null,
      checkedAt: verdict.checkedAt,
    },
  };
}

/** The built-in reasoning adapter ids (CAP-008 table), for tests/docs. */
export const REASONING_ADAPTER_IDS_LOCAL: readonly string[] = REASONING_ADAPTERS.map(
  (adapter) => adapter.id,
);

export { toSingleLine };
