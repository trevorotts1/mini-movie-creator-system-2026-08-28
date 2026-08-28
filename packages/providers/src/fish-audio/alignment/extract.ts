/**
 * Alignment extraction/normalization (FISH-006).
 *
 * Turns a raw provider alignment payload (FISH-001/003 hand-off) into the
 * canonical `FishDialogueAlignment` record: times normalized to integer
 * milliseconds, words sorted by start time, duration resolved, everything
 * validated. Throws on malformed input — never silently repairs timings
 * (a wrong caption beat is worse than a loud failure).
 *
 * The provider payload is UNTRUSTED data (spec §21): validated field by
 * field, never evaluated, never interpolated into executable context.
 */
import type {
  FishAlignedPhoneme,
  FishAlignedPhonemePayload,
  FishAlignedWord,
  FishAlignedWordPayload,
  FishAlignmentPayload,
  FishAlignmentTimeUnit,
  FishDialogueAlignment,
  FishDialogueAlignmentSource,
} from "./types.js";

/** Options for `extractAlignment`. */
export interface ExtractAlignmentOptions {
  /** Dialogue asset key (FISH-005 cache key) the payload belongs to. */
  key: string;
  /** Dialogue text to record; overrides `payload.text` when given. Callers
   * should pass the ORIGINAL script text (FISH-004: captions must align to
   * original text, not pronunciation-rewritten TTS text). */
  text?: string;
  /** Fish model that produced the audio. */
  model?: string;
  /** How the timings were obtained. Default "provider_response". */
  source?: FishDialogueAlignmentSource;
  /** Injectable clock for `extractedAt` (tests). */
  now?: () => Date;
}

const UNIT_TO_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  seconds: 1000,
};

/** True when `v` is a finite number (rejects NaN/Infinity from payloads). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Convert one time value from `unit` to integer milliseconds. */
function toMs(value: number, unit: FishAlignmentTimeUnit, field: string): number {
  const factor = UNIT_TO_MS[unit];
  if (factor === undefined) {
    throw new Error(`${field}: unsupported time unit ${JSON.stringify(unit)}`);
  }
  const ms = value * factor;
  const rounded = Math.round(ms);
  if (!isFiniteNumber(rounded)) {
    throw new Error(`${field} is not a finite time value`);
  }
  return rounded;
}

/** Validate + normalize one phoneme payload. */
function normalizePhoneme(
  raw: FishAlignedPhonemePayload,
  unit: FishAlignmentTimeUnit,
  path: string,
): FishAlignedPhoneme {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${path} must be an object`);
  }
  const phoneme = typeof raw.phoneme === "string" ? raw.phoneme.trim() : "";
  if (!phoneme) {
    throw new Error(`${path}.phoneme is required`);
  }
  if (!isFiniteNumber(raw.start) || !isFiniteNumber(raw.end)) {
    throw new Error(`${path}.start/.end must be finite numbers`);
  }
  const startMs = toMs(raw.start, unit, `${path}.start`);
  const endMs = toMs(raw.end, unit, `${path}.end`);
  if (endMs < startMs) {
    throw new Error(`${path}: end (${endMs}ms) is before start (${startMs}ms)`);
  }
  return { phoneme, startMs, endMs };
}

/** Validate + normalize one word payload. */
function normalizeWord(
  raw: FishAlignedWordPayload,
  unit: FishAlignmentTimeUnit,
  path: string,
): FishAlignedWord {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${path} must be an object`);
  }
  if (typeof raw.word !== "string" || raw.word.trim() === "") {
    throw new Error(`${path}.word is required`);
  }
  if (!isFiniteNumber(raw.start) || !isFiniteNumber(raw.end)) {
    throw new Error(`${path}.start/.end must be finite numbers`);
  }
  const startMs = toMs(raw.start, unit, `${path}.start`);
  const endMs = toMs(raw.end, unit, `${path}.end`);
  if (endMs < startMs) {
    throw new Error(`${path}: end (${endMs}ms) is before start (${startMs}ms)`);
  }
  const out: FishAlignedWord = { word: raw.word, startMs, endMs };
  if (raw.speaker !== undefined) {
    if (!Number.isInteger(raw.speaker) || raw.speaker < 0) {
      throw new Error(`${path}.speaker must be a non-negative integer`);
    }
    out.speaker = raw.speaker;
  }
  if (raw.phonemes !== undefined) {
    if (!Array.isArray(raw.phonemes)) {
      throw new Error(`${path}.phonemes must be an array`);
    }
    out.phonemes = raw.phonemes.map((p, i) =>
      normalizePhoneme(p, unit, `${path}.phonemes[${i}]`),
    );
  }
  return out;
}

/**
 * Validate + normalize a raw provider alignment payload into the canonical
 * record. Throws (never silently repairs) on malformed input.
 *
 * Normalization performed:
 * - all times converted to integer milliseconds (payload `timeUnit`);
 * - words sorted by `startMs` (ties by `endMs`, then input order — a stable
 *   sort so equal-timestamp words keep provider order);
 * - `durationMs` = payload `duration` when supplied (normalized, and never
 *   less than the last word end), otherwise the last word end.
 */
export function extractAlignment(
  payload: FishAlignmentPayload,
  options: ExtractAlignmentOptions,
): FishDialogueAlignment {
  if (!payload || typeof payload !== "object") {
    throw new Error("alignment payload must be an object");
  }
  const key = options.key?.trim();
  if (!key) {
    throw new Error("options.key is required");
  }
  const text =
    options.text !== undefined
      ? options.text
      : typeof payload.text === "string"
        ? payload.text
        : undefined;
  if (typeof text !== "string") {
    throw new Error("alignment text is required (options.text or payload.text)");
  }
  const unit: FishAlignmentTimeUnit = payload.timeUnit ?? "ms";
  if (!UNIT_TO_MS[unit]) {
    throw new Error(`alignment payload.timeUnit is unsupported: ${JSON.stringify(unit)}`);
  }
  if (!Array.isArray(payload.words)) {
    throw new Error("alignment payload.words must be an array");
  }
  const words = payload.words.map((w, i) => normalizeWord(w, unit, `words[${i}]`));

  // Stable sort by start, then end — equal words keep provider order.
  const indexed = words.map((w, i) => ({ w, i }));
  indexed.sort((a, b) => {
    if (a.w.startMs !== b.w.startMs) return a.w.startMs - b.w.startMs;
    if (a.w.endMs !== b.w.endMs) return a.w.endMs - b.w.endMs;
    return a.i - b.i;
  });
  const sorted = indexed.map((e) => e.w);

  const lastEnd = sorted.length > 0 ? sorted[sorted.length - 1]!.endMs : 0;
  let durationMs = lastEnd;
  if (payload.duration !== undefined) {
    if (!isFiniteNumber(payload.duration)) {
      throw new Error("alignment payload.duration must be a finite number");
    }
    const d = toMs(payload.duration, unit, "payload.duration");
    if (d < lastEnd) {
      throw new Error(
        `alignment payload.duration (${d}ms) is less than the last word end (${lastEnd}ms)`,
      );
    }
    durationMs = d;
  }

  const source = options.source ?? "provider_response";
  const extractedAt = (options.now ?? (() => new Date()))().toISOString();

  const alignment: FishDialogueAlignment = {
    key,
    text,
    ...(options.model !== undefined ? { model: options.model } : {}),
    source,
    words: sorted,
    durationMs,
    extractedAt,
  };
  return alignment;
}