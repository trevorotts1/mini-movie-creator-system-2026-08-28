/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal dotenv-style .env reader for the repo root.
 *
 * Loads `KEY=VALUE` lines into a plain record. Never logs file contents or
 * values; never writes to process.env implicitly — the caller decides.
 * Supports: comments (#), blank lines, optional `export ` prefix, single- and
 * double-quoted values, inline comments outside quotes.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    let statement = line;
    if (statement.startsWith("export ")) statement = statement.slice("export ".length).trim();

    const eq = statement.indexOf("=");
    if (eq <= 0) continue; // no separator, or empty key — skip silently

    const key = statement.slice(0, eq).trim();
    let value = statement.slice(eq + 1).trim();

    const first = value[0];
    const last = value[value.length - 1];
    if (
      value.length >= 2 &&
      first !== undefined &&
      last !== undefined &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Inline comment on an unquoted value: KEY=value # explanation
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    if (key !== "") result[key] = value;
  }
  return result;
}

/**
 * Locate the repo-root .env by walking up from `startDir`.
 * Returns null when absent (callers treat that as "no file overrides").
 */
export function findEnvFile(startDir: string, filename = ".env"): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load .env entries from `envPath` if it exists. Returns a record suitable for
 * merging UNDER process.env (real environment always wins over file values).
 */
export function loadEnvFile(envPath: string | null): Record<string, string> {
  if (envPath === null || !existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    // Unreadable .env must never crash startup; validation will surface the
    // resulting missing variables by name instead.
    return {};
  }
}