# Your First Series — A Complete Walkthrough

`docs/first-series.md` · REL-003 example project

This walkthrough takes the demo series **"Mona & the Brass Key"** from an
intake idea to an approved canon change — **every step free**. No provider is
called, no credit card is touched, and each section maps to an assertion in
`examples/demo-series/pipeline.test.ts`, so you can run the whole story as a
test before running it for real.

What you will build: a 2-scene pilot episode `S01E01 "The Overdue Room"`
(Mona the library cat finds a brass key and meets Smudge in the Overdue
Room), 9 shots of 6 seconds each — 54 seconds of planned runtime.

---

## 0. Prerequisites

- Node 26+ and pnpm.
- This repo checked out; dependencies installed (`pnpm install`).
- Nothing else. No API keys are needed for the walkthrough.

## 1. Get oriented

| Path | What it is |
|---|---|
| `examples/demo-series/fixtures.ts` | The entire demo as data: intake, concept response, screenplay, planned scenes, cast versions. Untrusted text — stored, never executed. |
| `examples/demo-series/pipeline.test.ts` | The end-to-end non-paid pipeline, asserted step by step. |
| `examples/demo-series/cli.test.ts` | Proves the `create-series` / `create-episode` verbs are registered and parse. |
| `docs/first-series.md` | This document. |

## 2. Verify (the one command)

From the repo root:

```bash
npx vitest run examples/demo-series --config examples/vitest.examples.config.ts
```

Expected tail: `Test Files 2 passed (2) · Tests 7 passed (7)`.

Note: bare `npx vitest run examples/demo-series` (without `--config`) passes
zero test files — the root `vitest.config.ts` `include` list covers
`packages/`, `apps/`, and `scripts/` only, and `examples/` is not a pnpm
workspace member. Always pass the config flag.

## 3. What the walkthrough does, step by step

The demo walks the pipeline in **gate order** (the approval store
`ApprovalStore` enforces it — approving gate N requires every earlier gate
APPROVED; the order is `concept → script → character → storyboard →
rough-cut → canon`):

1. **Persisted records.** `SqliteProjectRepository` / `SqliteSeriesRepository`
   / `SqliteEpisodeRepository` create project → series → episode
   (`mmcs create-series` / `mmcs create-episode` own these verbs in CORE-011;
   `examples/demo-series/cli.test.ts` proves the verbs are registered and
   parse today, while their handlers are still stubs).
2. **Gate 1 — concept.** `parseIntake` validates the demo intake;
   `generateConcept` runs against an in-process **mock** director-model
   transport that always answers with the fixture's two options
   (`optionCount: 2` — the response validator requires exactly the requested
   count). Gate `concept` approved.
3. **Gate 2 — script.** `parseScreenplay` parses the 2-scene screenplay with
   the known-cast list; `estimateRuntime` derives 54s. Gate `script` approved.
4. **Shot planning.** `planEpisodeShots` decomposes the planned scenes into 9
   shots inside the Agnes video window (4–12s each, 6s each here). The planner
   warns (non-fatal) that SC02's 4 beats clamp its 5-shot pace target.
5. **Scene masters.** Each scene is classified (`classifySceneMasterNeed`) and
   planned per-scene with a deterministic canon-at-the-episode
   `resolveAppearance`; `approveSceneMasterSpec` marks each APPROVED and
   provider-reference-eligible.
6. **Keyframes + references.** `planKeyframes` (DIR-012) picks per-shot
   keyframe strategies — every decision is `downgraded: []` because the demo
   profile supports the whole taxonomy; `planReferenceBudget` (DIR-013)
   selects the minimum-sufficient reference pack per shot, under the model's
   ceiling, with a deterministic justification log.
7. **Storyboard + mocked frames.** `planStoryboard` mints one
   `ASSET_S01E01_*_SB01` contract per shot. Two rules of the paid boundary:
   - `generateStoryboardFrames` ONLY accepts the `MockImageClient` (kind
     `"mock"`) and only while the plan is DRAFT — real paid generation happens
     after gate 4;
   - `assertPaidGenerationAllowed` is the fail-closed check: with a real-cost
     client kind it throws while the plan is DRAFT or gate `storyboard` is
     PENDING, and passes only after both are APPROVED. The test exercises the
     throw, then the pass.
8. **Gate 3 — character, BEFORE gate 4.** The candidate flow
   (`startCandidateFlow` → `generateCandidates` → `applySelection("1")`)
   leaves the chosen design APPROVED and the two unselected designs REJECTED
   (terminal — spec §9). The character record is set APPROVED, gate
   `character` approved, and `CharacterLockService.lock()` advances the
   candidate asset DRAFT → APPROVED → CANONICAL and the character to
   CANONICAL. Only the single APPROVED candidate is passed to the lock — a
   REJECTED one throws.
9. **Gate 4 — storyboard.** `approveStoryboardPlan(plan, gates, …)` transitions
   the plan to APPROVED through the store; the paid-path check now passes.
10. **Cost — tracked, unspent.** `createCostEngineSchema` + `CostLedger`
    reserve kind `"included"` for the planned work: reservation approved,
    committed at `actualUsd: 0` (included work is never counted as paid
    spend against the $25 limit), `projectedTotalUsd === 0`.
11. **QC (planning).** All 17 `QC_CHECK_IDS` recorded as passed; a
    schema-valid per-shot result (route `video-direct`) rolls up `"PASS"`.
12. **Rough cut + registry.** `assembleRoughCut` builds the master timeline:
    9 segments, dialogue lines placed at absolute
    `startSec` (14s → frame 420 at the default 30 fps), one temp music bed at
    −18 dB, total `durationSeconds` 54.0. `buildEpisodeCompositionRegistry`
    registers the episode (positive `sequenceIndex` values — the registry
    rejects zero-based indices) and `getCompositionForEpisode(registry,
    "S01E01")` resolves composition `S01E01` at 54s × 24 fps frames.
13. **Asset manifest.** The 9 storyboard frames are registered as assets
    (deterministic `ASSET_S01E01_*_SB01` ids) and their `qcState` flips to
    `PASSED`.
14. **Gate 5 — rough-cut approved.**
15. **Gate 6 — canon.** A series bible is created; the pilot's summary is
    appended; `proposeEndOfEpisodeChanges` stages one proposal (a world rule
    + a prop) that is dry-run validated and staged PROPOSED; gate `canon` is
    approved; the batch approval `approveAllProposedChanges` (gate-checked,
    atomic, `canonVersion` stamped sequential from 1) applies it. All six
    gates end APPROVED.

## 4. Where your real run starts

Repeat this structure against a real provider **only from the point where the
test asserts paid permission**: after gate `storyboard` is APPROVED and
`assertPaidGenerationAllowed` passes, swap `MockImageClient` for a real image
port and a real video provider. Everything before that — all planning,
approval, candidate, lock, storyboard-contract, QC-schema, rough-cut, and
canon work — runs exactly as this test does, for free.

Budgets: the demo ledger uses `limitUsd: 25` with the reservation kind
`"included"`, which never counts toward the paid limit. A real generation
reservation would use kind `"paid"` and respect the same ledger.

## 5. Failure map (what each error is telling you)

| Error | Cause | Fix |
|---|---|---|
| `expected at least 3 options` (ResponseValidationError) | Concept request omitted `optionCount` (default 3) while the response carries another count | Pass `optionCount` matching your fixture |
| `GateOrderError` on `approve("storyboard")` | Character gate still PENDING | Approve gates in order; lock the character before storyboard |
| `REJECTED candidates are terminal and never become CANONICAL (spec §9)` | A REJECTED candidate was passed to the lock | Pass only the APPROVED candidate |
| `plan must be DRAFT for mocked generation…` | `generateStoryboardFrames` on an APPROVED plan | Generate frames while DRAFT; approve after |
| `duplicate sequenceIndex` (rough cut) | Two shots share an index | Use episode-wide unique indices |
| registry `RegistryPlanError` | zero-based scene/shot indices | `sequenceIndex` values are positive integers |
| `no proposed canon changes to approve` | Approval attempted before proposing | Propose first, then approve |

## 6. Files this task owns

- `examples/demo-series/` (fixtures, tests, this walkthrough's executable twin)
- `examples/vitest.examples.config.ts`
- `docs/first-series.md`

Shared control files (`spec.md`, `ownership.md`, todo/ledger/qc/checklist
docs, `state/tasks.json`, `state/merge-queue.json`) are owned elsewhere and
untouched here.