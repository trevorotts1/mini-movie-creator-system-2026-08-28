# OpenClaw skill verification — MMCS (SKL-007)

Task: **SKL-007 — OpenClaw invocation test** (workflow WF10).
Owner script: `integrations/openclaw/invocation-test.sh`.
Test environment: **live operator box** (OpenClaw 2026.7.1-2 build 0790d9f, gateway
ws://127.0.0.1:18789, macOS darwin 25.3.0, node v26.7.0).

Every claim below was executed live on 2026-08-28. Nothing is assumed; where a
step could not be performed as designed, the actual path taken and its evidence
are named.

## 1. What had to be proven (acceptance criteria)

1. Explicit invocation from an OpenClaw agent reaches the **same mmcs engine**
   and **project state** (no fork, no second engine).
2. Skill **watcher pickup verified, not assumed**.
3. `openclaw skills check` **passes** with the skill installed.
4. Test evidence **recorded here**.

## 2. Versions and surfaces used

| Surface | Value |
|---|---|
| OpenClaw CLI | `openclaw 2026.7.1-2 (0790d9f)` at `/Users/blackceomacmini/.local/bin/openclaw` |
| Gateway | ws://127.0.0.1:18789 (LaunchAgent, healthy: `openclaw health` exit 0) |
| Engine under test | `/Users/blackceomacmini/Projects/mini-movie-creator-system-2026-08-28/worktrees/SKL-007` (`package.json` name `mmcs-monorepo`) |
| Engine binary | `apps/cli/dist/index.js` (built via `pnpm run build` in `apps/cli`; note: `tsc` does not set the exec bit — `chmod +x` required, the test script enforces it) |
| Engine verb exercised | `mmcs status` (read-only stub: prints `[mmcs] status — STUB: registered, not implemented yet (spec §24).`, exits 0) |
| Skill packaging | `integrations/openclaw/mini-movie-creator/` (SKL-005 branch, installed to workspace) |
| Agent used | `codex-computer-use` (unrestricted skills allowlist; workspace `~/clawd`) |

## 3. Install path (SKL-005 packaging, CLI form)

```
openclaw skills install ./integrations/openclaw/mini-movie-creator \
  --as mini-movie-creator --force --agent codex-computer-use
```

Result: `Installed mini-movie-creator from path -> /Users/blackceomacmini/clawd/skills/mini-movie-creator`.

Live-verified details of this OpenClaw version's install flow:

- `--as` works for **local directory** installs; both relative (`./…`) and
  absolute paths install successfully (re-tested 2026-08-28 by QC with a
  disposable probe skill: `openclaw skills install /tmp/<probe> --as
  mmcs-install-probe --force --agent codex-computer-use` → rc 0, installed,
  then removed and removal confirmed by the watcher).
- Install destination is the config-resolved agent workspace:
  `<workspace>/skills/<slug>` (`~/clawd/skills/mini-movie-creator`). Workspace
  skills have highest precedence (skills roots order 1).
- This OpenClaw version has **no `openclaw skills remove`** command
  (`skills --help` lists check/curator/info/install/list/search/update/verify/
  workshop only). Local-directory installs are removed by deleting the skill
  directory from `<workspace>/skills/`; the watcher reflects the removal
  within seconds (proven live).

`openclaw skills info mini-movie-creator --agent codex-computer-use` after
install:

```
mini-movie-creator ✓ Ready
  Source: openclaw-workspace
  Path: ~/clawd/skills/mini-movie-creator/SKILL.md
  Visible to model: yes
  Available as command: yes
```

## 4. `openclaw skills check` — PASS

`openclaw skills check --agent codex-computer-use` exit code **0**:

```
Total: 189
✓ Eligible: 179
✓ Visible to model: 175
✗ Missing requirements: 1        (unrelated: "✨ gemini (bins: gemini)" — a bundled
                                  skill needing the `gemini` binary; pre-existing,
                                  not MMCS's)
Ready and visible to model:
  mini-movie-creator
```

`openclaw skills check --agent main` also exits 0 (0 missing requirements).

## 5. Watcher pickup — VERIFIED, not assumed

Method: a temporary probe skill (`mmcs-watcher-probe`) is dropped as a raw
directory + `SKILL.md` into `<workspace>/skills/` — no `openclaw skills
install`, no gateway restart — and `openclaw skills check --json` is polled
until the skill appears in `eligible` **and** `modelVisible`. The probe is then
removed and the disappearance is polled the same way (bidirectional proof).
Probe directory is always cleaned up.

Live results (repeated across runs):

| Run | Pickup | Removal |
|---|---|---|
| 1 | 2.9 s | 2.8 s |
| 2 | 5 s | 3 s |
| 3 | 6 s | 2 s |
| 4 | 7 s | 3 s |
| 5 | 5 s | 2 s |

Conclusion: the watcher (default `skills.load.watch: true`, 250 ms debounce)
picks up new workspace skills and removals within seconds; **no gateway restart
is required**. A snapshot refresh is visible through `openclaw skills check`
without restarting anything.

## 6. Explicit invocation from an OpenClaw agent — same engine, same state

The agent turn is driven by `openclaw agent --agent codex-computer-use …`
(one turn, fresh session key, `--thinking off`, read-only verb only). The
message instructs the agent to run, verbatim:

```
node <engine>/apps/cli/dist/index.js status; echo "MMCS_INVOC_EXIT:$?"; echo "MARKER:<unique>"
```

Verification: the agent session transcript
(`~/.openclaw/agents/codex-computer-use/sessions/<id>.jsonl`) is parsed for the
`toolResult` rows (`role: "toolResult"`, `toolName: exec`). The recorded tool
result must contain **exactly the same first line** the direct local run of the
same binary produces (`[mmcs] status — STUB: registered, not implemented yet
(spec §24).`) **and** `MMCS_INVOC_EXIT:0`.

Live evidence (run 2026-08-28, transcript
`e22cb042-9127-4ad0-b9d4-f5e1590eb10e.jsonl`, earlier proof transcripts:
`3d934ed9-ca50-4d1f-8e9a-bec923c8caf8.jsonl`,
`8b49d77f-4174-4819-b15b-b1bc38b7d29a.jsonl`,
`23fb0e8b-3fa5-438d-81ec-5fa134c22920.jsonl`,
`413455f1-b460-40f7-a683-e77c161d3ffb.jsonl`,
`6111ebb6-607a-48ef-a991-890791cc1d52.jsonl`):

- Direct local run: `node apps/cli/dist/index.js status` →
  `[mmcs] status — STUB: registered, not implemented yet (spec §24).`, exit 0.
- Agent `exec` tool call arguments (transcript-recorded):
  `node /Users/blackceomacmini/Projects/mini-movie-creator-system-2026-08-28/worktrees/SKL-007/apps/cli/dist/index.js status; echo "MMCS_INVOC_EXIT:$?"; echo "MARKER:MMCS_SKL007_…"`
- Agent-recorded `toolResult` text:
  `[mmcs] status — STUB: registered, not implemented yet (spec §24).` +
  `MMCS_INVOC_EXIT:0` + marker — **byte-identical to the direct run**.

Skill-mediated path proven separately: the OpenClaw agent ran the skill's own
wrapper (`bash ~/clawd/skills/mini-movie-creator/scripts/mmcs-status.sh
--mmcs-root <engine> --check`) and reported
`mmcs-status.sh: OK — engine at <engine> responds to 'mmcs status'.` with exit
0 (transcript `3d934ed9-…`, tool call verbatim in transcript).

**Same engine, same project state:** both invocations resolve the identical
engine root (the checkout containing `apps/cli/`, `state/`) — the agent is
driven against the exact same binary path, and the script asserts
`<engine>/state` exists. There is no second engine and no copied business
logic; the skill packaging is instructions + a wrapper script that executes the
engine CLI (spec §43.1: same MMCS CLI/API, same project database, never a
fork).

## 7. Agent allowlist landmine (recorded for installers)

The fleet `main` agent is configured with an **empty skills allowlist**
(`"skills": []` in `agents.list`), which OpenClaw interprets as *zero allowed
skills*: `openclaw skills check --agent main` reports
`Excluded by agent allowlist: 178` and `Visible to model: 0` for everything,
including any MMCS install. This is not an MMCS defect — the test therefore
targets an agent whose allowlist is unrestricted (`codex-computer-use`), and
`invocation-test.sh` defaults to that agent (`MMCS_OPENCLAW_AGENT` to override).
Installers targeting a different agent must give that agent a non-empty skills
allowlist (or remove the empty one) or no skill will ever be visible to its
model.

## 8. Model-behavior caveats observed (not MMCS defects)

- The codex-computer-use agent's model occasionally repeats the identical exec
  call until OpenClaw's loop guard trips ("Called exec with identical arguments
  … 6 times"). In every such case the **tool result was already recorded** with
  the correct engine output — the evidence stands even when the model never
  produces a final reply. This is why `invocation-test.sh` verifies from the
  transcript's `toolResult` rows rather than from the model's chat reply, and
  why a non-zero `openclaw agent` exit (model timeout/flake) is non-fatal as
  long as the transcript evidence is present.
- One early probe hit a genuine model-provider rate limit
  (`FailoverError: ⚠️ API rate limit reached`) and one context overflow — both
  retried successfully on a fresh session key.
- Agent turns cost a model round-trip; step 4 is gated behind
  `MMCS_OPENCLAW_LIVE=1` so batch regression never spends tokens by accident.

## 9. How to re-run

From the repo (engine root) checkout:

```
bash integrations/openclaw/invocation-test.sh --check          # state check, no mutation
bash integrations/openclaw/invocation-test.sh --self-test      # offline structural self-check
MMCS_OPENCLAW_LIVE=1 bash integrations/openclaw/invocation-test.sh          # full test incl. watcher probe
MMCS_OPENCLAW_LIVE=1 bash integrations/openclaw/invocation-test.sh --install # + install first
```

Optional overrides: `--agent <id>` / `MMCS_OPENCLAW_AGENT`,
`--mmcs-root <dir>` / `MMCS_ROOT`, `--skill-dir <dir>` / `MMCS_SKILL_DIR`,
`MMCS_OPENCLAW_SKIP_WATCHER=1`, `MMCS_OPENCLAW_AGENT_TIMEOUT=<seconds>`.

Full-run output (final lines, exit 0):

```
invocation-test: PASS — step 3 — watcher PICKUP verified in 5s (no gateway restart)
invocation-test: PASS — step 3 — watcher REMOVAL verified in 2s (bidirectional)
invocation-test: PASS — step 4 — agent invocation reached the SAME engine: tool result matches direct output; engine rc=0
invocation-test: PASS — step 4 — evidence transcript: ~/.openclaw/agents/codex-computer-use/sessions/e22cb042-9127-4ad0-b9d4-f5e1590eb10e.jsonl
invocation-test: PASS — step 4 — same project state: both invocations resolved engine root …/worktrees/SKL-007 (state/ present)
invocation-test: PASS — ALL GREEN — skills check + watcher pickup + same-engine agent invocation verified
```

## 10. Verdict

All four SKL-007 acceptance criteria **verified live** on 2026-08-28.
`openclaw skills check` passes; watcher pickup and removal observed in seconds
without restart; an explicit OpenClaw agent invocation executed the same
`mmcs` engine binary against the same project state with byte-identical output
and exit 0; evidence transcripts and this document record the chain.
