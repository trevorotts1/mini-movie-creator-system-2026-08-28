/**
 * Writer-model interface — DIR-004 (spec §14: "Separate user selection for:
 * director model; writer model; script critic; ..."; runbook §28 registry).
 *
 * The writer model is pluggable: any implementation of `WriterModelClient`
 * works — a live OpenRouter/9Router client, or the test fake. The generator
 * NEVER calls a network itself; it only composes the prompt and parses the
 * client's response. This is the mocked-LLM seam the acceptance test uses.
 *
 * Pre-request validation (spec §5 order) is the client's responsibility for
 * its own endpoint; the generator contributes the exact prompt character
 * count (§6 doctrine: count actual characters) into the metadata record.
 */

/** A single chat-style message to the writer model. */
export interface WriterModelMessage {
  role: "system" | "user";
  content: string;
}

/** Request sent to the writer model. */
export interface WriterModelRequest {
  /** Messages in order; the last is the user prompt with the approved concept. */
  messages: readonly WriterModelMessage[];
  /** Routing slug of the writer model (e.g. OpenRouter model id). */
  modelId: string;
  /**
   * Reasoning effort for the request. `MAX_REASONING` is a logical preference
   * (runbook §28): the live adapter maps it to the highest effort the endpoint
   * supports — never the literal string "max" unless the endpoint accepts it.
   * Null = no effort knob for this model.
   */
  reasoningEffort: string | null;
  /** Deterministic sampling temperature; the writer uses a low temperature. */
  temperature: number;
}

/** Raw text response from the writer model. */
export interface WriterModelResponse {
  /** The full completion text. Expected to contain the screenplay JSON. */
  text: string;
  /** Routing slug echoed back for provenance (defaults to request.modelId). */
  modelId?: string;
}

/** Transport interface for the writer model (mock in tests, live in prod). */
export interface WriterModelClient {
  complete(request: WriterModelRequest): Promise<WriterModelResponse>;
}

/** Error thrown when the writer call itself fails (non-2xx, timeout, ...). */
export class WriterModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterModelError";
  }
}