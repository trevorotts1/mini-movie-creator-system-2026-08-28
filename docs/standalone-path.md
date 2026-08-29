# Standalone App Architecture Path

MMCS is built so the same engine can power a standalone application later
without a rewrite (spec §30). This page states what is already true in the
code and what stays reserved.

## What "standalone-ready" means here

| Requirement (spec §2/§30) | Where it holds today |
|---|---|
| Engine UI-independent | `packages/` subsystems own all business logic; `apps/cli` is a thin layer over `core` with no business logic |
| State in durable DB, never chat context | SQLite through `packages/database/` + `state/` control files |
| Provider adapters usable as backend services | `packages/providers/` (agnes, kie, fish-audio) — no CLI or chat assumptions inside |
| Approval gates are persisted domain states | `packages/core/src/approvals/` (SQLite-backed `ApprovalStore`, gate order enforced) |
| CLI commands map cleanly to future API endpoints | command registry `apps/cli/src/dispatch/registry.ts` is importable from `apps/api` (per its own header comment: register once, importable for tests and the API app) |
| Media URLs/IDs are data, not prompt memory | GHL file IDs/URLs/checksums persisted verbatim (spec §17) |
| Storage abstracted | `MediaStore` abstraction + `GoHighLevelMediaStore` (`packages/media-storage/`); S3/R2/GCS later without engine rewrites |
| SQLite migratable to PostgreSQL | schema/migrations in `packages/database/` designed so a server-DB migration is practical later (spec §25) |
| Auth/tenancy not hard-coded to one person | engine never assumes a single operator; per-customer credential config required (spec §34) |

## The thin API boundary

`apps/api/` is the service boundary stub: same operations as the CLI over
HTTP, honoring the same approval gates (spec §24/§59). Its current surface
explicitly declares the intent (`apps/api/src/index.ts`) — endpoints populate
as feature tasks wire them. The acceptance bar, already demonstrated in tests
(`apps/cli` dispatch tests + `examples/demo-series/` pipeline), is that **the
engine runs without Claude**: the CLI is a plain program; the skill only
instructs.

## What is deliberately NOT built in V1

- No polished standalone UI/dashboard: `apps/web` is reserved
  (`.gitkeep` only — no V1 dashboard work; spec §34).
- No YouTube upload/publishing: deferred to a future PublishingProvider
  interface; V1's final destination is durable GHL Media Storage.
- No multi-tenant product features in V1 *usage* — but none may be
  hard-coded against.

## If you build on the engine

Import the packages (`@mmcs/*`) rather than forking files; drive operations
through the same verbs the CLI uses (`apps/cli/src/dispatch/registry.ts` —
the spec §24 surface); honor gates by reading approval state, never by
re-implementing it. Dependency direction is binding —
`docs/ARCHITECTURE.md` § "Dependency direction (binding)".