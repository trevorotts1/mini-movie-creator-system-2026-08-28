# Code Path Ownership (ownership.md)

**Project:** mini-movie-creator-system (MMCS)
**Binding Rule:** Zero path overlap across parallel tasks. No builder may touch files outside its declared Owned Paths.

---

## Ownership Table

| Task ID | Owned Paths | Builder | Checker | State |
|---|---|---|---|---|
| WF00-01 | `state/*`, `logs/*`, `scripts/orchestration/*`, `docs/*`, root control `.md` files | ControlPlane | Self | BUILDING |

*(Planning workflow will populate path assignments for all scheduled tasks to guarantee zero write collisions across parallel builder agents.)*