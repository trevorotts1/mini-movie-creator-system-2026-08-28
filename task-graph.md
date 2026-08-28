# task-graph.md — MMCS Dependency DAG

**Project:** mini-movie-creator-system-2026-08-28
**Authority sources:** `~/Projects/mmcs-runbook-2026-08-28.md` §10 (waves), §24 (task decomposition); repo `spec.md` §28 (waves), §24 (CLI), §32 (acceptance).
**Status:** AUTHORITATIVE dependency DAG — 2026-08-28.

Task count note: runbook §24 verbatim enumeration yields **149** task IDs (CORE 15, CHAR 15, DIR 15, CAP 10, AGN 10, KIE 10, FISH 10, GHL 12, VID 16, QC 12, SKL 7, REC 11, REL 6). The orchestration instruction said 148; the §24 list itself is authoritative and all 149 appear below, each with an explicit dependency list or `NONE`.

---

## 1. Notation legend

| Notation | Meaning |
|---|---|
| `TASK -> dep1, dep2` | TASK depends on dep1 and dep2. A dependency is **satisfied** when the dep task reaches `MERGED` on `integration` (batch-merge loop), or earlier when the dep's consumed surface is a stable interface the dep owner has committed. |
| `NONE` | No upstream task dependency. Start-eligible immediately in Wave 1 (Wave 0 bootstrap already done per spec §2). |
| W1 / W2 / W3 | Wave membership (§2 below). Within-wave edges unlock the dependent **immediately** when the dep merges — never wave-gated. |
| Edge rule | Only **real** data/control dependencies appear. "Lives in the same repo" is not an edge. Fixture/mock-testable integration is a Wave-1 edge, not a Wave-2 membership. |

---

## 2. Wave definitions — only real dependencies create a later phase

**Wave 0 — bootstrap (DONE).** Repo, fork relationship, license, upstream baseline, BASELINE-REPORT.md, environment docs (spec §2). No §24 tasks remain here.

**Wave 1 — all genuinely independent subsystem implementation (the default; 127 tasks).** Everything buildable against schemas, interfaces, and mocked fixtures: all CORE, CHAR-001–013, DIR-001–015, CAP-001–010, AGN-001–010, KIE-001–010, FISH-001–010, GHL-001–008 + 010–012, VID-001–011 + 015–016, QC-001–011, REC-001–009. Intra-wave edges below are real but do **not** wait for the wave — dependents unlock the moment their specific deps merge.

**Wave 2 — only work truly needing Wave-1 outputs (16 tasks).** Concrete edges:

- **Character chain** (`character candidate -> canonical GHL image -> series bible integration`): `GHL-009` needs a real locked canonical record (`CHAR-002`, `CHAR-005`) plus real GHL ingest (`GHL-008`); `CHAR-014` refreshes/falls back those real links; `CHAR-015` scores reference packs from real accepted/rejected clip outcomes (`QC-001`). (Bible domain model CHAR-012/013 is Wave 1; its durable GHL-linked integration lands via GHL-009/CHAR-014.)
- **Screenplay -> scene -> shot -> reference plan -> model-specific request:** carried entirely by Wave-1 edges `DIR-004 -> DIR-009 -> DIR-010 -> DIR-012/DIR-013 -> AGN-008 / KIE-004 / KIE-006` (fixture-testable per hop). Its end-to-end proof across real providers is REL-004 (Wave 3). No separate Wave-2 task exists for this chain — none is needed.
- **Provider result -> GHL archival -> QC -> Remotion rough cut:** `VID-012` assembles only QC-approved, GHL-archived assets (deps `QC-006`, `GHL-008`, all layer tasks); `VID-013` selective replacement on the real rough cut; `VID-014` final render; `QC-012` final episode QC on the real assembly.
- **CLI/Skill calling completed engine APIs:** `SKL-001`–`SKL-007` — the canonical skill is authored against the completed `mmcs` CLI (`CORE-011`), then installed and invoked in real Claude Code / claude-nine / OpenClaw hosts.
- **Persistent restart/resume across real provider job IDs:** `REC-010` (all hooks + `CORE-014` checkpoint + real Agnes/Kie job-id idempotency `AGN-010`, `KIE-008`); `REC-011` (auto-compact simulation over real Pre/PostCompact hooks).

**Wave 3 — full-system integration, smoke production, final release (6 tasks):** `REL-001`–`REL-006`. Wave 3 starts when every Wave-1/Wave-2 subsystem terminal has merged into `REL-001`'s dependency set.

**Unlock doctrine:** the watchdog refills agents against the edge list, not against waves. A Wave-2 task starts the moment its listed deps are MERGED, even if the rest of Wave 1 is still running.

---

## 3. Full edge list (all 149 tasks)

### CORE / state / database (15)

| Task | Depends on | Wave |
|---|---|---|
| CORE-001 | NONE | W1 |
| CORE-002 | CORE-001 | W1 |
| CORE-003 | CORE-002 | W1 |
| CORE-004 | CORE-003 | W1 |
| CORE-005 | CORE-003 | W1 |
| CORE-006 | CORE-003 | W1 |
| CORE-007 | CORE-003 | W1 |
| CORE-008 | CORE-002 | W1 |
| CORE-009 | CORE-003, CORE-008 | W1 |
| CORE-010 | CORE-002 | W1 |
| CORE-011 | CORE-002, CORE-010 | W1 |
| CORE-012 | CORE-002 | W1 |
| CORE-013 | CORE-002 | W1 |
| CORE-014 | CORE-002, CORE-013 | W1 |
| CORE-015 | CORE-003 | W1 |

### Character / series (15)

| Task | Depends on | Wave |
|---|---|---|
| CHAR-001 | CORE-002 | W1 |
| CHAR-002 | CHAR-001, CORE-005 | W1 |
| CHAR-003 | CHAR-001, CORE-008 | W1 |
| CHAR-004 | CHAR-003, CORE-011 | W1 |
| CHAR-005 | CHAR-003, CORE-008 | W1 |
| CHAR-006 | CHAR-001, CORE-005 | W1 |
| CHAR-007 | CHAR-006 | W1 |
| CHAR-008 | CHAR-006 | W1 |
| CHAR-009 | CHAR-001, FISH-002 | W1 |
| CHAR-010 | CHAR-001, CORE-004 | W1 |
| CHAR-011 | CORE-005 | W1 |
| CHAR-012 | CORE-004, CHAR-010 | W1 |
| CHAR-013 | CHAR-012, CORE-008 | W1 |
| CHAR-014 | CHAR-002, GHL-009 | W2 |
| CHAR-015 | CHAR-002, CORE-006, QC-001 | W2 |

### Writing / directing (15)

| Task | Depends on | Wave |
|---|---|---|
| DIR-001 | CORE-004 | W1 |
| DIR-002 | DIR-001, CAP-007 | W1 |
| DIR-003 | DIR-002, CORE-008 | W1 |
| DIR-004 | DIR-003, CAP-007 | W1 |
| DIR-005 | DIR-004 | W1 |
| DIR-006 | DIR-004, CAP-007 | W1 |
| DIR-007 | DIR-006 | W1 |
| DIR-008 | DIR-007, CORE-008 | W1 |
| DIR-009 | DIR-008, CHAR-001 | W1 |
| DIR-010 | DIR-009, CHAR-001, CAP-001, CAP-006 | W1 |
| DIR-011 | DIR-010, CHAR-002 | W1 |
| DIR-012 | DIR-010, CAP-001 | W1 |
| DIR-013 | DIR-011, DIR-012, CAP-001, CAP-004 | W1 |
| DIR-014 | DIR-012, DIR-013 | W1 |
| DIR-015 | DIR-014, CORE-008 | W1 |

### Providers / capabilities (10)

| Task | Depends on | Wave |
|---|---|---|
| CAP-001 | CORE-002 | W1 |
| CAP-002 | CAP-001 | W1 |
| CAP-003 | CAP-001 | W1 |
| CAP-004 | CAP-001 | W1 |
| CAP-005 | CAP-001 | W1 |
| CAP-006 | CAP-001 | W1 |
| CAP-007 | CAP-001 | W1 |
| CAP-008 | CAP-007 | W1 |
| CAP-009 | CAP-001, CORE-011 | W1 |
| CAP-010 | CAP-001, CAP-009 | W1 |

### Agnes (10)

| Task | Depends on | Wave |
|---|---|---|
| AGN-001 | CORE-002, CORE-010 | W1 |
| AGN-002 | AGN-001, CAP-001 | W1 |
| AGN-003 | AGN-002 | W1 |
| AGN-004 | AGN-001, CORE-013, CAP-001 | W1 |
| AGN-005 | AGN-004 | W1 |
| AGN-006 | AGN-004, CAP-002 | W1 |
| AGN-007 | AGN-004, CAP-002 | W1 |
| AGN-008 | AGN-004, CAP-004, CAP-005 | W1 |
| AGN-009 | AGN-004, CORE-009 | W1 |
| AGN-010 | AGN-005, CORE-013 | W1 |

### Kie (10)

| Task | Depends on | Wave |
|---|---|---|
| KIE-001 | CORE-002, CORE-010 | W1 |
| KIE-002 | KIE-001, CORE-013 | W1 |
| KIE-003 | KIE-002, CAP-002 | W1 |
| KIE-004 | KIE-003, CAP-005 | W1 |
| KIE-005 | KIE-002, CAP-002 | W1 |
| KIE-006 | KIE-005, CAP-004, CAP-005 | W1 |
| KIE-007 | KIE-002, CAP-006, CORE-009 | W1 |
| KIE-008 | KIE-002, CORE-007 | W1 |
| KIE-009 | KIE-002 | W1 |
| KIE-010 | KIE-003, KIE-004, KIE-005, KIE-006, KIE-007, KIE-008, KIE-009 | W1 |

### Fish / audio (10)

| Task | Depends on | Wave |
|---|---|---|
| FISH-001 | CORE-002, CORE-010 | W1 |
| FISH-002 | FISH-001 | W1 |
| FISH-003 | FISH-002, CORE-013 | W1 |
| FISH-004 | FISH-002 | W1 |
| FISH-005 | FISH-003, CORE-013 | W1 |
| FISH-006 | FISH-003 | W1 |
| FISH-007 | FISH-006 | W1 |
| FISH-008 | FISH-003 | W1 |
| FISH-009 | FISH-008 | W1 |
| FISH-010 | FISH-001, CAP-006 | W1 |

### GHL (12)

| Task | Depends on | Wave |
|---|---|---|
| GHL-001 | CORE-002, CORE-010 | W1 |
| GHL-002 | GHL-001 | W1 |
| GHL-003 | GHL-001 | W1 |
| GHL-004 | GHL-002, GHL-003 | W1 |
| GHL-005 | GHL-001 | W1 |
| GHL-006 | GHL-005 | W1 |
| GHL-007 | GHL-005, GHL-006 | W1 |
| GHL-008 | GHL-005, GHL-006, CORE-007 | W1 |
| GHL-009 | GHL-008, CHAR-002, CHAR-005 | W2 |
| GHL-010 | GHL-004, CORE-004 | W1 |
| GHL-011 | GHL-005, GHL-006, CORE-013 | W1 |
| GHL-012 | GHL-005, GHL-006, CORE-007 | W1 |

### Remotion / FFmpeg (16)

| Task | Depends on | Wave |
|---|---|---|
| VID-001 | NONE | W1 |
| VID-002 | VID-001, CORE-002 | W1 |
| VID-003 | VID-002, CORE-006 | W1 |
| VID-004 | VID-003, FISH-007 | W1 |
| VID-005 | VID-003, CORE-007 | W1 |
| VID-006 | VID-003 | W1 |
| VID-007 | VID-003 | W1 |
| VID-008 | VID-003 | W1 |
| VID-009 | VID-003 | W1 |
| VID-010 | VID-003 | W1 |
| VID-011 | VID-002 | W1 |
| VID-012 | VID-004, VID-005, VID-006, VID-007, VID-008, VID-009, VID-010, VID-011, QC-006, GHL-008 | W2 |
| VID-013 | VID-012 | W2 |
| VID-014 | VID-012, VID-013, VID-015 | W2 |
| VID-015 | NONE | W1 |
| VID-016 | NONE | W1 |

### QC / routing (12)

| Task | Depends on | Wave |
|---|---|---|
| QC-001 | CORE-007 | W1 |
| QC-002 | QC-001, CHAR-002 | W1 |
| QC-003 | QC-001, CHAR-006 | W1 |
| QC-004 | QC-001, CHAR-012 | W1 |
| QC-005 | QC-001, CAP-007, VID-016 | W1 |
| QC-006 | QC-001, CORE-009 | W1 |
| QC-007 | QC-006, AGN-006 | W1 |
| QC-008 | QC-007, AGN-007 | W1 |
| QC-009 | QC-008, KIE-003 | W1 |
| QC-010 | QC-009, KIE-005 | W1 |
| QC-011 | QC-006, CORE-008 | W1 |
| QC-012 | QC-002, QC-003, QC-004, QC-005, VID-012 | W2 |

### Skills / integration / recovery / release (24)

| Task | Depends on | Wave |
|---|---|---|
| SKL-001 | CORE-011 | W2 |
| SKL-002 | SKL-001 | W2 |
| SKL-003 | SKL-002 | W2 |
| SKL-004 | SKL-003 | W2 |
| SKL-005 | SKL-001 | W2 |
| SKL-006 | SKL-005 | W2 |
| SKL-007 | SKL-005 | W2 |
| REC-001 | NONE | W1 |
| REC-002 | REC-001 | W1 |
| REC-003 | REC-001 | W1 |
| REC-004 | REC-001 | W1 |
| REC-005 | REC-001 | W1 |
| REC-006 | REC-001 | W1 |
| REC-007 | REC-001 | W1 |
| REC-008 | REC-001 | W1 |
| REC-009 | REC-001 | W1 |
| REC-010 | REC-001, REC-002, REC-003, REC-004, REC-005, CORE-014, AGN-010, KIE-008 | W2 |
| REC-011 | REC-001, REC-002, REC-003 | W2 |
| REL-001 | CORE-015, CHAR-013, CHAR-014, CHAR-015, DIR-015, CAP-010, AGN-010, KIE-010, FISH-009, FISH-010, GHL-012, VID-014, VID-016, QC-011, QC-012, SKL-007, REC-011 | W3 |
| REL-002 | REL-001 | W3 |
| REL-003 | REL-001 | W3 |
| REL-004 | REL-002, REL-003 | W3 |
| REL-005 | REL-004 | W3 |
| REL-006 | REL-004, REL-005 | W3 |

---

## 4. Critical path

Longest path through the DAG — **22 nodes / 21 edges**, all through the directing chain, because the six approval-gate semantics serialize concept -> screenplay -> critic -> revision -> approval -> parse -> shots -> keyframes -> budget -> storyboard:

```
CORE-001 -> CORE-002 -> CORE-003 -> CORE-004 -> DIR-001 -> DIR-002 -> DIR-003
-> DIR-004 -> DIR-006 -> DIR-007 -> DIR-008 -> DIR-009 -> DIR-010
-> DIR-011 -> DIR-013 -> DIR-014 -> DIR-015
-> REL-001 -> REL-002 -> REL-004 -> REL-005 -> REL-006
```

(DIR-011 and DIR-012 are equidistant at depth 15; either can sit in the DIR-013 slot.)

Orchestration consequences:

1. **True bottleneck pair: CORE-001 -> CORE-002.** Every package-placed task in the graph descends from them. Staff CORE-001 and CORE-002 first with the strongest builders; everything else fans out behind them.
2. **CORE-003** is the second choke point (all four schema tasks CORE-004–007 hang off it). Land it early.
3. **DIR gate chain** (DIR-001..015) is the longest single-family chain — 15 tasks deep. Keep it continuously staffed; never let a DIR task sit BUILDER_DONE without its Sonnet QC.
4. **Secondary long chain** (media/audio): CORE-001 -> CORE-002 -> CORE-010 -> FISH-001 -> FISH-002 -> FISH-003 -> FISH-006 -> FISH-007 -> VID-004 -> VID-012 -> VID-013 -> VID-014 (depth 12) — feeds REL-001 but does not extend the critical path (VID-014 depth 12 < DIR-015 depth 18).
5. **Parallelism ceiling:** 5 tasks start with `NONE` (CORE-001, VID-001, VID-015, VID-016, REC-001); within the first merges, 100+ Wave-1 tasks are concurrently unblocked. The DAG supports the full 10-workflow x 10-agent topology from runbook §9 without artificial phasing.

---

## 5. Machine-readable adjacency

Every task ID is a key; values are the task IDs it depends on (empty array = NONE).

```json
{"dependencies": {"CORE-001": [], "CORE-002": ["CORE-001"], "CORE-003": ["CORE-002"], "CORE-004": ["CORE-003"], "CORE-005": ["CORE-003"], "CORE-006": ["CORE-003"], "CORE-007": ["CORE-003"], "CORE-008": ["CORE-002"], "CORE-009": ["CORE-003", "CORE-008"], "CORE-010": ["CORE-002"], "CORE-011": ["CORE-002", "CORE-010"], "CORE-012": ["CORE-002"], "CORE-013": ["CORE-002"], "CORE-014": ["CORE-002", "CORE-013"], "CORE-015": ["CORE-003"], "CHAR-001": ["CORE-002"], "CHAR-002": ["CHAR-001", "CORE-005"], "CHAR-003": ["CHAR-001", "CORE-008"], "CHAR-004": ["CHAR-003", "CORE-011"], "CHAR-005": ["CHAR-003", "CORE-008"], "CHAR-006": ["CHAR-001", "CORE-005"], "CHAR-007": ["CHAR-006"], "CHAR-008": ["CHAR-006"], "CHAR-009": ["CHAR-001", "FISH-002"], "CHAR-010": ["CHAR-001", "CORE-004"], "CHAR-011": ["CORE-005"], "CHAR-012": ["CORE-004", "CHAR-010"], "CHAR-013": ["CHAR-012", "CORE-008"], "CHAR-014": ["CHAR-002", "GHL-009"], "CHAR-015": ["CHAR-002", "CORE-006", "QC-001"], "DIR-001": ["CORE-004"], "DIR-002": ["DIR-001", "CAP-007"], "DIR-003": ["DIR-002", "CORE-008"], "DIR-004": ["DIR-003", "CAP-007"], "DIR-005": ["DIR-004"], "DIR-006": ["DIR-004", "CAP-007"], "DIR-007": ["DIR-006"], "DIR-008": ["DIR-007", "CORE-008"], "DIR-009": ["DIR-008", "CHAR-001"], "DIR-010": ["DIR-009", "CHAR-001", "CAP-001", "CAP-006"], "DIR-011": ["DIR-010", "CHAR-002"], "DIR-012": ["DIR-010", "CAP-001"], "DIR-013": ["DIR-011", "DIR-012", "CAP-001", "CAP-004"], "DIR-014": ["DIR-012", "DIR-013"], "DIR-015": ["DIR-014", "CORE-008"], "CAP-001": ["CORE-002"], "CAP-002": ["CAP-001"], "CAP-003": ["CAP-001"], "CAP-004": ["CAP-001"], "CAP-005": ["CAP-001"], "CAP-006": ["CAP-001"], "CAP-007": ["CAP-001"], "CAP-008": ["CAP-007"], "CAP-009": ["CAP-001", "CORE-011"], "CAP-010": ["CAP-001", "CAP-009"], "AGN-001": ["CORE-002", "CORE-010"], "AGN-002": ["AGN-001", "CAP-001"], "AGN-003": ["AGN-002"], "AGN-004": ["AGN-001", "CORE-013", "CAP-001"], "AGN-005": ["AGN-004"], "AGN-006": ["AGN-004", "CAP-002"], "AGN-007": ["AGN-004", "CAP-002"], "AGN-008": ["AGN-004", "CAP-004", "CAP-005"], "AGN-009": ["AGN-004", "CORE-009"], "AGN-010": ["AGN-005", "CORE-013"], "KIE-001": ["CORE-002", "CORE-010"], "KIE-002": ["KIE-001", "CORE-013"], "KIE-003": ["KIE-002", "CAP-002"], "KIE-004": ["KIE-003", "CAP-005"], "KIE-005": ["KIE-002", "CAP-002"], "KIE-006": ["KIE-005", "CAP-004", "CAP-005"], "KIE-007": ["KIE-002", "CAP-006", "CORE-009"], "KIE-008": ["KIE-002", "CORE-007"], "KIE-009": ["KIE-002"], "KIE-010": ["KIE-003", "KIE-004", "KIE-005", "KIE-006", "KIE-007", "KIE-008", "KIE-009"], "FISH-001": ["CORE-002", "CORE-010"], "FISH-002": ["FISH-001"], "FISH-003": ["FISH-002", "CORE-013"], "FISH-004": ["FISH-002"], "FISH-005": ["FISH-003", "CORE-013"], "FISH-006": ["FISH-003"], "FISH-007": ["FISH-006"], "FISH-008": ["FISH-003"], "FISH-009": ["FISH-008"], "FISH-010": ["FISH-001", "CAP-006"], "GHL-001": ["CORE-002", "CORE-010"], "GHL-002": ["GHL-001"], "GHL-003": ["GHL-001"], "GHL-004": ["GHL-002", "GHL-003"], "GHL-005": ["GHL-001"], "GHL-006": ["GHL-005"], "GHL-007": ["GHL-005", "GHL-006"], "GHL-008": ["GHL-005", "GHL-006", "CORE-007"], "GHL-009": ["GHL-008", "CHAR-002", "CHAR-005"], "GHL-010": ["GHL-004", "CORE-004"], "GHL-011": ["GHL-005", "GHL-006", "CORE-013"], "GHL-012": ["GHL-005", "GHL-006", "CORE-007"], "VID-001": [], "VID-002": ["VID-001", "CORE-002"], "VID-003": ["VID-002", "CORE-006"], "VID-004": ["VID-003", "FISH-007"], "VID-005": ["VID-003", "CORE-007"], "VID-006": ["VID-003"], "VID-007": ["VID-003"], "VID-008": ["VID-003"], "VID-009": ["VID-003"], "VID-010": ["VID-003"], "VID-011": ["VID-002"], "VID-012": ["VID-004", "VID-005", "VID-006", "VID-007", "VID-008", "VID-009", "VID-010", "VID-011", "QC-006", "GHL-008"], "VID-013": ["VID-012"], "VID-014": ["VID-012", "VID-013", "VID-015"], "VID-015": [], "VID-016": [], "QC-001": ["CORE-007"], "QC-002": ["QC-001", "CHAR-002"], "QC-003": ["QC-001", "CHAR-006"], "QC-004": ["QC-001", "CHAR-012"], "QC-005": ["QC-001", "CAP-007", "VID-016"], "QC-006": ["QC-001", "CORE-009"], "QC-007": ["QC-006", "AGN-006"], "QC-008": ["QC-007", "AGN-007"], "QC-009": ["QC-008", "KIE-003"], "QC-010": ["QC-009", "KIE-005"], "QC-011": ["QC-006", "CORE-008"], "QC-012": ["QC-002", "QC-003", "QC-004", "QC-005", "VID-012"], "SKL-001": ["CORE-011"], "SKL-002": ["SKL-001"], "SKL-003": ["SKL-002"], "SKL-004": ["SKL-003"], "SKL-005": ["SKL-001"], "SKL-006": ["SKL-005"], "SKL-007": ["SKL-005"], "REC-001": [], "REC-002": ["REC-001"], "REC-003": ["REC-001"], "REC-004": ["REC-001"], "REC-005": ["REC-001"], "REC-006": ["REC-001"], "REC-007": ["REC-001"], "REC-008": ["REC-001"], "REC-009": ["REC-001"], "REC-010": ["REC-001", "REC-002", "REC-003", "REC-004", "REC-005", "CORE-014", "AGN-010", "KIE-008"], "REC-011": ["REC-001", "REC-002", "REC-003"], "REL-001": ["CORE-015", "CHAR-013", "CHAR-014", "CHAR-015", "DIR-015", "CAP-010", "AGN-010", "KIE-010", "FISH-009", "FISH-010", "GHL-012", "VID-014", "VID-016", "QC-011", "QC-012", "SKL-007", "REC-011"], "REL-002": ["REL-001"], "REL-003": ["REL-001"], "REL-004": ["REL-002", "REL-003"], "REL-005": ["REL-004"], "REL-006": ["REL-004", "REL-005"]}}
```

Wave membership map (for the scheduler): W1 = CORE-001..015, CHAR-001..013, DIR-001..015, CAP-001..010, AGN-001..010, KIE-001..010, FISH-001..010, GHL-001..008, GHL-010..012, VID-001..011, VID-015, VID-016, QC-001..011, REC-001..009 (127 tasks). W2 = CHAR-014, CHAR-015, GHL-009, VID-012, VID-013, VID-014, QC-012, SKL-001..007, REC-010, REC-011 (16 tasks). W3 = REL-001..006 (6 tasks). 127 + 16 + 6 = 149.