/**
 * Pronunciation dictionary entry for one word/phrase.
 *
 * MMCS spec section 30: the canonical character voice profile stores a
 * pronunciation dictionary plus important proper nouns. Fish Audio applies
 * pronunciations by rewriting TTS text before synthesis (the /tts API has no
 * separate lexicon endpoint), so an entry carries the replacement text and the
 * exact match rule that triggers it.
 */

/** How an entry's term matches text. */
export type PronunciationMatchMode =
  /** Case-sensitive whole-word match (Latin scripts). Default. */
  | "word"
  /** Case-insensitive whole-word match (Latin scripts). */
  | "word-ci"
  /** Substring match (CJK and scripts without word boundaries). */
  | "substring"
  /** Literal case-sensitive substring match. */
  | "literal";

/** One pronunciation rewrite rule. */
export interface PronunciationEntry {
  /** Unique key within the dictionary (e.g. "nguyen", "s01e09-monica"). */
  id: string;
  /** The term to match in TTS text. */
  term: string;
  /**
   * Text substituted into the TTS request — phonetic respelling, phoneme
   * markup, or any other Fish-friendly representation of the pronunciation.
   */
  pronunciation: string;
  /** Match strategy. Default: "word". */
  matchMode?: PronunciationMatchMode;
  /**
   * Language tag the entry applies to (BCP-47, e.g. "vi-VN", "en-US").
   * Advisory metadata; the dictionary is filtered by language if provided.
   */
  language?: string;
  /** Free-form note (source of the pronunciation, approval state, etc.). */
  note?: string;
}

/** A proper noun the TTS engine should not mangle. */
export interface ProperNoun {
  /** Unique key within the dictionary. */
  id: string;
  /** The proper noun as it appears in scripts. */
  term: string;
  /** Optional spoken form to substitute; when absent the noun is only protected. */
  pronunciation?: string;
  /** Optional language tag (BCP-47). */
  language?: string;
}

/**
 * A versioned per-character pronunciation dictionary.
 *
 * `version` is a monotonic integer: every mutation through the dictionary
 * methods bumps it, so TTS requests can pin and report the exact dictionary
 * version they were generated against.
 */
export interface PronunciationDictionary {
  /** Owning character ID (spec section 30 canonical voice profile). */
  readonly characterId: string;
  /** Monotonic dictionary version; starts at 1. */
  readonly version: number;
  /** All pronunciation entries, in insertion order. */
  readonly entries: readonly PronunciationEntry[];
  /** All protected proper nouns, in insertion order. */
  readonly properNouns: readonly ProperNoun[];
}

/** Options for `createPronunciationDictionary`. */
export interface CreateDictionaryOptions {
  characterId: string;
  /** Initial version when seeding from persisted state. Default: 1. */
  version?: number;
  entries?: readonly PronunciationEntry[];
  properNouns?: readonly ProperNoun[];
}

/** Validate one entry; throws with a precise message on bad input. */
function assertEntry(entry: PronunciationEntry, index: number): void {
  if (!entry || typeof entry !== "object") {
    throw new Error(`entries[${index}] must be an object`);
  }
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    throw new Error(`entries[${index}].id must be a non-empty string`);
  }
  if (typeof entry.term !== "string" || entry.term.trim() === "") {
    throw new Error(`entries[${index}].term must be a non-empty string`);
  }
  if (typeof entry.pronunciation !== "string" || entry.pronunciation.trim() === "") {
    throw new Error(`entries[${index}].pronunciation must be a non-empty string`);
  }
}

/** Validate one proper noun; throws with a precise message on bad input. */
function assertProperNoun(noun: ProperNoun, index: number): void {
  if (!noun || typeof noun !== "object") {
    throw new Error(`properNouns[${index}] must be an object`);
  }
  if (typeof noun.id !== "string" || noun.id.trim() === "") {
    throw new Error(`properNouns[${index}].id must be a non-empty string`);
  }
  if (typeof noun.term !== "string" || noun.term.trim() === "") {
    throw new Error(`properNouns[${index}].term must be a non-empty string`);
  }
  if (noun.pronunciation !== undefined && typeof noun.pronunciation !== "string") {
    throw new Error(`properNouns[${index}].pronunciation must be a string when present`);
  }
}

/** Create an empty dictionary for a character. */
export function createPronunciationDictionary(
  options: CreateDictionaryOptions,
): PronunciationDictionary {
  if (typeof options.characterId !== "string" || options.characterId.trim() === "") {
    throw new Error("characterId is required");
  }
  const entries = [...(options.entries ?? [])];
  const properNouns = [...(options.properNouns ?? [])];
  entries.forEach(assertEntry);
  properNouns.forEach(assertProperNoun);
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("version must be a positive integer");
  }
  return {
    characterId: options.characterId,
    version,
    entries,
    properNouns,
  };
}

/**
 * Mutable working copy of a dictionary. Mutations bump `version`, so callers
 * can pin TTS requests to the exact dictionary state used.
 */
export class PronunciationDictionaryBuilder {
  private characterId: string;
  private currentVersion: number;
  private entryList: PronunciationEntry[];
  private properNounList: ProperNoun[];

  constructor(source: PronunciationDictionary) {
    this.characterId = source.characterId;
    this.currentVersion = source.version;
    this.entryList = [...source.entries];
    this.properNounList = [...source.properNouns];
  }

  /** Current version (bumped by each mutation below). */
  get version(): number {
    return this.currentVersion;
  }

  /** Add (or replace by id) a pronunciation entry. Bumps version. */
  setEntry(entry: PronunciationEntry): this {
    assertEntry(entry, this.entryList.length);
    const existing = this.entryList.findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      this.entryList[existing] = entry;
    } else {
      this.entryList.push(entry);
    }
    this.currentVersion += 1;
    return this;
  }

  /** Remove an entry by id. Bumps version only when something was removed. */
  removeEntry(id: string): this {
    const before = this.entryList.length;
    this.entryList = this.entryList.filter((e) => e.id !== id);
    if (this.entryList.length !== before) {
      this.currentVersion += 1;
    }
    return this;
  }

  /** Add (or replace by id) a protected proper noun. Bumps version. */
  setProperNoun(noun: ProperNoun): this {
    assertProperNoun(noun, this.properNounList.length);
    const existing = this.properNounList.findIndex((n) => n.id === noun.id);
    if (existing >= 0) {
      this.properNounList[existing] = noun;
    } else {
      this.properNounList.push(noun);
    }
    this.currentVersion += 1;
    return this;
  }

  /** Remove a proper noun by id. Bumps version only when something was removed. */
  removeProperNoun(id: string): this {
    const before = this.properNounList.length;
    this.properNounList = this.properNounList.filter((n) => n.id !== id);
    if (this.properNounList.length !== before) {
      this.currentVersion += 1;
    }
    return this;
  }

  /** Snapshot the current state as an immutable dictionary. */
  build(): PronunciationDictionary {
    return {
      characterId: this.characterId,
      version: this.currentVersion,
      entries: [...this.entryList],
      properNouns: [...this.properNounList],
    };
  }
}

/** Serialize a dictionary to a JSON-safe plain object (persisted per character). */
export function serializePronunciationDictionary(
  dictionary: PronunciationDictionary,
): string {
  return JSON.stringify({
    characterId: dictionary.characterId,
    version: dictionary.version,
    entries: dictionary.entries,
    properNouns: dictionary.properNouns,
  });
}

/** Rehydrate a dictionary from `serializePronunciationDictionary` output. */
export function deserializePronunciationDictionary(json: string): PronunciationDictionary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`invalid pronunciation dictionary JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid pronunciation dictionary JSON: expected an object");
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.characterId !== "string" || raw.characterId.trim() === "") {
    throw new Error("invalid pronunciation dictionary JSON: characterId is required");
  }
  const entries = Array.isArray(raw.entries) ? (raw.entries as PronunciationEntry[]) : [];
  const properNouns = Array.isArray(raw.properNouns)
    ? (raw.properNouns as ProperNoun[])
    : [];
  const version = typeof raw.version === "number" ? raw.version : 1;
  return createPronunciationDictionary({
    characterId: raw.characterId,
    version,
    entries,
    properNouns,
  });
}