/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  ReferenceCountValidationError,
  WAN_REFERENCE_LIMITS,
  collectReferenceCountIssues,
  countReferences,
  validateReferenceCounts,
  type ReferenceCounts,
} from "./reference-count.js";

/** N distinct fake image URLs. */
function imageUrls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://assets.example.com/refs/img-${i}.png`);
}

/** N distinct fake video URLs. */
function videoUrls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://assets.example.com/refs/clip-${i}.mp4`);
}

/** N distinct fake audio URLs. */
function audioUrls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://assets.example.com/refs/vo-${i}.wav`);
}

const counts = (images: number, videos = 0, audio = 0): ReferenceCounts => ({
  images,
  videos,
  audio,
});

describe("Wan 3.0 profile constants", () => {
  it("carries the documented Wan baseline: 10 images / 5 videos / 5 audio, total UNKNOWN", () => {
    expect(WAN_REFERENCE_LIMITS.maxImages).toBe(10);
    expect(WAN_REFERENCE_LIMITS.maxVideos).toBe(5);
    expect(WAN_REFERENCE_LIMITS.maxAudio).toBe(5);
    expect(WAN_REFERENCE_LIMITS.maxFiles).toBeNull();
  });
});

describe("validateReferenceCounts — Wan reference images", () => {
  it("accepts exactly 10 reference images (the documented Wan maximum)", () => {
    expect(() =>
      validateReferenceCounts(WAN_REFERENCE_LIMITS, countReferences(imageUrls(10))),
    ).not.toThrow();
    expect(collectReferenceCountIssues(WAN_REFERENCE_LIMITS, counts(10))).toEqual([]);
  });

  it("rejects 11 reference images BEFORE any provider call", () => {
    const eleven = imageUrls(11);
    try {
      validateReferenceCounts(WAN_REFERENCE_LIMITS, countReferences(eleven));
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReferenceCountValidationError);
      const issues = (err as ReferenceCountValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.field).toBe("images");
      expect(issues[0]!.code).toBe("TOO_MANY_REFERENCES");
      expect(issues[0]!.message).toContain("at most 10");
      expect(issues[0]!.message).toContain("11");
    }
  });

  it("rejects a far-over-limit image payload (e.g. 25) with the same code", () => {
    const issues = collectReferenceCountIssues(WAN_REFERENCE_LIMITS, counts(25));
    expect(issues.map((i) => i.code)).toContain("TOO_MANY_REFERENCES");
    expect(issues.map((i) => i.field)).toContain("images");
  });
});

describe("validateReferenceCounts — per-kind counts against a profile", () => {
  it("accepts images/videos/audio within their respective maxima", () => {
    expect(() =>
      validateReferenceCounts(WAN_REFERENCE_LIMITS, {
        images: 10,
        videos: 5,
        audio: 5,
      }),
    ).not.toThrow();
  });

  it("rejects too many reference videos independently of images", () => {
    const issues = collectReferenceCountIssues(WAN_REFERENCE_LIMITS, {
      images: 2,
      videos: 6,
      audio: 0,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("videos");
    expect(issues[0]!.code).toBe("TOO_MANY_REFERENCES");
    expect(issues[0]!.message).toContain("at most 5");
    expect(issues[0]!.message).toContain("6");
  });

  it("rejects too many reference audio independently of images/videos", () => {
    const issues = collectReferenceCountIssues(WAN_REFERENCE_LIMITS, {
      images: 0,
      videos: 1,
      audio: 6,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("audio");
    expect(issues[0]!.code).toBe("TOO_MANY_REFERENCES");
  });

  it("collects EVERY violation in one pass, not just the first", () => {
    const issues = collectReferenceCountIssues(WAN_REFERENCE_LIMITS, {
      images: 11,
      videos: 6,
      audio: 6,
    });
    const fields = issues.map((i) => i.field).sort();
    expect(fields).toEqual(["audio", "images", "videos"]);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(["TOO_MANY_REFERENCES"]));
  });

  it("zero references always passes", () => {
    expect(() => validateReferenceCounts(WAN_REFERENCE_LIMITS, counts(0, 0, 0))).not.toThrow();
    expect(collectReferenceCountIssues(WAN_REFERENCE_LIMITS, counts(0, 0, 0))).toEqual([]);
  });
});

describe("UNKNOWN limits are never enforced (runbook §16: UNKNOWN is valid)", () => {
  it("passes any count when the profile limit is null — never a guessed limit", () => {
    const unknownProfile = { maxImages: null, maxVideos: null, maxAudio: null, maxFiles: null };
    expect(() => validateReferenceCounts(unknownProfile, counts(500, 500, 500))).not.toThrow();
    expect(collectReferenceCountIssues(unknownProfile, counts(500, 500, 500))).toEqual([]);
  });

  it("enforces only the maxima the profile actually states", () => {
    const partial = { maxImages: 2, maxVideos: null, maxAudio: null, maxFiles: null };
    expect(() => validateReferenceCounts(partial, counts(2, 99, 99))).not.toThrow();
    const issues = collectReferenceCountIssues(partial, counts(3, 99, 99));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("images");
  });

  it("rejects a negative or non-integer count even under a null limit", () => {
    const unknownProfile = { maxImages: null, maxVideos: null, maxAudio: null, maxFiles: null };
    const bad = { images: -1, videos: 1.5, audio: 0 } as unknown as ReferenceCounts;
    const issues = collectReferenceCountIssues(unknownProfile, bad);
    expect(issues.map((i) => i.field).sort()).toEqual(["images", "videos"]);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(["REFERENCE_COUNT_INVALID"]));
  });

  it("flags a malformed (non-integer, negative, non-numeric) profile limit", () => {
    const bogus = { maxImages: -1, maxVideos: 2.5, maxAudio: "ten", maxFiles: null } as unknown as {
      maxImages: number | null;
      maxVideos: number | null;
      maxAudio: number | null;
      maxFiles: number | null;
    };
    const issues = collectReferenceCountIssues(bogus, counts(0, 0, 0));
    // maxImages -1, maxVideos 2.5, maxAudio "ten" are ALL malformed limits —
    // each reported; counts of 0 never trip TOO_MANY_REFERENCES.
    expect(issues).toHaveLength(3);
    expect(new Set(issues.map((i) => i.code))).toEqual(new Set(["INVALID_PROFILE_LIMIT"]));
    expect(issues.every((i) => i.field === "profile")).toBe(true);
  });
});

describe("total reference files (maxFiles)", () => {
  it("rejects a total above maxFiles even when each kind is within its own max", () => {
    const profile = { maxImages: 10, maxVideos: 5, maxAudio: 5, maxFiles: 12 };
    // 10 + 5 = 15 total > 12, each kind individually legal.
    const issues = collectReferenceCountIssues(profile, counts(10, 5, 0));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("files");
    expect(issues[0]!.code).toBe("TOO_MANY_REFERENCE_FILES");
    expect(issues[0]!.message).toContain("at most 12");
    expect(issues[0]!.message).toContain("15");
  });

  it("accepts a total within maxFiles", () => {
    const profile = { maxImages: 10, maxVideos: 5, maxAudio: 5, maxFiles: 15 };
    expect(() => validateReferenceCounts(profile, counts(10, 5, 0))).not.toThrow();
  });

  it("ignores malformed counts when summing for maxFiles (per-kind invalid already reported)", () => {
    const profile = { maxImages: 10, maxVideos: 5, maxAudio: 5, maxFiles: 3 };
    const bad = { images: 2, videos: -5, audio: 0 } as unknown as ReferenceCounts;
    const issues = collectReferenceCountIssues(profile, bad);
    expect(issues.map((i) => i.code)).toContain("REFERENCE_COUNT_INVALID");
    expect(issues.map((i) => i.code)).not.toContain("TOO_MANY_REFERENCE_FILES");
  });
});

describe("countReferences — derive counts from request URL lists", () => {
  it("counts undefined lists as zero", () => {
    expect(countReferences()).toEqual({ images: 0, videos: 0, audio: 0 });
  });

  it("counts provided lists per kind", () => {
    expect(countReferences(imageUrls(11), videoUrls(1), audioUrls(2))).toEqual({
      images: 11,
      videos: 1,
      audio: 2,
    });
  });

  it("round-trips into the Wan rejection path", () => {
    expect(() =>
      validateReferenceCounts(WAN_REFERENCE_LIMITS, countReferences(imageUrls(11))),
    ).toThrow(ReferenceCountValidationError);
  });
});