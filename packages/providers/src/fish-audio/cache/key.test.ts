import { describe, expect, it } from "vitest";
import {
  canonicalizeRequest,
  dialogueCacheKey,
  displayKey,
  isCurrentKeyFormat,
  stableStringify,
  FISH_CACHE_KEY_VERSION,
} from "./key.js";
import type { FishDialogueRequest } from "./types.js";

const base: FishDialogueRequest = {
  text: "Monica: We leave at dawn.",
  voiceId: "voice-001",
  model: "s2-pro",
};

describe("dialogueCacheKey", () => {
  it("produces a versioned, 64-hex key", () => {
    const key = dialogueCacheKey(base);
    expect(key.startsWith(`${FISH_CACHE_KEY_VERSION}:`)).toBe(true);
    expect(isCurrentKeyFormat(key)).toBe(true);
    expect(key).toMatch(/^fsh1:[0-9a-f]{64}$/);
  });

  it("is idempotent: same request -> same key", () => {
    expect(dialogueCacheKey(base)).toBe(dialogueCacheKey(base));
  });

  it("same request with different property order -> same key", () => {
    const reordered: FishDialogueRequest = {
      model: "s2-pro",
      voiceId: "voice-001",
      text: "Monica: We leave at dawn.",
      format: "mp3",
      temperature: 0.7,
    };
    const ordered: FishDialogueRequest = {
      text: "Monica: We leave at dawn.",
      voiceId: "voice-001",
      model: "s2-pro",
      format: "mp3",
      temperature: 0.7,
    };
    expect(dialogueCacheKey(reordered)).toBe(dialogueCacheKey(ordered));
  });

  it("different text -> different key", () => {
    expect(dialogueCacheKey(base)).not.toBe(
      dialogueCacheKey({ ...base, text: "Monica: We stay." }),
    );
  });

  it("different voice -> different key", () => {
    expect(dialogueCacheKey(base)).not.toBe(
      dialogueCacheKey({ ...base, voiceId: "voice-002" }),
    );
  });

  it("different model -> different key", () => {
    expect(dialogueCacheKey(base)).not.toBe(
      dialogueCacheKey({ ...base, model: "s1" }),
    );
  });

  it("different format -> different key", () => {
    expect(dialogueCacheKey(base)).not.toBe(
      dialogueCacheKey({ ...base, format: "wav" }),
    );
  });

  it("different prosody -> different key", () => {
    expect(dialogueCacheKey(base)).not.toBe(
      dialogueCacheKey({ ...base, prosody: { speed: 1.2 } }),
    );
  });

  it("voice array order matters (S2 multi-speaker dialogue)", () => {
    expect(dialogueCacheKey({ ...base, voiceId: ["a", "b"] })).not.toBe(
      dialogueCacheKey({ ...base, voiceId: ["b", "a"] }),
    );
    expect(dialogueCacheKey({ ...base, voiceId: ["a", "b"] })).toBe(
      dialogueCacheKey({ ...base, voiceId: ["a", "b"] }),
    );
  });

  it("undefined vs absent fields are equivalent", () => {
    const withUndef = { ...base, format: undefined, temperature: undefined };
    expect(dialogueCacheKey(withUndef)).toBe(dialogueCacheKey(base));
  });

  it("untrusted story text is hashed, never interpreted", () => {
    const hostile: FishDialogueRequest = {
      text: '{"__proto__":{"polluted":true}}; process.exit(1); require("fs")',
      voiceId: "voice-001",
      model: "s2-pro",
    };
    const key = dialogueCacheKey(hostile);
    expect(isCurrentKeyFormat(key)).toBe(true);
    // Key is a pure hex digest — no script content can survive into it.
    expect(key.slice(5)).toMatch(/^[0-9a-f]{64}$/);
    // Prototype-pollution-shaped payloads must not alter stableStringify behavior.
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
  });
});

describe("canonicalizeRequest", () => {
  it("drops undefined fields and fixes emission order", () => {
    const canon = canonicalizeRequest({ text: "hi", voiceId: "v", model: "m" });
    expect(Object.keys(canon)).toEqual(["text", "voiceId", "model"]);
    expect(canon.format).toBeUndefined();
  });

  it("copies voice arrays defensively", () => {
    const voiceId = ["a", "b"];
    const canon = canonicalizeRequest({ ...base, voiceId });
    expect(canon.voiceId).toEqual(["a", "b"]);
    expect(canon.voiceId).not.toBe(voiceId);
  });
});

describe("displayKey", () => {
  it("truncates to a stable short form", () => {
    const key = dialogueCacheKey(base);
    const short = displayKey(key);
    expect(short.startsWith("fsh1:")).toBe(true);
    expect(short.length).toBe("fsh1:".length + 16);
    expect(key.startsWith(short)).toBe(true);
  });
});