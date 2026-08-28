/**
 * GHL-007 tests — URL/file validation (spec §29 security baseline).
 * Pure-function tests; no network, no filesystem, no credentials.
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_URL_SCHEMES,
  MAX_GENERAL_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  MEDIA_CATEGORIES,
  MEDIA_MIME_TYPES,
  ValidationError,
  checkFilename,
  extensionForMimeType,
  isPrivateHost,
  isSafeFilename,
  maxBytesForCategory,
  mimeCategory,
  normalizeMimeType,
  sanitizeFilename,
  validateFileSize,
  validateMediaFile,
  validateMimeType,
  validateRemoteUrl,
} from "./index.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.code;
    throw error;
  }
  return "NO_THROW";
}

describe("validateRemoteUrl — scheme allowlist", () => {
  it("accepts a plain https URL", () => {
    const url = validateRemoteUrl("https://files.example.com/abc.png");
    expect(url.hostname).toBe("files.example.com");
    expect(url.protocol).toBe("https:");
  });

  it("rejects http", () => {
    expect(codeOf(() => validateRemoteUrl("http://files.example.com/a.png"))).toBe(
      "DISALLOWED_SCHEME",
    );
  });

  it("rejects ftp, file, data, and javascript schemes", () => {
    for (const raw of [
      "ftp://files.example.com/a.png",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      expect(codeOf(() => validateRemoteUrl(raw))).toBe("DISALLOWED_SCHEME");
    }
  });

  it("exposes the allowlist as https-only", () => {
    expect(ALLOWED_URL_SCHEMES).toEqual(["https:"]);
  });

  it("rejects unparseable and empty URLs", () => {
    expect(codeOf(() => validateRemoteUrl("not a url"))).toBe("INVALID_URL");
    expect(codeOf(() => validateRemoteUrl(""))).toBe("INVALID_URL");
    expect(codeOf(() => validateRemoteUrl("   "))).toBe("INVALID_URL");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(codeOf(() => validateRemoteUrl(undefined as any))).toBe("INVALID_URL");
  });

  it("accepts an explicit https default port (443) and rejects others", () => {
    expect(validateRemoteUrl("https://files.example.com:443/a.png").port).toBe("");
    expect(codeOf(() => validateRemoteUrl("https://files.example.com:8080/a.png"))).toBe(
      "DISALLOWED_PORT",
    );
    expect(codeOf(() => validateRemoteUrl("https://files.example.com:80/a.png"))).toBe(
      "DISALLOWED_PORT",
    );
    expect(codeOf(() => validateRemoteUrl("https://files.example.com:22/a.png"))).toBe(
      "DISALLOWED_PORT",
    );
  });

  it("rejects URLs with embedded credentials", () => {
    expect(codeOf(() => validateRemoteUrl("https://user:pass@files.example.com/a.png"))).toBe(
      "EMBEDDED_CREDENTIALS",
    );
    expect(codeOf(() => validateRemoteUrl("https://token@files.example.com/a.png"))).toBe(
      "EMBEDDED_CREDENTIALS",
    );
  });
});

describe("validateRemoteUrl — SSRF guard (no private ranges)", () => {
  it("rejects loopback IPv4 and localhost names", () => {
    expect(codeOf(() => validateRemoteUrl("https://127.0.0.1/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://127.1.2.3/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://localhost/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://sub.localhost/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://0.0.0.0/a.png"))).toBe("PRIVATE_HOST");
  });

  it("rejects RFC1918 private ranges", () => {
    for (const host of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(codeOf(() => validateRemoteUrl(`https://${host}/a.png`))).toBe("PRIVATE_HOST");
    }
  });

  it("rejects link-local, CGNAT, multicast, and reserved ranges", () => {
    for (const host of ["169.254.1.1", "100.64.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
      expect(codeOf(() => validateRemoteUrl(`https://${host}/a.png`))).toBe("PRIVATE_HOST");
    }
  });

  it("rejects the cloud metadata endpoints", () => {
    expect(codeOf(() => validateRemoteUrl("https://169.254.169.254/latest/meta-data/"))).toBe(
      "PRIVATE_HOST",
    );
    expect(codeOf(() => validateRemoteUrl("https://metadata.google.internal/computeMetadata/v1/"))).toBe(
      "PRIVATE_HOST",
    );
  });

  it("rejects IPv6 loopback, link-local, unique-local, and IPv4-mapped privates", () => {
    expect(codeOf(() => validateRemoteUrl("https://[::1]/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://[fe80::1]/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://[fd00::1]/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://[::ffff:127.0.0.1]/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://[::ffff:10.0.0.5]/a.png"))).toBe("PRIVATE_HOST");
  });

  it("rejects .internal and .local names", () => {
    expect(codeOf(() => validateRemoteUrl("https://storage.internal/a.png"))).toBe("PRIVATE_HOST");
    expect(codeOf(() => validateRemoteUrl("https://nas.local/a.png"))).toBe("PRIVATE_HOST");
  });

  it("rejects a hostname that is only a dot (FQDN root)", () => {
    expect(codeOf(() => validateRemoteUrl("https://./a.png"))).toBe("PRIVATE_HOST");
  });

  it("accepts public hosts including the GHL storage domain shape", () => {
    for (const host of [
      "files.benefitsfromsunnysideups.com",
      "storage.googleapis.com",
      "firebasestorage.googleapis.com",
      "services.leadconnectorhq.com",
      "203.0.113.10", // TEST-NET-3 documentation range: public, not RFC1918
    ]) {
      expect(validateRemoteUrl(`https://${host}/x.png`).hostname).toBe(host);
    }
  });

  it("isPrivateHost matches the URL-level guard", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("192.168.0.15")).toBe(true);
    expect(isPrivateHost("172.20.1.1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just outside RFC1918
  });
});

describe("sanitizeFilename — path traversal safety", () => {
  it("flattens traversal sequences", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.png")).toBe("c.png");
    expect(sanitizeFilename("..\\..\\windows\\system32\\evil.png")).toBe("evil.png");
    expect(sanitizeFilename("/absolute/path/file.mp4")).toBe("file.mp4");
    expect(sanitizeFilename("C:\\Users\\victim\\secret.png")).toBe("secret.png");
  });

  it("never returns a name containing a separator or dot-dot", () => {
    for (const raw of [
      "../../.ssh/id_rsa",
      "foo/../../bar.png",
      "a/b\\c/d.mov",
      "....//....//etc/cron.d/x",
      "~/../../root/.bashrc",
    ]) {
      const safe = sanitizeFilename(raw);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
      expect(safe).not.toContain("..");
    }
  });

  it("removes control characters and Windows-reserved characters", () => {
    expect(sanitizeFilename("bad\u0000name.png")).toBe("badname.png");
    expect(sanitizeFilename("weird:name*?.png")).toBe("weirdname.png");
    expect(sanitizeFilename("quote\"pipe|.png")).toBe("quotepipe.png");
  });

  it("handles reserved device names and trailing dots/spaces", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("nul.txt")).toBe("_nul.txt");
    expect(sanitizeFilename("COM1")).toBe("_COM1");
    expect(sanitizeFilename("report. ")).toBe("report");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeFilename("  spaced   out .png  ")).toBe("spaced out .png");
  });

  it("caps length while preserving the extension", () => {
    const long = "x".repeat(300) + ".png";
    const safe = sanitizeFilename(long);
    expect(safe.length).toBeLessThanOrEqual(200);
    expect(safe.endsWith(".png")).toBe(true);
  });

  it("falls back for degenerate input", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("///")).toBe("file");
  });

  it("isSafeFilename agrees with sanitizeFilename", () => {
    expect(isSafeFilename("episode-01-shot-03.png")).toBe(true);
    expect(isSafeFilename("../evil.png")).toBe(false);
    expect(isSafeFilename("")).toBe(false);
  });

  it("checkFilename reports whether sanitization changed the name", () => {
    expect(checkFilename("clean.png")).toEqual({ sanitized: false, filename: "clean.png" });
    const result = checkFilename("../../dirty.png");
    expect(result.sanitized).toBe(true);
    expect(result.filename).toBe("dirty.png");
    expect(codeOf(() => checkFilename("   "))).toBe("EMPTY_FILENAME");
  });
});

describe("validateMimeType — media category checks", () => {
  it("accepts every archived image/video/audio MIME type", () => {
    for (const category of MEDIA_CATEGORIES) {
      for (const mime of MEDIA_MIME_TYPES[category]) {
        expect(mimeCategory(mime)).toBe(category);
        expect(validateMimeType(mime).category).toBe(category);
      }
    }
  });

  it("normalizes case and parameters", () => {
    expect(normalizeMimeType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(validateMimeType("Video/MP4; codecs=avc1").mimeType).toBe("video/mp4");
  });

  it("rejects non-media MIME types (spec §29: content-type allowlist)", () => {
    expect(codeOf(() => validateMimeType("text/html"))).toBe("DISALLOWED_MIME_TYPE");
    expect(codeOf(() => validateMimeType("application/javascript"))).toBe("DISALLOWED_MIME_TYPE");
    expect(codeOf(() => validateMimeType("application/x-sh"))).toBe("DISALLOWED_MIME_TYPE");
    expect(codeOf(() => validateMimeType("application/octet-stream"))).toBe("DISALLOWED_MIME_TYPE");
  });

  it("falls back to the filename extension when MIME is absent", () => {
    expect(validateMimeType(undefined, "shot.png").mimeType).toBe("image/png");
    expect(validateMimeType("", "clip.MP4").category).toBe("video");
    expect(validateMimeType(null, "voice.mp3").category).toBe("audio");
    expect(codeOf(() => validateMimeType(undefined, "payload.exe"))).toBe("UNKNOWN_MIME_TYPE");
    expect(codeOf(() => validateMimeType(undefined, "noext"))).toBe("UNKNOWN_MIME_TYPE");
  });

  it("honors category restrictions", () => {
    expect(validateMimeType("video/mp4", undefined, { allowedCategories: ["video"] }).category).toBe(
      "video",
    );
    expect(codeOf(() => validateMimeType("image/png", undefined, { allowedCategories: ["video"] }))).toBe(
      "DISALLOWED_MIME_TYPE",
    );
  });

  it("maps MIME types to canonical extensions", () => {
    expect(extensionForMimeType("image/png")).toBe("png");
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("video/mp4")).toBe("mp4");
    expect(extensionForMimeType("video/quicktime")).toBe("mov");
    expect(extensionForMimeType("audio/mpeg")).toBe("mp3");
    expect(extensionForMimeType("application/zip")).toBeNull();
  });
});

describe("validateFileSize — 25 MB / 500 MB limits (spec §17)", () => {
  it("exposes the spec limits", () => {
    expect(MAX_GENERAL_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_VIDEO_FILE_BYTES).toBe(500 * 1024 * 1024);
    expect(maxBytesForCategory("video")).toBe(MAX_VIDEO_FILE_BYTES);
    expect(maxBytesForCategory("image")).toBe(MAX_GENERAL_FILE_BYTES);
    expect(maxBytesForCategory("audio")).toBe(MAX_GENERAL_FILE_BYTES);
  });

  it("accepts sizes within the limit and rejects over-limit", () => {
    validateFileSize(1024, "image");
    validateFileSize(25 * 1024 * 1024, "image"); // exactly at the limit
    expect(codeOf(() => validateFileSize(25 * 1024 * 1024 + 1, "image"))).toBe("FILE_TOO_LARGE");
    expect(codeOf(() => validateFileSize(501 * 1024 * 1024, "video"))).toBe("FILE_TOO_LARGE");
    validateFileSize(500 * 1024 * 1024, "video"); // exactly at the video limit
  });

  it("rejects empty and non-numeric sizes", () => {
    expect(codeOf(() => validateFileSize(0, "image"))).toBe("FILE_EMPTY");
    expect(codeOf(() => validateFileSize(-5, "video"))).toBe("FILE_EMPTY");
    expect(codeOf(() => validateFileSize(Number.NaN, "image"))).toBe("FILE_EMPTY");
  });

  it("supports an explicit custom limit", () => {
    validateFileSize(100, "image", { maxBytes: 100 });
    expect(codeOf(() => validateFileSize(101, "image", { maxBytes: 100 }))).toBe("FILE_TOO_LARGE");
  });
});

describe("validateMediaFile — combined MIME + size preflight", () => {
  it("validates both and returns the category", () => {
    expect(validateMediaFile("image/png", 1024)).toEqual({ category: "image", mimeType: "image/png" });
    expect(validateMediaFile("video/mp4", 499 * 1024 * 1024).category).toBe("video");
  });

  it("applies the category size limit", () => {
    // A 30 MB "image" exceeds the 25 MB general limit...
    expect(codeOf(() => validateMediaFile("image/png", 30 * 1024 * 1024))).toBe("FILE_TOO_LARGE");
    // ...but the same size is fine as video.
    expect(validateMediaFile("video/mp4", 30 * 1024 * 1024).category).toBe("video");
  });

  it("rejects bad MIME before checking size", () => {
    expect(codeOf(() => validateMediaFile("text/html", 1024))).toBe("DISALLOWED_MIME_TYPE");
  });
});