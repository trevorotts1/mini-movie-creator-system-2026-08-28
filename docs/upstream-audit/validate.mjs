#!/usr/bin/env node
// CORE-001 validator — proves the upstream preservation map against the live tree.
// Usage: node docs/upstream-audit/validate.mjs   (exit 0 = all checks pass)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const mapPath = path.join(here, "preservation-map.md");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. Map exists, non-empty (acceptance: test -s)
const mapRaw = existsSync(mapPath) ? readFileSync(mapPath, "utf8") : "";
check("preservation-map.md exists and is non-empty", mapRaw.trim().length > 0);

// 2. PF-1 and PF-2 carried forward (acceptance: grep -q "PF-1")
check("carries PF-1", mapRaw.includes("PF-1"));
check("carries PF-2", mapRaw.includes("PF-2"));

// 3. Disposition vocabulary present
for (const d of ["keep", "rewrite", "drop", "superseded"]) {
  check(`disposition vocabulary includes "${d}"`, mapRaw.includes(`**${d}**`) || mapRaw.includes(d));
}
check("explicit drop list section present", mapRaw.includes("## 11. Explicit drop list"));

// 4. Inventory: every upstream package/script/tool appears in the map
const listDir = (rel, filter) => {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter(filter).sort();
};

const tools = listDir("tools", (f) => f.endsWith(".py"));
check("tools inventory count is 11", tools.length === 11, `found ${tools.length}: ${tools.join(", ")}`);
for (const t of tools) check(`map covers tools/${t}`, mapRaw.includes(t));

const remotionScripts = listDir("remotion/scripts", (f) => f.endsWith(".mjs"));
check("remotion scripts inventory count is 3", remotionScripts.length === 3, `found ${remotionScripts.length}`);
for (const s of remotionScripts) check(`map covers remotion/scripts/${s}`, mapRaw.includes(s));

const skills = listDir(".claude/skills", (f) => !f.startsWith("."));
check("skills inventory count is 5", skills.length === 5, `found ${skills.length}: ${skills.join(", ")}`);
for (const s of skills) check(`map covers skill ${s}`, mapRaw.includes(s));

// lib kits: top-level *.tsx + nested *.ts (geo/world.ts) — 16 total per BASELINE-REPORT §2
const libDir = path.join(repoRoot, "remotion", "src", "lib");
const libKits = existsSync(libDir)
  ? readdirSync(libDir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? readdirSync(path.join(libDir, e.name)).map((f) => `${e.name}/${f}`)
          : [e.name],
      )
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .sort()
  : [];
check("lib kits inventory count is 16", libKits.length === 16, `found ${libKits.length}: ${libKits.join(", ")}`);
for (const k of libKits) check(`map covers remotion/src/lib/${k}`, mapRaw.includes(k));

const shots = listDir("remotion/src/shots", (f) => !f.startsWith("."));
check("compositions inventory count is 14", shots.length === 14, `found ${shots.length}: ${shots.join(", ")}`);
check("map covers 14 compositions", mapRaw.includes("14 comps") || mapRaw.includes("14 compositions"));

// 5. Data contracts + spec §2 reconciliation present
for (const c of ["beats.json", "character.json", "sfx-plan.json"]) {
  check(`map covers contract ${c}`, mapRaw.includes(c));
}
check("spec §2 reconciliation section present", mapRaw.includes("## 9. Reconciliation against spec §2"));
check("Remotion version fact carried (4.0.486)", mapRaw.includes("4.0.486"));
check("13/14 smoke fact carried", mapRaw.includes("13/14"));
check("PF-1 fix owner named (VID-001)", mapRaw.includes("VID-001"));
check("npm audit fix carry-forward stated", mapRaw.includes("npm audit fix"));

// 6. Live-tree cross-check: chess SVGs still absent (PF-1 condition unchanged)
check(
  "PF-1 precondition holds: media/library/chess/ absent",
  !existsSync(path.join(repoRoot, "media", "library", "chess")),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll preservation-map checks passed.");