/// <reference types="node" />
/**
 * Caption track loader (FISH-007) — resolve the alignment record for a
 * dialogue asset and build its caption track.
 *
 * Reads the FISH-006 alignment store's on-disk document directly
 * (`<directory>/<key>.json`, `{formatVersion:1, alignment}`), so the
 * caption pipeline works against the SAME alignment files FISH-006
 * persists, without importing the alignment package (no cross-task
 * dependency; FISH-006 may not be merged when this lands). The document is
 * structurally checked here; word-level validation stays in
 * `buildCaptionTrack` (single validation point at build time, mirroring
 * FISH-006's posture).
 *
 * Untrusted data rules: the key is validated before it ever becomes a path;
 * dialogue text/timings are data only — never evaluated, never
 * interpolated into executable context.
 */
import path from "node:path";
import { isCurrentDialogueAssetKey } from "./key.js";
import { buildCaptionTrack } from "./build.js";
import type {
  CaptionBuildOptions,
  CaptionSourceAlignment,
  CaptionTrack,
} from "./types.js";

/** Injectable filesystem seam for tests. Mirrors the fs subset used. */
export interface CaptionReadFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const DEFAULT_FS: CaptionReadFs = {
  readFile: (p, enc) =>
    import("node:fs").then((m) => m.promises.readFile(p, enc as "utf8")) as Promise<string>,
};

export interface LoadCaptionTrackOptions extends CaptionBuildOptions {
  /** Directory holding FISH-006 alignment documents (`<key>.json`). */
  directory: string;
  /** Dialogue asset key (FISH-005 cache key) to load. */
  key: string;
  /** Injected filesystem (tests). Default: node:fs promises. */
  fs?: CaptionReadFs;
}

/**
 * Parse + structurally check an alignment document (the FISH-006
 * `FishAlignmentFile` shape). Returns the alignment record as a
 * `CaptionSourceAlignment` — field-compatible with `FishDialogueAlignment`.
 */
export function parseAlignmentDoc(
  raw: string,
  filePath: string,
): CaptionSourceAlignment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Alignment file at ${filePath} is not valid JSON`);
  }
  const doc = parsed as Partial<{ formatVersion: unknown; alignment: unknown }>;
  const alignment = doc?.alignment as Partial<CaptionSourceAlignment> | null;
  if (
    doc?.formatVersion !== 1 ||
    typeof alignment !== "object" ||
    alignment === null ||
    typeof alignment.key !== "string" ||
    typeof alignment.text !== "string" ||
    !Array.isArray(alignment.words)
  ) {
    throw new Error(
      `Alignment file at ${filePath} is malformed (expected formatVersion 1)`,
    );
  }
  return alignment as CaptionSourceAlignment;
}

/**
 * Load a FISH-006 alignment record for `key` and build its caption track.
 * Throws when the key is malformed (path safety) or the file is missing.
 */
export async function loadCaptionTrack(
  options: LoadCaptionTrackOptions,
): Promise<CaptionTrack> {
  const key = options.key?.trim();
  if (!key || !isCurrentDialogueAssetKey(key)) {
    throw new Error(
      `Not a valid dialogue asset key: ${JSON.stringify(options.key)}`,
    );
  }
  if (!options.directory?.trim()) {
    throw new Error("directory is required");
  }
  const fsImpl = options.fs ?? DEFAULT_FS;
  const filePath = path.join(options.directory, `${options.key}.json`);
  let raw: string;
  try {
    raw = await fsImpl.readFile(filePath, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(`No alignment record for dialogue asset ${key} at ${filePath}`);
    }
    throw err;
  }
  const alignment = parseAlignmentDoc(raw, filePath);
  const { directory: _d, key: _k, fs: _f, ...buildOptions } = options;
  return buildCaptionTrack({ ...alignment, key }, buildOptions);
}