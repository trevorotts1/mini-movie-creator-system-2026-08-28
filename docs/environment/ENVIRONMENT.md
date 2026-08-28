# MMCS Environment — Operator Mac Mini (verified 2026-08-28)

Source of discovery: live CLI probes + on-disk inspection on this box. Nothing re-verified
from the pre-verified list; facts marked pre-verified are used as given.

## Host

| Item | Value |
|---|---|
| OS | macOS 26.3.1, arm64 (Darwin 25.3.0) |
| Host | TrevelynsMini2 (192.168.1.206) — Trevor's operator/canary box |
| Disk | 33 Gi free of 460 Gi (~92% used; live `df` on Data volume: 30 Gi avail, 93% capacity) |

**RISK — DISK SPACE.** ~30–33 Gi free on a 460 Gi volume. MMCS media pipelines
(ffmpeg renders, remotion bundles, downloaded stock assets) can consume tens of Gi
per production run. Flag: monitor `df` before/after media jobs; no headroom for a
bad render loop. This box also hosts the openclaw gateway + 91 agents, so runaway
subagent output compounds the risk.

## Toolchain (pre-verified facts)

| Tool | Version | Notes |
|---|---|---|
| git | 2.50.1 | |
| gh | 2.86.0 | auth trevorotts1, keyring token |
| node | v26.7.0 | /opt/homebrew/bin/node |
| npm | 11.8.0 | `ignore-scripts=true` in ~/.npmrc (npm hardening) |
| bun | 1.3.14 | |
| pnpm | MISSING | not installed |
| ffmpeg / ffprobe | 8.1.1 | |
| python3 | 3.14.5 | |
| claude | 2.1.227 | real Anthropic CLI, `~/bin/claude` wrapper → native binary |
| claude-nine | 2.1.227 | 9Router wrapper, config dir `~/.claude-nine` (see CLAUDE-NINE-CAPABILITIES.md) |
| openclaw | 2026.7.1-2 (0790d9f) | gateway live on ws://127.0.0.1:18789, LaunchAgent running |

## claude / claude-nine launcher architecture (verified on disk)

- `~/bin/claude` — wrapper for the REAL CLI (talks to Anthropic directly). Two jobs:
  1. repairs a broken install when npm's `ignore-scripts=true` skipped the
     postinstall (package lives at `~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/`,
     native binary `bin/claude.exe`, ~256 MB Mach-O vs ~500-byte placeholder);
  2. scrubs router config that hijacks `~/.claude/settings.json`, and unsets
     inherited 9Router env (`ANTHROPIC_BASE_URL` on :20128, `sk-9r-*` tokens,
     slash-containing router model ids) so the real CLI never routes through 9Router.
- `~/.local/bin/claude-nine` (also `claude-9` via `~/bin`) — sets
  `CLAUDE_CONFIG_DIR=~/.claude-nine`, exports `GITHUB_PERSONAL_ACCESS_TOKEN`
  from the gh keyring for the github MCP plugin (never printed), re-applies three
  9Router patch guards on every launch
  (`9router-dupfix-guard.sh`, `9router-codex-terminal-guard.sh`,
  `9router-nextserver-guard.sh`), runs `sync-nine-skills.sh`, auto-starts 9Router
  on :20128 if nothing is listening, then execs the same native binary.
- Shared helper: `~/bin/claude-code-lib.sh` (`cc_resolve_binary`, `cc_scrub_router_settings`).
- 9Router itself: `~/.9router/`, port 20128; auth via `apiKeyHelper`
  (`~/.local/bin/get-9router-key.sh`, token in macOS Keychain — never plaintext).

## Claude hooks — CONFIRMED event names

Confirmed against the settings schema this CLI actually references
(`$schema: https://json.schemastore.org/claude-code-settings.json`, fetched live),
which enumerates 31 hook events:

SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure,
PostToolBatch, PermissionRequest, PermissionDenied, Notification, UserPromptSubmit,
UserPromptExpansion, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
PostCompact, Elicitation, ElicitationResult, TeammateIdle, TaskCompleted,
TaskCreated, Setup, InstructionsLoaded, CwdChanged, FileChanged, ConfigChange,
WorktreeCreate, WorktreeRemove, MessageDisplay, DirectoryAdded.

Specifically requested events: **all 8 CONFIRMED** (SessionStart, PreCompact,
PostCompact, TaskCompleted, SubagentStart, SubagentStop, SessionEnd, TeammateIdle).

NOT FOUND: no hook event named `PostCompact` is missing — but note there is NO
`Compact`/`CompactStart` event separate from Pre/PostCompact, and no
`TeammateStart`. Also no `.claude/sheets` directory anywhere (checked `~/.claude`,
`~/.claude-nine`).

**Live hook usage** (real CLI, `~/.claude/settings.json`): SessionStart (2 MCP key
sync scripts), Stop (4 gate scripts: reconcile-tasks-reminder, floor-claim-gate,
goal-claim-gate, negative-claim-gate), PreToolUse matcher `Bash|Monitor`
(gate-wait-guard.sh), SubagentStop (subagent-stop-guard.sh). claude-nine's
settings.json currently defines **no hooks** — the same guards live only in the
real CLI's config.

## Workflows (dynamic multi-agent) — CONFIRMED

- `enableWorkflows: true` + `workflowSizeGuideline: "unrestricted"` in BOTH
  `~/.claude/settings.json` and `~/.claude-nine/settings.json`.
- Schema keys confirmed: `disableWorkflows` (inverse flag),
  `workflowKeywordTriggerEnabled` (the literal keyword "ultracode" in a prompt
  triggers a dynamic workflow; v2.1.157+), `workflowSizeGuideline` (advisory agent
  count Claude aims for).
- Registry = plain `.js` files in `<config-dir>/workflows/`:
  - `~/.claude-nine/workflows/` — 44 files (mmcs-bootstrap, wf-A/B/C, qmm-*, cc-check-*, oc-check-*, judge-pool-*, propagate-*, wf-box-update-A..D).
  - `~/.claude/workflows/` — 7 files (gauntlet-loop-2, wf-fix-cc-wave2, wf-fix-dirty-cc, plus 4 wf-box-update copies). Registries are separate per config dir.
- Format (read from `~/.claude-nine/workflows/mmcs-bootstrap.js`): ES module with
  `export const meta = { name, description, phases: [{title, detail}] }`, then
  top-level `phase('Name')` calls and `await agent(prompt, schema?)` spawning
  subagents; `args` carries launch parameters; workflow returns a RESULT schema
  (`ok/summary/details/blockers`).

## Agent teams — CONFIRMED (experimental, enabled)

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in both configs;
  `teammateMode: "in-process"`, `teammateDefaultModel: "sonnet-chain"` (claude-nine).
- Live state: `~/.claude-nine/teams/` holds 10 `session-*` dirs, each with
  `config.json` (leadAgentId, members[], backendType). `~/.claude/teams/` has 9.
- In-session tools observed: SendMessage (teammate messaging), ListAgents,
  TaskCreate/Get/Update/List (shared task store).
- `claude agents --json` lists live interactive + background sessions (3 active at
  discovery time); `--bg` flag and `claude agents` agent view confirmed in help.

## MCP servers (live, `claude mcp list`)

Connected: claude.ai Airtable, Google Calendar, Gmail, Google Drive, Hugging Face,
plugin:github (api.githubcopilot.com), plugin:playwright (headless), plugin:context7,
n8n-mcp, sequential-thinking, mobbin.
Needs auth: Context7(claude.ai), n8n(claude.ai), Slack, Canva, Vercel, Fireflies,
plugin:supabase/figma/vercel/stripe/slack.
Failed: `headroom` (ENOENT — binary not on PATH).
claude-nine additionally enables plugin `candice-integration@candice-marketplace`
(local dir marketplace at `~/Library/Application Support/BlackCEO/999/plugin`).

## openclaw (verified live, paths only)

| Item | Value |
|---|---|
| Version | 2026.7.1-2 (0790d9f) |
| Gateway | ws://127.0.0.1:18789, LaunchAgent `loaded · running (pid 18635)` |
| Dashboard | http://127.0.0.1:18789/ |
| Default agent workspace | `/Users/blackceomacmini/clawd` (`openclaw config get agents.defaults.workspace`) |
| Per-agent dirs | `~/.openclaw/agents/<name>/agent` |
| Agents configured | 91 (`openclaw agents list`) |
| Skills | 188 listed (`openclaw skills list`), header reports 0/188 ready; sources: openclaw-bundled / openclaw-managed / openclaw-workspace / openclaw-extra |
| Hooks (openclaw's own) | 5/5 ready, all openclaw-bundled: boot-md, bootstrap-extra-files, command-logger, compaction-notifier, session-memory |
| Workspaces | `~/.openclaw/workspaces/` (claudecode-gr, command-center, ollama-local, rescue-rangers, workflows) + `~/.openclaw/workspace/` (main) |
| Config warning | whatsapp plugin referenced in config but not installed (pre-existing, not MMCS-related) |

Key subcommands verified: `openclaw skills list/info/install/check/workshop`,
`openclaw hooks list`, `openclaw agents list/bindings`, `openclaw config get|patch`,
`openclaw status`, `openclaw gateway`, `openclaw cron`, `openclaw memory`.

## Repo facts (this project)

- Path: `/Users/blackceomacmini/Projects/mini-movie-creator-system-2026-08-28`
- Renamed fork of hassancs91/claude-faceless-shorts-creator → trevorotts1/mini-movie-creator-system-2026-08-28, clean main at 773054b, remotes origin+upstream wired, MIT LICENSE present.
- Existing tree: `ai-shorts/`, `media/`, `remotion/`, `shorts/`, `tools/`, `vox-shorts/`, `.env.example`, `brand.md`, `CLAUDE.md`, `IDEAS.md`, `README.md`.

## Known environment quirks relevant to MMCS

1. **Disk pressure** — see risk above. Clean before heavy media work; renders and
   node_modules across many worktrees are the usual consumers.
2. **npm `ignore-scripts=true`** — any `npm install` of claude-code (or packages
   needing postinstall) silently skips scripts; the `~/bin/claude` wrapper
   self-heals the CLI, other packages do not self-heal.
3. **pnpm missing** — remotion/next projects that assume pnpm need corepack or
   npm fallback.
4. **9Router guards are load-bearing** — a 9Router update silently reverts the
   dupfix/codex-terminal/next-server patches; `claude-nine` re-applies them every
   launch. Never launch the native binary directly for router work.
5. **Two CLIs, two config worlds** — `claude` (real, ~/.claude) vs `claude-nine`
   (router, ~/.claude-nine). Skills sync one way (real → nine, symlinks; nine's own
   tuned copies win). Workflows do NOT sync — each config dir has its own registry.