import { describe, expect, it } from "vitest";
import {
  CHARACTER_ID_MAX_SEQUENCE,
  CHARACTER_ID_MIN_SEQUENCE,
  CharacterIdError,
  formatCharacterId,
  isCanonicalSlug,
  isValidCharacterId,
  padSequence,
  parseCharacterId,
} from "./ids.js";
import {
  nextCharacterId,
  nextCharacterIdForSlug,
  sameCharacterId,
  slugifyCharacterName,
} from "./allocate.js";

describe("isValidCharacterId / parseCharacterId — spec §9 format", () => {
  it("accepts the spec §9 example shape", () => {
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_001")).toBe(true);
    expect(parseCharacterId("CHAR_MONICA_BENNETT_001")).toEqual({
      slug: "MONICA_BENNETT",
      sequence: 1,
    });
  });

  it("accepts multi-token names and higher sequences", () => {
    expect(isValidCharacterId("CHAR_JD_999")).toBe(true);
    expect(parseCharacterId("CHAR_THE_DOCTOR_042")).toEqual({
      slug: "THE_DOCTOR",
      sequence: 42,
    });
    expect(isValidCharacterId("CHAR_X1_007")).toBe(true);
  });

  it("rejects raw display names — IDs are never display-name-keyed", () => {
    expect(isValidCharacterId("Monica Bennett")).toBe(false);
    expect(isValidCharacterId("monica bennett")).toBe(false);
    expect(isValidCharacterId("Monica")).toBe(false);
  });

  it("rejects wrong prefix, lowercase, bad sequences", () => {
    expect(isValidCharacterId("LOC_MONICA_BENNETT_001")).toBe(false);
    expect(isValidCharacterId("char_monica_bennett_001")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_1")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_0001")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_000")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_BENNETT_1000")).toBe(false);
    expect(isValidCharacterId("CHAR__001")).toBe(false);
    expect(isValidCharacterId("CHAR_MONICA_001")).toBe(true);
  });

  it("rejects empty/digit-only name tokens that would blur the sequence field", () => {
    // Digit-only name tokens are ambiguous with the trailing 3-digit
    // sequence field — rejected in both parse and slug, consistently.
    expect(parseCharacterId("CHAR_007_002")).toBeNull();
    expect(isValidCharacterId("CHAR_001")).toBe(false); // only a sequence
    expect(isValidCharacterId("")).toBe(false);
    expect(isValidCharacterId("CHAR")).toBe(false);
  });

  it("rejects non-string input defensively", () => {
    expect(parseCharacterId(undefined as unknown as string)).toBeNull();
    expect(parseCharacterId(null as unknown as string)).toBeNull();
    expect(parseCharacterId(42 as unknown as string)).toBeNull();
  });
});

describe("formatCharacterId / padSequence", () => {
  it("formats canonical IDs with zero-padded sequences", () => {
    expect(formatCharacterId("MONICA_BENNETT", 1)).toBe("CHAR_MONICA_BENNETT_001");
    expect(formatCharacterId("MONICA_BENNETT", 42)).toBe("CHAR_MONICA_BENNETT_042");
    expect(formatCharacterId("MONICA_BENNETT", 999)).toBe("CHAR_MONICA_BENNETT_999");
    expect(padSequence(7)).toBe("007");
  });

  it("round-trips through parse", () => {
    const id = formatCharacterId("ROUND_TRIP", 5);
    expect(parseCharacterId(id)).toEqual({ slug: "ROUND_TRIP", sequence: 5 });
    expect(isValidCharacterId(id)).toBe(true);
  });

  it("throws on invalid slugs instead of repairing", () => {
    expect(() => formatCharacterId("monica bennett", 1)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("", 1)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("MONICA__BENNETT", 1)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("MONICA_", 1)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("_MONICA", 1)).toThrow(CharacterIdError);
  });

  it("throws on out-of-range sequences", () => {
    expect(() => formatCharacterId("MONICA", 0)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("MONICA", 1000)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("MONICA", 1.5)).toThrow(CharacterIdError);
    expect(() => formatCharacterId("MONICA", Number.NaN)).toThrow(CharacterIdError);
  });
});

describe("isCanonicalSlug", () => {
  it("accepts letter-bearing A-Z/0-9 tokens", () => {
    expect(isCanonicalSlug("MONICA_BENNETT")).toBe(true);
    expect(isCanonicalSlug("A")).toBe(true);
    expect(isCanonicalSlug("X1")).toBe(true);
    expect(isCanonicalSlug("2PAC")).toBe(true);
  });

  it("rejects empty, underscore-only, and digit-only tokens", () => {
    expect(isCanonicalSlug("")).toBe(false);
    expect(isCanonicalSlug("___")).toBe(false);
    expect(isCanonicalSlug("MONICA__BENNETT")).toBe(false);
    expect(isCanonicalSlug("MONICA_")).toBe(false);
    expect(isCanonicalSlug("_MONICA")).toBe(false);
    expect(isCanonicalSlug("007")).toBe(false); // digit-only: sequence ambiguity
    expect(isCanonicalSlug("MONICA_007")).toBe(false);
  });
});

describe("slugifyCharacterName — never display-name-keyed", () => {
  it("canonicalizes case, spacing, hyphens, underscores", () => {
    expect(slugifyCharacterName("Monica Bennett")).toBe("MONICA_BENNETT");
    expect(slugifyCharacterName("monica  bennett")).toBe("MONICA_BENNETT");
    expect(slugifyCharacterName("Monica-Bennett")).toBe("MONICA_BENNETT");
    expect(slugifyCharacterName("  Monica_Bennett ")).toBe("MONICA_BENNETT");
    expect(slugifyCharacterName("Dr. Who")).toBe("DR_WHO");
    expect(slugifyCharacterName("Émile")).toBe("MILE");
  });

  it("variant spellings of one name share one slug (one allocation lane)", () => {
    const issued = ["CHAR_MONICA_BENNETT_001"];
    expect(nextCharacterId({ displayName: "Monica Bennett" }, issued)).toBe(
      "CHAR_MONICA_BENNETT_002",
    );
    expect(nextCharacterId({ displayName: "monica bennett" }, issued)).toBe(
      "CHAR_MONICA_BENNETT_002",
    );
    expect(nextCharacterId({ displayName: "MONICA   BENNETT" }, issued)).toBe(
      "CHAR_MONICA_BENNETT_002",
    );
  });

  it("throws when nothing letter-bearing survives", () => {
    expect(() => slugifyCharacterName("")).toThrow(CharacterIdError);
    expect(() => slugifyCharacterName("   ")).toThrow(CharacterIdError);
    expect(() => slugifyCharacterName("123")).toThrow(CharacterIdError);
    expect(() => slugifyCharacterName("!!! 🎭 !!!")).toThrow(CharacterIdError);
  });
});

describe("nextCharacterId — stable allocation", () => {
  it("starts at 001 for a fresh name (spec example)", () => {
    expect(nextCharacterId({ displayName: "Monica Bennett" })).toBe(
      "CHAR_MONICA_BENNETT_001",
    );
  });

  it("is deterministic for the same name + issued set", () => {
    const issued = ["CHAR_MONICA_BENNETT_001", "CHAR_MONICA_BENNETT_002"];
    const a = nextCharacterId({ displayName: "Monica Bennett" }, issued);
    const b = nextCharacterId({ displayName: "Monica Bennett" }, issued);
    expect(a).toBe(b);
    expect(a).toBe("CHAR_MONICA_BENNETT_003");
  });

  it("fills the lowest unused sequence, surviving gaps", () => {
    const issued = ["CHAR_MONICA_BENNETT_001", "CHAR_MONICA_BENNETT_003"];
    expect(nextCharacterId({ displayName: "Monica Bennett" }, issued)).toBe(
      "CHAR_MONICA_BENNETT_002",
    );
  });

  it("ignores malformed entries in the issued set instead of crashing", () => {
    const issued = ["garbage", "Monica Bennett", "CHAR_OTHER_001", ""];
    expect(nextCharacterId({ displayName: "Monica Bennett" }, issued)).toBe(
      "CHAR_MONICA_BENNETT_001",
    );
  });

  it("does not collide across different name slugs", () => {
    const issued = ["CHAR_MONICA_BENNETT_001", "CHAR_MONICA_BENNETT_002"];
    expect(nextCharacterId({ displayName: "John Smith" }, issued)).toBe(
      "CHAR_JOHN_SMITH_001",
    );
  });

  it("throws once all 999 sequences are exhausted", () => {
    const issued: string[] = [];
    for (let s = CHARACTER_ID_MIN_SEQUENCE; s <= CHARACTER_ID_MAX_SEQUENCE; s += 1) {
      issued.push(formatCharacterId("FULL", s));
    }
    expect(() => nextCharacterId({ displayName: "Full" }, issued)).toThrow(
      /exhausted/,
    );
  });
});

describe("nextCharacterIdForSlug", () => {
  it("allocates for a canonical slug directly", () => {
    expect(nextCharacterIdForSlug("MONICA_BENNETT", [])).toBe("CHAR_MONICA_BENNETT_001");
    expect(
      nextCharacterIdForSlug("MONICA_BENNETT", ["CHAR_MONICA_BENNETT_001"]),
    ).toBe("CHAR_MONICA_BENNETT_002");
  });

  it("rejects non-canonical slugs", () => {
    expect(() => nextCharacterIdForSlug("monica bennett")).toThrow(CharacterIdError);
    expect(() => nextCharacterIdForSlug("")).toThrow(CharacterIdError);
    expect(() => nextCharacterIdForSlug("007")).toThrow(CharacterIdError);
  });

  it("accepts any iterable (Set, generator)", () => {
    const issued = new Set(["CHAR_A_001", "CHAR_A_002"]);
    expect(nextCharacterIdForSlug("A", issued)).toBe("CHAR_A_003");
    function* gen(): Iterable<string> {
      yield "CHAR_B_001";
    }
    expect(nextCharacterIdForSlug("B", gen())).toBe("CHAR_B_002");
  });
});

describe("sameCharacterId", () => {
  it("matches canonical IDs and rejects junk on either side", () => {
    expect(sameCharacterId("CHAR_MONICA_BENNETT_001", "CHAR_MONICA_BENNETT_001")).toBe(true);
    expect(sameCharacterId("CHAR_MONICA_BENNETT_001", "CHAR_MONICA_BENNETT_002")).toBe(false);
    expect(sameCharacterId("CHAR_MONICA_BENNETT_001", "Monica Bennett")).toBe(false);
    expect(sameCharacterId("nonsense", "CHAR_MONICA_BENNETT_001")).toBe(false);
    expect(sameCharacterId("nonsense", "also nonsense")).toBe(false);
  });
});

describe("COLLISION — 1000 generated IDs are unique", () => {
  it("a full single-slug field (999 IDs) is unique, and the 1000th allocation fails loudly instead of colliding", () => {
    const issued: string[] = [];
    for (let i = 0; i < CHARACTER_ID_MAX_SEQUENCE; i += 1) {
      const id = nextCharacterId({ displayName: "Monica Bennett" }, issued);
      expect(isValidCharacterId(id)).toBe(true);
      issued.push(id);
    }
    expect(new Set(issued).size).toBe(999);
    // Deterministic shape: first is the spec example, last fills the field.
    expect(issued[0]).toBe("CHAR_MONICA_BENNETT_001");
    expect(issued[issued.length - 1]).toBe("CHAR_MONICA_BENNETT_999");
    // The sequence field is exhausted — never silently reuse or collide.
    expect(() => nextCharacterId({ displayName: "Monica Bennett" }, issued)).toThrow(
      /exhausted/,
    );
  });

  it("1000 IDs across many names never collide, and re-deriving from the issued set reproduces them", () => {
    const names = [
      "Monica Bennett",
      "John Smith",
      "Dr. Who",
      "X1",
      "Anna-Marie O'Neill",
    ];
    const issued = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const name = names[i % names.length] as string;
      const id = nextCharacterId({ displayName: name }, issued);
      expect(issued.has(id)).toBe(false); // hard collision assertion
      expect(isValidCharacterId(id)).toBe(true);
      issued.add(id);
    }
    expect(issued.size).toBe(1000);
    // Every slug's allocation is gap-free from 001 upward.
    const bySlug = new Map<string, number[]>();
    for (const id of issued) {
      const parsed = parseCharacterId(id);
      if (parsed === null) throw new Error(`unparseable ID in set: ${id}`);
      const list = bySlug.get(parsed.slug) ?? [];
      list.push(parsed.sequence);
      bySlug.set(parsed.slug, list);
    }
    for (const [slug, seqs] of bySlug) {
      seqs.sort((a, b) => a - b);
      expect(seqs[0]).toBe(1);
      expect(isCanonicalSlug(slug)).toBe(true);
      for (let i = 0; i < seqs.length; i += 1) {
        expect(seqs[i]).toBe(i + 1); // contiguous 1..N, no gaps, no dupes
      }
    }
  });
});