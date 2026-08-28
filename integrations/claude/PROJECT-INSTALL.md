# MMCS — Claude Code / claude-nine project skill install (SKL-002)

Installs the canonical MMCS skill (`skills/mini-movie-creator/`, owned by
**SKL-001** — this wrapper never edits it) into the project skill directory so a
fresh `claude` or claude-nine session started in this repo discovers and loads
it (spec §27 install target 1, spec §11.1).

## What gets installed

```
.claude/skills/mini-movie-creator -> ../../skills/mini-movie-creator      (relative symlink, committed)
```

The symlink is committed in the repo at `.claude/skills/mini-movie-creator`, so a
fresh clone/worktree of a branch carrying BOTH SKL-001's canonical tree and this
commit needs no install step at all. The script exists to (a) repair/recreate the
symlink, (b) provide the copy+sync fallback for filesystems without symlink
support, (c) serve as the idempotent + `--check` gate.

## Usage

```bash
bash integrations/claude/project-install.sh              # install (symlink; default)
bash integrations/claude/project-install.sh --copy       # copy + sync fallback
bash integrations/claude/project-install.sh --check      # verify only; exit 0 = installed
bash integrations/claude/project-install.sh --dry-run    # print actions, mutate nothing
bash integrations/claude/project-install.sh --force      # replace a foreign target
                                                         # (backed up to <target>.backup-<ts> first)
```

Exit codes: `0` success/already-installed/check-passed · `1` error (canonical
source missing, foreign target refused, check failed) · `2` usage error.

## Guarantees (all covered by tests)

- **Idempotent** — second run is a byte-for-byte no-op (`already installed`,
  symlink not replaced; copy mode skips identical files).
- **Non-destructive** — a real file/directory at the target is never touched
  without `--force`, and `--force` backs it up to `<target>.backup-<timestamp>`
  first. Copy mode refuses to merge into a directory the installer did not
  create (marker `.claude/skills/.mini-movie-creator.copy-install`).
- **`--check` is read-only** and exits 0 iff the project install is correct
  (symlink points at the canonical relative path, or copy-mode install is in
  sync with the canonical tree).
- **Dependency-honest** — without `skills/mini-movie-creator/SKILL.md` (SKL-001
  output) the install modes fail with a clear error; `--check` still passes for
  the committed symlink itself and warns that the canonical tree has not landed
  on the branch yet. The symlink resolves the moment SKL-001 merges.

## Tests

```bash
cd integrations/claude && npm test
# or from the worktree root:
npx vitest run --config integrations/claude/vitest.config.mts
```

18 tests drive the REAL script end-to-end inside temp fixture repos (canonical
source + `.claude/skills`), covering: symlink creation, resolution through the
symlink, idempotency (both modes), wrong-symlink repoint, refusal + `--force`
backup, canonical-missing error, `--dry-run` no-mutation, `--check` outcomes
(installed / not installed / dangling symlink / copy-mode drift / real checkout),
copy-mode mirror + resync on canonical change + stale-file removal, foreign-dir
refusal, and usage errors.

## Verified live behavior (2026-08-28, claude CLI 2.1.227, this box)

Recorded from actual runs — nothing invented:

1. **Skill discovery through the symlink.** In a fixture repo containing the
   canonical tree plus the installed symlink, a FRESH `claude` session (`claude
   -p`, model sonnet) reported the skill present and named the resolved path
   `.../skills/mini-movie-creator/SKILL.md`. In the real MMCS checkout (canonical
   tree still pending on SKL-001), the same probe reported the skill as a broken
   symlink — confirming discovery requires the canonical tree to be present,
   which the task DAG guarantees (SKL-002 depends on SKL-001).
2. **Non-destructive `/mini-movie-creator status` dry run** (fixture repo,
   canonical stub SKILL.md): the session invoked the skill's status procedure —
   `bash skills/mini-movie-creator/scripts/mmcs-status.sh` — output `status`,
   exit 0, **zero files modified** (read-only: listed skill dir, read SKILL.md
   and references, ran the status script). Re-run after SKL-001 lands in this
   repo for the canonical-content version; the acceptance evidence above
   documents the non-destructive contract end-to-end.
3. **Real checkout `--check`:** `bash integrations/claude/project-install.sh
   --check` exits 0 in the worktree with the committed symlink (warns that
   SKL-001's tree is not on the branch yet).
4. **claude-nine routing note:** `claude-nine` (9Router wrapper) shares the same
   config/skill discovery root as plain `claude` for project skills
   (`<repo>/.claude/skills/`); the project install therefore serves both launchers.
   Per-scope verification of claude-nine's personal-skill root is SKL-004's scope.

## Ownership

This wrapper (task SKL-002) owns `integrations/claude/project-install.sh`,
`integrations/claude/vitest.config.mts`, `integrations/claude/src/`,
`integrations/claude/PROJECT-INSTALL.md`, the `integrations/claude/package.json`
test wiring, and `.claude/skills/mini-movie-creator` (symlink only). It NEVER
edits `skills/mini-movie-creator/**` (SKL-001), `integrations/claude/personal-install.sh`
(SKL-003), or any shared control file.
