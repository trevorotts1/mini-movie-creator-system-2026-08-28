/**
 * Response parsing — DIR-004.
 *
 * The writer model returns JSON text. Parsing is strict-fail: a response that
 * is not valid JSON, or that violates the v1 shape contract, raises
 * `ScreenplayParseError` with the exact problem. Truncation ("response seems
 * cut off"), fence-wrapped payloads, and shape violations are all surfaced —
 * never silently repaired into a half-screenplay.
 *
 * All parsed prose is UNTRUSTED DATA (spec §29): kept verbatim as data, never
 * executed or interpreted as instructions.
 */

import {
  SCREENPLAY_SCHEMA_VERSION,
  type Screenplay,
  type ScreenplayCharacter,
  type ScreenplayDialogueLine,
  type ScreenplayScene,
} from "./types.js";

/** Error thrown when the writer response cannot be parsed into a screenplay. */
export class ScreenplayParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenplayParseError";
  }
}

/** Detect the classic LLM truncation artifacts inside a JSON string value:
 * an escaped quote in progress ("\") immediately before end-of-input. */
function looksTruncated(text: string): boolean {
  return /(^|[^\\])(\\\\)*\\$/.test(text);
}

/** Strip one optional markdown fence and parse the JSON object. */
export function parseWriterJson(text: string): Record<string, unknown> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new ScreenplayParseError("writer response is empty");
  }
  if (looksTruncated(text)) {
    throw new ScreenplayParseError(
      "writer response appears truncated (unterminated escape/quote at end); cannot parse screenplay",
    );
  }
  let candidate = text.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(candidate);
  if (fence?.[1] !== undefined) {
    candidate = fence[1].trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ScreenplayParseError(
      `writer response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScreenplayParseError(
      "writer response must be a JSON object containing the screenplay",
    );
  }
  return parsed as Record<string, unknown>;
}

function requireString(
  source: Record<string, unknown>,
  field: string,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ScreenplayParseError(
      `screenplay field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function requireNumber(
  source: Record<string, unknown>,
  field: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScreenplayParseError(
      `screenplay field "${field}" must be a finite number`,
    );
  }
  return value;
}

function requireArray(
  source: Record<string, unknown>,
  field: string,
): readonly unknown[] {
  const value = source[field];
  if (!Array.isArray(value)) {
    throw new ScreenplayParseError(
      `screenplay field "${field}" must be an array`,
    );
  }
  return value;
}

/** Slug for the screenplay ID: A-Z/0-9 tokens joined by `_`. */
function titleSlug(title: string): string {
  const slug = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "UNTITLED" : slug.slice(0, 60);
}

/** Zero-pad a 1-based ordinal to 3 digits. */
function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Does the prose mention the character? Full name first, then any name part
 * of at least 4 characters (avoids matching stop-word names like "The").
 */
function nameAppearsInText(name: string, text: string): boolean {
  if (text.includes(name)) return true;
  return name
    .split(/\s+/)
    .filter((part) => part.length >= 4)
    .some((part) => text.includes(part));
}

/** Parse heading "INT. OFFICE - DAY" into its three parts. */
export function parseSceneHeading(heading: string): {
  interiorExterior: "INT" | "EXT";
  location: string;
  timeOfDay: string;
} {
  // Greedy location: sluglines may carry sublocations ("INT. OFFICE - LAB - DAY");
  // splitting on the LAST " - " keeps them in the location and the time-of-day
  // as the final segment.
  const match =
    /^(INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s+(.+)\s+-\s+(.+)$/i.exec(heading.trim());
  if (!match) {
    throw new ScreenplayParseError(
      `scene heading must match "INT./EXT. LOCATION - TIME", got: ${JSON.stringify(heading)}`,
    );
  }
  const ieRaw = match[1]!.toUpperCase();
  const interiorExterior: "INT" | "EXT" =
    ieRaw.startsWith("INT") && !ieRaw.startsWith("INT/EXT") && ieRaw !== "I/E."
      ? "INT"
      : ieRaw.startsWith("EXT")
        ? "EXT"
        : "INT";
  return {
    interiorExterior,
    location: match[2]!.trim(),
    timeOfDay: match[3]!.trim(),
  };
}

/** Parse the writer JSON (already validated as an object) into a Screenplay. */
export function parseScreenplayResponse(
  raw: Record<string, unknown>,
  context: {
    conceptId: string;
    writerModelId: string;
    reasoningEffort: string | null;
    promptCharacterCount: number;
    responseCharacterCount: number;
    generatedAt: string;
    fallbackTitle: string;
    fallbackLogline: string;
  },
): Screenplay {
  const title = requireStringOrFallback(raw, "title", context.fallbackTitle);
  // Logline: prefer the writer's version; fall back to the approved concept's
  // (an omitted logline is not a structural violation — the concept carries it).
  const logline = requireStringOrFallback(raw, "logline", context.fallbackLogline);
  const scenesRaw = requireArray(raw, "scenes");
  const charactersRaw = requireArray(raw, "characters");
  if (scenesRaw.length === 0) {
    throw new ScreenplayParseError(
      "screenplay must contain at least one scene",
    );
  }

  const characters = parseCharacters(charactersRaw);
  const knownNames = new Set(characters.map((c) => c.name));

  const scenes: ScreenplayScene[] = scenesRaw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ScreenplayParseError(`scenes[${index}] must be an object`);
    }
    const scene = entry as Record<string, unknown>;
    const sceneId = `SC${pad3(index + 1)}`;
    const heading = requireString(scene, "heading");
    const parts = parseSceneHeading(heading);

    const dialogueRaw = scene.dialogue;
    if (dialogueRaw !== undefined && !Array.isArray(dialogueRaw)) {
      throw new ScreenplayParseError(
        `scenes[${index}] (${sceneId}) field "dialogue" must be an array when present`,
      );
    }
    const dialogue: ScreenplayDialogueLine[] = (dialogueRaw ?? []).map(
      (lineEntry, lineIndex) => {
        if (
          lineEntry === null ||
          typeof lineEntry !== "object" ||
          Array.isArray(lineEntry)
        ) {
          throw new ScreenplayParseError(
            `scenes[${index}].dialogue[${lineIndex}] must be an object`,
          );
        }
        const line = lineEntry as Record<string, unknown>;
        const characterName = requireString(line, "characterName");
        if (!knownNames.has(characterName)) {
          throw new ScreenplayParseError(
            `dialogue line ${sceneId}_L${pad3(lineIndex + 1)} references unknown character ${JSON.stringify(characterName)}; every speaker must be in characters`,
          );
        }
        const text = requireString(line, "text");
        const parenthetical = line.parenthetical;
        const lineOut: {
          lineId: string;
          sceneId: string;
          characterName: string;
          text: string;
          parenthetical?: string;
        } = {
          lineId: `${sceneId}_L${pad3(lineIndex + 1)}`,
          sceneId,
          characterName,
          text,
        };
        if (typeof parenthetical === "string" && parenthetical.trim() !== "") {
          lineOut.parenthetical = parenthetical;
        }
        return lineOut;
      },
    );

    const synopsisRaw = scene.synopsis;
    const synopsis =
      typeof synopsisRaw === "string" ? synopsisRaw.trim() : "";
    if (synopsis === "" && dialogue.length === 0) {
      throw new ScreenplayParseError(
        `scenes[${index}] (${sceneId}) must have at least one of synopsis or dialogue`,
      );
    }

    let estimated = 0;
    if (typeof scene.estimatedDurationSeconds === "number" &&
        Number.isFinite(scene.estimatedDurationSeconds) &&
        scene.estimatedDurationSeconds > 0) {
      estimated = scene.estimatedDurationSeconds;
    } else {
      // Heuristic: ~2.5s per word of spoken text + 8s baseline action beat.
      const words = dialogue.reduce(
        (sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length,
        0,
      );
      estimated = Math.max(5, Math.round(words * 2.5 + 8));
    }

    const sceneOut: ScreenplayScene = {
      sceneId,
      sequenceIndex: index + 1,
      heading,
      interiorExterior: parts.interiorExterior,
      location: parts.location,
      timeOfDay: parts.timeOfDay,
      synopsis,
      characterNames: Array.from(
        new Set([
          ...characters
            .filter(
              (character) =>
                (synopsis !== "" &&
                  nameAppearsInText(character.name, synopsis)) ||
                dialogue.some(
                  (line) => line.characterName === character.name,
                ),
            )
            .map((character) => character.name),
        ]),
      ),
      dialogue,
      estimatedDurationSeconds: estimated,
    };
    return sceneOut;
  });

  // Characters appearing in dialogue but missing from the cast list are a
  // contract violation — rejected inside the dialogue map above.

  return {
    screenplayId: `SCR_${titleSlug(title)}_001`,
    conceptId: context.conceptId,
    title,
    logline,
    scenes,
    characters,
    metadata: {
      generatedAt: context.generatedAt,
      writerModelId: context.writerModelId,
      reasoningEffort: context.reasoningEffort,
      promptCharacterCount: context.promptCharacterCount,
      responseCharacterCount: context.responseCharacterCount,
      schemaVersion: SCREENPLAY_SCHEMA_VERSION,
    },
  };
}

function requireStringOrFallback(
  source: Record<string, unknown>,
  field: string,
  fallback: string,
): string {
  const value = source[field];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (fallback !== "") return fallback;
  throw new ScreenplayParseError(
    `screenplay field "${field}" must be a non-empty string`,
  );
}

function parseCharacters(
  charactersRaw: readonly unknown[],
): ScreenplayCharacter[] {
  const seen = new Set<string>();
  const characters: ScreenplayCharacter[] = charactersRaw.map(
    (entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ScreenplayParseError(`characters[${index}] must be an object`);
      }
      const character = entry as Record<string, unknown>;
      const name = requireString(character, "name");
      if (seen.has(name)) {
        throw new ScreenplayParseError(
          `duplicate character name ${JSON.stringify(name)} in cast`,
        );
      }
      seen.add(name);
      const roleRaw = character.role;
      const validRoles = ["lead", "supporting", "cameo"] as const;
      if (
        typeof roleRaw !== "string" ||
        !(validRoles as readonly string[]).includes(roleRaw)
      ) {
        throw new ScreenplayParseError(
          `characters[${index}] field "role" must be one of lead|supporting|cameo, got ${JSON.stringify(roleRaw)}`,
        );
      }
      const role = roleRaw as "lead" | "supporting" | "cameo";
      const description =
        typeof character.description === "string" ? character.description : "";
      const isNew = character.isNew === true;
      return { name, role, description, isNew };
    },
  );
  if (characters.length === 0) {
    throw new ScreenplayParseError(
      "screenplay cast must contain at least one character",
    );
  }
  return characters;
}

export { parseCharacters };