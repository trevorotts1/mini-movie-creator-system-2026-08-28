# Adding a New Image/Video Provider

MMCS never hard-codes a provider branch into the engine — new image/video
providers arrive as a **capability profile + adapter package + provider
capability doc**, the same shape as the shipped Agnes/Kie stack. This is a
code change (spec §15: "provider adapters, never hard-coded branches").

## The shipped example to mirror

| Layer | Path |
|---|---|
| Capability data | `packages/capability-registry/src/data/agnes.ts`, `kie.ts` (schema + validators beside them) |
| Adapter package | `packages/providers/src/agnes/` (client, profiles, quota, retry, validation, video), `packages/providers/src/kie/` (client, cost, errors, task, temp-url, seedance, wan) |
| Human capability doc | `docs/provider-capabilities/agnes.md`, `kie.md` |
| CLI inspection | `mmcs models`, `mmcs providers verify` |

## Steps

1. **Research with provenance (spec §31).** Read the provider's *current
   official* docs before coding: auth, endpoints, request/response shapes,
   rate limits, error semantics, async job model. Record source URLs +
   `lastVerifiedAt` in the new capability doc.
2. **Write the capability profile.** Add a sibling of
   `packages/capability-registry/src/data/agnes.ts` (one `data` module per
   provider) following the
   existing schema/validators. Values actually attested by the provider are
   VERIFIED; router-catalog values are PROVISIONAL; gaps stay `null` /
   UNKNOWN with a notes entry — never invented. Include pricing as
   `pricingDetail` entries with list prices. Add a companion doc under
   `docs/provider-capabilities/` and index it in that directory's README.
3. **Write the adapter under `packages/providers/`.** Requirements the
   existing adapters satisfy (copy their discipline):
   - async jobs are durable records created **before** polling, with request
     hash/idempotency identifier, provider/model, task/job ID, params,
     timestamps, status, result URL, archival status, retry count
     (spec §18 idempotency states);
   - temporary result URLs are never canonical — outputs archive to GHL via
     the `MediaStore` abstraction (`packages/media-storage/src/`) immediately
     (spec §17);
   - retries/validation live in the adapter, not in callers;
   - no secrets in code — credentials resolve from env names at runtime.
4. **Unit tests in a sandbox** like the shipped ones
   (`packages/providers/src/kie/__tests__/` style) — no live calls in unit
   tests.
5. **Register in the smoke** — extend `scripts/release/provider-smoke.ts`
   credential-gating table so an absent credential shows the provider
   MOCKED/BLOCKED and a configured one CREDENTIALED, projection still $0.0000
   in report-only mode. Live checks stay behind
   `MMCS_SMOKE_LIVE=1` + `MMCS_SMOKE_COST_ACK` (explicit spend consent).
6. **Run the gates:**

```bash
bash scripts/release/provider-smoke.sh     # report-only, exit 0, $0 spend
bash scripts/release/e2e-dry-run.sh        # full pipeline with the new adapter mocked
bash scripts/release/regression.sh         # typecheck/vitest/gen/lint/render-smoke sweep
```

7. **Keep UNKNOWN honest.** New capability docs follow the confidence rules
   in `docs/provider-capabilities/README.md`; a test-friendly UNKNOWN beats a
   fabricated number every time.