import type {
  ParsedScene,
  SceneSlug,
  StructuredScreenplay,
  StructuredScreenplayScene,
} from "./types.js";
import { looksLikeSlug, parseSlug } from "./slug.js";

/**
 * Normalizes a structured screenplay document (the DIR-004 generator shape)
 * into the shared ParsedScene form. Field aliases are accepted liberally
 * (`name`/`title`, `character`/`speaker`) because the upstream generator
 * contract is still settling; normalization never invents scene content.
 */

export function normalizeStructuredScreenplay(
  document: StructuredScreenplay,
): ParsedScene[] {
  const scenes = Array.isArray(document.scenes) ? document.scenes : [];
  return scenes
    .map((scene, index) => normalizeStructuredScene(scene, index))
    .filter((scene): scene is ParsedScene => scene !== null);
}

function normalizeStructuredScene(
  scene: StructuredScreenplayScene,
  index: number,
): ParsedScene | null {
  if (scene === null || typeof scene !== "object") return null;

  // `name` is a display label, never a heading substitute — a scene with a
  // name but no heading must stay location-less (warning surface), not leak
  // the label into the location field.
  const heading =
    nonEmpty(scene.heading) ?? nonEmpty(scene.title);

  const slug: SceneSlug =
    scene.slug && typeof scene.slug === "object"
      ? {
          intExt: normalizeIntExt(scene.slug.intExt ?? null),
          location: nonEmpty(scene.slug.location) ?? "UNKNOWN",
          timeOfDay: nonEmpty(scene.slug.timeOfDay),
        }
      : parseSlugOrHeading(scene, heading);

  // Explicit display name wins; otherwise derive from slug/heading.
  const name =
    nonEmpty(scene.name) ?? buildSceneName(index, heading, slug);

  const characters = unique(
    (Array.isArray(scene.characters) ? scene.characters : [])
      .map((c) => (typeof c === "string" ? c.trim().toUpperCase() : ""))
      .filter((c) => c.length > 0),
  );

  const actionLines = toLines(scene.action);

  const dialogue = (Array.isArray(scene.dialogue) ? scene.dialogue : [])
    .map((line) => {
      const character = nonEmpty(
        line.character ?? line.speaker ?? line.name ?? null,
      );
      if (!character) return null;
      const text = nonEmpty(line.text ?? line.line ?? null) ?? "";
      return {
        character: character.toUpperCase().replace(/\s+/g, " "),
        parenthetical: nonEmpty(line.parenthetical ?? null),
        cueModifiers: Array.isArray(line.cueModifiers) ? [...line.cueModifiers] : [],
        text,
      };
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);

  // Characters from dialogue that the caller did not already list.
  for (const line of dialogue) {
    if (!characters.includes(line.character)) characters.push(line.character);
  }

  const durationSeconds =
    typeof scene.estimatedDurationSeconds === "number" &&
    Number.isFinite(scene.estimatedDurationSeconds) &&
    scene.estimatedDurationSeconds > 0
      ? scene.estimatedDurationSeconds
      : estimateSceneDuration(dialogue, actionLines);

  return {
    sceneId: `SC${String(index + 1).padStart(2, "0")}`,
    index,
    name,
    heading: heading ?? null,
    slug,
    location: slug.location,
    timeOfDay: slug.timeOfDay,
    characters,
    actionLines,
    dialogue,
    durationSeconds,
    durationBreakdown: splitDuration(dialogue, actionLines),
  };
}

function parseSlugOrHeading(
  scene: StructuredScreenplayScene,
  heading: string | null,
): SceneSlug {
  const intExtRaw = nonEmpty(scene.intExt ?? null);
  if (intExtRaw || nonEmpty(scene.location ?? null) || nonEmpty(scene.timeOfDay ?? null)) {
    return {
      intExt: normalizeIntExt(intExtRaw),
      location: nonEmpty(scene.location ?? null) ?? "UNKNOWN",
      timeOfDay: nonEmpty(scene.timeOfDay ?? null),
    };
  }
  if (heading && looksLikeSlug(heading)) return parseSlug(heading);
  // Non-slug headings carry no location data: leave UNKNOWN so the
  // SCENE_WITHOUT_LOCATION warning surfaces to the operator.
  return {
    intExt: "UNKNOWN",
    location: "UNKNOWN",
    timeOfDay: null,
  };
}

function normalizeIntExt(
  value: string | null,
): "INT" | "EXT" | "INT/EXT" | "UNKNOWN" {
  if (!value) return "UNKNOWN";
  const upper = value.toUpperCase().replace(/[^A-Z/]/g, "");
  if (upper === "INT") return "INT";
  if (upper === "EXT") return "EXT";
  if (upper === "I/E" || upper === "E/I" || upper === "INT/EXT" || upper === "EXT/INT") {
    return "INT/EXT";
  }
  return "UNKNOWN";
}

function buildSceneName(
  index: number,
  heading: string | null,
  slug: SceneSlug,
): string {
  const locationPart = slug.location !== "UNKNOWN" ? slug.location : null;
  if (locationPart) {
    return `${slug.intExt} ${locationPart}${slug.timeOfDay ? ` - ${slug.timeOfDay}` : ""}`;
  }
  if (heading && heading.trim()) return heading.trim();
  return `SCENE ${index + 1}`;
}

function toLines(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  return value
    .split(/\n+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Duration estimate shared by both parsers. This is the single estimator in
 * the package so text and structured screens agree.
 */
export function estimateSceneDuration(
  dialogue: { text: string; character: string }[],
  actionLines: string[],
): number {
  const dialogueWords = dialogue.reduce(
    (sum, line) => sum + countWords(line.text),
    0,
  );
  const actionWords = actionLines.reduce((sum, line) => sum + countWords(line), 0);
  // ~2.0 words/second spoken pace (120 wpm deliberate screen pacing).
  const dialogueSeconds = dialogueWords / 2.0;
  // ~3.0 words/second: action prose plays as visual beats, not narration
  // (calibrated so a full 45-second reference screenplay estimates ~45s).
  const actionSeconds = actionWords / 3.0;
  const total = dialogueSeconds + actionSeconds;
  return total > 0 ? Math.round(total * 10) / 10 : 0;
}

function splitDuration(
  dialogue: { text: string }[],
  actionLines: string[],
): { dialogueSeconds: number; actionSeconds: number } {
  const dialogueWords = dialogue.reduce(
    (sum, line) => sum + countWords(line.text),
    0,
  );
  const actionWords = actionLines.reduce((sum, line) => sum + countWords(line), 0);
  const dialogueSeconds = Math.round((dialogueWords / 2.0) * 10) / 10;
  const actionSeconds = Math.round((actionWords / 3.0) * 10) / 10;
  const total = dialogueSeconds + actionSeconds;
  if (total <= 0) return { dialogueSeconds: 0, actionSeconds: 0 };
  return { dialogueSeconds, actionSeconds };
}

export function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}