# Skill Installs — Claude Code, claude-nine, OpenClaw

MMCS ships **one canonical skill** with three install targets — no copied
business logic anywhere (spec §27). Canonical source:
`skills/mini-movie-creator/` (`SKILL.md` + `references/` + `scripts/`),
owned by SKL-001; install wrappers never edit it.

The skill is a thin control interface over the `mmcs` engine: it instructs
the calling agent to honor the six approval gates, never bypass cost
controls, run `mmcs status` before mutating, and use engine verbs instead of
hand-manipulating media.

## 1. Claude Code / claude-nine — project scope (SKL-002)

The committed symlink `.claude/skills/mini-movie-creator` →
`../../skills/mini-movie-creator` makes a fresh `claude` / claude-nine
session in the repo discover the skill with **no install step**. To repair,
reinstall, copy-fallback, or check:

```bash
bash integrations/claude/project-install.sh              # install (symlink; default)
bash integrations/claude/project-install.sh --copy       # copy + sync fallback (no symlink FS)
bash integrations/claude/project-install.sh --check      # verify only; exit 0 = installed
bash integrations/claude/project-install.sh --dry-run    # print actions, mutate nothing
bash integrations/claude/project-install.sh --force      # replace foreign target (backed up first)
```

Details: `integrations/claude/PROJECT-INSTALL.md`.

## 2. Claude Code / claude-nine — personal scope (SKL-003)

Makes the skill loadable from sessions started **outside** the repo. Writes
an absolute symlink `~/.claude/skills/mini-movie-creator` plus
`~/.mmcs/mmcs.env` (paths + env NAMES only, no secrets) recording the engine
location:

```bash
bash integrations/claude/personal-install.sh                 # install
bash integrations/claude/personal-install.sh --source <path> # canonical content from another checkout
bash integrations/claude/personal-install.sh --repo-root <p> # engine root recorded in ~/.mmcs/mmcs.env
```

Never overwrite an existing personal skill without backup + explicit
confirmation. From any directory afterwards:

```bash
source ~/.mmcs/mmcs.env                       # exports MMCS_REPO_ROOT, MMCS_CLI
bash ~/.claude/skills/mini-movie-creator/scripts/mmcs-status.sh
```

Details: `integrations/claude/PERSONAL-INSTALL.md`.

### claude-nine specifics (SKL-004)

claude-nine (alias `claude-9`) is Claude Code routed through 9Router using
the config dir `~/.claude-nine/`. Its launcher syncs `~/.claude/skills`
entries into `~/.claude-nine/skills` (project-scope skills come from
`.claude/skills` under the working directory as usual). Verify live on your
box:

```bash
bash integrations/claude/nine-verify.sh
```

Non-destructive (probes in `mktemp -d`, removed on exit). A `SKIP` result is
recorded as a skip — never as a pass. Capability notes:
`docs/environment/CLAUDE-NINE-CAPABILITIES.md`.

## 3. OpenClaw (SKL-005 workspace / SKL-006 optional global)

The packaged copy lives at `integrations/openclaw/mini-movie-creator/`.
**Workspace install is the supported default** — placed into the active
agent's workspace, resolved from OpenClaw config (`agents.list[].workspace`,
falling back to `agents.defaults.workspace`). If OpenClaw cannot answer, the
script aborts rather than guess a path:

```bash
bash integrations/openclaw/install.sh --check        # verify, mutates nothing
bash integrations/openclaw/install.sh                # workspace install
bash integrations/openclaw/install.sh --uninstall    # remove
```

Optional shared/global form (installs into OpenClaw's managed global skills
directory): `bash integrations/openclaw/global-install.sh` (or `--check` for
verify + self-test). Invocation evidence:
`docs/openclaw-skill-verification.md`.

## After installing any target

The skill always drives the same engine. Confirm health:

```bash
mmcs doctor          # or node apps/cli/dist/index.js doctor
```

and, for a skill session, `/mini-movie-creator` in Claude Code / claude-nine.
The equivalent OpenClaw path is the same `SKILL.md` through the OpenClaw
agent.