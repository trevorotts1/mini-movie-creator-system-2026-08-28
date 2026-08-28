/// <reference types="node" />
import { randomBytes } from "node:crypto";

import { isValidAspectRatio } from "./aspect-ratio.js";
import { containsNulByte, sanitizeIdeaText } from "./sanitize.js";
import {
  IDEA_TEXT_MAX_LENGTH,
  IDEA_TEXT_MIN_LENGTH,
  RUNTIME_MAX_SECONDS,
  RUNTIME_MIN_SECONDS,
  SERIES_LINK_MAX_LENGTH,
  type IdeaIntake,
  type IdeaIntakeInput,
} from "./types.js";

/**
 * Validate and normalize an idea intake record (spec §24 "collect idea +
 * aspect ratio/runtime", §23 master format, §25 series linkage).
 *
 * Every field of the record is always present on the result — optional
 * inputs normalize to explicit `null` rather than missing keys. Throws
 * {@linkcode IntakeValidationError} naming the offending field; the error
 * message never embeds the idea text itself (untrusted data stays out of
 * exception strings and logs — spec §29).
 */
export function parseIntake(input: IdeaIntakeInput): IdeaIntake {
  const rawText = requireRawText(input.rawText);
  const aspectRatio = requireAspectRatio(input.aspectRatio);
  const targetRuntimeSeconds = requireRuntime(input.targetRuntimeSeconds);
  const seriesLink = requireSeriesLink(input.seriesLink);
  const createdAt = requireCreatedAt(input.createdAt);

  return {
    intakeId: input.intakeId ?? newIntakeId(),
    rawText,
    aspectRatio,
    targetRuntimeSeconds,
    seriesLink,
    createdAt,
  };
}

/** Generate a stable intake business ID (`idea_` + 16 random bytes hex). */
export function newIntakeId(): string {
  return `idea_${randomBytes(16).toString("hex")}`;
}

/**
 * Validate + sanitize the raw idea text. Sanitization strips control
 * characters only; the prose (including any instruction-shaped content) is
 * preserved verbatim — it is data, never a command (spec §29).
 */
function requireRawText(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntakeValidationError("rawText", "must be a string");
  }
  if (containsNulByte(value)) {
    throw new IntakeValidationError("rawText", "contains a NUL byte");
  }
  const text = sanitizeIdeaText(value);
  if (text.length < IDEA_TEXT_MIN_LENGTH) {
    throw new IntakeValidationError("rawText", "must not be empty");
  }
  if (text.length > IDEA_TEXT_MAX_LENGTH) {
    throw new IntakeValidationError(
      "rawText",
      `exceeds ${IDEA_TEXT_MAX_LENGTH} characters`,
    );
  }
  return text;
}

function requireAspectRatio(value: unknown): string {
  const effective = value ?? "16:9"; // spec §23 recommended default
  if (typeof effective !== "string" || !isValidAspectRatio(effective)) {
    throw new IntakeValidationError(
      "aspectRatio",
      `invalid aspect ratio (expected "w:h", e.g. "16:9")`,
    );
  }
  return effective;
}

function requireRuntime(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new IntakeValidationError("targetRuntimeSeconds", "must be an integer number of seconds");
  }
  if (value < RUNTIME_MIN_SECONDS || value > RUNTIME_MAX_SECONDS) {
    throw new IntakeValidationError(
      "targetRuntimeSeconds",
      `must be between ${RUNTIME_MIN_SECONDS} and ${RUNTIME_MAX_SECONDS} seconds`,
    );
  }
  return value;
}

/**
 * The series link is an opaque ID (`ser_…` from the CORE-004 repository).
 * Shape-checked only — never parsed, never used as a path or command.
 * Null = standalone movie (spec §25 projects kind).
 */
function requireSeriesLink(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IntakeValidationError("seriesLink", "must be a non-empty string or null");
  }
  if (value.length > SERIES_LINK_MAX_LENGTH) {
    throw new IntakeValidationError("seriesLink", `exceeds ${SERIES_LINK_MAX_LENGTH} characters`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new IntakeValidationError("seriesLink", "must not contain control characters");
  }
  if (/\s/.test(value)) {
    throw new IntakeValidationError("seriesLink", "must not contain whitespace");
  }
  return value;
}

function requireCreatedAt(value: unknown): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new IntakeValidationError("createdAt", "must be an ISO-8601 timestamp string");
  }
  return value;
}

/** Thrown when an intake field fails validation; names the field, never the idea text. */
export class IntakeValidationError extends Error {
  /** The offending field name (e.g. "aspectRatio"). */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "IntakeValidationError";
    this.field = field;
  }
}