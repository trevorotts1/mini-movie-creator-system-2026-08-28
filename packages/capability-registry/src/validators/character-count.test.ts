/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  countPromptCharacters,
  validateCharacterCount,
  type CharacterCountInput,
} from "./character-count.js";

/** Runbook §26.4 / CAP-002 registry: Wan 3.0 and Seedance 2.0 Mini hard max. */
const WAN_HARD_MAX = 20_000;

function input(
  hardMaxCharacters: number | null,
  value: string | readonly string[],
): CharacterCountInput {
  return { prompt: { hardMaxCharacters, value } };
}

describe("countPromptCharacters", () => {
  it("counts an empty string as 0", () => {
    expect(countPromptCharacters("")).toBe(0);
  });

  it("counts a plain ASCII string exactly", () => {
    expect(countPromptCharacters("hello world")).toBe(11);
  });

  it("counts every character including whitespace and newlines", () => {
    expect(countPromptCharacters("a b\nc\td")).toBe(7); // a, space, b, \n, c, \t, d
  });

  it("counts multibyte BMP characters as single UTF-16 code units", () => {
    // é is one BMP char; Greek, CJK and emoji-without-surrogate-pair too.
    expect(countPromptCharacters("café")).toBe(4);
    expect(countPromptCharacters("こんにちは")).toBe(5);
    expect(countPromptCharacters("电影大师")).toBe(4);
  });

  it("counts astral-plane characters as 2 UTF-16 code units (String.length convention)", () => {
    // U+1F3AC (clapperboard) is 2 UTF-16 code units — the convention JS SDKs
    // serialize and the one KIE-006's WAN_MAX_PROMPT_CHARS uses.
    expect(countPromptCharacters("🎬")).toBe(2);
    expect("🎬".length).toBe(2);
  });

  it("joins segments in order with no injected separators", () => {
    expect(countPromptCharacters(["abc", "def"])).toBe(6);
    expect(countPromptCharacters(["abc", "", "de"])).toBe(5);
    expect(countPromptCharacters([])).toBe(0);
    expect(countPromptCharacters(["ab", "cd"])).toBe(
      countPromptCharacters("abcd"),
    );
  });
});

describe("validateCharacterCount — known hard max", () => {
  it("passes a prompt at exactly the hard max (boundary is legal)", () => {
    const at = "x".repeat(WAN_HARD_MAX);
    const result = validateCharacterCount(input(WAN_HARD_MAX, at));
    expect(result).toEqual({
      ok: true,
      charCount: WAN_HARD_MAX,
      violations: [],
      limitUnknown: false,
    });
  });

  it("passes a prompt under the hard max", () => {
    const result = validateCharacterCount(input(WAN_HARD_MAX, "short prompt"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.charCount).toBe(12);
      expect(result.limitUnknown).toBe(false);
    }
  });

  it("rejects a Wan prompt of 20,001 characters (Wan >20,000 test)", () => {
    const over = "x".repeat(WAN_HARD_MAX + 1);
    const result = validateCharacterCount(input(WAN_HARD_MAX, over));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.charCount).toBe(20_001);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.code).toBe("PROMPT_TOO_LONG");
      expect(result.violations[0]?.field).toBe("prompt.value");
      expect(result.violations[0]?.message).toContain("20001");
      expect(result.violations[0]?.message).toContain("20000");
    }
  });

  it("rejects segment lists whose joined length exceeds the max even when each segment fits", () => {
    const halves = ["y".repeat(12_000), "y".repeat(12_000)] as const;
    const result = validateCharacterCount(input(WAN_HARD_MAX, halves));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.charCount).toBe(24_000);
      expect(result.violations[0]?.code).toBe("PROMPT_TOO_LONG");
    }
  });

  it("passes multibyte prompts that fit after UTF-16 counting", () => {
    // 15,000 emoji = 30,000 UTF-16 units > 20,000 → must reject.
    const result = validateCharacterCount(
      input(WAN_HARD_MAX, "🎬".repeat(15_000)),
    );
    expect(result.ok).toBe(false);
    // 9,000 emoji = 18,000 UTF-16 units ≤ 20,000 → must pass.
    const ok = validateCharacterCount(input(WAN_HARD_MAX, "🎬".repeat(9_000)));
    expect(ok.ok).toBe(true);
  });

  it("rejects over a small non-Wan max the same way", () => {
    const result = validateCharacterCount(input(10, "0123456789A"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe("PROMPT_TOO_LONG");
      expect(result.charCount).toBe(11);
    }
  });
});

describe("validateCharacterCount — UNKNOWN hard max (null)", () => {
  it("passes an over-20,000-char prompt when the limit is UNKNOWN (Agnes)", () => {
    // Never invent a limit: null hardMaxCharacters passes at ANY size.
    const huge = "z".repeat(WAN_HARD_MAX + 50_000);
    const result = validateCharacterCount(input(null, huge));
    expect(result).toEqual({
      ok: true,
      charCount: 70_000,
      violations: [],
      limitUnknown: true,
    });
  });

  it("passes an empty prompt when the limit is UNKNOWN", () => {
    expect(validateCharacterCount(input(null, ""))).toEqual({
      ok: true,
      charCount: 0,
      violations: [],
      limitUnknown: true,
    });
  });

  it("does not enforce the Wan max against a null-limit profile", () => {
    const over = "w".repeat(WAN_HARD_MAX + 1);
    const result = validateCharacterCount(input(null, over));
    expect(result.ok).toBe(true);
  });
});

describe("validateCharacterCount — corrupt limit handling", () => {
  it("fails with INVALID_LIMIT on a negative limit instead of passing everything", () => {
    const result = validateCharacterCount(input(-1, "abc"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.code).toBe("INVALID_LIMIT");
      expect(result.violations[0]?.field).toBe("prompt.hardMaxCharacters");
    }
  });

  it("fails with INVALID_LIMIT on NaN/Infinity", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY] as number[]) {
      const result = validateCharacterCount(input(bad, "abc"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations[0]?.code).toBe("INVALID_LIMIT");
      }
    }
  });
});

describe("messages are safe to log", () => {
  it("never embeds prompt content in violations", () => {
    const secret = "CONFIDENTIAL-SCRIPT-CONTENT-XYZ";
    const result = validateCharacterCount(input(5, secret));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.violations);
      expect(serialized).not.toContain("CONFIDENTIAL-SCRIPT-CONTENT-XYZ");
    }
  });
});