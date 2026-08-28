/**
 * CAP-005 — Mutually-exclusive-mode validator (capability-registry).
 *
 * Generic pre-flight check that a generation request's input modes do not
 * combine modes the capability profile declares incompatible. Runbook §16
 * pre-request validation step: "validate mutually exclusive modes" before
 * any provider call.
 *
 * Two layers of rules:
 *   1. HARD RULE (provider-documented, profile-independent): first/last-frame
 *      inputs can NEVER be combined with multimodal reference inputs. This is
 *      the Wan 3.0 constraint (runbook §26.4, Kie docs: first/last-frame and
 *      multimodal-reference scenarios "cannot be used simultaneously") and it
 *      holds for Seedance 2.0 Mini as well (KIE-004, docs.kie.ai
 *      2026-08-28). Enforced even when a profile's incompatibleCombinations
 *      list is empty, because it is a provider fact, not a per-profile
 *      preference.
 *   2. GENERIC RULE: each entry of the profile's
 *      `references.incompatibleCombinations` is a "+"-joined list of mode
 *      keys (e.g. "referenceVideos+referenceAudio"); a request is rejected
 *      when two or more DISTINCT modes named by any single entry are active
 *      at once. Malformed entries (unknown tokens, fewer than two distinct
 *      modes) are themselves reported so bad capability data surfaces before
 *      a paid call instead of silently passing.
 *
 * Pure module — no I/O, no fetch. The registry (CAP-001/CAP-002) supplies
 * profiles; adapters call this right before submission.
 */

/**
 * Canonical mode keys a request can activate. Kept provider-neutral so any
 * capability profile in the registry (Agnes, Seedance, Wan, future image
 * models) expresses incompatibilities with the same vocabulary.
 */
export type ExclusiveModeKey =
  | "firstFrame"
  | "lastFrame"
  | "firstLastFrame"
  | "multimodalReferences"
  | "referenceVideos"
  | "referenceAudio";

/** All mode keys, in canonical order (tests/errors iterate deterministically). */
export const EXCLUSIVE_MODE_KEYS: readonly ExclusiveModeKey[] = [
  "firstFrame",
  "lastFrame",
  "firstLastFrame",
  "multimodalReferences",
  "referenceVideos",
  "referenceAudio",
] as const;

/** Separator used inside an incompatibleCombinations entry. */
export const INCOMPATIBLE_COMBINATION_SEPARATOR = "+";

/** The provider-documented frame-vs-references conflicts, always enforced. */
export const FRAME_VS_REFERENCES_CONFLICTS: readonly (readonly [
  ExclusiveModeKey,
  ExclusiveModeKey,
])[] = [
  ["firstFrame", "multimodalReferences"],
  ["firstFrame", "referenceVideos"],
  ["firstFrame", "referenceAudio"],
  ["lastFrame", "multimodalReferences"],
  ["lastFrame", "referenceVideos"],
  ["lastFrame", "referenceAudio"],
  ["firstLastFrame", "multimodalReferences"],
  ["firstLastFrame", "referenceVideos"],
  ["firstLastFrame", "referenceAudio"],
] as const;

/** True when the key names a first/last-frame input mode. */
export function isFrameMode(key: ExclusiveModeKey): boolean {
  return (
    key === "firstFrame" || key === "lastFrame" || key === "firstLastFrame"
  );
}

/** True when the key names a multimodal-reference input mode. */
export function isReferenceMode(key: ExclusiveModeKey): boolean {
  return !isFrameMode(key);
}

/**
 * The subset of a capability profile this validator reads. Structural — any
 * full MediaModelCapability (CAP-001 schema, where the field is
 * `string[] | null`) satisfies it, so callers pass registry entries directly
 * without a conversion step.
 */
export interface ExclusiveModeCapability {
  references: {
    /**
     * "+"-joined mode keys that cannot be combined, e.g.
     * "referenceVideos+referenceAudio". null (CAP-001 UNKNOWN) is accepted and
     * treated as "no declared combinations" — the hard frame-vs-references
     * rule still applies.
     */
    incompatibleCombinations: readonly string[] | null;
  };
}

/**
 * The raw input fields a video request may carry. Field names match the
 * provider-agnostic shot request shape; empty strings and empty arrays are
 * treated as absent.
 */
export interface ModeInputs {
  /** Exact starting frame. Frame mode. */
  firstFrameUrl?: string;
  /** Exact ending frame (requires a first frame). Frame mode. */
  lastFrameUrl?: string;
  /** Multimodal reference images. Reference mode. */
  referenceImageUrls?: readonly string[];
  /** Multimodal reference videos. Reference mode. */
  referenceVideoUrls?: readonly string[];
  /** Multimodal reference audio. Reference mode. */
  referenceAudioUrls?: readonly string[];
}

/** A single validation defect. Message names the fields and the violated rule. */
export interface ExclusiveModeIssue {
  /** Request field (or "incompatibleCombinations" for capability-data defects). */
  field: string;
  /** Machine-readable rule identifier (stable for downstream tests/routing). */
  code: ExclusiveModeIssueCode;
  /** Human-readable explanation; safe to log. */
  message: string;
}

/** Stable issue codes (stable for downstream tests/routing). */
export type ExclusiveModeIssueCode =
  | "MUTUALLY_EXCLUSIVE_MODES"
  | "INVALID_INCOMPATIBLE_COMBINATION";

/** True when a string input field is present and non-blank. */
function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when an array input field has at least one entry. */
function hasEntries(value: readonly string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Which modes the request's input fields activate. firstLastFrame activates
 * only when BOTH frame fields are present; a lone lastFrameUrl activates
 * lastFrame alone (its own legality is a per-model question, not this
 * validator's — only exclusivity is enforced here).
 */
export function activeModes(inputs: ModeInputs): ReadonlySet<ExclusiveModeKey> {
  const active = new Set<ExclusiveModeKey>();
  const first = isPresent(inputs.firstFrameUrl);
  const last = isPresent(inputs.lastFrameUrl);
  if (first) active.add("firstFrame");
  if (last) active.add("lastFrame");
  if (first && last) active.add("firstLastFrame");
  if (hasEntries(inputs.referenceImageUrls)) active.add("multimodalReferences");
  if (hasEntries(inputs.referenceVideoUrls)) active.add("referenceVideos");
  if (hasEntries(inputs.referenceAudioUrls)) active.add("referenceAudio");
  return active;
}

/**
 * Parse one incompatibleCombinations entry into its distinct mode keys.
 * Returns null when the entry is malformed: an unknown token, or fewer than
 * two DISTINCT modes (a combination needs at least two different modes to
 * constrain anything).
 */
export function parseIncompatibleCombination(
  entry: string,
): readonly ExclusiveModeKey[] | null {
  const tokens = entry
    .split(INCOMPATIBLE_COMBINATION_SEPARATOR)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const keys: ExclusiveModeKey[] = [];
  for (const token of tokens) {
    const key = (EXCLUSIVE_MODE_KEYS as readonly string[]).includes(token)
      ? (token as ExclusiveModeKey)
      : null;
    if (key === null) return null;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.length >= 2 ? keys : null;
}

/** Collect every exclusivity violation for one request against one profile. */
export function validateExclusiveModes(
  capability: ExclusiveModeCapability,
  inputs: ModeInputs,
): readonly ExclusiveModeIssue[] {
  const issues: ExclusiveModeIssue[] = [];
  const active = activeModes(inputs);

  // 1. Hard rule: any frame mode combined with any reference mode.
  for (const [frameKey, referenceKey] of FRAME_VS_REFERENCES_CONFLICTS) {
    if (active.has(frameKey) && active.has(referenceKey)) {
      issues.push({
        field: "mode",
        code: "MUTUALLY_EXCLUSIVE_MODES",
        message: `${frameKey} input(s) cannot be combined with ${referenceKey} input(s) — first/last-frame and multimodal-reference are separate generation modes; pick one`,
      });
      break; // one hard-rule issue covers every frame/reference mix present
    }
  }

  // 2. Generic rule: every declared combination is checked against the
  //    active set; malformed entries are reported as capability-data defects.
  const entries = capability?.references?.incompatibleCombinations ?? [];
  for (const entry of entries) {
    const modes = parseIncompatibleCombination(entry);
    if (modes === null) {
      issues.push({
        field: "incompatibleCombinations",
        code: "INVALID_INCOMPATIBLE_COMBINATION",
        message: `incompatibleCombinations entry "${entry}" is malformed — expected two or more distinct "+"-joined mode keys from: ${EXCLUSIVE_MODE_KEYS.join(", ")}`,
      });
      continue;
    }
    const activeInCombination = modes.filter((mode) => active.has(mode));
    if (activeInCombination.length >= 2) {
      issues.push({
        field: "mode",
        code: "MUTUALLY_EXCLUSIVE_MODES",
        message: `${entry} declares mutually exclusive modes but the request activates ${activeInCombination.join(" + ")} — remove all but one`,
      });
    }
  }

  return issues;
}

/** Thrown by {@link assertExclusiveModes} on any pre-flight failure. */
export class ExclusiveModeValidationError extends Error {
  readonly issues: readonly ExclusiveModeIssue[];
  constructor(issues: readonly ExclusiveModeIssue[]) {
    super(`generation request failed mutually-exclusive-mode validation (${issues.length} issue(s)): ${issues
      .map((issue) => `[${issue.code}] ${issue.field}: ${issue.message}`)
      .join("; ")}`);
    this.name = "ExclusiveModeValidationError";
    this.issues = issues;
  }
}

/**
 * Validate or throw. Adapters call this right before payload submission;
 * callers wanting soft handling use {@link validateExclusiveModes} directly.
 */
export function assertExclusiveModes(
  capability: ExclusiveModeCapability,
  inputs: ModeInputs,
): void {
  const issues = validateExclusiveModes(capability, inputs);
  if (issues.length > 0) throw new ExclusiveModeValidationError(issues);
}