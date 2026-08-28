/// <reference types="node" />
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomic file write: write to a unique temp file in the same directory, fsync,
 * then rename over the target. Rename is atomic within a directory, so a
 * reader either sees the full previous file or the full new file — never a
 * partial write, even if the process crashes mid-write. The temp file is
 * removed on failure so no litter accumulates.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      /* temp file already gone */
    }
    throw err;
  }
}

/**
 * Atomic JSON write (UTF-8, 2-space indent, trailing newline) via atomicWriteFile.
 */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export interface JsonReadResult<T> {
  value: T;
  /** True when the target file was missing or empty and the fallback was used. */
  defaulted: boolean;
}

/**
 * Read a JSON file, returning a fallback for missing/empty files.
 * Throws on corrupt non-empty content — crash-mid-write is impossible by
 * construction (temp+rename), so corrupt content means external damage and
 * must not be silently swallowed.
 */
export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { value: fallback, defaulted: true };
  }
  if (raw.trim() === "") {
    return { value: fallback, defaulted: true };
  }
  return { value: JSON.parse(raw) as T, defaulted: false };
}