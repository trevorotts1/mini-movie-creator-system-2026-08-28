import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * CORE-002 acceptance: the target monorepo/module layout is real.
 * - 11 spec packages (spec §1) + the domain split package each exist with package.json
 * - 3 apps + 2 integrations each exist with package.json
 * - root package.json declares workspaces listing packages/*
 * - tsconfig.base.json exists with @mmcs/* path aliases
 */
const SPEC_PACKAGES = [
  "core",
  "database",
  "providers",
  "capability-registry",
  "prompt-compilers",
  "scene-intelligence",
  "character-library",
  "media-storage",
  "qc",
  "cost-engine",
  "remotion-runtime",
] as const;

const APPS = ["cli", "api", "web"] as const;
const INTEGRATIONS = ["openclaw", "claude"] as const;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("monorepo layout (CORE-002)", () => {
  it("every spec package dir exists with a package.json", () => {
    for (const pkg of SPEC_PACKAGES) {
      const manifest = readJson(`packages/${pkg}/package.json`);
      expect(manifest.name, `packages/${pkg} name`).toBe(`@mmcs/${pkg}`);
      expect(manifest.private).toBe(true);
      expect(fs.existsSync(path.join(ROOT, `packages/${pkg}/src/index.ts`))).toBe(
        true,
      );
    }
  });

  it("the domain split package exists alongside the spec packages", () => {
    expect(readJson("packages/domain/package.json").name).toBe("@mmcs/domain");
  });

  it("every app and integration dir exists with a package.json", () => {
    for (const app of APPS) {
      const manifest = readJson(`apps/${app}/package.json`);
      expect(manifest.name).toBe(`@mmcs/${app}`);
      expect(manifest.private).toBe(true);
    }
    for (const integ of INTEGRATIONS) {
      const manifest = readJson(`integrations/${integ}/package.json`);
      expect(manifest.private).toBe(true);
    }
  });

  it("root package.json workspaces lists packages/*", () => {
    const root = readJson("package.json");
    const workspaces = root.workspaces as string[] | undefined;
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces).toContain("packages/*");
    expect(workspaces).toContain("apps/*");
    expect(workspaces).toContain("integrations/*");
  });

  it("tsconfig.base.json aliases every @mmcs package", () => {
    const tsconfig = readJson("tsconfig.base.json");
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
    const paths = compilerOptions.paths as Record<string, string[]>;
    expect(paths["@mmcs/core"]).toEqual(["./packages/core/src/index.ts"]);
    for (const pkg of [...SPEC_PACKAGES, "domain"]) {
      expect(paths[`@mmcs/${pkg}`]).toBeDefined();
    }
  });

  it("root workspaces resolve to real workspace manifests", () => {
    const out = execFileSync(
      "node",
      [
        "-e",
        "console.log(JSON.stringify(require(process.cwd() + '/package.json').workspaces))",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(JSON.parse(out)).toContain("packages/*");
  });
});