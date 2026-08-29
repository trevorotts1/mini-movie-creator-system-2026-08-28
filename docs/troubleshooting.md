# Troubleshooting

First-resort triage for operating MMCS. Install-time problems are also
covered in `docs/installation.md` (§ Troubleshooting); this page is the
wider map. Start with:

```bash
mmcs doctor     # environment, providers, config health — names only, no secrets printed
mmcs status     # project/series/episode state, open approval gate, cumulative spend
```

## Symptoms → causes → fixes

| Symptom | Cause | Fix |
|---|---|---|
| `mmcs` not found on PATH | CLI not built after clone/pull | `pnpm --filter @mmcs/cli build`, then run the built entry (`apps/cli/dist/index.js` — produced by that build) with `node` (identical verb surface) |
| doctor lists a provider as missing that you set | `.env` not at repo root, name mismatch vs `.env.example`, blank value, or a shell env override | fix name/value/placement; rerun `mmcs doctor` (config-loading rules: `docs/installation.md`) |
| `GateOrderError` when approving a gate | an earlier gate is not APPROVED | approve gates strictly in order (`docs/approvals.md`); the demo failure map in `docs/first-series.md` § 5 shows each variant |
| Paid generation refused before gate 4 | storyboard gate not APPROVED (`assertPaidGenerationAllowed` fails closed) | run the gate verbs; never force the paid path (`docs/approvals.md`) |
| Over-limit request blocked, no ledger row | cumulative spend would reach `AUTO_SPEND_LIMIT_USD` (default 25) | approval flow per `docs/cost-controls.md`; nothing was spent — the declined request leaves no row |
| A job is stuck / session died mid-generation | async job state machine is durable — resume, don't resubmit | `mmcs recover`; see `skills/mini-movie-creator/references/recovery.md` (never resubmit at SUBMITTED, never regenerate at GENERATED_TEMPORARY) |
| Media generation repeated unexpectedly | resubmitted instead of resuming | forbidden by design — persist is the contract; use `mmcs retry-shot <id>` only for genuinely failed shots |
| Remotion typecheck / render-smoke fail in `scripts/release/regression.sh` | standalone `remotion/` npm workspace missing its deps | `cd remotion && npm ci` (own lockfile, gitignored node_modules); rerun |
| `docs/first-series.md` test passes 0 files | missing `--config` flag | `npx vitest run examples/demo-series --config examples/vitest.examples.config.ts` |
| `RegistryPlanError` / `duplicate sequenceIndex` | bad planning inputs (zero-based indices / duplicate indices) | use positive integers, episode-wide unique sequence indices (`docs/first-series.md` § 5) |
| OpenClaw install can't resolve a workspace | config doesn't name one | never guess a path — script aborts by design; resolve the active workspace in OpenClaw config, then rerun `integrations/openclaw/install.sh` |
| Personal-scope skill not found outside repo | missing `~/.mmcs/mmcs.env` or broken symlink | rerun `bash integrations/claude/personal-install.sh` (`docs/skill-installs.md`) |

## Fail-closed is normal, not broken

Absent credentials BLOCK their provider path on purpose (generation cannot
silently spend money or misarchive media). The dry-run + smoke pair proves
the pipeline is otherwise healthy:

```bash
bash scripts/release/e2e-dry-run.sh     # 11/11 scenarios, zero creds, real ffmpeg render
bash scripts/release/provider-smoke.sh  # credential-gating, $0 spend inside the $25 gate
```

Committed reports: `docs/e2e-dry-run-report.md`, `docs/provider-smoke-report.md`.

## If state looks wrong

Production state is durable (SQLite + `state/`), so reconcile, never recreate:
read `skills/mini-movie-creator/references/recovery.md` (first actions after a
restart, provider job state machine, what NOT to do after a crash). Full
recovery drills: `docs/recovery-simulation.md`.

## Still stuck

- CLI verb reference: `skills/mini-movie-creator/references/workflow.md`.
- Architecture questions: `docs/ARCHITECTURE.md`.
- Environment-specific behavior on this box:
  `docs/environment/ENVIRONMENT.md`.