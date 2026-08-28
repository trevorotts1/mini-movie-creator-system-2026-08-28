import { randomBytes } from "node:crypto";
import { BaseRepository } from "../base.js";

/**
 * Generate an MMCS row id: `mmcs_` + 16 random bytes hex. ULID-style
 * sorting is not required (rows carry explicit created_at), so plain
 * random ids keep the format dependency-free.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** Validate an aspect-ratio string like "16:9", "9:16", "2.39:1". */
export function isValidAspectRatio(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) {
    return false;
  }
  const parts = value.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [w, h] = parts as [string, string];
  const dimension = /^\d{1,5}(\.\d{1,3})?$/; // decimals allowed for cinematic ratios (e.g. 2.39)
  return dimension.test(w) && dimension.test(h) && Number(w) > 0 && Number(h) > 0;
}

export class ValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** Shared connection + validation helpers for the CORE-004 repositories. */
export abstract class SchemaRepository extends BaseRepository {
  protected requireAspectRatio(field: string, value: string | undefined | null, fallback: string): string {
    const effective = value ?? fallback;
    if (!isValidAspectRatio(effective)) {
      throw new ValidationError(field, `invalid aspect ratio "${String(effective)}" (expected "w:h", e.g. "16:9")`);
    }
    return effective;
  }

  protected requireText(field: string, value: string | undefined, maxLen: number): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ValidationError(field, "must be a non-empty string");
    }
    if (value.length > maxLen) {
      throw new ValidationError(field, `exceeds ${maxLen} characters`);
    }
    return value;
  }

  protected requireInt(field: string, value: number | undefined, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ValidationError(field, `must be an integer between ${min} and ${max}`);
    }
    return value;
  }
}