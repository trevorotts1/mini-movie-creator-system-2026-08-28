/**
 * Screenplay generator — DIR-004 (acceptance: approved concept → screenplay via
 * writer-model interface; structured output; mocked-LLM test).
 *
 * Gate 1 enforcement (spec §3): "no screenplay work before approval." The
 * generator refuses any concept whose `approval.state` is not APPROVED —
 * before any model call, before any prompt is composed.
 *
 * Flow: validate gate → compose prompt (exact character count recorded, spec §6)
 * → call the injected WriterModelClient → parse strictly → stamp provenance.
 * No network code here: the live OpenRouter/9Router adapter implements
 * `WriterModelClient` separately; tests inject a mock.
 */

import { composeScreenplayPrompt, validateConceptShape } from "./prompt.js";
import { parseScreenplayResponse, parseWriterJson } from "./parse.js";
import {
  SCREENPLAY_SCHEMA_VERSION,
  type ApprovedConcept,
  type Screenplay,
} from "./types.js";
import { WriterModelError, type WriterModelClient } from "./writer-model.js";

/** Error thrown when screenplay generation is attempted on an unapproved concept. */
export class ConceptNotApprovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptNotApprovedError";
  }
}

/** Options for one generation run. */
export interface ScreenplayGeneratorOptions {
  /**
   * Reasoning effort for the writer model. Defaults to the logical
   * `MAX_REASONING` preference (runbook §28); the live adapter maps it to the
   * highest effort the endpoint supports.
   */
  reasoningEffort?: string | null;
  /** Sampling temperature; default 0.4 (deterministic-leaning creative). */
  temperature?: number;
  /** Routing slug of the writer model; default "mmcs-writer/default". */
  writerModelId?: string;
  /** Overrides the generated-at timestamp (tests inject a fixed clock). */
  now?: () => string;
}

const MAX_REASONING = "MAX_REASONING";

/**
 * Generate a structured screenplay from an APPROVED concept.
 *
 * @throws ConceptNotApprovedError when `concept.approval.state !== "APPROVED"`.
 * @throws WriterModelError when the writer client fails.
 * @throws ScreenplayParseError when the response violates the v1 contract.
 */
export async function generateScreenplay(
  concept: ApprovedConcept,
  writer: WriterModelClient,
  options: ScreenplayGeneratorOptions = {},
): Promise<Screenplay> {
  // Gate 1 — hard stop. Structural validation first (clear error), then the
  // approval check so an unapproved-but-malformed concept still fails on the
  // gate, not on shape.
  if (concept === null || typeof concept !== "object") {
    throw new ConceptNotApprovedError(
      "screenplay generation requires an approved concept record",
    );
  }
  if (concept.approval === undefined || concept.approval === null) {
    throw new ConceptNotApprovedError(
      `concept ${concept.conceptId ?? "(unknown)"} has no approval record; run the concept approval gate (gate 1) first`,
    );
  }
  if (concept.approval.state !== "APPROVED") {
    throw new ConceptNotApprovedError(
      `concept ${concept.conceptId ?? "(unknown)"} is ${concept.approval.state}; no screenplay work before concept approval (spec gate 1)`,
    );
  }
  validateConceptShape(concept);

  const messages = composeScreenplayPrompt(concept, {
    schemaVersion: SCREENPLAY_SCHEMA_VERSION,
  });
  const promptText = messages.map((m) => m.content).join("\n\n");
  const promptCharacterCount = promptText.length;

  const reasoningEffort =
    options.reasoningEffort === undefined
      ? "MAX_REASONING"
      : options.reasoningEffort;
  if (
    reasoningEffort !== null &&
    (typeof reasoningEffort !== "string" || reasoningEffort.trim() === "")
  ) {
    throw new WriterModelError(
      `reasoningEffort must be a non-empty string or null, got ${JSON.stringify(reasoningEffort)}`,
    );
  }
  const temperature = options.temperature ?? 0.4;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new WriterModelError(
      `temperature must be a finite number in [0, 2], got ${JSON.stringify(temperature)}`,
    );
  }
  const modelId = options.writerModelId ?? "mmcs-writer/default";

  let response;
  try {
    response = await writer.complete({
      messages,
      modelId,
      reasoningEffort,
      temperature,
    });
  } catch (error) {
    if (error instanceof WriterModelError) throw error;
    throw new WriterModelError(
      `writer model call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response === null || typeof response !== "object") {
    throw new WriterModelError(
      "writer model returned no response object",
    );
  }
  const responseText = response.text;
  if (typeof responseText !== "string") {
    throw new WriterModelError(
      "writer model response must carry a string `text` field",
    );
  }
  const writerModelId = response.modelId ?? modelId;
  const raw = parseWriterJson(responseText);

  const now = options.now ?? (() => new Date().toISOString());
  return parseScreenplayResponse(raw, {
    conceptId: concept.conceptId,
    writerModelId,
    reasoningEffort,
    promptCharacterCount,
    responseCharacterCount: responseText.length,
    generatedAt: now(),
    fallbackTitle: concept.title,
    fallbackLogline: concept.logline,
  });
}