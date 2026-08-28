/**
 * Concept-response parser — DIR-002.
 *
 * The director model's raw JSON text is UNTRUSTED DATA (spec §29): it is
 * parsed defensively, length-bounded, control-character-sanitized, and never
 * evaluated, interpolated into code, or re-interpreted as instructions.
 * Contract violations become {@linkcode ResponseValidationError} with
 * value-free messages — the raw model output never lands in an exception
 * string or log line.
 */

import { CONCEPT_FIELD_LIMITS } from "./types.js";

/** A single suspicious token found in untrusted text. */
export interface SuspiciousToken {
  readonly index: number;
  readonly pattern: string;
}

/** Result of a shallow untrusted-text scan. Always defined, never thrown. */
export interface ResponseScanReport {
  readonly unsafe: boolean;
  readonly tokens: readonly SuspiciousToken[];
}

/** Fail-closed contract violations; message never embeds model output. */
export type ResponseViolationCode =
  | "NOT_OBJECT"
  | "NOT_ARRAY"
  | "EMPTY_OPTIONS"
  | "TOO_MANY_OPTIONS"
  | "FIELD_NOT_STRING"
  | "FIELD_TOO_LONG"
  | "LIST_ITEM_NOT_STRING"
  | "LIST_TOO_LONG"
  | "LIST_ITEM_TOO_LONG"
  | "NUMERIC_FIELD_INVALID"
  | "NO_RECOMMENDED";

export interface ResponseViolation {
  /** Option index, or 0 for root-level violations. */
  readonly index: number;
  readonly field: string;
  readonly code: ResponseViolationCode;
  /** Human-readable explanation; safe to log. */
  readonly message: string;
}

/** Thrown when the model response does not match the contract. Value-free. */
export class ResponseValidationError extends Error {
  readonly violations: readonly ResponseViolation[];

  constructor(violations: readonly ResponseViolation[]) {
    const first = violations[0];
    const detail =
      first === undefined ? "no violations" : `at option ${first.index}: ${first.message}`;
    super(`invalid director-model response (${detail})`);
    this.name = "ResponseValidationError";
    this.violations = violations;
  }
}

/** Public parsed option (before FINALIZED merge). */
export interface ParsedConceptOption {
  readonly index: number;
  readonly title: string;
  readonly logline: string;
  readonly premise: string;
  readonly genre: string | null;
  readonly tone: string | null;
  readonly visualStyle: string | null;
  readonly standoutMoments: readonly string[];
  readonly risks: readonly string[];
  readonly recommended: boolean;
  readonly suggestedRuntimeSeconds: number | null;
  readonly suggestedAspectRatio: string | null;
  readonly suggestedEpisodeCount: number | null;
}

/** Internal parsed response: options + model notes + violation list. */
export interface InternalParsedResponse {
  readonly options: readonly ParsedConceptOption[];
  readonly modelNotes: string | null;
  readonly violations: readonly ResponseViolation[];
}

export interface ParseResponseOptions {
  /** Exact option count the prompt requested. */
  readonly expectedOptionCount: number;
  readonly minOptionCount?: number;
  readonly maxOptionCount?: number;
}

/** Shallow scan of untrusted text for instruction-smuggling patterns. */
export function scanTextForInjection(text: string): ResponseScanReport {
  const needles = [
    "ignore previous",
    "ignore all previous",
    "system prompt",
    "you are now",
    "sudo ",
    "rm -rf",
    "shell command",
    "run this",
    "execute this",
    "/bin/sh",
    "bash -c",
    "powershell",
    "disable all",
    "developer message",
    "peek at",
  ];
  const found: SuspiciousToken[] = [];
  for (const needle of needles) {
    const at = text.toLowerCase().indexOf(needle);
    if (at >= 0) found.push({ index: at, pattern: needle });
  }
  return { unsafe: found.length > 0, tokens: found };
}

const NUMERIC_STRING_PATTERN = /^[+-]?[0-9]+$/;

/** Parse a nullable numeric field; string numbers accepted. Never lets NaN through. */
function readNullableNumber(
  raw: unknown,
  min: number,
  max: number,
  violations: ResponseViolation[],
  index: number,
  field: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && NUMERIC_STRING_PATTERN.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    violations.push({
      index,
      field,
      code: "NUMERIC_FIELD_INVALID",
      message: `${field} must be a finite number`,
    });
    return null;
  }
  if (!Number.isFinite(value)) {
    violations.push({
      index,
      field,
      code: "NUMERIC_FIELD_INVALID",
      message: `${field} must be a finite number`,
    });
    return null;
  }
  // Clamp into the numeric window rather than failing the whole response:
  // an off-by-one runtime suggestion is a soft defect, not a rejection.
  return Math.min(Math.max(value, min), max);
}

interface RawOptionFields {
  title: string | null;
  logline: string | null;
  premise: string | null;
  genre: string | null;
  tone: string | null;
  visualStyle: string | null;
  standoutMoments: readonly string[];
  risks: readonly string[];
  recommended: boolean;
  suggestedRuntimeSeconds: number | null;
  suggestedAspectRatio: string | null;
  suggestedEpisodeCount: number | null;
}

/** Read one raw option object; missing soft fields default, hard fields fail closed. */
function readOptionFields(
  raw: Record<string, unknown>,
  index: number,
  violations: ResponseViolation[],
): RawOptionFields {
  const stringFields = [
    { key: "title", max: CONCEPT_FIELD_LIMITS.title, required: true },
    { key: "logline", max: CONCEPT_FIELD_LIMITS.logline, required: true },
    { key: "premise", max: CONCEPT_FIELD_LIMITS.premise, required: true },
    { key: "genre", max: CONCEPT_FIELD_LIMITS.descriptor, required: false },
    { key: "tone", max: CONCEPT_FIELD_LIMITS.descriptor, required: false },
    { key: "visualStyle", max: CONCEPT_FIELD_LIMITS.descriptor, required: false },
  ] as const;

  const fields: RawOptionFields = {
    title: null,
    logline: null,
    premise: null,
    genre: null,
    tone: null,
    visualStyle: null,
    standoutMoments: [],
    risks: [],
    recommended: raw.recommended === true,
    suggestedRuntimeSeconds: null,
    suggestedAspectRatio: null,
    suggestedEpisodeCount: null,
  };

  for (const spec of stringFields) {
    const value = raw[spec.key];
    if (value === undefined || value === null) {
      if (spec.required) {
        violations.push({
          index,
          field: spec.key,
          code: "FIELD_NOT_STRING",
          message: `${spec.key} is required`,
        });
      }
      continue;
    }
    if (typeof value !== "string") {
      violations.push({
        index,
        field: spec.key,
        code: "FIELD_NOT_STRING",
        message: `${spec.key} must be a string`,
      });
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (spec.required) {
        violations.push({
          index,
          field: spec.key,
          code: "FIELD_NOT_STRING",
          message: `${spec.key} must not be empty`,
        });
      }
      continue;
    }
    if (trimmed.length > spec.max) {
      violations.push({
        index,
        field: spec.key,
        code: "FIELD_TOO_LONG",
        message: `${spec.key} exceeds ${spec.max} characters`,
      });
      continue;
    }
    fields[spec.key] = trimmed;
  }

  const listFields = [
    { key: "standoutMoments", max: CONCEPT_FIELD_LIMITS.listItems },
    { key: "risks", max: CONCEPT_FIELD_LIMITS.listItems },
  ] as const;
  for (const spec of listFields) {
    const value = raw[spec.key];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      violations.push({
        index,
        field: spec.key,
        code: "LIST_ITEM_NOT_STRING",
        message: `${spec.key} must be an array of strings`,
      });
      continue;
    }
    if (value.length > spec.max) {
      violations.push({
        index,
        field: spec.key,
        code: "LIST_TOO_LONG",
        message: `${spec.key} exceeds ${spec.max} items`,
      });
    }
    const items: string[] = [];
    for (const item of value.slice(0, spec.max)) {
      if (typeof item !== "string") {
        violations.push({
          index,
          field: spec.key,
          code: "LIST_ITEM_NOT_STRING",
          message: `${spec.key} items must be strings`,
        });
        continue;
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length > CONCEPT_FIELD_LIMITS.listItem) {
        violations.push({
          index,
          field: spec.key,
          code: "LIST_ITEM_TOO_LONG",
          message: `${spec.key} item exceeds ${CONCEPT_FIELD_LIMITS.listItem} characters`,
        });
        continue;
      }
      items.push(trimmed);
    }
    fields[spec.key] = items;
  }

  fields.suggestedRuntimeSeconds = readNullableNumber(
    raw.suggestedRuntimeSeconds,
    30,
    14_400,
    violations,
    index,
    "suggestedRuntimeSeconds",
  );
  fields.suggestedEpisodeCount = readNullableNumber(
    raw.suggestedEpisodeCount,
    1,
    1_000,
    violations,
    index,
    "suggestedEpisodeCount",
  );
  const aspect = raw.suggestedAspectRatio;
  if (typeof aspect === "string" && aspect.trim().length > 0) {
    const trimmed = aspect.trim();
    if (trimmed.length <= 32) fields.suggestedAspectRatio = trimmed;
  }

  return fields;
}

/**
 * Parse + validate the director model's JSON response. Returns violations
 * instead of throwing; `assertValidConceptResponse` fails closed on any.
 */
export function parseConceptResponseBody(
  body: unknown,
  options: ParseResponseOptions,
): InternalParsedResponse {
  const min = options.minOptionCount ?? options.expectedOptionCount;
  const max = options.maxOptionCount ?? options.expectedOptionCount;
  const violations: ResponseViolation[] = [];

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    violations.push({
      index: 0,
      field: "root",
      code: "NOT_OBJECT",
      message: "response must be a JSON object",
    });
    return { options: [], modelNotes: null, violations };
  }

  const obj = body as Record<string, unknown>;
  const rawOptions = obj.options;
  if (!Array.isArray(rawOptions)) {
    violations.push({
      index: 0,
      field: "options",
      code: "NOT_ARRAY",
      message: "options must be an array",
    });
    return { options: [], modelNotes: null, violations };
  }
  if (rawOptions.length === 0) {
    violations.push({
      index: 0,
      field: "options",
      code: "EMPTY_OPTIONS",
      message: "at least one option is required",
    });
  }
  if (rawOptions.length < min) {
    violations.push({
      index: 0,
      field: "options",
      code: "EMPTY_OPTIONS",
      message: `expected at least ${min} options, got ${rawOptions.length}`,
    });
  }
  if (rawOptions.length > max) {
    violations.push({
      index: 0,
      field: "options",
      code: "TOO_MANY_OPTIONS",
      message: `expected at most ${max} options, got ${rawOptions.length}`,
    });
  }

  const parsedOptions: ParsedConceptOption[] = [];
  for (let i = 0; i < rawOptions.length; i += 1) {
    const raw = rawOptions[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      violations.push({
        index: i,
        field: "option",
        code: "NOT_OBJECT",
        message: "each option must be an object",
      });
      continue;
    }
    const fields = readOptionFields(raw as Record<string, unknown>, i, violations);
    const trulyMissing =
      fields.title === null && fields.logline === null && fields.premise === null;
    if (trulyMissing) {
      violations.push({
        index: i,
        field: "option",
        code: "NOT_OBJECT",
        message: "option is missing required fields",
      });
      continue;
    }
    parsedOptions.push({
      index: i,
      title: fields.title ?? "",
      logline: fields.logline ?? "",
      premise: fields.premise ?? "",
      genre: fields.genre,
      tone: fields.tone,
      visualStyle: fields.visualStyle,
      standoutMoments: fields.standoutMoments,
      risks: fields.risks,
      recommended: fields.recommended,
      suggestedRuntimeSeconds: fields.suggestedRuntimeSeconds,
      suggestedAspectRatio: fields.suggestedAspectRatio,
      suggestedEpisodeCount: fields.suggestedEpisodeCount,
    });
  }

  const recommendedCount = parsedOptions.filter((option) => option.recommended).length;
  if (recommendedCount === 0) {
    violations.push({
      index: 0,
      field: "options",
      code: "NO_RECOMMENDED",
      message: "no option is marked recommended",
    });
  } else if (recommendedCount > 1) {
    violations.push({
      index: 0,
      field: "options",
      code: "NO_RECOMMENDED",
      message: "more than one option is marked recommended",
    });
  }

  let modelNotes: string | null = null;
  const rawNotes = obj.modelNotes;
  if (typeof rawNotes === "string" && rawNotes.trim().length > 0) {
    const trimmed = rawNotes.trim();
    if (trimmed.length > CONCEPT_FIELD_LIMITS.descriptor) {
      violations.push({
        index: 0,
        field: "modelNotes",
        code: "FIELD_TOO_LONG",
        message: `modelNotes exceeds ${CONCEPT_FIELD_LIMITS.descriptor} characters`,
      });
    } else {
      modelNotes = trimmed;
    }
  }

  return { options: parsedOptions, modelNotes, violations };
}

/** Fails closed: any violation throws {@linkcode ResponseValidationError}. */
export function assertValidConceptResponse(
  body: unknown,
  options: ParseResponseOptions,
): InternalParsedResponse {
  const parsed = parseConceptResponseBody(body, options);
  if (parsed.violations.length > 0) {
    throw new ResponseValidationError(parsed.violations);
  }
  return parsed;
}
