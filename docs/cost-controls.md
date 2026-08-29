# Cost Controls

MMCS enforces spend discipline in the engine — the calling agent cannot
weaken it, and five parallel workers cannot dodge it either (the reservation
ledger is shared and atomic, `packages/cost-engine/src/ledger.ts`).

## The $25 auto-authorization gate

- `AUTO_SPEND_LIMIT_USD` in `.env` (repo root) sets the cumulative
  **per-episode** paid-spend ceiling in USD. **Default 25.00 when unset**
  (matches spec §33 / `.env.example`).
- Below the ceiling: generation proceeds **automatically** — no per-call
  approval interruptions.
- At/above the ceiling: the engine stops and requires explicit operator
  approval **before crossing**. The STOP the agent relays carries: what the
  next generation costs, current cumulative spend, what remains planned.
- The operator may raise the ceiling in project **config** — never mid-episode
  by the calling agent, never through env edits while an episode runs.

## How the ledger works

1. **Estimate first.** `mmcs estimate` runs BEFORE paid generation and shows
   projected provider usage/cost.
2. **Atomic reservation.** Every submission reserves budget against one
   shared ledger and the job advances to `BUDGET_RESERVED` before any provider
   call. Parallel submissions each reserve collectively toward the same
   ceiling — no evasion possible.
3. **Actual costs ledgered** into asset/task records after completion.
4. **Release on failure/rejection** — failed or QC-rejected work releases its
   reservation.
5. **Included quota is separate.** Subscription/free-allowance usage (kind
   `"included"`) never counts toward the paid limit; only kind `"paid"` does
   (see `docs/first-series.md` § 4 for the ledger kinds in the demo).

## Spend gate vs. the six approval gates

The spend gate is **automatic and independent** of the six human approval
gates (`docs/approvals.md`). Gate 4 (storyboard) blocks any paid generation
until APPROVED — the spend gate is the second, arithmetic layer on top.

## Verification — always zero spend by default

```bash
bash scripts/release/provider-smoke.sh    # report-only: $0 projection + $0 spend inside the $25 gate, exit 0
bash scripts/release/e2e-dry-run.sh       # full pipeline dry run — a budget decline leaves NO ledger row; resume never resubmits
```

Both are committed gates in the release suite
(`scripts/release/regression.sh` runs the sweep). Committed evidence:
`docs/provider-smoke-report.md` (spend $0.0000, all absent credentials
BLOCKED) and `docs/e2e-dry-run-report.md` (over-limit request →
`requires_approval`, zero rows; resume never double-spends).

## Secrets and spend are separate problems

Cost controls meter spend; secrets rules (spec §26/§29) keep values out of
logs, transcripts, and commits. Env variable NAMES are discoverable
(`mmcs doctor`); values never are.