import { describe, it, expect } from "vitest";
import {
  GHL_API_BASE_URL,
  GHL_API_VERSION,
  GHL_AUTH_HEADER,
  GHL_TOKEN_KIND_ENV_VAR,
  GHL_TOKEN_EXPIRES_AT_ENV_VAR,
  GHL_VERSION_HEADER,
  createGhlAuthConfig,
  ghlAuthConfigFromEnv,
  redactGhlToken,
  isGhlTokenPresent,
  InvalidGhlTokenError,
  MissingGhlConfigError,
} from "./auth.js";
import { GHL_ENDPOINTS } from "./config.js";

const TOKEN = "pit-test-token-abcdef1234567890";
// Replaced a 20-char mixed-case literal that had the exact shape of a real
// GHL locationId with an obvious placeholder: this repository is public and
// the fixture only asserts header shape, never this value.
const LOCATION = "loc_test_subaccount_0001";

describe("GHL auth config", () => {
  it("builds bearer + Version: v3 headers from config", () => {
    const config = createGhlAuthConfig({ token: TOKEN, locationId: LOCATION });
    const headers = config.buildHeaders();

    expect(headers[GHL_AUTH_HEADER]).toBe(`Bearer ${TOKEN}`);
    expect(headers[GHL_VERSION_HEADER]).toBe("v3");
    expect(GHL_API_VERSION).toBe("v3");
  });

  it("uses the official base URL and endpoint paths", () => {
    const config = createGhlAuthConfig({ token: TOKEN, locationId: LOCATION });
    expect(config.baseUrl).toBe("https://services.leadconnectorhq.com");
    expect(GHL_API_BASE_URL).toBe("https://services.leadconnectorhq.com");
    expect(GHL_ENDPOINTS.listFiles).toBe("/medias/files");
    expect(GHL_ENDPOINTS.uploadFile).toBe("/medias/upload-file");
    expect(GHL_ENDPOINTS.createFolder).toBe("/medias/folder");
  });

  it("trims whitespace around token and locationId", () => {
    const config = createGhlAuthConfig({ token: `  ${TOKEN}  `, locationId: ` ${LOCATION} ` });
    expect(config.buildHeaders()[GHL_AUTH_HEADER]).toBe(`Bearer ${TOKEN}`);
    expect(config.locationId).toBe(LOCATION);
  });

  it("supports sub-account access token kind and baseUrl override", () => {
    const config = createGhlAuthConfig({
      token: TOKEN,
      locationId: LOCATION,
      tokenKind: "sub-account-access-token",
      baseUrl: "https://example.test/",
    });
    expect(config.tokenKind).toBe("sub-account-access-token");
    expect(config.baseUrl).toBe("https://example.test");
  });

  it("rejects missing token / locationId with MissingGhlConfigError", () => {
    expect(() => createGhlAuthConfig({ token: "", locationId: LOCATION })).toThrow(
      MissingGhlConfigError,
    );
    expect(() => createGhlAuthConfig({ token: "   ", locationId: LOCATION })).toThrow(
      /missing: token/,
    );
    expect(() => createGhlAuthConfig({ token: TOKEN, locationId: "" })).toThrow(
      /missing: locationId/,
    );
  });

  it("rejects empty or non-http(s) baseUrl override with MissingGhlConfigError", () => {
    expect(() =>
      createGhlAuthConfig({ token: TOKEN, locationId: LOCATION, baseUrl: "" }),
    ).toThrow(/baseUrl/);
    expect(() =>
      createGhlAuthConfig({ token: TOKEN, locationId: LOCATION, baseUrl: "   " }),
    ).toThrow(/baseUrl/);
    expect(() =>
      createGhlAuthConfig({ token: TOKEN, locationId: LOCATION, baseUrl: "not-a-url" }),
    ).toThrow(/baseUrl/);
    expect(() =>
      createGhlAuthConfig({ token: TOKEN, locationId: LOCATION, baseUrl: "ftp://example.test" }),
    ).toThrow(/baseUrl/);
  });

  it("builds config from environment variables", () => {
    const config = ghlAuthConfigFromEnv({
      GHL_ACCESS_TOKEN: TOKEN,
      GHL_LOCATION_ID: LOCATION,
    });
    const headers = config.buildHeaders();
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Version).toBe("v3");
    expect(config.locationId).toBe(LOCATION);
  });

  it("fails fast when env vars are absent", () => {
    expect(() => ghlAuthConfigFromEnv({})).toThrow(MissingGhlConfigError);
    expect(() => ghlAuthConfigFromEnv({ GHL_ACCESS_TOKEN: TOKEN })).toThrow(/GHL_LOCATION_ID/);
    expect(() => ghlAuthConfigFromEnv({ GHL_LOCATION_ID: LOCATION })).toThrow(/GHL_ACCESS_TOKEN/);
  });

  it("reads the token kind and expiry from the environment (SKR-026)", () => {
    const config = ghlAuthConfigFromEnv({
      GHL_ACCESS_TOKEN: TOKEN,
      GHL_LOCATION_ID: LOCATION,
      [GHL_TOKEN_KIND_ENV_VAR]: "sub-account-access-token",
      [GHL_TOKEN_EXPIRES_AT_ENV_VAR]: "2026-08-29T00:00:00.000Z",
    });
    expect(config.tokenKind).toBe("sub-account-access-token");
    expect(config.tokenExpiresAt()).toBe("2026-08-29T00:00:00.000Z");
    // Default stays the static Private Integration Token MMCS ships with.
    expect(ghlAuthConfigFromEnv({ GHL_ACCESS_TOKEN: TOKEN, GHL_LOCATION_ID: LOCATION }).tokenKind).toBe(
      "private-integration-token",
    );
  });

  it("rejects an undocumented GHL_TOKEN_KIND instead of guessing", () => {
    expect(() =>
      ghlAuthConfigFromEnv({
        GHL_ACCESS_TOKEN: TOKEN,
        GHL_LOCATION_ID: LOCATION,
        [GHL_TOKEN_KIND_ENV_VAR]: "oauth-ish",
      }),
    ).toThrow(InvalidGhlTokenError);
  });
});

describe("GHL token lifecycle wiring (SKR-026)", () => {
  it("renews an expiring OAuth token through authorizedHeaders()", async () => {
    let refreshes = 0;
    const config = createGhlAuthConfig({
      token: TOKEN,
      locationId: LOCATION,
      tokenKind: "sub-account-access-token",
      expiresAt: "2026-08-28T11:59:00.000Z", // already expired
      refresh: async () => {
        refreshes += 1;
        return { token: "oauth-token-after-refresh" };
      },
    });
    const headers = await config.authorizedHeaders();
    expect(refreshes).toBe(1);
    expect(headers[GHL_AUTH_HEADER]).toBe("Bearer oauth-token-after-refresh");
    expect(headers[GHL_VERSION_HEADER]).toBe("v3");
    // The refreshed token is what later synchronous snapshots carry.
    expect(config.buildHeaders()[GHL_AUTH_HEADER]).toBe("Bearer oauth-token-after-refresh");
  });

  it("keeps buildHeaders() a synchronous snapshot for callers that cannot await", () => {
    const config = createGhlAuthConfig({ token: TOKEN, locationId: LOCATION });
    expect(config.buildHeaders()[GHL_AUTH_HEADER]).toBe(`Bearer ${TOKEN}`);
  });

  it("recovers from a 401 for a sub-account token and refuses for a static PIT", async () => {
    const oauth = createGhlAuthConfig({
      token: TOKEN,
      locationId: LOCATION,
      tokenKind: "sub-account-access-token",
      refresh: async () => ({ token: "token-after-401" }),
    });
    const recovered = await oauth.recoverFromUnauthorized();
    expect(recovered[GHL_AUTH_HEADER]).toBe("Bearer token-after-401");

    const pit = createGhlAuthConfig({ token: TOKEN, locationId: LOCATION });
    await expect(pit.recoverFromUnauthorized()).rejects.toThrow(/rotate GHL_ACCESS_TOKEN/);
  });

  it("never leaks a refreshed token through stringification", async () => {
    const config = createGhlAuthConfig({
      token: TOKEN,
      locationId: LOCATION,
      tokenKind: "sub-account-access-token",
      refresh: async () => ({ token: "rotated-secret-value-9876" }),
    });
    await config.recoverFromUnauthorized();
    expect(String(config)).not.toContain("rotated-secret-value-9876");
    expect(JSON.stringify(config)).not.toContain("rotated-secret-value-9876");
  });
});

describe("GHL token redaction", () => {
  it("never exposes token material through stringification", () => {
    const config = createGhlAuthConfig({ token: TOKEN, locationId: LOCATION });

    expect(String(config)).not.toContain(TOKEN);
    expect(String(config)).toContain("[REDACTED_GHL_TOKEN]");

    expect(JSON.stringify(config)).not.toContain(TOKEN);

    // Template-literal interpolation goes through toString.
    expect(`log: ${config}`).not.toContain(TOKEN);
  });

  it("redactGhlToken returns a fixed mask independent of token content", () => {
    expect(redactGhlToken(TOKEN)).toBe("[REDACTED_GHL_TOKEN]");
    expect(redactGhlToken("different-secret-value-xyz")).toBe("[REDACTED_GHL_TOKEN]");
    expect(redactGhlToken("")).toBe("[REDACTED_GHL_TOKEN]");
  });

  it("error messages never contain the token", () => {
    try {
      createGhlAuthConfig({ token: "", locationId: LOCATION });
      throw new Error("expected MissingGhlConfigError");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
    try {
      createGhlAuthConfig({ token: TOKEN, locationId: "" });
      throw new Error("expected MissingGhlConfigError");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});

describe("token presence check", () => {
  it("rejects undefined, empty and placeholder-length values", () => {
    expect(isGhlTokenPresent(undefined)).toBe(false);
    expect(isGhlTokenPresent("")).toBe(false);
    expect(isGhlTokenPresent("short")).toBe(false);
    expect(isGhlTokenPresent(TOKEN)).toBe(true);
  });
});