import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomic file write for checkpoint state: write to a unique temp file in the
 * same directory, fsync, then rename over the target. Rename is atomic within
 * a directory, so a reader — or a `kill -9` at any instant — either sees the
 * full previous file or the full new file, never a partial write. The temp
 * file is removed on failure so no litter accumulates on the happy path.
 *
 * Mirrors the primitive in `packages/core/src/idempotency/atomic-write.ts`
 * (CORE-013); kept local so the recovery subsystem has no cross-task
 * dependency. The integration task may unify them behind one shared util.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    // Best-effort directory fsync: makes the rename itself durable across a
    // power loss, not just a process kill. Not supported on every platform —
    // never fails the write.
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* directory fsync unsupported here — rename durability is still atomic */
    }
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
 * Atomic JSON write (UTF-8, 2-space indent, trailing newline).
 */
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a JSON file, returning `null` for a missing or empty file. Throws on
 * corrupt non-empty content — crash-mid-write is impossible by construction
 * (temp+rename), so corrupt content means external damage and must surface
 * loudly, not be silently swallowed into a fake-empty checkpoint.
 */
export async function readJsonFileOrNull<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.trim() === "") {
    return null;
  }
  return JSON.parse(raw) as T;
}