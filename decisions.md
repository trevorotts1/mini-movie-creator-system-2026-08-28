# Architectural & Process Decisions (decisions.md)

**Project:** mini-movie-creator-system (MMCS)
**Format:** ADR-style, immutable once adopted.

---

## D-001: Repository Foundation & Upstream Fork Relationship

- **Date:** 2026-08-28
- **Status:** APPROVED
- **Author:** Bootstrap Control Plane Agent

### Context
MMCS builds upon the foundation of `hassancs91/claude-faceless-shorts-creator`, which provides an initial Remotion template and voiceover workflow under the MIT License. We needed to confirm whether the GitHub remote was configured as a direct fork or a detached fresh repository.

### Finding (from live Git and GitHub verification)
1. Live remotes (`git remote -v`):
   - `origin`: `https://github.com/trevorotts1/mini-movie-creator-system-2026-08-28.git`
   - `upstream`: `https://github.com/hassancs91/claude-faceless-shorts-creator`
2. GitHub API check (`gh repo view trevorotts1/mini-movie-creator-system-2026-08-28 --json isFork,parent,url`):
   - `isFork`: `true`
   - `parent`: `hassancs91/claude-faceless-shorts-creator`
   - `url`: `https://github.com/trevorotts1/mini-movie-creator-system-2026-08-28`
3. Commit tree verification:
   - Base commit `773054bebbe460de0f31dcfda5315970b1c8b4f2` (2026-08-18) is identical to upstream `main`.

### Decision
The repository is maintained as an official GitHub fork of `hassancs91/claude-faceless-shorts-creator`. We preserve the original MIT License, maintain the `upstream` remote for tracking upstream improvements, and build MMCS subsystems as additive layers with dedicated paths and explicit control plane structures.

### Consequences
- MIT License attribution is preserved in root `LICENSE`.
- Upstream changes can be fetched via `git fetch upstream` when needed.
- Upstream files remain untouched during MMCS bootstrap.
- All MMCS architecture expands cleanly into structured directories (`state/`, `docs/`, `scripts/orchestration/`, etc.).