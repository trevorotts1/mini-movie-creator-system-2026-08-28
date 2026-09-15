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

export interface CommandOptionSpec {
  /** Long flag without leading dashes — "episode" registers `--episode`. */
  flag: string;
  /**
   * Placeholder for a value-taking flag, e.g. "code" for `--episode <code>`.
   * Omit entirely for a boolean flag.
   */
  value?: string;
  description: string;
}

export interface CommandSpec {
  /** Full verb path, e.g. "approve concept" (spec §24 names, space = nesting). */
  name: string;
  description: string;
  /** Required positional argument placeholders, e.g. ["<candidate>"]. */
  args?: string[];
  /**
   * Long flags this verb accepts. Registered on the commander subcommand so
   * documented flags parse instead of being rejected as unknown options, and
   * so their values reach the handler. Keep in step with what the handler
   * actually reads.
   */
  options?: CommandOptionSpec[];
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
      options: [
        { flag: "name", value: "title", description: "Series title (required)" },
        { flag: "aspect-ratio", value: "ratio", description: 'Default "16:9"' },
      ],
    },
    {
      name: "create-scene",
      description: "Add a scene to an episode",
      group: "pipeline",
      options: [
        { flag: "episode", value: "code-or-id", description: "Episode code or id (required)" },
        { flag: "title", value: "title", description: "Scene title" },
        { flag: "index", value: "n", description: "Sequence index (default 0)" },
      ],
    },
    {
      name: "create-shot",
      description: "Add a shot to a scene",
      group: "pipeline",
      options: [
        { flag: "scene", value: "sceneId", description: "Scene id (required)" },
        { flag: "duration", value: "seconds", description: "Target duration in seconds (required)" },
        { flag: "index", value: "n", description: "Sequence index (default 0)" },
        { flag: "action", value: "text", description: "Action description" },
      ],
    },
    {
      name: "create-episode",
      description: "Create a new episode in a series",
      group: "pipeline",
      options: [
        { flag: "series", value: "id-or-name", description: "Series to create the episode in (required)" },
        { flag: "title", value: "title", description: "Episode title (required)" },
        { flag: "season", value: "n", description: "Season number (default 1)" },
        { flag: "number", value: "n", description: "Episode number (default 1)" },
        { flag: "runtime", value: "seconds", description: "Target runtime in seconds" },
      ],
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
      name: "spend",
      description: "Show the cumulative paid-spend ledger against the ceiling (read-only)",
      group: "generation",
    },
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
      name: "approve character",
      description: "Approve the character gate",
      group: "characters",
    },
    {
      name: "approve storyboard",
      description: "Approve the storyboard gate",
      group: "storyboard",
    },
    {
      name: "approve canon",
      description: "Approve the canon gate",
      group: "pipeline",
    },
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