// SKL-005 acceptance tests: OpenClaw workspace packaging + install.
// Spec §27 item 3: packaging at integrations/openclaw/mini-movie-creator/
// (SKILL.md + references/scripts); no engine fork; workspace resolved from
// OpenClaw config, never guessed; current `openclaw skills install` flow or
// workspace placement; `openclaw skills list` shows mini-movie-creator.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGING_DIR = path.join(INTEGRATION_DIR, "mini-movie-creator");
const INSTALL_SH = path.join(INTEGRATION_DIR, "install.sh");

function read(rel: string): string {
  return fs.readFileSync(path.join(PACKAGING_DIR, rel), "utf8");
}

function sh(script: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("SKL-005 packaging structure", () => {
  it("has SKILL.md + references + scripts at the owned path", () => {
    expect(fs.existsSync(path.join(PACKAGING_DIR, "SKILL.md"))).toBe(true);
    for (const ref of [
      "references/workflow.md",
      "references/approvals.md",
      "references/providers.md",
      "references/recovery.md",
      "scripts/mmcs-status.sh",
    ]) {
      expect(fs.existsSync(path.join(PACKAGING_DIR, ref)), ref).toBe(true);
    }
  });

  it("SKILL.md has AgentSkills-style frontmatter with the exact name", () => {
    const md = read("SKILL.md");
    expect(md.startsWith("---\n")).toBe(true);
    const fm = md.slice(4, md.indexOf("\n---", 4));
    expect(fm).toMatch(/^name: mini-movie-creator$/m);
    expect(fm).toMatch(/^description: /m);
    // Concise: spec keeps SKILL.md thin (≤500 lines).
    expect(md.split("\n").length).toBeLessThanOrEqual(500);
  });

  it("references hold the detail (workflow/approvals/providers/recovery are substantive)", () => {
    for (const ref of [
      "references/workflow.md",
      "references/approvals.md",
      "references/providers.md",
      "references/recovery.md",
    ]) {
      expect(read(ref).length, ref).toBeGreaterThan(2000);
    }
  });

  it("SKILL.md teaches all required engine verbs (spec §24/§27 surface)", () => {
    const md = read("SKILL.md");
    for (const verb of [
      "status",
      "doctor",
      "create-series",
      "create-episode",
      "develop-concept",
      "write-script",
      "cast",
      "choose-character",
      "approve-character",
      "storyboard",
      "estimate",
      "generate",
      "generate-shot",
      "retry-shot",
      "qc",
      "rough-cut",
      "final",
      "canon review",
      "canon approve",
      "providers verify",
      "models",
      "character list",
      "storage status",
      "recover",
    ]) {
      expect(md, `missing verb: ${verb}`).toContain(verb);
    }
  });

  it("SKILL.md teaches the hard gates and the $25.00 spend wall", () => {
    const md = read("SKILL.md");
    expect(md).toContain("approve concept");
    expect(md).toContain("approve script");
    expect(md).toContain("approve rough-cut");
    expect(md).toContain("$25.00");
    expect(md.toLowerCase()).toContain("stop");
    // Character flow: 3 candidates, 1/2/3/Try Again, lock only after approval.
    expect(md).toContain("Character 1 / 2 / 3 / Try Again");
  });

  it("no engine fork: no SQL, no direct DB access, no copied business logic", () => {
    const files = [
      "SKILL.md",
      "references/workflow.md",
      "references/approvals.md",
      "references/providers.md",
      "references/recovery.md",
      "scripts/mmcs-status.sh",
    ];
    for (const f of files) {
      const content = read(f);
      // No SQL against the app DB; no direct sqlite opens.
      expect(content, f).not.toMatch(/CREATE TABLE|INSERT INTO|better-sqlite3/i);
      expect(content, f).not.toMatch(/sqlite3\s+.*\.db/i);
    }
  });

  it("no secrets: no API keys or secret values anywhere in the packaging", () => {
    const files = [
      "SKILL.md",
      "references/workflow.md",
      "references/approvals.md",
      "references/providers.md",
      "references/recovery.md",
      "scripts/mmcs-status.sh",
    ];
    const secretShapes =
      /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|pk_live_|AKIA[0-9A-Z]{12,}|pat_[A-Za-z0-9]{8,})/;
    for (const f of files) {
      expect(read(f), f).not.toMatch(secretShapes);
    }
  });
});

describe("SKL-005 mmcs-status.sh wrapper", () => {
  it("refuses to guess: exit 2 + guidance when no engine root resolves", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-nowhere-"));
    const r2 = spawnSync(
      "bash",
      [path.join(PACKAGING_DIR, "scripts/mmcs-status.sh")],
      { cwd: dir, encoding: "utf8" },
    );
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("not resolvable");
    expect(r2.stderr).toContain("Never guessed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--mmcs-root with a fake engine runs `mmcs status` through the runner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-root-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "mmcs-monorepo" }),
    );
    // Fake mmcs on PATH that echoes status output.
    const bin = path.join(dir, "fakebin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "mmcs"),
      "#!/usr/bin/env bash\necho '[mmcs] status — test stub'\n",
    );
    fs.chmodSync(path.join(bin, "mmcs"), 0o755);
    const r = spawnSync(
      "bash",
      [path.join(PACKAGING_DIR, "scripts/mmcs-status.sh"), "--mmcs-root", dir],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("test stub");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--check exits non-zero when the runner fails, zero when it succeeds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-check-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "mmcs-monorepo" }),
    );
    const bin = path.join(dir, "fakebin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "mmcs"),
      "#!/usr/bin/env bash\nexit 3\n",
    );
    fs.chmodSync(path.join(bin, "mmcs"), 0o755);
    const bad = spawnSync(
      "bash",
      [path.join(PACKAGING_DIR, "scripts/mmcs-status.sh"), "--check", "--mmcs-root", dir],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(bad.status).toBe(3);

    fs.writeFileSync(
      path.join(bin, "mmcs"),
      "#!/usr/bin/env bash\necho ok\n",
    );
    const good = spawnSync(
      "bash",
      [path.join(PACKAGING_DIR, "scripts/mmcs-status.sh"), "--check", "--mmcs-root", dir],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("OK");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("SKL-005 install.sh contract", () => {
  it("help works", () => {
    const r = sh(INSTALL_SH, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--check");
  });
});