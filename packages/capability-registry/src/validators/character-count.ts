/**
 * CAP-003 — Character-count validator.
 *
 * Counts compiled prompt characters exactly (UTF-16 code units — the same
 * convention KIE-006 uses for `WAN_MAX_PROMPT_CHARS`) and rejects prompts
 * over a model's documented hard max BEFORE any provider call is made.
 *
 * UNKNOWN hard max is VALID: when a capability record has
 * `prompt.hardMaxCharacters === null` (undocumented), this validator must
 * PASS at any size — it never invents a limit to fill the null (runbook:
 * "Never invent a hard Agnes prompt limit because another model has one").
 *
 * Pure, synchronous, side-effect-free: safe to run on the hot path ahead of
 * provider submission. Messages never embed prompt content.
 */

/**
 * A prompt input: either one compiled string or an ordered list of compiled
 * segments (prompt compilers may assemble prompts in parts). Segments are
 * concatenated in order before counting — no separators are injected, so the
 * count equals the characters a provider would actually receive.
 */
export type CompiledPrompt = string | readonly string[];

/** Stable violation codes — callers branch on these, not on message text. */
export type CharacterCountViolationCode = "PROMPT_TOO_LONG" | "INVALID_LIMIT";

/** One concrete character-count violation found in a request. */
export interface CharacterCountViolation {
  code: CharacterCountViolationCode;
  /** Dotted path of the offending field. */
  field: string;
  /** Human-readable, safe-to-log explanation (never embeds prompt content). */
  message: string;
}

/** A capability record fragment carrying the prompt hard max (CAP-002 shape). */
export interface PromptLimitSource {
  prompt: {
    /**
     * Documented hard character max, or null when undocumented (UNKNOWN).
     * null means the validator MUST pass at any size.
     */
    hardMaxCharacters: number | null;
  };
}

/** Input accepted by {@link validateCharacterCount}. */
export interface CharacterCountInput extends PromptLimitSource {
  prompt: PromptLimitSource["prompt"] & { value: CompiledPrompt };
}

/** Successful validation result. */
export interface CharacterCountPass {
  ok: true;
  /** Exact prompt length in UTF-16 code units. */
  charCount: number;
  violations: [];
  /** true when the limit was null/unknown and no check was enforced. */
  limitUnknown: boolean;
}

/** Failed validation result — the caller must not submit to the provider. */
export interface CharacterCountFail {
  ok: false;
  charCount: number;
  violations: [CharacterCountViolation, ...CharacterCountViolation[]];
  limitUnknown: boolean;
}

export type CharacterCountResult = CharacterCountPass | CharacterCountFail;

/**
 * Count compiled prompt characters exactly, in UTF-16 code units.
 *
 * String.length IS the UTF-16 code unit count, so this is exact and matches
 * what JavaScript-side provider SDKs would serialize. Accepts a single string
 * or an ordered segment list (joined without separators).
 */
export function countPromptCharacters(prompt: CompiledPrompt): number {
  if (typeof prompt === "string") return prompt.length;
  let total = 0;
  for (const segment of prompt) {
    total += segment.length;
  }
  return total;
}

/**
 * Validate a compiled prompt against a capability record's prompt hard max.
 *
 * - `hardMaxCharacters: null` (UNKNOWN) → pass with `limitUnknown: true`,
 *   regardless of size. Never invents a limit.
 * - Over the hard max (strictly greater — the boundary value itself is legal)
 *   → fail with `PROMPT_TOO_LONG`.
 * - A corrupt limit (non-finite / negative number) → fail with
 *   `INVALID_LIMIT` rather than silently passing or guessing a fallback.
 */
export function validateCharacterCount(
  input: CharacterCountInput,
): CharacterCountResult {
  const charCount = countPromptCharacters(input.prompt.value);
  const limit = input.prompt.hardMaxCharacters;

  // UNKNOWN hard max — documented as null. Pass at any size.
  if (limit === null || limit === undefined) {
    return { ok: true, charCount, violations: [], limitUnknown: true };
  }

  // Corrupt limit — refuse, never guess.
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return {
      ok: false,
      charCount,
      limitUnknown: false,
      violations: [
        {
          code: "INVALID_LIMIT",
          field: "prompt.hardMaxCharacters",
          message:
            "Capability record has a corrupt prompt.hardMaxCharacters (must be null or a finite non-negative number); refusing to guess a limit.",
        },
      ],
    };
  }

  if (charCount > limit) {
    return {
      ok: false,
      charCount,
      limitUnknown: false,
      violations: [
        {
          code: "PROMPT_TOO_LONG",
          field: "prompt.value",
          message: `Compiled prompt is ${charCount} characters (UTF-16 code units); provider hard max is ${limit}. Rejecting BEFORE the provider call.`,
        },
      ],
    };
  }

  return { ok: true, charCount, violations: [], limitUnknown: false };
}