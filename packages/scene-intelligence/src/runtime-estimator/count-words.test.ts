import { describe, expect, it } from "vitest";

import { countWords, roundSeconds, validateScreenplayInput } from "./count-words.js";
import { RuntimeEstimatorError } from "./types.js";

describe("countWords", () => {
  it("returns 0 for empty and whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("counts single words and simple sentences", () => {
    expect(countWords("Hello")).toBe(1);
    expect(countWords("The quick brown fox jumps.")).toBe(5);
  });

  it("keeps apostrophe contractions as one word", () => {
    expect(countWords("don't stop")).toBe(2);
    expect(countWords("it's Monica's turn")).toBe(3);
  });

  it("splits on punctuation boundaries without counting bare marks", () => {
    expect(countWords("Wait-- no, stop!")).toBe(3);
    expect(countWords("...")).toBe(0);
    expect(countWords("---")).toBe(0);
  });

  it("counts hyphenated compounds as one word", () => {
    expect(countWords("a well-known face")).toBe(3);
  });

  it("counts ellipses-joined words as separate words", () => {
    expect(countWords("Wait… what?")).toBe(2);
  });

  it("handles unicode letters", () => {
    expect(countWords("café naïve")).toBe(2);
    expect(countWords("日本語 テスト")).toBe(2);
  });

  it("never throws on hostile text — it only counts", () => {
    const hostile = "'; DROP TABLE scenes; -- ${process.exit(1)} <script>alert(1)</script>";
    expect(() => countWords(hostile)).not.toThrow();
    expect(countWords(hostile)).toBeGreaterThan(0);
  });
});

describe("roundSeconds", () => {
  it("rounds to two decimals", () => {
    expect(roundSeconds(3.14159)).toBe(3.14);
    expect(roundSeconds(2.005)).toBe(2.01);
    expect(roundSeconds(10)).toBe(10);
  });
});

describe("validateScreenplayInput", () => {
  const valid = {
    id: "EP_TEST",
    scenes: [{ id: "SC01", elements: [{ kind: "dialogue", text: "Hello." }] }],
  };

  it("accepts a valid input", () => {
    expect(() => validateScreenplayInput(valid)).not.toThrow();
  });

  it("rejects non-objects", () => {
    expect(() => validateScreenplayInput(null)).toThrow(RuntimeEstimatorError);
    expect(() => validateScreenplayInput("script")).toThrow(RuntimeEstimatorError);
  });

  it("rejects missing/empty id", () => {
    expect(() => validateScreenplayInput({ ...valid, id: "" })).toThrow(/non-empty string/);
    expect(() => validateScreenplayInput({ ...valid, id: 42 })).toThrow(/non-empty string/);
  });

  it("rejects missing scenes array", () => {
    expect(() => validateScreenplayInput({ id: "X" })).toThrow(/scenes must be an array/);
  });

  it("rejects scenes without id", () => {
    expect(() => validateScreenplayInput({ id: "X", scenes: [{ elements: [] }] })).toThrow(
      /scenes\[0\].id/,
    );
  });

  it("rejects unknown element kinds", () => {
    expect(() =>
      validateScreenplayInput({ id: "X", scenes: [{ id: "SC01", elements: [{ kind: "montage", text: "x" }] }] }),
    ).toThrow(/kind must be/);
  });

  it("rejects non-string element text", () => {
    expect(() =>
      validateScreenplayInput({ id: "X", scenes: [{ id: "SC01", elements: [{ kind: "action", text: 5 }] }] }),
    ).toThrow(/text must be a string/);
  });

  it("locates the failing scene by index", () => {
    expect(() =>
      validateScreenplayInput({
        id: "X",
        scenes: [
          { id: "SC01", elements: [] },
          { id: "SC02", elements: [{ kind: "nope", text: "x" }] },
        ],
      }),
    ).toThrow(/scenes\[1\]/);
  });
});