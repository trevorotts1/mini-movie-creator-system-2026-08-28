/**
 * Concept generator — DIR-002 (runbook §24 WF03; spec §0 "story idea →
 * concept → script development", human gate 1 "developed concept presented").
 *
 * Purpose: turn a validated idea intake record into a DEVELOPED CONCEPT — a
 * set of distinct concept options plus the director model's recommendation —
 * via the capability-checked director-model interface (spec §14). The result
 * is handed to gate 1 (DIR-003 approval); no screenplay work happens before
 * that approval.
 *
 * SEAMS (testable without a network or paid provider):
 *  1. prepareDirectorModel (director-model.ts) — capability check gating;
 *  2. transport (DirectorTransport) — the HTTP adapter; the mock records
 *     wires and answers canned responses;
 *  3. parseConceptResponseBody (response.ts) — untrusted-output parse.
 *
 * SECURITY (spec §29): idea text and model output are untrusted data. The
 * idea is fenced inside the user prompt; output is parsed defensively and
 * never executed. Error messages are value-free (no idea text, no raw model
 * output in exceptions or logs).
 */

/// <reference types="node" />
import { randomBytes } from "node:crypto";

import { buildConceptSystemPrompt, buildConceptUserPrompt, promptRecords } from "./prompt.js";
import {
  assertValidConceptResponse,
  scanTextForInjection,
  type ParsedConceptOption,
} from "./response.js";
import { containsNulByte, sanitizeText, toSingleLine } from "./sanitize.js";
import {
  CONCEPT_OPTIONS_DEFAULT,
  CONCEPT_OPTIONS_MAX,
  CONCEPT_OPTIONS_MIN,
  IDEA_TEXT_MAX_LENGTH,
  IDEA_TEXT_MIN_LENGTH,
  type ConceptGenerationRequest,
  type ConceptOption,
  type DevelopedConcept,
  type IdeaIntakeLike,
  type PromptRecord,
} from "./types.js";

/** OpenRouter chat-completions timeouts (spec §29: provider timeout limits). */
export const COMPLETIONS_TIMEOUT_MS = 120_000;
/** Default sampling temperature for creative generation. */
export const DEFAULT_TEMPERATURE = 0.8;
/** Default completion token ceiling. */
export const DEFAULT_MAX_TOKENS = 4_096;

/** Stable concept business ID (`concept_` + 16 random bytes hex). */
export function newConceptId(): string {
  return `concept_${randomBytes(16).toString("hex")}`;
}

/**
 * Capability-checked generation. The caller passes a client obtained from
 * `prepareDirectorModel` — by construction that client only exists for a
 * model that passed the capability gate. Returns the developed concept; any
 * contract violation or transport failure throws a typed error.
 */
export async function generateConcept(
  request: ConceptGenerationRequest,
): Promise<DevelopedConcept> {
  const optionCount = validateOptionCount(request.optionCount);
  const temperature = request.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;

  const intake = requireIntake(request.intake);
  const system = buildConceptSystemPrompt({ optionCount });
  const user = buildConceptUserPrompt({ intake, optionCount });
  const record: PromptRecord = {
    system,
    user,
    ...promptRecords({ system, user }),
  };

  const wire = {
    url: `${request.client.baseUrl}/chat/completions`,
    headers: {
      "content-type": "application/json",
      /**
       * Authorization is transport-owned, not wire-owned: the concrete
       * adapter (step 2) injects the real credential from env/config at
       * request time. The wire object deliberately carries no secret value —
       * spec §29 (no API keys in logs or data structures).
       */
      authorization: "bearer <injected by transport adapter>",
    },
    body: {
      model: request.client.modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
      ...(request.client.capabilityCheck.effort !== null
        ? { reasoning: { effort: request.client.capabilityCheck.effort } }
        : {}),
    },
  };

  const raw = await request.client.transport.request(wire).catch((error) => {
    throw transportError(error);
  });

  const body = extractChatContent(raw);
  const parsed = assertValidConceptResponse(body, {
    expectedOptionCount: optionCount,
  });

  // The parsed content is untrusted DATA (spec §29): it is stored, presented
  // at gate 1, and never executed or re-interpreted as instructions. The
  // injection scanner exists as a reporting aid for downstream loggers —
  // detection here would be a gate on text, which spec §29 forbids treating
  // as anything but data.
  const injectionFlags = parsed.options
    .filter((option) => scanTextForInjection(option.title).unsafe)
    .map((option) => option.index);

  const options = mergeOptions(parsed.options, optionCount);
  const recommended = findRecommended(options);
  if (recommended === undefined) {
    throw new Error(
      "invalid director-model response (at option 0: no option is marked recommended)",
    );
  }

  return {
    conceptId: request.conceptId ?? newConceptId(),
    intakeId: intake.intakeId,
    options,
    recommendedOptionId: recommended.optionId,
    aspectRatio: intake.aspectRatio,
    targetRuntimeSeconds: intake.targetRuntimeSeconds,
    seriesLink: intake.seriesLink,
    generatedAt: request.generatedAt ?? new Date().toISOString(),
    generatedBy: request.client.capabilityCheck,
    prompts: record,
    modelNotes: parsed.modelNotes,
    // Value-free flag for downstream logging: option indices whose titles
    // contain instruction-shaped text. Content itself is still data.
    flaggedOptionIndexes: injectionFlags,
  };
}

/** Clamp/validate the requested option count against the domain bounds. */
export function validateOptionCount(value: number | undefined): number {
  if (value === undefined) return CONCEPT_OPTIONS_DEFAULT;
  if (!Number.isInteger(value)) {
    throw new Error(`optionCount must be an integer, got ${String(value)}`);
  }
  return Math.min(Math.max(value, CONCEPT_OPTIONS_MIN), CONCEPT_OPTIONS_MAX);
}

/**
 * Validate the intake BEFORE any provider interaction (runbook §16
 * pre-request validation order). The idea text is untrusted data (spec §29):
 * NUL bytes are rejected outright; everything else must be a non-empty
 * string within the intake bounds mirrored from DIR-001.
 */
export function requireIntake(intake: IdeaIntakeLike): IdeaIntakeLike {
  if (typeof intake !== "object" || intake === null) {
    throw new Error("intake: must be an object");
  }
  const { rawText } = intake;
  if (typeof rawText !== "string") {
    throw new Error("rawText: must be a string");
  }
  if (containsNulByte(rawText)) {
    throw new Error("rawText: contains a NUL byte");
  }
  const text = sanitizeText(rawText);
  if (text.length < IDEA_TEXT_MIN_LENGTH) {
    throw new Error("rawText: must not be empty");
  }
  if (text.length > IDEA_TEXT_MAX_LENGTH) {
    throw new Error(`rawText: exceeds ${IDEA_TEXT_MAX_LENGTH} characters`);
  }
  if (typeof intake.intakeId !== "string" || intake.intakeId.length === 0) {
    throw new Error("intakeId: must be a non-empty string");
  }
  if (typeof intake.aspectRatio !== "string" || intake.aspectRatio.length === 0) {
    throw new Error("aspectRatio: must be a non-empty string");
  }
  if (
    typeof intake.targetRuntimeSeconds !== "number" ||
    !Number.isFinite(intake.targetRuntimeSeconds) ||
    intake.targetRuntimeSeconds <= 0
  ) {
    throw new Error("targetRuntimeSeconds: must be a positive finite number");
  }
  return { ...intake, rawText: text };
}

/** Map transport failures to a typed error without leaking response bodies. */
export function transportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "unknown transport error";
  return new Error(`director model transport failed: ${message}`);
}

/**
 * Extract the assistant message content from an OpenRouter-compatible chat
 * completion payload, then pull the JSON object out of a possibly fenced /
 * prose-wrapped string. The model output is untrusted: the fence strip only
 * recognizes balanced code fences; anything else parses through the same
 * fail-closed response validator.
 */
export function extractChatContent(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("director model returned a non-object payload");
  }
  const obj = payload as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0 || choices[0] === undefined) {
    throw new Error("director model returned no choices");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("director model returned an invalid choice");
  }
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw new Error("director model returned no message");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("director model returned empty content");
  }
  return parseJsonFromText(sanitizeText(content));
}

/**
 * Pull the first JSON value out of a model output string. Supports a single
 * balanced ```json … ``` fence (strip + parse) and a prose-wrapped object
 * (first { to last }). Never evaluates anything — JSON.parse only.
 */
export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();

  // Balanced markdown fence, no other non-spacing content around it.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced !== null) {
    const inner = fenced[1];
    if (inner !== undefined) return JSON.parse(inner);
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("director model response contains no JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

/** Merge validated options into the finalized ConceptOption shape. */
export function mergeOptions(
  parsed: readonly ParsedConceptOption[],
  _expectedOptionCount: number,
): ConceptOption[] {
  return parsed.map((option, index) => ({
    optionId: `option_${index + 1}`,
    title: option.title,
    logline: option.logline,
    premise: option.premise,
    genre: option.genre,
    tone: option.tone,
    visualStyle: option.visualStyle,
    standoutMoments: option.standoutMoments,
    risks: option.risks,
    suggestedRuntimeSeconds: option.suggestedRuntimeSeconds,
    suggestedAspectRatio: option.suggestedAspectRatio,
    suggestedEpisodeCount: option.suggestedEpisodeCount,
    recommended: option.recommended,
  }));
}

/** The option the model marked recommended (contract guarantees exactly one). */
export function findRecommended(options: readonly ConceptOption[]): ConceptOption | undefined {
  return options.find((option) => option.recommended);
}

export { toSingleLine, containsNulByte };

export type { IdeaIntakeLike };
