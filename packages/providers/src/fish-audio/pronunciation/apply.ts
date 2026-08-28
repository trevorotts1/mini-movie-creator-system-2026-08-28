/**
 * Text rewriting that applies a pronunciation dictionary and proper-noun
 * protection to TTS input before it reaches the Fish Audio /tts endpoint.
 *
 * Fish Audio has no server-side lexicon API; pronunciations are enforced by
 * rewriting the request text, so every rewrite must be deterministic and
 * reversible-in-effect (captions are generated from the ORIGINAL text
 * elsewhere — this module never mutates caller input).
 */

import type {
  PronunciationDictionary,
  PronunciationEntry,
} from "./dictionary.js";

/** Result of applying a dictionary to one piece of TTS text. */
export interface PronunciationApplication {
  /** Text to send to Fish Audio TTS (rewritten). */
  ttsText: string;
  /** Original input text — untouched; captions/alignment use this. */
  originalText: string;
  /** Dictionary version the rewrite was computed against. */
  dictionaryVersion: number;
  /** Character ID owning the dictionary that was applied. */
  characterId: string;
  /** Entries whose term matched and was rewritten, in application order. */
  applied: Array<{ id: string; term: string; pronunciation: string }>;
  /** Proper nouns that matched and were protected/rewritten. */
  properNounsApplied: Array<{ id: string; term: string }>;
}

/** Options for `applyPronunciation`. */
export interface ApplyPronunciationOptions {
  /**
   * Restrict to entries/proper nouns with this BCP-47 language tag.
   * Entries without a language tag always apply.
   */
  language?: string;
}

/** Build the RegExp for an entry's match mode. */
function entryRegExp(entry: PronunciationEntry): RegExp | null {
  const term = entry.term;
  if (term === "") return null;
  switch (entry.matchMode ?? "word") {
    case "word":
    case "word-ci": {
      // \p{L}\p{N} word chars so hyphenated names like "O'Brien" or "X-37"
      // match as one word; lookbehind/ahead keeps adjacent punctuation.
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
        entry.matchMode === "word-ci" ? "giu" : "gu",
      );
    }
    case "substring":
      return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
    case "literal":
      return null; // handled via split/join to avoid any regex semantics
    default:
      return null;
  }
}

/** Apply one entry to the text, returning [newText, replacementCount]. */
function applyEntry(
  text: string,
  entry: PronunciationEntry,
): { text: string; count: number } {
  const mode = entry.matchMode ?? "word";
  if (mode === "literal") {
    let count = 0;
    let out = text;
    let idx = out.indexOf(entry.term);
    while (idx !== -1) {
      count += 1;
      out =
        out.slice(0, idx) +
        entry.pronunciation +
        out.slice(idx + entry.term.length);
      idx = out.indexOf(entry.term, idx + entry.pronunciation.length);
    }
    return { text: out, count };
  }
  const re = entryRegExp(entry);
  if (!re) return { text, count: 0 };
  let count = 0;
  const out = text.replace(re, () => {
    count += 1;
    return entry.pronunciation;
  });
  return { text: out, count };
}

/** Case-insensitive whole-word matcher for proper-noun protection. */
function properNounRegExp(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Apply a pronunciation dictionary to TTS text.
 *
 * Order: proper-noun protection runs FIRST (so an entry that rewrites a
 * substring of a proper noun cannot corrupt the noun), then pronunciation
 * entries in insertion order. Deterministic; never mutates the input.
 */
export function applyPronunciation(
  text: string,
  dictionary: PronunciationDictionary,
  options: ApplyPronunciationOptions = {},
): PronunciationApplication {
  if (typeof text !== "string") {
    throw new Error("text must be a string");
  }
  if (!dictionary || typeof dictionary !== "object") {
    throw new Error("dictionary is required");
  }

  const applied: PronunciationApplication["applied"] = [];
  const properNounsApplied: PronunciationApplication["properNounsApplied"] = [];

  let ttsText = text;

  // 1. Proper nouns: protect (or rewrite with their explicit pronunciation).
  for (const noun of dictionary.properNouns) {
    if (noun.language && options.language && noun.language !== options.language) {
      continue;
    }
    if (noun.term === "") continue;
    if (noun.pronunciation !== undefined && noun.pronunciation !== "") {
      const re = properNounRegExp(noun.term);
      let count = 0;
      ttsText = ttsText.replace(re, () => {
        count += 1;
        return noun.pronunciation as string;
      });
      if (count > 0) {
        properNounsApplied.push({ id: noun.id, term: noun.term });
      }
    } else {
      // Protection only: ensure the exact casing is preserved for the noun.
      const re = properNounRegExp(noun.term);
      let count = 0;
      ttsText = ttsText.replace(re, () => {
        count += 1;
        return noun.term;
      });
      if (count > 0) {
        properNounsApplied.push({ id: noun.id, term: noun.term });
      }
    }
  }

  // 2. Pronunciation entries, in insertion order.
  for (const entry of dictionary.entries) {
    if (entry.language && options.language && entry.language !== options.language) {
      continue;
    }
    const { text: next, count } = applyEntry(ttsText, entry);
    if (count > 0) {
      ttsText = next;
      applied.push({
        id: entry.id,
        term: entry.term,
        pronunciation: entry.pronunciation,
      });
    }
  }

  return {
    ttsText,
    originalText: text,
    dictionaryVersion: dictionary.version,
    characterId: dictionary.characterId,
    applied,
    properNounsApplied,
  };
}