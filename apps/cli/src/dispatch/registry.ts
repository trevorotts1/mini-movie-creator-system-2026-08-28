// Command registry for the `mmcs` CLI (spec §24).
//
// CORE-011 owns this registry + dispatcher. Command-owning tasks (e.g. CHAR-004)
// add `src/commands/<group>.ts` files that export CommandSpec overrides; the
// dispatcher merges them over these stubs at integration (see mergeSpecs).
//
// Stub output contract (documented, scriptable):
// - Every registered verb has a handler. Until a feature task replaces it, the
//   handler prints ONE line to stdout:
//     `[mmcs] <verb> — STUB: registered, not implemented yet (spec §24).`
//   plus ` args: <a, b>` when positional arguments were provided.
// - Stub handlers exit 0. Unknown command exits 1. Missing required argument
//   exits 1 (commander defaults).

export interface CommandSpec {
  /** Full verb path, e.g. "approve concept" (spec §24 names, space = nesting). */
  name: string;
  description: string;
  /** Required positional argument placeholders, e.g. ["<candidate>"]. */
  args?: string[];
  /** Logical group (help organization + ownership hints). */
  group: string;
}

export const COMMAND_GROUPS = [
  "pipeline",
  "approvals",
  "characters",
  "storyboard",
  "generation",
  "canon",
  "providers",
  "storage",
  "recovery",
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * The full spec §24 verb list, in spec order. Keep exact names — the test
 * suite checks this registry against the spec list.
 */
export function buildRegistry(): CommandSpec[] {
  return [
    // --- pipeline lifecycle ---
    {
      name: "doctor",
      description: "Check environment, providers, and config health",
      group: "pipeline",
    },
    {
      name: "status",
      description: "Show project/series/episode state and approval gates",
      group: "pipeline",
    },
    {
      name: "create-series",
      description: "Create a new series with persistent defaults",
      group: "pipeline",
    },
    {
      name: "create-episode",
      description: "Create a new episode in a series",
      group: "pipeline",
    },
    // --- approval gates (spec §3) ---
    {
      name: "develop-concept",
      description: "Develop a concept for approval (STOP at concept gate)",
      group: "approvals",
    },
    {
      name: "approve concept",
      description: "Approve the developed concept",
      group: "approvals",
    },
    {
      name: "write-script",
      description: "Write the script for the episode (STOP at script gate)",
      group: "approvals",
    },
    {
      name: "approve script",
      description: "Approve the written script",
      group: "approvals",
    },
    {
      name: "approve rough-cut",
      description: "Approve the rough cut",
      group: "approvals",
    },
    // --- characters (spec §9) ---
    {
      name: "cast",
      description: "Generate character candidates",
      group: "characters",
    },
    {
      name: "choose-character",
      description: "Choose a character candidate for refinement",
      args: ["<candidate>"],
      group: "characters",
    },
    {
      name: "approve-character",
      description: "Approve a character version",
      args: ["<id>"],
      group: "characters",
    },
    {
      name: "character list",
      description: "List characters in the library",
      group: "characters",
    },
    {
      name: "character show",
      description: "Show a character and its versions",
      args: ["<id>"],
      group: "characters",
    },
    // --- storyboard (spec §7/§8) ---
    {
      name: "storyboard",
      description: "Generate storyboard/shot plan",
      group: "storyboard",
    },
    {
      name: "approve-storyboard",
      description: "Approve the storyboard",
      group: "storyboard",
    },
    // --- generation / QC / assembly ---
    {
      name: "estimate",
      description: "Estimate cost and duration of the generation plan",
      group: "generation",
    },
    {
      name: "generate",
      description: "Generate all shots for the episode",
      group: "generation",
    },
    {
      name: "generate-shot",
      description: "Generate a single shot",
      args: ["<id>"],
      group: "generation",
    },
    {
      name: "retry-shot",
      description: "Retry a failed shot",
      args: ["<id>"],
      group: "generation",
    },
    {
      name: "qc",
      description: "Run QC on generated assets",
      group: "generation",
    },
    {
      name: "rough-cut",
      description: "Assemble the rough cut (STOP at rough-cut gate)",
      group: "generation",
    },
    {
      name: "final",
      description: "Produce the final render",
      group: "generation",
    },
    // --- canon (spec §10) ---
    {
      name: "canon review",
      description: "Review series canon/continuity",
      group: "canon",
    },
    {
      name: "canon approve",
      description: "Approve canon updates",
      group: "canon",
    },
    // --- providers / models (spec §5, §15) ---
    {
      name: "providers",
      description: "List configured providers",
      group: "providers",
    },
    {
      name: "providers verify",
      description:
        "Verify configured/documented/observed capability per provider",
      group: "providers",
    },
    {
      name: "models",
      description: "List models available per provider",
      group: "providers",
    },
    // --- storage (spec §17/§19) ---
    {
      name: "storage status",
      description: "Show media storage backend status",
      group: "storage",
    },
    // --- recovery (spec §18) ---
    {
      name: "recover",
      description: "Resume interrupted pipeline work safely",
      group: "recovery",
    },
  ];
}

/**
 * Merge feature-task command files over the base registry. Later specs win by
 * full verb-path name; base ordering is preserved so help stays stable.
 */
export function mergeSpecs(
  base: readonly CommandSpec[],
  overrides: readonly CommandSpec[],
): CommandSpec[] {
  const byName = new Map<string, CommandSpec>();
  for (const spec of base) byName.set(spec.name, spec);
  for (const spec of overrides) byName.set(spec.name, spec);
  return [...byName.values()];
}