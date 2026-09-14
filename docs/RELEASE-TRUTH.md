# Release Truth — what the release gates did and did not prove

Audit note, written 2026-09-14 against the tree at the `mmcs-repair-2026-09-13`
branch. Scope: the six `REL-*` release tasks (`todo.md` lines 1623–1687) and the
two committed evidence reports they produced.

This file exists because two control documents disagree about the same release.
`todo.md` line 4 declares **"ALL 149/149 TASKS MERGED"**, while the same file
still carries a `## BLOCKED set (1)` heading at line 10, a counts table at lines
1693–1706 reading **Total 149 | READY 1 | BLOCKED 1**, and per-task headers at
lines 1634/1645/1656/1667/1678 that are still unchecked `- [ ]` while their own
`Status:` lines say MERGED. `checklist.md` gives the third answer: **13
feature-acceptance boxes are unchecked**, including the two gates that matter
most for this product — `checklist.md:64`
`- [ ] Remotion + FFmpeg rendering verified end-to-end` and `checklist.md:68`
`- [ ] Hard $25 cost ceiling enforced on test runs`.

Those control files belong to a different workstream and are deliberately **not**
edited here. This document states the truth they disagree about.

**How to read the gate results.** "Script exits 0" and "scenario printed PASS"
are claims about a script, not about the product. A gate proves only what its
assertions assert; nothing more. The tables below separate the two.

---

## 1. Gates that were genuinely met

These were demonstrated by an assertion in code that a reader can re-run, and
the assertion is about the thing it claims to be about.

| Gate | What was actually proved | Where the proof lives |
|---|---|---|
| REL-001 clean install | Fresh clone → workspace install → composite package build → CLI build → `mmcs doctor` exit 0, with no secrets. The script hard-checks Node ≥ 22.5 for `node:sqlite` and aborts before mutating anything. | `scripts/release/clean-install.sh` (prerequisite gate ~lines 120–133); `mmcs doctor` confirmed live — it reads env-var **presence** and opens the durable approval store, then exits 0 with zero keys set |
| REL-002 regression sweep | Six areas (tools / vitest / `npm run gen` / typecheck / lint / render-smoke) run from one script and report per-area. | `scripts/release/regression.sh` |
| REL-003 example project | The demo series runs as tests with fixtures and no paid call. | `examples/demo-series/`; `docs/first-series.md` |
| REL-006 docs deliverables | Every §33 doc exists, is non-trivial, and every backticked repo-relative path inside it resolves. | `scripts/release/docs-verify.sh` |
| State durability across restart | The restart boundary (fresh service instance over the same store, no resubmission) is genuinely exercised — `createVideo` call counts prove the resumed path issued zero new paid calls. | `scripts/release/e2e-dry-run.ts` scenario S13, asserted at line 1369 |
| Spend-gate arithmetic | An over-limit paid reservation is **declined** with `AgnesVideoBudgetDeclinedError` and leaves no ledger row. This proves the gate refuses when asked; see §3 for what it does not prove. | `scripts/release/e2e-dry-run.ts:1306`, reported at `docs/e2e-dry-run-report.md:18` |
| ffmpeg/ffprobe are really invoked | The dry-run executes the real binaries on PATH and the real ffprobe gate validates codec/duration before any PASS. | `scripts/release/e2e-dry-run.ts` lines 807–819 (tool probe), 104–106 (real `ffprobeValidate`) |

Honest reporting that must be preserved, not "corrected":

- `docs/provider-smoke-report.md` labels every provider `credentials absent` /
  `Mode: BLOCKED` / `Live item: BLOCKED` / `$0.0000` (lines 18–21) and repeats it
  in its "Honesty notes" section (lines 25–28): *"Mocked; live API behavior is
  NOT covered and is NOT reported as covered."*
- `docs/e2e-dry-run-report.md:27` states the same for its own run: *"Live-item
  coverage … is **BLOCKED — credentials absent by design**; the dry run proves
  the full control path and the fail-closed gates, never live provider
  behavior."*
- `docs/e2e-dry-run-report.md:18` reports the archival URL as
  `https://storage.mock-ghl.invalid/...` — the mock host is visible in the
  evidence, which is exactly right.

Neither report oversells itself. The problem is the **roll-up above them**,
which reads as a release gate (see §2).

---

## 2. Reported as passing, with zero coverage

### 2a. REL-005 provider smoke exercised no live provider — all four were blocked

`docs/provider-smoke-report.md`:

- line 7: `**Result: PASS**`
- lines 18–21: all four providers (`agnes`, `kie`, `fish`, `ghl`) —
  `Credentials: absent`, `Mode: BLOCKED`, `Live item: BLOCKED`, `Spend: $0.0000`,
  `Job IDs: none (mocked)`.

The task's own acceptance criterion (`todo.md:1675`) required
*"≥1 Agnes generation; … Fish Audio; GHL archival"*. **Zero generations ran.**
The report is honest line-by-line; the word `PASS` is not, because the gate had
no live coverage to pass on. `$0` spend is a true measurement of a run that did
nothing, not evidence that the $25 wall holds under real spend.

`scripts/release/provider-smoke.ts:38–42` explains *why* this is the shipped
default: the script runs in `report-only` mode and can never emit a live `PASS`
outcome. So the committed report is the only outcome this gate can produce —
it is structurally incapable of satisfying its own acceptance criterion.

### 2b. REL-004 e2e dry run never invokes the CLI

`scripts/release/e2e-dry-run.ts` drives subsystem modules by direct import. It
contains **no** reference to `apps/cli`, to a built entry point, or to a `mmcs`
subprocess — verified by search. Therefore the gate that was used to declare the
release ready could not have detected an unwired CLI, and did not: this tree
shipped for several batches with verbs that printed
`STUB: registered, not implemented yet` and exited 0. `apps/cli/src/cli-bootstrap.test.ts:58`
is the assertion that closes that hole — and its own header comment records that
its absence is what let the gap through.

### 2c. The "real ffmpeg render" renders a test pattern, and the final render is clamped to 2 seconds

`README.md` promises a **"real ffmpeg render"**. What runs is an ffmpeg `lavfi`
`testsrc2` colour-bar pattern, produced by the function named
`makeFfmpegFixtureAdapter` in each of these two modules (cite the symbol, not
the line — concurrent repair work shifts these files):

- `packages/remotion-runtime/src/rough-cut/render.ts` — `testsrc2=...`
- `packages/remotion-runtime/src/final-render/ffprobe-fixture.ts` — `testsrc2=...`,
  with the duration forcibly capped by `String(Math.min(request.durationSeconds, 2))`

The dry run imports the capped adapter as its final-render adapter
(`scripts/release/e2e-dry-run.ts:105`) and its own evidence shows the result:
`docs/e2e-dry-run-report.md:22` reports the rough cut at **54s** but the final
render at **`ffprobe ok=true 2s`**. The final output is therefore ~27× shorter
than the composition it claims to have rendered. ffmpeg and ffprobe genuinely
ran; no Remotion composition was ever assembled or encoded.

This is not fixable in documentation alone: `@mmcs/remotion-runtime` declares
`remotion` but no `@remotion/renderer`, `@remotion/bundler` or `@remotion/cli`,
and the CLI's own render adapter is a refusal, not a renderer
(`apps/cli/src/index.ts:1007` — `"rough-cut: no render adapter configured in
this CLI"`; the equivalent for `final` sits in `finalPorts()`).

### 2d. `docs/e2e-dry-run-report.md` line 13: "20 tables" is an observation, not a validator

The cell reads `20 tables; cost_reservations+cost_quota_usage present`. The
assertion behind it is `scripts/release/e2e-dry-run.ts:915`:

```ts
assert(tables.length >= 10 && hasLedger, "migrations + cost schema on scratch SQLite ...")
```

`20` is the number that happened to be observed on the day; the gate only
requires **≥ 10**. A future run with 11 tables would still print PASS. The
committed cell now says which of the two numbers is load-bearing.

Caveat an operator must know: `docs/e2e-dry-run-report.md` is **regenerated** —
`scripts/release/e2e-dry-run.sh --markdown` overwrites it from
`scripts/release/e2e-dry-run.ts:1944–1948`. The next regeneration will restore
the bare `20 tables; …` wording and this caveat will be erased from that file.
The permanent fix belongs in the generator: the assertion message at
`scripts/release/e2e-dry-run.ts:915` should carry the `>= 10` predicate
alongside the observed count. This is a code change and is **not** made here.

### 2e. The rendering and spend gates are still open in the acceptance record

`checklist.md` was never updated to match the "149/149" claim:

- `checklist.md:64` `- [ ] Remotion + FFmpeg rendering verified end-to-end`
- `checklist.md:68` `- [ ] Hard $25 cost ceiling enforced on test runs`
- 11 further unchecked boxes at `checklist.md:20–25` (planning phase),
  `:57` (asset manifest data model), `:61–63` (image adapters, video router,
  Fish TTS integration), `:69–71` (budget managers, QC in the build loop, six
  gates wired into runtime flow), `:75–78` (skills tested, standalone resume,
  security scan, full regression on a clean clone).

Every one of those lines is a gate that §1 does **not** prove. In particular
"6 approval gates wired into runtime flow" (`checklist.md:71`) and "Hard $25
cost ceiling enforced on test runs" (`checklist.md:68`) remain unproven in the
sense an operator means: the durable gate objects exist and behave in tests, but
nothing proves they are reached by a production run.

---

## 3. What remains unverified

Listed plainly. None of these is a documentation defect — each is missing
coverage, and several are missing product code.

1. **No live provider call has ever been made by this engine.** No Agnes, Kie,
   Fish or GHL credential was present in any recorded run, so adapter auth,
   request shape, async job semantics, provider error mapping and real pricing
   are entirely unexercised (`docs/provider-smoke-report.md:18–21`).
2. **No live GHL transport.** Archival was proved against scripted fakes
   (`scripts/release/e2e-dry-run.ts:1374` onwards, "Emergency archival — happy
   path over a shared fake ingest"), which is why the evidence URLs point at
   `storage.mock-ghl.invalid`.
3. **No Remotion render.** The renderer/bundler is not a dependency and no
   composition has been encoded. See §2c.
4. **The final render's duration is not the composition's duration** (the
   `Math.min(request.durationSeconds, 2)` cap in
   `packages/remotion-runtime/src/final-render/ffprobe-fixture.ts`), so
   frame-count, timeline and audio placement are unproven end-to-end.
5. **No production path reaches the $25 wall.** The ledger and gate are real and
   tested in isolation, and the dry run proves a refusal, but no production verb
   is demonstrated to submit a paid job through the gate before spending.
6. **`mmcs rough-cut <episodeId>` and `mmcs final <episodeId>` cannot be called
   with an episode.** Both usage banners document an `<episodeId>` argument
   (`packages/remotion-runtime/src/rough-cut/cli.ts:42`,
   `packages/remotion-runtime/src/final-render/cli.ts:41`) but both command
   specs declare no argument (`ROUGH_CUT_SPEC` at `rough-cut/cli.ts:35`,
   `FINAL_SPEC` at `final-render/cli.ts:34`). Running them with an episode id
   yields `error: too many arguments` and exit 1. Observed live on the built
   CLI, 2026-09-14. So even the refusal path in §2c is currently unreachable by
   the documented invocation.
7. **The install path is not reproducible off this box.** `clean-install.sh` is
   written for pnpm + Node ≥ 22.5, but the environment survey
   (`docs/environment/ENVIRONMENT.md`) is a point-in-time snapshot; the pnpm row
   had to be corrected once already (see that file's pnpm row and quirk 3).
8. **`mmcs providers verify` verifies nothing.** It runs with an empty registry
   loader and zero registered probes, reports `0 model(s) checked`, and exits 0
   (`apps/cli/src/commands/providers-verify/command.ts` — `emptyRegistryLoader`,
   `defaultProbes`). The intended configured-vs-documented-vs-observed report has
   never been produced. See `docs/provider-setup.md`.
9. **Docker/Linux rendering is unbuilt.** No Dockerfile, compose file or CI
   configuration exists in the tree, and the render toolchain is mac-arm64 only.

---

## 4. What "done" would require

For the two gates above to be claimed honestly:

- a run of `scripts/release/provider-smoke.sh --live` with real credentials,
  recording at least one live generation, its job ID and a non-zero spend line
  under the $25 cap — or a decision, recorded in `decisions.md`, that the
  project ships without live-provider proof;
- a render gate that asserts the **encoded output duration matches the
  composition duration**, after `@remotion/renderer` + `@remotion/bundler` are
  actual dependencies and `RoughCutRenderAdapter` is a real renderer;
- a CLI-surface gate that runs every §24 verb through the shipped entry point
  and fails on stub output or a false-zero exit (`apps/cli/src/cli-bootstrap.test.ts`
  is that gate — it must run in the release sweep, not only in vitest);
- a production-path assertion that the $25 ledger is consulted before a paid
  submission, not only that it declines when asked directly.

Until then the accurate roll-up is: **install, docs, regression, restart and
refusal behaviour are proven; rendering, live providers, live archival and
production spend enforcement are not.**
