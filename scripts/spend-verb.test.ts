// SKR-010 — the spend ledger must be reachable on a production path, and must read the
// real ledger rather than print constants.
//
// The enforcement point (`new CostLedger(...)` in the CLI) existed but was constructed by
// NOTHING, so the $25 ceiling was decorative and an operator could not read their remaining
// budget. `mmcs spend` now constructs it and reports it. This test drives the REAL CLI
// end-to-end: dispatch() in the unit harness falls back to stub handlers, so asserting
// there would have proved nothing about the real verb.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Run the real CLI with an isolated state dir. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-spend-"));
  dirs.push(stateDir);
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", path.join(REPO, "apps", "cli", "src", "index.ts"), ...args],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, MMCS_STATE_DIR: stateDir, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { code: 0, stdout, stateDir };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? ""), stateDir };
  }
}

describe("mmcs spend (SKR-010)", () => {
  it("reports the ledger against the ceiling, and says it submitted nothing", () => {
    const r = cli(["spend"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ceiling:");
    expect(r.stdout).toContain("open reservations:");
    expect(r.stdout).toContain("committed actual:");
    expect(r.stdout).toContain("remaining:");
    expect(r.stdout).toMatch(/Nothing here submits paid work/);
    // A fresh ledger must be genuinely empty, not fabricated numbers.
    expect(r.stdout).toContain("$0.00");
  });

  it("reads live configuration rather than a hardcoded ceiling", () => {
    // AUTO_SPEND_LIMIT_USD may only LOWER the cap; if the verb printed a constant this
    // would still read $25.00.
    const r = cli(["spend"], { AUTO_SPEND_LIMIT_USD: "9.5" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$9.50");
    expect(r.stdout).not.toContain("$25.00");
  });

  it("reads real ledger rows — an injected reservation shows up", () => {
    // The decisive check: write a reservation straight into the table, then read it back
    // through the verb. If the verb printed constants this would not move.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmcs-spend-"));
    dirs.push(stateDir);
    const runOnce = (args: string[]) =>
      execFileSync("npx", ["tsx", path.join(REPO, "apps", "cli", "src", "index.ts"), ...args], {
        cwd: REPO, encoding: "utf8",
        env: { ...process.env, MMCS_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      });

    runOnce(["spend"]); // creates + migrates the DB
    const dbFile = fs.readdirSync(stateDir).find((f) => f.endsWith(".db"));
    expect(dbFile, "the verb must create the database").toBeDefined();

    execFileSync("sqlite3", [
      path.join(stateDir, dbFile as string),
      "INSERT INTO cost_reservations (id,episode_id,provider,provider_model,kind,status,estimated_cents,created_at,updated_at) " +
        "VALUES ('res_probe_1','EP_PROBE','kie','seedance-2-mini','paid','reserved',750,'2026-09-15T00:00:00Z','2026-09-15T00:00:00Z');",
    ]);

    const out = runOnce(["spend"]);
    expect(out).toContain("$7.50"); // open reservation
    expect(out).toContain("$17.50"); // remaining
    expect(out).toContain("kie: $7.50"); // provider breakdown
  });
});
