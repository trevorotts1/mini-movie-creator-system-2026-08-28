import { describe, expect, it } from "vitest";
import {
  PronunciationDictionaryBuilder,
  createPronunciationDictionary,
  deserializePronunciationDictionary,
  serializePronunciationDictionary,
  type PronunciationDictionary,
} from "./dictionary.js";
import { applyPronunciation } from "./apply.js";
import { resolveFishTtsRequest } from "./tts-request.js";

const MONICA_ENTRIES = [
  {
    id: "nguyen",
    term: "Nguyen",
    pronunciation: "Nwen",
    matchMode: "word-ci" as const,
  },
  {
    id: "pho",
    term: "pho",
    pronunciation: "fuh",
    matchMode: "word" as const,
  },
];

const MONICA_NOUNS = [
  { id: "sagon", term: "Saigon", language: "en-US" },
  { id: "ha-noi", term: "Hà Nội" },
];

function monicaDictionary(): PronunciationDictionary {
  return createPronunciationDictionary({
    characterId: "monica",
    entries: MONICA_ENTRIES,
    properNouns: MONICA_NOUNS,
  });
}

describe("createPronunciationDictionary", () => {
  it("creates an empty versioned dictionary for a character", () => {
    const dict = createPronunciationDictionary({ characterId: "monica" });
    expect(dict.characterId).toBe("monica");
    expect(dict.version).toBe(1);
    expect(dict.entries).toEqual([]);
    expect(dict.properNouns).toEqual([]);
  });

  it("rejects a missing characterId", () => {
    expect(() => createPronunciationDictionary({ characterId: "" })).toThrow(
      /characterId is required/,
    );
  });

  it("rejects invalid entries with precise messages", () => {
    expect(() =>
      createPronunciationDictionary({
        characterId: "m",
        entries: [{ id: "", term: "x", pronunciation: "y" }],
      }),
    ).toThrow(/entries\[0\]\.id/);
    expect(() =>
      createPronunciationDictionary({
        characterId: "m",
        entries: [{ id: "a", term: "  ", pronunciation: "y" }],
      }),
    ).toThrow(/entries\[0\]\.term/);
    expect(() =>
      createPronunciationDictionary({
        characterId: "m",
        properNouns: [{ id: "a", term: "x", pronunciation: 5 as unknown as string }],
      }),
    ).toThrow(/properNouns\[0\]\.pronunciation/);
  });

  it("rejects a non-positive seed version", () => {
    expect(() =>
      createPronunciationDictionary({ characterId: "m", version: 0 }),
    ).toThrow(/version must be a positive integer/);
  });
});

describe("PronunciationDictionaryBuilder versioning", () => {
  it("starts at the source version and bumps on each mutation", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    expect(builder.version).toBe(1);
    builder.setEntry({ id: "x", term: "Xu", pronunciation: "Sue" });
    expect(builder.version).toBe(2);
    builder.setProperNoun({ id: "danang", term: "Da Nang" });
    expect(builder.version).toBe(3);
    const dict = builder.build();
    expect(dict.version).toBe(3);
    expect(dict.entries).toHaveLength(3);
    expect(dict.properNouns).toHaveLength(3);
  });

  it("replacing by id bumps version exactly once", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    builder.setEntry({ id: "nguyen", term: "Nguyen", pronunciation: "Ng-wee-en" });
    expect(builder.version).toBe(2);
    const dict = builder.build();
    expect(dict.entries).toHaveLength(2);
    expect(dict.entries.find((e) => e.id === "nguyen")?.pronunciation).toBe("Ng-wee-en");
  });

  it("removeEntry bumps only when something was removed", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    builder.removeEntry("does-not-exist");
    expect(builder.version).toBe(1);
    builder.removeEntry("pho");
    expect(builder.version).toBe(2);
    expect(builder.build().entries.map((e) => e.id)).toEqual(["nguyen"]);
  });

  it("removeProperNoun bumps only when something was removed", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    builder.removeProperNoun("nope");
    expect(builder.version).toBe(1);
    builder.removeProperNoun("sagon");
    expect(builder.version).toBe(2);
    expect(builder.build().properNouns.map((n) => n.id)).toEqual(["ha-noi"]);
  });

  it("build snapshots are independent of later mutations", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    const snapshot = builder.build();
    builder.setEntry({ id: "late", term: "later", pronunciation: "lay-ter" });
    expect(snapshot.version).toBe(1);
    expect(snapshot.entries).toHaveLength(2);
  });
});

describe("serialize/deserialize", () => {
  it("round-trips the dictionary including version", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    builder.setProperNoun({ id: "danang", term: "Da Nang" });
    const dict = builder.build();
    const restored = deserializePronunciationDictionary(serializePronunciationDictionary(dict));
    expect(restored).toEqual(dict);
  });

  it("rejects malformed JSON and wrong shapes", () => {
    expect(() => deserializePronunciationDictionary("{not json")).toThrow(
      /invalid pronunciation dictionary JSON/,
    );
    expect(() => deserializePronunciationDictionary("42")).toThrow(
      /expected an object/,
    );
    expect(() => deserializePronunciationDictionary("{}")).toThrow(
      /characterId is required/,
    );
  });
});

describe("applyPronunciation", () => {
  it("applies word-ci entries case-insensitively on word boundaries", () => {
    const app = applyPronunciation("Nguyen runs past the nguyen shop", monicaDictionary());
    expect(app.ttsText).toBe("Nwen runs past the Nwen shop");
    expect(app.originalText).toBe("Nguyen runs past the nguyen shop");
    expect(app.applied).toEqual([
      { id: "nguyen", term: "Nguyen", pronunciation: "Nwen" },
    ]);
    expect(app.dictionaryVersion).toBe(1);
    expect(app.characterId).toBe("monica");
  });

  it("does not match inside larger words", () => {
    const app = applyPronunciation("photography in the pho shop", monicaDictionary());
    expect(app.ttsText).toBe("photography in the fuh shop");
  });

  it("keeps punctuation adjacent to rewrites", () => {
    const app = applyPronunciation('"Nguyen!" she said.', monicaDictionary());
    expect(app.ttsText).toBe('"Nwen!" she said.');
  });

  it("protects proper nouns by restoring exact casing", () => {
    const app = applyPronunciation("the flight from saigon to hà nội", monicaDictionary());
    // Both nouns matched case-insensitively and restored to canonical casing.
    expect(app.ttsText).toBe("the flight from Saigon to Hà Nội");
    expect(app.properNounsApplied).toEqual([
      { id: "sagon", term: "Saigon" },
      { id: "ha-noi", term: "Hà Nội" },
    ]);
  });

  it("proper nouns with explicit pronunciation are rewritten", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      properNouns: [{ id: "ngo", term: "Ngo", pronunciation: "Oh-go" }],
    });
    const app = applyPronunciation("ngo and NGO and Ngo", dict);
    expect(app.ttsText).toBe("Oh-go and Oh-go and Oh-go");
    expect(app.properNounsApplied).toEqual([{ id: "ngo", term: "Ngo" }]);
  });

  it("proper nouns are protected BEFORE pronunciation entries run", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      entries: [{ id: "go", term: "go", pronunciation: "goh", matchMode: "word-ci" }],
      properNouns: [{ id: "ngo", term: "Ngo" }],
    });
    const app = applyPronunciation("let it go, Ngo", dict);
    // "Ngo" must not have been hit by the "go" entry.
    expect(app.ttsText).toBe("let it goh, Ngo");
  });

  it("filters entries by language, untagged entries always apply", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      entries: [
        { id: "nguyen", term: "Nguyen", pronunciation: "Nwen", language: "vi-VN" },
        { id: "always", term: "ok", pronunciation: "oh-kay" },
      ],
    });
    const vi = applyPronunciation("Nguyen says ok", dict, { language: "vi-VN" });
    expect(vi.ttsText).toBe("Nwen says oh-kay");
    const en = applyPronunciation("Nguyen says ok", dict, { language: "en-US" });
    expect(en.ttsText).toBe("Nguyen says oh-kay");
    expect(en.applied.map((a) => a.id)).toEqual(["always"]);
  });

  it("supports substring mode for CJK terms without regex injection", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      entries: [{ id: "kanji", term: "東京", pronunciation: "とうきょう", matchMode: "substring" }],
    });
    const app = applyPronunciation("東京タワーへ行く", dict);
    expect(app.ttsText).toBe("とうきょうタワーへ行く");
  });

  it("literal mode replaces without regex semantics", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      entries: [
        { id: "lit", term: "C++ (a.b)", pronunciation: "C plus plus", matchMode: "literal" },
      ],
    });
    const app = applyPronunciation("I write C++ (a.b) daily", dict);
    expect(app.ttsText).toBe("I write C plus plus daily");
  });

  it("never mutates the input string and reports zero matches cleanly", () => {
    const input = "nothing matches here";
    const app = applyPronunciation(input, monicaDictionary());
    expect(app.ttsText).toBe(input);
    expect(app.applied).toEqual([]);
    expect(app.properNounsApplied).toEqual([]);
    expect(input).toBe("nothing matches here");
  });

  it("applies entries in insertion order so later entries see earlier rewrites", () => {
    const dict = createPronunciationDictionary({
      characterId: "monica",
      entries: [
        { id: "a", term: "alpha", pronunciation: "beta" },
        { id: "b", term: "beta", pronunciation: "gamma" },
      ],
    });
    const app = applyPronunciation("alpha", dict);
    expect(app.ttsText).toBe("gamma");
    expect(app.applied.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("resolveFishTtsRequest", () => {
  const dicts = new Map<string, PronunciationDictionary>([["monica", monicaDictionary()]]);

  it("rewrites request text and carries dictionary version", () => {
    const resolved = resolveFishTtsRequest(
      {
        characterId: "monica",
        text: "Nguyen opened the pho shop in saigon.",
        voice: { voiceId: "fish-voice-123" },
      },
      (id) => dicts.get(id),
    );
    expect(resolved.payload.text).toBe("Nwen opened the fuh shop in Saigon.");
    expect(resolved.payload.reference_id).toBe("fish-voice-123");
    expect(resolved.payload.model).toBeUndefined();
    expect(resolved.originalText).toBe("Nguyen opened the pho shop in saigon.");
    expect(resolved.pronunciation.dictionaryVersion).toBe(1);
  });

  it("passes model through when pinned", () => {
    const resolved = resolveFishTtsRequest(
      {
        characterId: "monica",
        text: "hi",
        voice: { voiceId: "v1" },
        model: "s2",
      },
      () => undefined,
    );
    expect(resolved.payload.model).toBe("s2");
  });

  it("falls back to pass-through with version 0 when no dictionary exists", () => {
    const resolved = resolveFishTtsRequest(
      { characterId: "stranger", text: "Nguyen who?", voice: { voiceId: "v1" } },
      () => undefined,
    );
    expect(resolved.payload.text).toBe("Nguyen who?");
    expect(resolved.pronunciation.dictionaryVersion).toBe(0);
    expect(resolved.pronunciation.applied).toEqual([]);
  });

  it("rejects invalid requests", () => {
    expect(() =>
      resolveFishTtsRequest(
        { characterId: "", text: "x", voice: { voiceId: "v" } },
        () => undefined,
      ),
    ).toThrow(/characterId is required/);
    expect(() =>
      resolveFishTtsRequest(
        { characterId: "m", text: "x", voice: { voiceId: " " } },
        () => undefined,
      ),
    ).toThrow(/voiceId is required/);
  });

  it("reflects a bumped dictionary version in new requests", () => {
    const builder = new PronunciationDictionaryBuilder(monicaDictionary());
    const before = resolveFishTtsRequest(
      { characterId: "monica", text: "Nguyen", voice: { voiceId: "v" } },
      () => builder.build(),
    );
    expect(before.pronunciation.dictionaryVersion).toBe(1);
    builder.setEntry({ id: "pho2", term: "banh mi", pronunciation: "bun me" });
    const after = resolveFishTtsRequest(
      { characterId: "monica", text: "Nguyen", voice: { voiceId: "v" } },
      () => builder.build(),
    );
    expect(after.pronunciation.dictionaryVersion).toBe(2);
  });
});