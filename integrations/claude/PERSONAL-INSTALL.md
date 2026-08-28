# MMCS — Claude Code / claude-nine personal skill install (SKL-003)

Installs the canonical MMCS skill (`skills/mini-movie-creator/`, owned by
**SKL-001** — this wrapper never edits it) into the **personal** skill
directory so an ordinary `claude` or claude-nine session started **outside
the repo** also discovers and loads it (spec §27 install target 2, runbook
§11.2; project-scope install is SKL-002, claude-nine verification is SKL-004).

## What gets installed

```
$HOME/.claude/skills/mini-movie-creator -> <canonical source>   (absolute symlink)
```

The symlink is **absolute** because personal scope has no repo-relative
anchor: the target must resolve regardless of the working directory of the
session that loads it (project scope, by contrast, can use the relative
`../../skills/...` — see SKL-002).

The wrapper also writes `$HOME/.mmcs/mmcs.env` (paths + env NAMES only, no
secrets) recording the engine location:

```bash
source "$HOME/.mmcs/mmcs.env"        # exports MMCS_REPO_ROOT and MMCS_CLI
```

This is the escape hatch for a personal-scope session started OUTSIDE the
repo. `skills/mini-movie-creator/scripts/mmcs-status.sh` (SKL-001) resolves
the repo root by lexical walk-up from the script location, which stops at
`$HOME` when reached through the personal symlink; its documented override is
`$MMCS_REPO_ROOT`. Sourcing this file makes the full engine surface
reachable: `bash ~/.claude/skills/mini-movie-creator/scripts/mmcs-status.sh`
then exits 0 from any directory.

## Script behaviors (all covered by tests)

```bash
bash integrations/claude/personal-install.sh                  # install (symlink; default)
bash integrations/claude/personal-install.sh --source <path>  # canonical content from another checkout
bash integrations/claude/personal-install.sh --repo-root <p>  # engine/repo root recorded in ~/.mmcs/mmcs.env
bash integrations/claude/personal-install.sh --check          # verify only; exit 0 = installed
bash integrations/claude/personal-install.sh --dry-run        # print actions, mutate nothing
bash integrations/claude/personal-install.sh --force --confirm # replace an existing personal skill
                                                              # (full backup first; --confirm is the typed confirmation)
```

Exit codes: `0` success/already-installed/check-passed · `1` error (canonical
source missing, refused overwrite, broken symlink, check failed) · `2` usage
error.

### Safety: never destroys a personal skill without backup + confirmation

Spec §27: *"Never overwrite an existing personal skill without
backup/confirmation."* The personal scope is the operator's working
environment, so this is the strictest of the three install targets:

- A **wrong symlink** is repointed without a backup — a link holds no skill
  content, so nothing is destroyed.
- A **real file/directory** at the target is **never** touched without BOTH
  `--force` and `--confirm`. `--force` alone still refuses.
- When replacement proceeds, the installer writes a **full backup** to
  `<target>.backup-<timestamp>/` in the same directory **before** removing
  anything. Restoring is one `mv` command.
- `--dry-run` prints every action and mutates nothing (checked in a fixture
  — the real `$HOME` is never touched by tests, which spawn with `HOME`
  pointed at a temp dir).

### Dependency-honesty (same lifecycle as SKL-002)

The canonical tree `skills/mini-movie-creator/` is SKL-001's output, which was
still pending on `integration` at the time this wrapper was built. Install
modes refuse with a clear error when `SKILL.md` is absent; `--check` still
exits 0 when the symlink is correct and warns that the tree has not landed.
The symlink resolves the moment SKL-001 merges — the task DAG orders SKL-003
after SKL-001.

## Skill discovery roots (documented, per spec §27)

| Host | Personal skill root | Notes |
|---|---|---|
| `claude` | `~/.claude/skills/` | installed here |
| `claude-nine` | `~/.claude-nine/skills/` (PRIMARY) | synced from `~/.claude/skills/` by `~/.local/bin/sync-nine-skills.sh` at every launch; claude-nine's own real directories win over symlinks |

So installing to `~/.claude/skills/mini-movie-creator` makes the skill visible
to plain `claude` immediately and to `claude-nine` on its next launch through
its sync step. SKL-004 separately verifies claude-nine's exact root behavior
with live probes.

## Tests

```bash
cd integrations/claude && npm test
# or from the worktree root:
npx vitest run --config integrations/claude/vitest.config.mts
```

22 tests drive the REAL script end-to-end inside temp fixture islands
(canonical source + a fake `$HOME`), covering: symlink creation with an
absolute target, resolution through the symlink, idempotency, wrong-symlink
repoint, refusal without `--force`, refusal of `--force` without `--confirm`,
full-backup-then-replace with `--force --confirm` (nested file preserved in
the backup), canonical-missing error, `--source` alternate checkout,
`--repo-root` env recording, `--dry-run` no-mutation (incl. no env file),
`--check` outcomes (installed / pending canonical / missing / dangling / real
directory), and usage errors.

## Verification evidence (live, 2026-08-28, this box)

Recorded from actual runs — nothing invented:

1. **Install.** `bash integrations/claude/personal-install.sh --source
   <SKL-001 tree> --repo-root $HOME/Projects/mini-movie-creator-system-2026-08-28`
   created the symlink, wrote `~/.mmcs/mmcs.env` with
   `MMCS_REPO_ROOT=/Users/blackceomacmini/Projects/mini-movie-creator-system-2026-08-28`,
   and `--check` confirmed the symlink (warned that the canonical tree is not
   on integration yet).
2. **Outside-repo engine locate.** With only `source ~/.mmcs/mmcs.env`, from
   `/tmp`: `bash ~/.claude/skills/mini-movie-creator/scripts/mmcs-status.sh`
   → `engine surface reachable — exit 0` (via `MMCS_REPO_ROOT`). Without the
   env or an in-repo CWD, the script correctly reports unresolved root and
   exits 1 (SKL-001's own contract — never a false PASS).
3. **Fresh-session skill discovery.** In the live session itself, the skill
   resolved and loaded from `~/.claude/skills/mini-movie-creator` (canonical
   content on hand at the time). SKL-004 owns the dedicated fresh-claude-nine
   probe; this wrapper's discovery contract (absolute symlink + env root) is
   proven by the fixture tests above.
4. **Nothing destroyed.** The live box had NO pre-existing
   `~/.claude/skills/mini-movie-creator` before this install; no backup was
   needed, and none was created. The `--force --confirm` backup path is
   proven by the fixture tests (which use a fake `$HOME`; the real `$HOME`
   is never modified by tests).

After SKL-001 merges: `bash integrations/claude/personal-install.sh --check`
exits 0 with `SKILL.md found` — the symlink needs no repair (it already
points at the canonical path).

## Ownership

This task (SKL-003) owns `integrations/claude/personal-install.sh`,
`integrations/claude/vitest.config.mts`, `integrations/claude/src/personal-install.test.ts`,
`integrations/claude/package.json` test wiring, `integrations/claude/tsconfig.json`
(node types + test include), `integrations/claude/PERSONAL-INSTALL.md`, and
`$HOME/.claude/skills/mini-movie-creator` (symlink). It NEVER edits
`skills/mini-movie-creator/**` (SKL-001), `integrations/claude/project-install.sh`
(SKL-002), or any shared control file.
