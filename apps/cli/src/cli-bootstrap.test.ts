// Integration proof: the shipped entry point runs every §24 verb through a
// real handler or a named fail-closed answer — NEVER the stub line. This is
// the test whose absence let batch-11..16 ship an unwired CLI.
import { describe, it, expect } from "vitest";
import { main } from "./index.js";
import { rmSync } from "node:fs";

async function runVerb(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c: unknown): boolean => { chunks.push(String(c)); return true; };
  process.stderr.write = (c: unknown): boolean => { chunks.push(String(c)); return true; };
  try {
    await main(argv);
  } catch {
    // a real handler refusing (gate order, missing config) is a valid outcome
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return chunks.join("");
}

const ALL_VERBS: string[][] = [
  ["doctor"],
  ["status"],
  ["create-series"],
  ["create-episode"],
  ["develop-concept"],
  ["approve", "concept"],
  ["write-script"],
  ["approve", "script"],
  ["approve", "rough-cut"],
  ["cast"],
  ["choose-character", "1"],
  ["approve-character", "CHAR_TEST_001"],
  ["character", "list"],
  ["storyboard"],
  ["approve-storyboard"],
  ["estimate"],
  ["generate"],
  ["generate-shot", "SC01-SH01"],
  ["retry-shot", "SC01-SH01"],
  ["qc"],
  ["rough-cut"],
  ["final"],
  ["canon", "review"],
  ["canon", "approve"],
  ["providers"],
  ["providers", "verify"],
  ["models"],
  ["storage", "status"],
  ["recover"],
];

describe("CORE-011 integration: the shipped CLI has no silent stubs", { timeout: 60_000 }, () => {
  it("every §24 verb answers with real output or a named failure — never STUB", async () => {
    rmSync("state-test", { recursive: true, force: true });
    process.env.MMCS_STATE_DIR = "state-test";
    const offenders: string[] = [];
    for (const argv of ALL_VERBS) {
      const out = await runVerb(argv);
      if (out.includes("STUB: registered, not implemented yet")) {
        offenders.push(argv.join(" "));
      }
    }
    rmSync("state-test", { recursive: true, force: true });
    expect(offenders, `verbs still hitting the stub: ${offenders.join(", ")}`).toEqual([]);
  });

  it("unknown verb still exits 1", async () => {
    const code = await main(["definitely-not-a-verb"]);
    expect(code).toBe(1);
  });
});
