import type { ParsedDialogueLine, SceneIntExt, SceneSlug } from "./types.js";

/**
 * Slug-line and cue-line detection helpers shared by the plain-text and
 * structured normalizers. Screenplay conventions handled:
 *
 * - `INT. DINER - NIGHT` / `EXT. STREET - DAY`
 * - `INT./EXT.` and `I/E` variants
 * - numbered-heading prefixes: `SCENE 12 - INT. DINER - NIGHT`, `12A - ...`
 * - compound times: `NIGHT - CONTINUOUS`, `LATER THAT DAY`
 */

/** Canonical time-of-day words a slug segment may contain. */
export const TIME_WORDS = new Set([
  "DAY",
  "NIGHT",
  "DAWN",
  "DUSK",
  "MORNING",
  "AFTERNOON",
  "EVENING",
  "MIDNIGHT",
  "NOON",
  "SUNRISE",
  "SUNSET",
  "CONTINUOUS",
  "LATER",
  "MOMENTS",
  "INSTANTLY",
  "PRE-DAWN",
  "PREDAWN",
  "TWILIGHT",
  "FLASHBACK",
  "FLASH-FORWARD",
  "DREAM",
]);

/** Strips numbered-heading prefixes: "SCENE 4 - ...", "12A - ...", "#7. ...". */
const NUMBERED_PREFIX = /^(?:SCENE|SEQ\.)?\s*#?\d+[A-Z]?\s*[-–—.:]?\s+/i;

export function stripNumberedPrefix(heading: string): string {
  return heading.replace(NUMBERED_PREFIX, "").trim();
}

/**
 * True when the line looks like a scene slug (INT/EXT intro), with or
 * without a numbered-heading prefix.
 */
export function looksLikeSlug(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  const withoutPrefix = stripNumberedPrefix(trimmed);
  return /^(?:INT|EXT|I\/E|E\/I)(?:[./][^\w)]*|\b)/i.test(withoutPrefix) &&
    /^(?:INT|EXT|I\/E|E\/I)/i.test(withoutPrefix);
}

const INT_EXT_PATTERN =
  /^(I\/E|E\/I|INT\.?\/?EXT\.?|EXT\.?\/?INT\.?|INT|EXT)[\s.]+(.*)$/i;

/** Parses "INT. DINER - NIGHT" into its structured parts. */
export function parseSlug(raw: string): SceneSlug {
  const cleaned = stripNumberedPrefix(raw.trim());
  const match = INT_EXT_PATTERN.exec(cleaned);

  if (!match) {
    return {
      intExt: "UNKNOWN",
      location: cleaned || "UNKNOWN",
      timeOfDay: null,
    };
  }

  const marker = match[1]?.toUpperCase() ?? "UNKNOWN";
  const intExt: SceneIntExt =
    marker === "I/E" || marker === "E/I"
      ? "INT/EXT"
      : marker.startsWith("INT") && marker.includes("EXT")
        ? "INT/EXT"
        : marker === "INT"
          ? "INT"
          : marker === "EXT"
            ? "EXT"
            : "UNKNOWN";

  let rest = (match[2] ?? "").replace(/[.\s]+$/, "").trim();

  // Split location from time on the last " - " / " – " separator whose right
  // side starts with a known time word ("DINER - NIGHT - CONTINUOUS").
  let timeOfDay: string | null = null;
  const separators = /[-–—]/g;
  let bestSplit = -1;
  let candidate: RegExpExecArray | null;
  while ((candidate = separators.exec(rest)) !== null) {
    const right = rest.slice(candidate.index + 1).trim();
    if (right.length > 0 && startsWithTimeWord(right)) {
      bestSplit = candidate.index;
    }
  }
  if (bestSplit >= 0) {
    timeOfDay = normalizeTime(rest.slice(bestSplit + 1));
    rest = rest.slice(0, bestSplit).trim();
  }

  const location = rest.replace(/[.\s]+$/, "").trim() || "UNKNOWN";
  return { intExt, location, timeOfDay };
}

function startsWithTimeWord(segment: string): boolean {
  const upper = segment.toUpperCase();
  for (const word of TIME_WORDS) {
    if (upper === word || upper.startsWith(`${word} `) || upper.startsWith(`${word} -`)) {
      return true;
    }
    // Compound markers such as "MOMENTS LATER" or "LATER THAT DAY".
    if (
      (word === "MOMENTS" || word === "LATER") &&
      upper.startsWith(`${word} `)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeTime(segment: string): string {
  return segment
    .split(/[-–—]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" - ")
    .toUpperCase();
}

/** Cue modifiers recognized on a character cue line. */
const CUE_MODIFIERS = new Set([
  "V.O.",
  "VO",
  "O.S.",
  "OS",
  "O.C.",
  "OC",
  "OFF",
  "CONT'D",
  "CONTD",
  "PRE-LAP",
  "PRELAP",
  "FILTERED",
]);

export interface ParsedCue {
  character: string;
  cueModifiers: string[];
}

/**
 * Parses a dialogue cue line: "ROSE (V.O.)", "MARcus (CONT'D)" ->
 * character + modifiers. Parentheticals that carry direction ("(quiet)")
 * are NOT cue modifiers and remain for the parenthetical parser.
 */
export function parseCue(line: string): ParsedCue | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/^(?:INT|EXT|I\/E|E\/I)\b/i.test(trimmed)) return null;
  if (/\n/.test(trimmed)) return null;

  const modifierPattern = /\(([^)]*)\)/g;
  const modifiers: string[] = [];
  let name = trimmed;
  let match: RegExpExecArray | null;
  while ((match = modifierPattern.exec(trimmed)) !== null) {
    const inner = match[1]?.trim().toUpperCase();
    if (!inner) continue;
    if (CUE_MODIFIERS.has(inner)) {
      modifiers.push(normalizeModifier(inner));
    } else {
      return null; // Directional parenthetical on the cue line: not a pure cue.
    }
  }
  name = trimmed.replace(/\([^)]*\)/g, "").trim();
  if (!name || !/^[A-Z0-9][A-Z0-9 .'"’\-/]*$/.test(name)) return null;

  return { character: name.replace(/\s+/g, " ").trim(), cueModifiers: modifiers };
}

function normalizeModifier(modifier: string): string {
  switch (modifier) {
    case "VO":
      return "V.O.";
    case "OS":
      return "O.S.";
    case "OC":
      return "O.C.";
    case "CONTD":
      return "CONT'D";
    case "PRELAP":
      return "PRE-LAP";
    default:
      return modifier;
  }
}

/** Builds a dialogue line record from a parsed cue plus its spoken text. */
export function buildDialogueLine(
  cue: ParsedCue,
  text: string,
  parenthetical: string | null,
): ParsedDialogueLine {
  return {
    character: cue.character,
    parenthetical,
    cueModifiers: cue.cueModifiers,
    text,
  };
}