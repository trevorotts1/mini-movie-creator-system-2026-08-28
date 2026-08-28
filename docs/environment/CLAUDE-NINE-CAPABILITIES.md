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

## Skill discovery mechanism (re-verified 2026-08-28, SKL-004)

1. **Primary dir:** `~/.claude-nine/skills/` (per `CLAUDE_CONFIG_DIR`) —
   **claude-nine's skill discovery root**. Live count 2026-08-28: **61 entries =
   11 real directories + 50 symlinks**. The 11 real dirs are claude-nine's own
   tuned copies, which **win over anything the real CLI carries**:
   box-update, fix-unit, judge-unit, look, merge-writer, orchestrate, purpose,
   skill-warfix, skill-warroom, spec-protocol, swarm.
2. **Sync from real CLI:** `~/.local/bin/sync-nine-skills.sh` runs on every
   launch (verified wired into the wrapper at `~/bin/claude-nine`, lines 93-94).
   It symlinks any skill present in `~/.claude/skills` but missing in
   `~/.claude-nine/skills` (50 links as of 2026-08-28 — the full `.agents/skills`
   chain via the real CLI), prunes dead links, and **never overwrites a real
   directory**. Verified run output: `sync-nine-skills: already in sync
   (61 skills).`, exit 0. So a skill installed at `~/.claude/skills/` (SKL-003
   personal install) becomes visible to claude-nine on next launch automatically.
3. **Project skills:** `.claude/skills/` under the working directory (standard
   Claude Code behavior — MMCS can ship project-local skills there). Verified
   live: see the MMCS probe section below.
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

## MMCS verification (SKL-004, verified live 2026-08-28)

The `mini-movie-creator` skill is one canonical source (`skills/mini-movie-creator/`,
SKL-001). Every host — Claude Code, claude-nine, OpenClaw — calls the SAME engine
(`apps/cli` → the `mmcs` CLI) and the SAME persistent project state. No host carries
copied business logic; a skill is only a thin control interface over the engine.

**How claude-nine reaches the skill (discovery path):**

| Install scope | Location | How claude-nine sees it |
|---|---|---|
| Project (repo) | `<repo>/.claude/skills/mini-movie-creator` | Direct project-scope discovery under the working directory |
| Personal | `~/.claude/skills/mini-movie-creator` | `sync-nine-skills.sh` (runs on every claude-nine launch) symlinks it into `~/.claude-nine/skills/` |
| Primary root | `~/.claude-nine/skills/mini-movie-creator` (symlink) | Loaded directly from the `CLAUDE_CONFIG_DIR` skills root |

Note: a symlink installed into `~/.claude-nine/skills/` manually persists — the sync
script only removes links whose target was deleted, and only adds missing links.

**Live probe results (2026-08-28, engine = `apps/cli` @ task/SKL-004 worktree,
CLI handler still the documented §24 stub):**

1. **Fresh claude-nine session + project skill → same engine.** A throwaway skill
   `mmcs-nine-probe` at `<fresh-tmp-cwd>/.claude/skills/` was discovered and invoked
   by a brand-new headless session
   (`claude-nine -p "Invoke the /mmcs-nine-probe skill..." --allowedTools Bash`).
   Per the skill, the session executed
   `node <repo>/apps/cli/dist/index.js status` and returned verbatim:
   `MMCS-NINE-PROBE-OK engine=[mmcs] status — STUB: registered, not implemented
   yet (spec §24).` — proving discovery, invocation, and an engine call with zero
   copied logic.
2. **Config-dir root proven.** With an isolated `CLAUDE_CONFIG_DIR` containing only
   `settings.json` + `skills/mmcs-nine-primary-probe/`, a fresh session resolved and
   invoked the skill (marker `MMCS-NINE-PRIMARY-ROOT-OK`) — confirming
   `$CLAUDE_CONFIG_DIR/skills` is the primary discovery root.
3. **Sync behavior.** `sync-nine-skills.sh` re-run: exit 0, "already in sync
   (61 skills)". Root mix: 11 real dirs (nine's own, never overwritten) + 50
   symlinks into `~/.claude/skills`.

**Re-run the verification:**

```bash
cd <repo-root>
bash integrations/claude/nine-verify.sh             # full: live probes, ~2 model calls via 9Router
bash integrations/claude/nine-verify.sh --selftest  # structural checks only, no model calls
```

The script rebuilds `apps/cli` if `dist/` is missing, so it always drives the real
engine. Exit 0 = every check passed. Probe directories are `mktemp -d` scratch and
removed on exit; nothing in the repo, `~/.claude`, or `~/.claude-nine` is modified.

Practical notes for headless probe runs: pass `</dev/null` (a `-p` session otherwise
waits ~3s on inherited stdin) and allow `--max-turns 15` (a skill → Bash tool →
reply chain is unreliable at 6 turns and hit the cap once at 10; deterministic 3/3
at 15).

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