/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  DEFAULT_AUTO_SPEND_LIMIT_USD,
  MMCS_ENV_KEYS,
  findEnvFile,
  loadConfig,
  parseEnvFile,
  tryLoadConfig,
} from "./index.js";

const VALID_ENV: Record<string, string> = {
  AGNES_API_KEY: "agnes-test-key",
  KIE_API_KEY: "kie-test-key",
  FISH_API_KEY: "fish-test-key",
  GHL_ACCESS_TOKEN: "ghl-test-token",
  GHL_LOCATION_ID: "loc-test",
  OPENROUTER_API_KEY: "or-test-key",
  NINEROUTER_URL: "http://127.0.0.1:4000",
  NINEROUTER_KEY: "nr-test-key",
};

function withTempDir(name: string, write: (dir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), `mmcs-config-${name}-`));
  write(dir);
  return dir;
}

let cleanup: string | null = null;
afterEach(() => {
  if (cleanup) {
    rmSync(cleanup, { recursive: true, force: true });
    cleanup = null;
  }
});

describe("MMCS env schema", () => {
  it("recognizes exactly the nine contract variables", () => {
    expect([...MMCS_ENV_KEYS].sort()).toEqual(
      [
        "AGNES_API_KEY",
        "AUTO_SPEND_LIMIT_USD",
        "FISH_API_KEY",
        "GHL_ACCESS_TOKEN",
        "GHL_LOCATION_ID",
        "KIE_API_KEY",
        "NINEROUTER_KEY",
        "NINEROUTER_URL",
        "OPENROUTER_API_KEY",
      ].sort(),
    );
  });

  it("loads a fully configured environment", () => {
    const config = loadConfig({ env: { ...VALID_ENV }, noEnvFile: true });
    expect(config.AGNES_API_KEY).toBe("agnes-test-key");
    expect(config.GHL_LOCATION_ID).toBe("loc-test");
    expect(config.NINEROUTER_URL).toBe("http://127.0.0.1:4000");
  });

  it("defaults AUTO_SPEND_LIMIT_USD to 25.00", () => {
    const config = loadConfig({ env: { ...VALID_ENV }, noEnvFile: true });
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(DEFAULT_AUTO_SPEND_LIMIT_USD);
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(25);
  });

  it("accepts an explicit AUTO_SPEND_LIMIT_USD", () => {
    const config = loadConfig({
      env: { ...VALID_ENV, AUTO_SPEND_LIMIT_USD: "10.50" },
      noEnvFile: true,
    });
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(10.5);
  });

  it("rejects a non-numeric AUTO_SPEND_LIMIT_USD and names the variable", () => {
    expect(() =>
      loadConfig({ env: { ...VALID_ENV, AUTO_SPEND_LIMIT_USD: "lots" }, noEnvFile: true }),
    ).toThrow(/AUTO_SPEND_LIMIT_USD/);
  });

  it("treats an empty-string variable as missing, naming it", () => {
    expect(() =>
      loadConfig({ env: { ...VALID_ENV, GHL_LOCATION_ID: "" }, noEnvFile: true }),
    ).toThrow(/GHL_LOCATION_ID/);
  });

  it("rejects a non-URL NINEROUTER_URL and names the variable", () => {
    expect(() =>
      loadConfig({ env: { ...VALID_ENV, NINEROUTER_URL: "not a url" }, noEnvFile: true }),
    ).toThrow(/NINEROUTER_URL/);
  });

  it("names every missing variable, not just the first", () => {
    try {
      loadConfig({ env: {}, noEnvFile: true });
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues.map((i) => i.key);
      for (const key of MMCS_ENV_KEYS) {
        if (key === "AUTO_SPEND_LIMIT_USD") continue;
        expect(issues).toContain(key);
      }
    }
  });

  it("never leaks variable values in the error message", () => {
    try {
      loadConfig({ env: { ...VALID_ENV, AGNES_API_KEY: "sk-secret-do-not-leak" }, noEnvFile: true });
      // Replace with an invalid type so it fails validation while a value exists:
      expect.unreachable("should have thrown");
    } catch {
      // Re-run with a genuinely failing parse to assert message hygiene.
    }
    const secret = "supersecretvalue123";
    try {
      loadConfig({ env: { ...VALID_ENV, NINEROUTER_URL: secret }, noEnvFile: true });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("tryLoadConfig (doctor mode)", () => {
  it("reports missing variables without throwing", () => {
    const { config, issues } = tryLoadConfig({ env: {}, noEnvFile: true });
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(25);
    const keys = issues.map((i) => i.key);
    expect(keys).toContain("GHL_ACCESS_TOKEN");
    expect(issues.find((i) => i.key === "GHL_ACCESS_TOKEN")?.reason).toMatch(/not configured/);
  });

  it("reports zero issues on a complete environment", () => {
    const { issues } = tryLoadConfig({ env: { ...VALID_ENV }, noEnvFile: true });
    expect(issues).toHaveLength(0);
  });
});

describe(".env file loading", () => {
  it("parses comments, export prefixes, quotes, and inline comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment line",
        "",
        "AGNES_API_KEY=plain-value # inline note",
        "export KIE_API_KEY=exported-value",
        'FISH_API_KEY="quoted value"',
        "GHL_LOCATION_ID='single quoted'",
      ].join("\n"),
    );
    expect(parsed.AGNES_API_KEY).toBe("plain-value");
    expect(parsed.KIE_API_KEY).toBe("exported-value");
    expect(parsed.FISH_API_KEY).toBe("quoted value");
    expect(parsed.GHL_LOCATION_ID).toBe("single quoted");
  });

  it("loads config from a .env file when env vars are absent", () => {
    const dir = withTempDir("load", (d) => {
      writeFileSync(
        path.join(d, ".env"),
        [...Object.entries(VALID_ENV).map(([k, v]) => `${k}=${v}`), "AUTO_SPEND_LIMIT_USD=12.25"].join("\n"),
      );
    });
    cleanup = dir;
    const config = loadConfig({ startDir: dir });
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(12.25);
    expect(config.KIE_API_KEY).toBe("kie-test-key");
  });

  it("lets real environment variables win over .env file values", () => {
    const dir = withTempDir("override", (d) => {
      writeFileSync(path.join(d, ".env"), "AUTO_SPEND_LIMIT_USD=99\n");
    });
    cleanup = dir;
    const config = loadConfig({
      startDir: dir,
      noEnvFile: false,
      env: { ...VALID_ENV, AUTO_SPEND_LIMIT_USD: "5" },
    });
    expect(config.AUTO_SPEND_LIMIT_USD).toBe(5);
  });

  it("finds the .env by walking up from a nested directory", () => {
    const dir = withTempDir("walk", (d) => {
      writeFileSync(path.join(d, ".env"), "NINEROUTER_KEY=from-file\n");
      mkdirSync(path.join(d, "nested", "deep"), { recursive: true });
    });
    cleanup = dir;
    const found = findEnvFile(path.join(dir, "nested", "deep"));
    expect(found).toBe(path.join(dir, ".env"));
  });

  it("returns null when no .env exists in any ancestor", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mmcs-config-empty-"));
    cleanup = dir;
    expect(findEnvFile(dir)).toBeNull();
  });

  it("treats an unreadable .env as absence, then names missing vars", () => {
    const bogus = withTempDir("bogus", () => {});
    cleanup = bogus;
    expect(() =>
      loadConfig({ envFile: path.join(bogus, "does-not-exist.env"), env: {} }),
    ).toThrow(ConfigValidationError);
  });
});