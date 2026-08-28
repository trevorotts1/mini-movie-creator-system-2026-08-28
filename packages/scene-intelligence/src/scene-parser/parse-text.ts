import type {
  ParseResult,
  ParsedDialogueLine,
  ParsedScene,
  SceneParseWarning,
  SceneParseWarningCode,
} from "./types.js";
import {
  buildDialogueLine,
  looksLikeSlug,
  parseCue,
  parseSlug,
  sanitizeSceneIdPrefix,
} from "./slug.js";
import { estimateSceneDuration } from "./normalize-structured.js";

/**
 * Fountain-style plain-text screenplay parser. Deterministic, zero-LLM:
 * heading lines (INT./EXT.) open scenes, ALL-CAPS lines over dialogue text
 * are cues, parentheticals are kept, everything else is action prose.
 *
 * Untrusted-input rules (spec §29): screenplay text is DATA. It is never
 * executed, never interpreted as instructions, never passed to a shell. The
 * parser only applies regex/substring logic and emits data records.
 */

const TRANSITION_PATTERN =
  /^(?:CUT TO:|FADE IN:|FADE OUT\.?|FADE TO BLACK\.?|DISSOLVE TO:|SMASH CUT TO:|MATCH CUT TO:|INTERCUT WITH:|BACK TO:|THE END)$/i;

const TITLE_PAGE_KEYWORDS =
  /^(TITLE|CREDIT|AUTHOR|AUTHORS|DRAFT|CONTACT|COPYRIGHT|SOURCE|NOTES):/i;

const PAGE_BREAK = /^={3,}$|^-{3,}$|^_{3,}$|^>{3,}$/;

/**
 * Parses a fountain-style screenplay into scenes.
 * Never throws. When the text is empty or has no scene headings the result
 * carries zero scenes plus the matching warning.
 */
export function parseScreenplayText(
  text: string,
  options: {
    knownCharacters?: string[];
    sceneIdPrefix?: string;
  } = {},
): { scenes: ParsedScene[]; warnings: SceneParseWarning[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const warnings: SceneParseWarning[] = [];

  const body = lines.filter(
    (line) =>
      !TITLE_PAGE_KEYWORDS.test(line.trim()) &&
      !PAGE_BREAK.test(line.trim()) &&
      !TRANSITION_PATTERN.test(line.trim()),
  );

  // Group lines into blocks: contiguous non-blank runs. A line that starts
  // a scene slug always begins its own block (slugs are hard scene
  // boundaries, even without a blank line before or after).
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  };
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (looksLikeSlug(trimmed)) {
      // Slug lines are always their own block: the following lines (cue,
      // text, action) form the scene body even when blank lines are absent.
      flush();
      current = [line];
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  if (blocks.length === 0) {
    warnings.push({
      code: "EMPTY_SCREENPLAY",
      message: "Screenplay text is empty.",
    });
    return { scenes: [], warnings };
  }

  // Index scene-start blocks: a slug block (INT/EXT line).
  const sceneStarts: number[] = [];
  blocks.forEach((block, i) => {
    if (isSlugBlock(block)) sceneStarts.push(i);
  });

  if (sceneStarts.length === 0) {
    warnings.push({
      code: "NO_SCENE_HEADINGS",
      message: "No INT./EXT. scene headings found.",
    });
    return { scenes: [], warnings };
  }

  // sceneId is an identifier (spec §19): keep the caller prefix but strip
  // anything that would smuggle path separators or control characters.
  const prefix = sanitizeSceneIdPrefix(options.sceneIdPrefix ?? "SC");
  const knownCharacters = (options.knownCharacters ?? []).map((c) =>
    c.trim().toUpperCase(),
  );

  const scenes: ParsedScene[] = [];
  sceneStarts.forEach((start, sceneIdx) => {
    const end = sceneIdx + 1 < sceneStarts.length ? (sceneStarts[sceneIdx + 1] ?? blocks.length) : blocks.length;
    const heading = blocks[start]?.[0]?.trim() ?? "";
    let slug = parseSlug(heading);

    const dialogue: ParsedDialogueLine[] = [];
    const actionLines: string[] = [];

    let i = start + 1;

    // Multi-line heading continuation: a bare "INT." slug whose location
    // remainder sits on the next line ("INT." + "APARTMENT - NIGHT"). Only
    // fires when the first line alone parsed WITHOUT a location and the
    // next single-line block is neither a cue nor a slug itself, so real
    // scene bodies are never consumed.
    if (slug.location === "UNKNOWN") {
      const nextBlock = blocks[i] ?? [];
      const nextFirst = (nextBlock[0] ?? "").trim();
      // A bare ALL-CAPS word parses as a cue ("MONA") — keep that reading.
      // A location remainder contains a " - " separator, which cues never do.
      const cueLike =
        parseCue(nextFirst) !== null && !/\s[-–—]\s/.test(nextFirst);
      if (
        nextBlock.length === 1 &&
        nextFirst.length > 0 &&
        !cueLike &&
        !looksLikeSlug(nextFirst) &&
        looksLikeSlug(`${heading} ${nextFirst}`)
      ) {
        const extended = parseSlug(`${heading} ${nextFirst}`);
        if (extended.location !== "UNKNOWN") {
          slug = extended;
          i += 1;
        }
      }
    }

    while (i < end) {
      const block = blocks[i] ?? [];
      if (block.length === 0) {
        i += 1;
        continue;
      }
      const first = block[0] ?? "";
      const cue = parseCue(first);
      if (cue && block.length >= 2) {
        // Dialogue block: [cue, (parenthetical), text lines...]
        let cursor = 1;
        let parenthetical: string | null = null;
        const parenMatch = /^\(([^)]*)\)$/.exec((block[cursor] ?? "").trim());
        if (parenMatch) {
          parenthetical = parenMatch[1]?.trim() ?? null;
          cursor += 1;
        }
        const textLines: string[] = [];
        while (cursor < block.length) {
          const line = (block[cursor] ?? "").trim();
          if (line.length > 0) textLines.push(line);
          cursor += 1;
        }
        const text = textLines.join(" ").replace(/\s+/g, " ").trim();
        if (text.length > 0 || parenthetical) {
          dialogue.push(buildDialogueLine(cue, text, parenthetical));
        }
      } else {
        for (const line of block) {
          const trimmed = line.trim();
          if (trimmed.length > 0) actionLines.push(trimmed);
        }
      }
      i += 1;
    }

    const characters = collectCharacters(dialogue, actionLines, knownCharacters);
    const locationLabel =
      slug.location !== "UNKNOWN"
        ? slug.location
        : heading.replace(/^(?:INT|EXT)\.?\s*/i, "").trim() || "UNKNOWN";

    const name = `${slug.intExt} ${locationLabel}${slug.timeOfDay ? ` - ${slug.timeOfDay}` : ""}`;

    scenes.push({
      sceneId: `${prefix}${String(sceneIdx + 1).padStart(2, "0")}`,
      index: sceneIdx,
      name,
      heading: heading || null,
      slug,
      location: slug.location,
      timeOfDay: slug.timeOfDay,
      characters,
      actionLines,
      dialogue,
      durationSeconds: estimateSceneDuration(dialogue, actionLines),
      durationBreakdown: {
        dialogueSeconds: Math.round(
          (dialogue.reduce((s, d) => s + countWords(d.text), 0) / 2.0) * 10,
        ) / 10,
        actionSeconds:
          Math.round(
            (actionLines.reduce((s, a) => s + countWords(a), 0) / 3.0) * 10,
          ) / 10,
      },
    });

    if (slug.location === "UNKNOWN") {
      warnings.push({
        code: "SCENE_WITHOUT_LOCATION",
        message: `Scene ${sceneIdx + 1} heading "${heading}" has no readable location.`,
      });
    }
  });

  return { scenes, warnings };
}

function isSlugBlock(block: string[]): boolean {
  if (block.length === 0) return false;
  const first = (block[0] ?? "").trim();
  // Multi-line heading: "INT." alone then rest on the next line. The slug
  // matcher accepts the joined line; the location is recovered later by the
  // heading-continuation step in the scene loop.
  if (/^(?:INT|EXT|I\/E|E\/I)\b[\s./]?$/i.test(first) && block.length >= 2) {
    return looksLikeSlug(`${first} ${block[1] ?? ""}`);
  }
  return looksLikeSlug(first);
}

/**
 * Ordered unique character list: dialogue speakers first (they drive
 * casting), then known-character names found in action prose, then
 * conventionally-capitalized names detected in action lines.
 */
function collectCharacters(
  dialogue: ParsedDialogueLine[],
  actionLines: string[],
  knownCharacters: string[],
): string[] {
  const characters: string[] = [];
  const seen = new Set<string>();

  for (const line of dialogue) {
    const name = line.character;
    if (name && !seen.has(name)) {
      seen.add(name);
      characters.push(name);
    }
  }

  const actionText = actionLines.join("\n");
  for (const known of knownCharacters) {
    if (!known || seen.has(known)) continue;
    // Action prose is not reliably capitalized; match case-insensitively.
    const pattern = new RegExp(`\\b${escapeRegex(known)}\\b`, "i");
    if (pattern.test(actionText)) {
      seen.add(known);
      characters.push(known);
    }
  }

  // Action convention: character names appear in ALL CAPS on first mention.
  const namePattern = /\b[A-Z][A-Z0-9'’.-]{1,29}\b/g;
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(actionText)) !== null) {
    const candidate = match[0];
    if (seen.has(candidate)) continue;
    if (isLikelyCharacterName(candidate)) {
      seen.add(candidate);
      characters.push(candidate);
    }
  }

  return characters;
}

/** Filters common ALL-CAPS non-name noise words out of action detections. */
const NON_NAME_WORDS = new Set([
  "THE",
  "A",
  "AN",
  "AND",
  "BUT",
  "OR",
  "OF",
  "TO",
  "IN",
  "ON",
  "AT",
  "BY",
  "FOR",
  "WITH",
  "FROM",
  "INT",
  "EXT",
  "INT/EXT",
  "DAY",
  "NIGHT",
  "MORNING",
  "AFTERNOON",
  "EVENING",
  "NIGHT.",
  "DAWN",
  "DUSK",
  "NOON",
  "MIDNIGHT",
  "CONTINUOUS",
  "LATER",
  "MOMENTS",
  "CUT",
  "FADE",
  "CUTTO",
  "CUT:",
  "SMASH",
  "DISSOLVE",
  "INTERCUT",
  "BACK",
  "SUPER",
  "VO",
  "V.O.",
  "OS",
  "O.S.",
  "POV",
  "B.G.",
  "BG",
  "FG",
  "SFX",
  "VFX",
  "MUSIC",
  "TITLE",
  "OVER",
  "BLACK",
  "WHITE",
  "SLOWLY",
  "SUDDENLY",
  "THEN",
  "NOW",
  "ALL",
  "HE",
  "SHE",
  "THEY",
  "HIS",
  "HER",
  "IT",
  "WE",
  "I",
  "YOU",
  "OK",
  "YES",
  "NO",
  "STOP",
  "MAN",
  "WOMAN",
  "WAITER",
  "TV",
  "CAR",
  "DOOR",
  "PHONE",
  "ROOM",
  "KITCHEN",
  "BEDROOM",
  "LIVING",
  "BATHROOM",
  "OFFICE",
  "STREET",
  "HALLWAY",
  "APARTMENT",
  "HOUSE",
  "DINER",
  "BAR",
  "CAFE",
  "HOTEL",
  "LOBBY",
  "ELEVATOR",
  "STAIRS",
  "ROOF",
  "GARAGE",
  "YARD",
  "GARDEN",
  "PARK",
  "BEACH",
  "FOREST",
  "DESK",
  "WINDOW",
  "TABLE",
  "CHAIR",
  "BED",
  "LIGHT",
  "LIGHTS",
  "SOUND",
  "MUSIC",
  "VOICE",
  "SHADOW",
  "RAIN",
  "WIND",
  "SNOW",
  "SUN",
  "MOON",
  "SKY",
  "WATER",
  "FIRE",
  "SMOKE",
  "BLOOD",
  "GUN",
  "KNIFE",
  "KEY",
  "NOTE",
  "PAPER",
  "BOOK",
  "BAG",
  "BOX",
  "BOTTLE",
  "CUP",
  "GLASS",
  "PLATE",
  "FOOD",
  "DRINK",
  "WINE",
  "BEER",
  "COFFEE",
  "TEA",
  "MILK",
  "JUICE",
  "BREAD",
  "MEAT",
  "FRUIT",
  "APPLE",
  "ORANGE",
  "BANANA",
  "HELLO",
  "GOODBYE",
  "THANK",
  "PLEASE",
  "SORRY",
  "WAIT",
  "LOOK",
  "SEE",
  "HEAR",
  "FEEL",
  "KNOW",
  "THINK",
  "SAY",
  "TELL",
  "ASK",
  "ANSWER",
  "COMES",
  "GOES",
  "WALKS",
  "RUNS",
  "SITS",
  "STANDS",
  "LIES",
  "DIES",
  "SMILES",
  "LAUGHS",
  "CRYING",
  "SCREAMS",
  "SHOUTS",
  "WHISPERS",
  "SPEAKS",
  "TALKS",
  "SAYS",
  "TELLS",
  "ASKS",
  "ANSWERS",
  "REPLIES",
  "RESPONDS",
  "CONTINUES",
  "STARTS",
  "BEGINS",
  "ENDS",
  "FINISHES",
  "STOPS",
  "TURNS",
  "MOVES",
  "GRABS",
  "TAKES",
  "GIVES",
  "PUSHES",
  "PULLS",
  "THROWS",
  "CATCHES",
  "HOLDS",
  "DROPS",
  "OPENS",
  "CLOSES",
  "ENTERS",
  "EXITS",
  "LEAVES",
  "ARRIVES",
  "RETURNS",
  "APPROACHES",
  "FOLLOWS",
  "WATCHES",
  "LOOKS",
  "STARES",
  "GLARES",
  "GLANCES",
  "PEERS",
  "SEES",
  "NOTICES",
  "SPOTS",
  "FINDS",
  "DISCOVERS",
  "REALIZES",
  "UNDERSTANDS",
  "REMEMBERS",
  "FORGETS",
  "KNOWS",
  "THINKS",
  "WONDERS",
  "DREAMS",
  "WAKES",
  "SLEEPS",
  "DREAM",
]);

function isLikelyCharacterName(candidate: string): boolean {
  if (candidate.length < 2) return false;
  if (NON_NAME_WORDS.has(candidate)) return false;
  // Exclude numeric-only and ordinal tokens.
  if (/^\d+$/.test(candidate.replace(/[.\-]/g, ""))) return false;
  // Exclude tokens that are mostly punctuation.
  const letters = candidate.replace(/[^A-Z]/g, "");
  if (letters.length < 2) return false;
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Wraps text parsing into the full ParseResult shape. */
export function parseScreenplayTextResult(
  text: string,
  options: {
    approved?: boolean;
    knownCharacters?: string[];
    sceneIdPrefix?: string;
  } = {},
): ParseResult {
  const warnings: SceneParseWarning[] = [];
  if (options.approved === false) {
    warnings.push({
      code: "UNAPPROVED_SCREENPLAY",
      message:
        "Screenplay has not passed the script approval gate; parsed scenes are provisional (Gate 2).",
    });
  }

  const parsed = parseScreenplayText(text, {
    knownCharacters: options.knownCharacters,
    sceneIdPrefix: options.sceneIdPrefix,
  });

  return {
    scenes: parsed.scenes,
    totalDurationSeconds:
      Math.round(parsed.scenes.reduce((sum, s) => sum + s.durationSeconds, 0) * 10) / 10,
    warnings: [...warnings, ...parsed.warnings],
    source: "text",
  };
}

export type { SceneParseWarningCode };