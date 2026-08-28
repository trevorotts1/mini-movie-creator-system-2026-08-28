# Control Ledger (ledger.md)

**APPEND-ONLY — never rewrite history.**
Every state change, merge, QC verdict, workflow launch, and milestone must be appended here with an exact UTC timestamp and operator/agent identity.

---

- 2026-08-28T12:03:27Z | BOOTSTRAP | repo created at origin from upstream hassancs91/claude-faceless-shorts-creator (MIT preserved)
- 2026-08-28T12:05:00Z | CONTROL_PLANE | directory structure, state JSON seeds, and 12 root control markdown files initialized by bootstrap control-plane agent
- 2026-08-28T12:30:00Z | PLANNING | mmcs-planning-verify | PASS | spec/todo/task-graph/ownership consistent; 149 tasks; READY 130, BLOCKED 19.
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-002 | sha: e2deb1d | Target monorepo/module layout
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-003 | sha: ba9f668 | SQLite connection + migrations runner
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-010 | sha: c2a4a8d | Config/env validation loader
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-011 | sha: 5529f9b | mmcs CLI bootstrap
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-012 | sha: 69bb6f0 | Structured logging
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-013 | sha: 62a5efc | Idempotency primitives
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CORE-014 | sha: 0e3b201 | Recovery checkpoint service
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CAP-001 | sha: 6586606 | Capability schema
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CAP-002 | sha: 808e3aa | Capability source/date/confidence data
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CHAR-001 | sha: 2efae8e | Global character stable IDs
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CHAR-002 | sha: 92af015 | Canonical identity asset metadata
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CHAR-006 | sha: 2cce12b | Appearance versions (effective episode)
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CHAR-008 | sha: eeaec71 | Hair versions
- 2026-08-28T13:30:06Z | BATCH_MERGE | merger | MERGED | CHAR-009 | sha: 0c7ef2c | Fish voice binding
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CORE-001 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-004 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | MERGED | CAP-005 | sha: fff515d | batch 2 (dd77818..e973ac2)
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | MERGED | CAP-006 | sha: 7cf45a1 | batch 2 (dd77818..e973ac2)
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-007 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | MERGED | CAP-008 | sha: 1669e5b | batch 2 (dd77818..e973ac2)
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-009 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-010 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CHAR-007 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | KIE-001 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | MERGED | KIE-002 | sha: 54abd40 | batch 2 (dd77818..e973ac2)
- 2026-08-28T10:05:00Z | BATCH_MERGE | merger | MERGED | KIE-003 | sha: e973ac2 | batch 2 (dd77818..e973ac2)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CAP-004 | sha: 2fc34f1 | Reference-count validator (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CHAR-007 | sha: 40765af | Wardrobe versions (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CORE-001 | sha: b1631a3 | Audit upstream packages/scripts + preservation map (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CORE-004 | sha: e12c7bc | Project/series/episode schema (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | FISH-001 | sha: e6d5b48 | Fish Audio client (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | GHL-001 | sha: de8c967 | GHL auth/config (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | KIE-004 | sha: 90ac338 | Seedance modes/validation (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | KIE-009 | sha: 2f79d22 | Failure normalization (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CHAR-003 | sha: e877f9e | Candidate generation flow (3 designs) (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CHAR-010 | sha: d260ead | Series cast links (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CHAR-012 | sha: 8f1446c | Series Bible events (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | FISH-002 | sha: 469b245 | Voice profile management (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | GHL-002 | sha: 0b650af | List/search media (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | GHL-007 | sha: 9a9fc4c | URL/file validation (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | CHAR-004 | sha: e1c075e | Selection/retry UI-CLI contract (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | MERGED | FISH-004 | sha: 0a820f3 | Pronunciation dictionary (batch 3 6ca3b08..c7d4892)
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-007 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-009 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CORE-005 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CORE-006 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CORE-007 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | KIE-001 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CAP-010 | conflict on integration, branch retains PASS — rebasing required
- 2026-08-28T14:38:00Z | BATCH_MERGE | merger | QC_PASS_CONFLICT | CHAR-011 | conflict on integration, branch retains PASS — rebasing required
