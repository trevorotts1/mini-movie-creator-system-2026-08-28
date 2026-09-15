// SKR-008 — the OpenClaw installer must not promise persistence it cannot deliver.
//
// The AGENTS.md block that install-client.sh writes into every client claimed the engine
// path was "persisted across container recreates". Nothing in this repo created that path
// or mounted it: the installer only DISCOVERS it as a candidate, and persistence is a
// property of the container DEPLOYMENT. SKR-008 offers "either implement persistence or
// correct the claim"; persistence is outside this repo, so the claim is what changed.
//
// This lives under scripts/ because the release gate runs the root vitest config, whose
// include is packages|apps|scripts. A test inside integrations/ would not be gated at all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "integrations", "openclaw", "mini-movie-creator", "install-client.sh");
const STATUS = path.join(REPO, "integrations", "openclaw", "mini-movie-creator", "scripts", "mmcs-status.sh");

describe("SKR-008 — no unearned persistence promise", () => {
  it("the AGENTS.md block does not claim the engine path survives container recreates", () => {
    const src = fs.readFileSync(INSTALLER, "utf8");
    const start = src.indexOf('MARK="## MMCS mini-movie engine');
    expect(start, "the AGENTS.md block marker moved; update this test").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("One-off montage", start));

    expect(block).not.toMatch(/persisted across container recreates/i);
    expect(block).not.toMatch(/survives container recreates/i);
    // Still useful: it must say where the engine is looked for...
    expect(block).toContain("workspace/mmcs");
    // ...that this script discovers rather than creates it...
    expect(block).toMatch(/DISCOVERS|does not create/i);
    // ...and that persistence belongs to the deployment, not this repo.
    expect(block).toMatch(/deployment/i);
  });

  it("the status script describes the path as a discovery candidate, not a guarantee", () => {
    const src = fs.readFileSync(STATUS, "utf8");
    expect(src).not.toMatch(/persisted across container recreates/i);
    expect(src).toMatch(/DISCOVERY candidate/i);
    expect(src).toMatch(/DEPLOYMENT/i);
  });

  it("still actually looks the engine up at that path (the fix removed a promise, not the feature)", () => {
    const src = fs.readFileSync(STATUS, "utf8");
    expect(src).toContain("$HOME/.openclaw/workspace/mmcs");
  });
});
