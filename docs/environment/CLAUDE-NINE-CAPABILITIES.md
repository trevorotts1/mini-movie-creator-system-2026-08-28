# claude-nine — Capabilities Reference (verified 2026-08-28)

`claude-nine` (alias `claude-9`) = Claude Code 2.1.227 routed through 9Router on
Trevor's own API keys. Wrapper: `~/.local/bin/claude-nine` (symlinked from
`~/bin/claude-9`), native binary at
`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`.

## Version & runtime identity

| Item | Value |
|---|---|
| Version | 2.1.227 (`claude-nine --version` — same binary as real `claude`) |
| Config dir | `~/.claude-nine` (`CLAUDE_CONFIG_DIR` set by wrapper) |
| Router | 9Router on `http://127.0.0.1:20128/v1` (`ANTHROPIC_BASE_URL`), auto-started by wrapper if not listening |
| Auth | `apiKeyHelper: ~/.local/bin/get-9router-key.sh` — token from macOS Keychain, 1h TTL (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3600000`); login/logout commands disabled |
| Permission mode | `bypassPermissions` (defaultMode), `skipDangerousModePermissionPrompt: true` |
| Context | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=700000`, `autoCompactWindow: 500000`, auto-compact on |
| Output | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=96000` |
| Status line | `/Users/blackceomacmini/.claude/statusline-command.sh` (shared with real CLI) |

## Model aliases & routing (verified from settings.json + schema)

`~/.claude-nine/settings.json` maps every Claude alias to a 9Router model id:

| Alias / request | Router id | Via |
|---|---|---|
| default (`"model": "opus"`) | **opus-chain** | `ANTHROPIC_DEFAULT_OPUS_MODEL` + `modelOverrides["claude-opus-5"]` |
| `sonnet` / claude-sonnet-5 / subagent default | **sonnet-chain** | `ANTHROPIC_DEFAULT_SONNET_MODEL` + `modelOverrides["claude-sonnet-5"]` |
| `haiku` / claude-haiku-4-5 | **haiku-chain** | `ANTHROPIC_DEFAULT_HAIKU_MODEL` + `modelOverrides["claude-haiku-4-5"]` |
| `fable` / claude-fable-5 | **fusion-coding** | `ANTHROPIC_DEFAULT_FABLE_MODEL` + `modelOverrides["claude-fable-5"]` |
| subagents | **inherit** | `CLAUDE_CODE_SUBAGENT_MODEL=inherit` (subagent takes parent's model unless its prompt names one) |
| teammates | **sonnet-chain** | `teammateDefaultModel` |

Routing expectations for workflows: a workflow `agent()` call without an explicit
model gets the parent's model (inherit); `--model opus` at launch lands on
opus-chain; anything asking for sonnet lands on sonnet-chain. Full-name requests
(`claude-opus-5` etc.) are also remapped by `modelOverrides`, so no request
escapes to Anthropic directly — everything goes through :20128.

## Skill discovery mechanism (verified)

1. **Primary dir:** `~/.claude-nine/skills/` (per `CLAUDE_CONFIG_DIR`). Contains
   49 real directories — claude-nine's own tuned copies (box-update, fix-unit,
   judge-unit, look, merge-writer, orchestrate, purpose, skill-warfix,
   skill-warroom, spec-protocol, swarm + fable-haiku/fable-mode/fable-sonnet,
   fablize, fleet-access, fleet-roll, graphify, kaizen, live-ledger, slides, tonine,
   ui-styling, ui-ux-pro-max, woo-guard, wp-guard, test-guard, docs-guard, eli5,
   bro, brand, design, design-system, banner-design, clean-code-guard,
   agw-ledger-tick/agw-resume/agw-work-loop, kimi-webbridge,
   resume-after-limit, temp-fleet-standing-gate, nine-router-setup).
2. **Sync from real CLI:** `~/.local/bin/sync-nine-skills.sh` runs on every launch.
   It symlinks any skill present in `~/.claude/skills` but missing in
   `~/.claude-nine/skills` (~52 links: graphify, fleet-access, gsap, tailwind,
   three, lottie, animejs, hyperframes*, supabase, ui-*, etc. — the full
   `.agents/skills` chain via the real CLI), prunes dead links, and **never
   overwrites a real directory** (claude-nine's tuned copies win over the real
   CLI's versions).
3. **Project skills:** `.claude/skills/` under the working directory (standard
   Claude Code behavior — MMCS can ship project-local skills there).
4. **Plugins:** `~/.claude-nine/plugins/` — installed set mirrors the real CLI's
   official plugins (frontend-design, github, playwright, security-guidance,
   supabase, figma, vercel, stripe, slack, context7) plus
   `candice-integration@candice-marketplace` (enabled; local marketplace dir).
5. NOT FOUND: no `.claude/sheets` directory in `~/.claude`, `~/.claude-nine`, or
   the repo. Skills resolve as `/skill-name` even in `--bare` mode (per help text).

## Workflow surfaces (verified)

- **Enablement:** `enableWorkflows: true`, `workflowSizeGuideline: "unrestricted"`
  (no agent-count cap guidance), plus
  `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=10000` and
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=500`,
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=8` in env.
- **Registry:** `~/.claude-nine/workflows/` — 44 `.js` workflow files. This is a
  per-config-dir registry (real CLI's `~/.claude/workflows/` has 7 different
  files; no sync between them). Format: `export const meta = { name, description,
  phases }` + `phase('X')` + `await agent(prompt, schema)` + `args` params + a
  RESULT JSON schema (ok/summary/details/blockers) returned by StructuredOutput.
- **Triggers:** prompt keyword **"ultracode"** triggers a dynamic workflow
  (`workflowKeywordTriggerEnabled` in schema; the keyword trigger setting was
  present in a settings backup `bak-ultracode-20260824`).
- **Bundled workflow commands:** the `--safe-mode` help text confirms workflows are
  among the customization classes that exist; `disableWorkflows` is the kill
  switch. `--disable-slash-commands` disables all skills.
- NOT FOUND: no `workflows list`/`workflows run` CLI subcommand — `claude --help`
  Commands list has no workflows entry; registry files are picked up by the
  harness itself (slash-command/ultracode surface), not by a management command.

## Agent / background-session surfaces (verified)

- `claude agents` — agent view (TUI) managing background agents. Flags: `--model`,
  `--effort`, `--permission-mode`, `--cwd`, `--json`, `--all` (include completed),
  `--settings`, `--mcp-config`, `--plugin-dir`, `--agent` default for dispatched
  sessions. `claude --bg` starts a background agent and returns immediately.
- `claude-nine agents --json` — live proof: 3 active sessions at discovery
  (2 idle interactive named sessions, 1 busy), each with pid/cwd/sessionId/name/status.
- **Agent teams** (experimental, ON): `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
  `teammateMode: "in-process"`, `teammateDefaultModel: "sonnet-chain"`. Team state
  at `~/.claude-nine/teams/<session-uuid>/config.json` (leadAgentId, members with
  agentId/name/agentType/backendType). 10 team dirs present. In-process teams give
  teammates SendMessage/ListAgents + a shared TaskCreate/Get/Update/List store.
- `--agent <name>` / `--agents '<json>'` per-session custom agent definitions;
  `agent` setting key in schema ("Name of an agent (built-in or custom) for the
  main thread").
- Subagent status line: `subagentStatusLine` settings key exists in schema.

## Hooks — CONFIRMED / NOT FOUND table

Schema source: `https://json.schemastore.org/claude-code-settings.json` (the exact
`$schema` URL referenced by `~/.claude-nine/settings.json`), fetched 2026-08-28.
It enumerates 31 hook event names. Cross-checked against live hook usage in
`~/.claude/settings.json` (real CLI) and `openclaw hooks list` (openclaw's own,
separate system).

| Event | Status | Evidence |
|---|---|---|
| SessionStart | CONFIRMED | in schema properties; used live in ~/.claude/settings.json (2 MCP-key sync scripts) |
| PreCompact | CONFIRMED | in schema properties |
| PostCompact | CONFIRMED | in schema properties |
| TaskCompleted | CONFIRMED | in schema properties |
| SubagentStart | CONFIRMED | in schema properties |
| SubagentStop | CONFIRMED | in schema properties; used live in ~/.claude/settings.json (subagent-stop-guard.sh) |
| SessionEnd | CONFIRMED | in schema properties |
| TeammateIdle | CONFIRMED | in schema properties |
| PreToolUse | CONFIRMED | schema + live use (matcher `Bash\|Monitor`, gate-wait-guard.sh) |
| PostToolUse / PostToolUseFailure / PostToolBatch | CONFIRMED | schema |
| PermissionRequest / PermissionDenied | CONFIRMED | schema |
| Notification, UserPromptSubmit, UserPromptExpansion | CONFIRMED | schema |
| Stop / StopFailure | CONFIRMED | schema + live use (4 gate scripts) |
| TaskCreated | CONFIRMED | schema (distinct from TaskCompleted) |
| Elicitation / ElicitationResult, Setup, InstructionsLoaded, CwdChanged, FileChanged, ConfigChange, WorktreeCreate, WorktreeRemove, MessageDisplay, DirectoryAdded | CONFIRMED | schema |
| `TeammateStart` (counterpart of TeammateIdle) | NOT FOUND | not in schema property list; sources checked: full schema property dump |
| `CompactStart` / bare `Compact` | NOT FOUND | same source; compaction hooks are PreCompact/PostCompact only |

claude-nine's own settings.json defines **zero hooks** today — all live hooks run
in the real CLI's config. Hook lifecycle events can be observed in stream output
via `--include-hook-events` (with `--output-format=stream-json`).

## Other verified runtime facts

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + in-process teammates are what the
  MMCS orchestration (SendMessage/ListAgents/Task* tools) runs on.
- `policy-limits.json` in `~/.claude-nine/`: `enforce_web_search_mcp_isolation`
  allowed=false; no compliance taints; `remote_control_at_startup` default false.
- `DISABLE_AUTOUPDATER=1` + `autoUpdates: false` — pinned to 2.1.227 until manual
  update (`claude update`); last update result file shows 2.1.226→2.1.227 via npm
  on 2026-08-10.
- `CANDICE_COMPANION_CMD` points at `~/.local/bin/candice-companion` (voice
  companion plugin integration).
- `--bare` mode exists (skips hooks/skills auto-discovery/CLAUDE.md; skills still
  resolve via /skill-name) — useful for clean-room test runs.
- Debug: `-d/--debug [filter]` (categories like `api,hooks`), `--debug-file`.

## Sources checked for NOT-FOUND items

- `claude-nine --help` / `claude --help` full output (commands + options)
- `claude agents --help`
- `~/.claude-nine/` full `ls -la` (71 files, 18 dirs) — no `sheets/`, no separate
  skills registry file
- `~/.claude/` full `ls -la` — no `sheets/`
- `~/.claude-nine/workflows/` and `~/.claude/workflows/` listings
- `~/.claude-nine/settings.json`, `~/.claude/settings.json` (full read)
- json.schemastore.org claude-code-settings.json — full `hooks.properties` and
  workflow/agent/teammate keys
- `~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/` (sdk-tools.d.ts,
  install.cjs, cli-wrapper.cjs — no hook event registry in the .cjs files checked)