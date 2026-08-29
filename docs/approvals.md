# Approval Gates

MMCS production pauses at **six human approval gates** plus one automatic
spend gate. Gates are **persisted domain states** in the engine (SQLite via
`packages/core/src/approvals/`), not chat messages — the calling agent relays
the operator's decision by running the gate verb, never by "feeling" approval
in conversation. Full operator contract:
`skills/mini-movie-creator/references/approvals.md`.

## The six gates

| # | Gate | Reached by | Advance by | Blocks |
| --- | --- | --- | --- | --- |
| 1 | Concept | `mmcs develop-concept` | `mmcs approve concept` | screenplay work |
| 2 | Script | `mmcs write-script` | `mmcs approve script` | cast/candidate work |
| 3 | Character selection/lock | candidate presentation | `mmcs choose-character <n>` then `mmcs approve-character <id>` | character CANONICAL state, downstream references |
| 4 | Storyboard | `mmcs storyboard` | `mmcs approve-storyboard` | **any paid generation** |
| 5 | Rough cut | `mmcs rough-cut` | `mmcs approve rough-cut` | final render |
| 6 | Canon/Series Bible update | `mmcs canon review` | `mmcs canon approve` | permanent canon change |

Order is **enforced by the `ApprovalStore`**: approving gate N requires every
earlier gate APPROVED. The demo run
(`examples/demo-series/pipeline.test.ts`) asserts this order end to end — see
`docs/first-series.md`.

## What an operator sees at a gate

Before the agent asks for a decision it must present **gate evidence**: the
artifact itself (concept text, screenplay, storyboard plan with per-shot
keyframe strategy and reference budget, rough cut, proposed canon changes)
plus current `mmcs status` (state, open gate, cumulative spend).

Gate 3 presents **exactly 3 candidates** as Character 1 / 2 / 3, with the only
choices `1`, `2`, `3`, `4-Try Again` (three NEW candidates; rejected ones are
never reusable). A character locks only after the explicit approve step.

## The spend gate (automatic, separate from the six)

- `AUTO_SPEND_LIMIT_USD` (`.env`, default **25.00** USD per episode — see
  `docs/installation.md`, `.env` reference).
- Cumulative **projected** paid spend **< $25.00** per episode → proceeds
  automatically.
- A request that would reach/exceed the ceiling → the engine stops and
  requires operator approval **before crossing**. The agent relays the STOP
  verbatim: next generation cost, current cumulative spend, what remains
  planned.
- Budget reservation is **atomic against one shared ledger**
  (`packages/cost-engine/src/ledger.ts`) and precedes submission
  (job state `BUDGET_RESERVED`). Parallel submissions cannot dodge it.
- Reservations release on failure/rejection. Included subscription quota is
  tracked separately and never counted as paid spend.
- Cost estimates appear at the estimate gate (`mmcs estimate`) BEFORE paid
  generation; actuals are ledgered into asset/task records.

## Rules for the calling agent

- Never advance past an open gate; loop back to the producing verb if the
  operator wants changes, then re-present.
- Never mark a gate approved because the conversation sounded approving.
- Never restate the spend ceiling upward on your own.
- An "I'd approve this" from conversation is not an approval — only the
  operator's explicit sign-off, run through the gate verb.