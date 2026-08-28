/// <reference types="node" />
/**
 * Minimal PATH lookup for a binary (avoids pulling the `which` npm package
 * into the runtime dependency graph). Mirrors the classic `which(1)` rules:
 * absolute/relative paths with a separator are used as-is; bare names are
 * searched through every `PATH` entry, honoring `PATHEXT`-free POSIX behavior.
 */
import { access, constants } from "node:fs/promises";

/** Returns the executable path found on PATH, or `null`. */
export async function which(name: string): Promise<string | null> {
  if (!name || name.trim() === "") return null;
  if (name.includes("/")) {
    try {
      await access(name, constants.F_OK | constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = `${dir}/${name}`;
    try {
      await access(candidate, constants.F_OK | constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}
