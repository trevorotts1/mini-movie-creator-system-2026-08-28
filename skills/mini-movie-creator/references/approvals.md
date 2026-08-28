# MMCS Approvals Reference — gates, evidence, spend rules

Six mandatory human approval gates plus the automatic spend gate. Nothing
advances past a gate without explicit operator sign-off. Trivial technical
operations never gate — gates exist for expensive, irreversible, and creative
decisions only.

## The six gates

| # | Gate | Reached by | Advance by | Blocks |
| --- | --- | --- | --- | --- |
| 1 | Concept | `mmcs develop-concept` | `mmcs approve concept` | screenplay work |
| 2 | Script | `mmcs write-script` | `mmcs approve script` | cast/candidate work |
| 3 | Character selection/lock | candidate presentation | `mmcs choose-character <n>` then `mmcs approve-character <id>` | character CANONICAL state, downstream references |
| 4 | Storyboard | `mmcs storyboard` | `mmcs approve-storyboard` | **any paid generation** |
| 5 | Rough cut | `mmcs rough-cut` | `mmcs approve rough-cut` | final render |
| 6 | Canon/Series Bible update | `mmcs canon review` | `mmcs canon approve` | permanent canon change |

Gate 3 detail: new characters present **exactly 3 candidates** as
Character 1 / 2 / 3. The only choices offered are `1`, `2`, `3`, and
`4-Try Again` (three NEW candidates; rejected ones never reusable). A
character locks only after the explicit approve step — selection alone is
not a lock.

## What "approval" means

- Approval state is a **persisted domain state** in the engine (SQLite +
  approval records), not a chat message. The calling agent relays the
  operator's decision by running the gate verb; it never marks a gate
  approved because the conversation felt approving.
- Present gate evidence before asking: the artifact itself (concept text,
  screenplay, storyboard plan with per-shot keyframe strategy and reference
  budget, rough cut, proposed canon changes) plus current `mmcs status`
  (state, gate, cumulative spend).
- If the operator asks for changes at a gate, loop back to the producing
  verb (`develop-concept`, `write-script`, `storyboard`, …) and re-present.
  Never skip ahead while a gate is open.
- Interruption for minor technical choices does not happen at gates — gates
  exist only for expensive/irreversible/creative decisions.

## The spend gate (automatic, separate from the 6 gates)

- `AUTO_SPEND_LIMIT_USD = 25.00` (configurable by the operator in project
  config — never by the calling agent mid-episode).
- Cumulative **projected** paid spend **< $25.00** for the episode →
  proceeds automatically.
- A request that would reach/exceed **$25.00** → the engine stops and
  requires user approval **before crossing**. Relay the STOP verbatim: what
  the next generation costs, current cumulative spend, what remains planned.
- Budget reservation is **atomic against one shared ledger** and precedes
  submission (job state BUDGET_RESERVED). Never parallelize submissions to
  evade it; five workers each reserving $24.99 must still stop at $25.00
  collectively.
- Release reservations on failure/rejection. Included subscription quota /
  free allowance is tracked separately and never counted as paid spend.
- Cost estimates are shown at the estimate gate (`mmcs estimate`) BEFORE
  production generation; actual costs are ledgered into asset/task records.

## Gate evidence format (what to show the operator)

For each gate, present in this order:

1. Artifact (concept / script / storyboard / rough cut / canon proposal).
2. One-line `mmcs status` summary: episode, current state, active gate.
3. For storyboard and later gates: current cumulative spend from the cost
   ledger and remaining planned spend from `mmcs estimate`.
4. The exact choices: approve / request changes (with what changes).

Then STOP and wait. Do not run any mutating verb until the operator answers
and you have executed the matching approve verb.

## Never

- Never self-approve. Builders do not approve; the human does.
- Never interpret silence, a thumbs-up emoji in another thread, or "looks
  good I guess" as a gate approval — require explicit sign-off.
- Never raise or restate the spend limit on your own authority.
- Never treat a gate as passed because a prior session recorded progress —
  check `mmcs status`; the engine's persisted state is authoritative.