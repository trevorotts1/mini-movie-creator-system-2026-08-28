/**
 * Untrusted-data handling for the concept pipeline (spec §29; same doctrine
 * as DIR-001 intake sanitize — mirrored locally until intake merges to
 * integration).
 *
 * Idea text and raw model output are UNTRUSTED DATA — never interpreted as
 * shell, tool or prompt instructions. Rules:
 * 1. sanitize — strip C0/C1 control characters (except \n \r \t) so nothing
 *    downstream can smuggle terminal/protocol sequences; reject NUL outright;
 * 2. preserve — everything else survives verbatim, INCLUDING text that looks
 *    like instructions ("ignore previous instructions…"). It is data: it
 *    validates, it is stored, it is never executed;
 * 3. bound — length caps before anything downstream sees the text.
 */

/** Control characters removed by {@linkcode sanitizeText} (C0 minus \n\r\t, plus C1). */
const CONTROL_CHARS_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
  "g",
);

/** True when the text contains a NUL byte — rejected, never stripped silently. */
export function containsNulByte(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * Strip control characters (except \n, \r, \t) from untrusted text.
 * Trimmed ends. Instruction-shaped content survives untouched — it is data.
 */
export function sanitizeText(text: string): string {
  return text.replace(CONTROL_CHARS_PATTERN, "").trim();
}

/**
 * Normalize untrusted text for storage metadata only: control chars stripped
 * AND line breaks collapsed so a multi-line injection attempt can never break
 * out of a single-line metadata field. Never used as instructions.
 */
export function toSingleLine(text: string): string {
  return text.replace(CONTROL_CHARS_PATTERN, "").replace(/\s+/g, " ").trim();
}