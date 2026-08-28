# Approvals reference — gates, spend wall, and state machine

The approval state machine (spec §8) is enforced by the engine. This file
documents how the agent interacts with it correctly.

## Hard STOP gates

| Gate | Approve verb | Blocks |
| --- | --- | --- |
| Concept | `mmcs approve concept` | script writing |
| Script | `mmcs approve script` | cast/shot planning |
| Character choice | `mmcs choose-character <candidate>` | character lock |
| Character lock | `mmcs approve-character <id>` | shot generation using that character |
| Storyboard | `mmcs approve-storyboard` | generation |
| Rough cut | `mmcs approve rough-cut` | final render |
| Canon change | `mmcs canon approve` | Series Bible update |

## Rules

1. **STOP means stop.** When a gate is open, present the artifact (concept,
   script, storyboard, rough cut, canon proposal) to the user and wait for an
   explicit decision. Silence is not approval. A "looks fine" is not approval
   of a different artifact.
2. **The CLI is the enforcer.** If a verb refuses because a gate is unmet,
   report the refusal verbatim; do not retry, do not edit state, do not work
   around by regenerating or skipping.
3. **Gates survive restarts.** Pending gates remain pending after a crash or
   restart; `mmcs status` shows them. Re-present the artifact if the user
   context is lost — never auto-approve after recovery.
4. **One artifact per approval.** Approving concept N does not approve script
   N+1. Each stage re-gates after revision.

## Spend wall (independent of gates)

- Cumulative **paid** spend per episode auto-authorizes strictly below
  $25.00. Reaching **$25.00 or above halts generation until explicit user
  approval**.
- Estimate first (`mmcs estimate`); if projected cumulative spend would
  reach the wall, say so before generating.
- Never shard requests, delay accounting, or parallelize reservations to stay
  under the wall. Two concurrent reservations cannot bypass it by design —
  do not try to prove otherwise.

## Presenting an approval

Show: what is being approved, the stage, the artifact location the engine
reported, current cumulative spend, and the exact verb the user's decision
maps to. Example shape:

```
Concept ready for "Series X — Episode 2" (stage: concept, gate: approve concept).
Projected next-stage spend: $6.40 (cumulative $11.10 of $25.00 wall).
Approve? → mmcs approve concept
```

After approval, re-run `mmcs status` to confirm the gate cleared.