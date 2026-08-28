import { describe, it, expect } from "vitest";
import {
  GHL_API_BASE_URL,
  GHL_API_VERSION,
  GHL_AUTH_HEADER,
  GHL_VERSION_HEADER,
  createGhlAuthConfig,
  ghlAuthConfigFromEnv,
  redactGhlToken,
  isGhlTokenPresent,
  MissingGhlConfigError,
} from "./auth.js";
import { GHL_ENDPOINTS } from "./config.js";

const TOKEN = "pit-test-token-abcdef1234567890";
const LOCATION = "sx6wyHhbFdRXh302LLNR";

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